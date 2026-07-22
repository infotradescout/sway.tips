import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  audioFileConnectionEvents,
  audioFileConnections,
  audioFileAccessGrants,
  audioFilePairingTokens,
  auditEvents,
  performers,
  users
} from '../db/schema';
import {
  assertAudioFilePairingClaim,
  AUDIO_FILE_CONNECTION_QR_CONTRACT,
  AUDIO_FILE_PAIRING_PURPOSES,
  type AudioFilePairingPurpose
} from './audio-publishing-contract';

const PAIRING_TTL_MS = 15 * 60 * 1000;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const RAW_PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashAudioFilePairingToken(rawToken: string) {
  const normalizedToken = rawToken.trim();
  if (!RAW_PAIRING_TOKEN_PATTERN.test(normalizedToken)) {
    throw Object.assign(new Error('This file connection QR is invalid.'), { status: 410 });
  }

  const tokenBytes = Buffer.from(normalizedToken, 'base64url');
  if (tokenBytes.length !== 32 || tokenBytes.toString('base64url') !== normalizedToken) {
    throw Object.assign(new Error('This file connection QR is invalid.'), { status: 410 });
  }

  return createHash('sha256').update(tokenBytes).digest('hex');
}

type PairingClaimDenial = Error & {
  status?: number;
  pairingTokenId?: string;
  denialReason?: string;
};

function claimDenialReason(
  token: {
    createdByUserId: string;
    consumedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  },
  claimingUserId: string
) {
  if (token.consumedAt) return 'consumed_token_replay';
  if (token.revokedAt) return 'revoked_token_replay';
  if (token.expiresAt.getTime() <= Date.now()) return 'expired_token';
  if (token.createdByUserId === claimingUserId) return 'creator_self_claim';
  return 'claim_contract_denied';
}

function auditableClaimDenial(error: unknown, pairingTokenId: string, denialReason: string) {
  const denial = (error instanceof Error ? error : new Error('Unable to claim this QR.')) as PairingClaimDenial;
  denial.status = 410;
  denial.pairingTokenId = pairingTokenId;
  denial.denialReason = denialReason;
  return denial;
}

function canonicalMemberPair(userA: string, userB: string) {
  return userA < userB
    ? { memberOneUserId: userA, memberTwoUserId: userB }
    : { memberOneUserId: userB, memberTwoUserId: userA };
}

function isPairingPurpose(value: unknown): value is AudioFilePairingPurpose {
  return typeof value === 'string' && (AUDIO_FILE_PAIRING_PURPOSES as readonly string[]).includes(value);
}

async function writeAudit(
  db: SwayDb,
  input: {
    actorId: string;
    entityType: string;
    entityId: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  }
) {
  await db.insert(auditEvents).values({
    actorType: 'performer',
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    previousStatus: null,
    nextStatus: null,
    metadata: input.metadata ?? null
  });
}

export function createAudioFilePairingService(config: { db: SwayDb }) {
  const { db } = config;

  async function resolveCreatorIdentity(userId: string) {
    const [row] = await db
      .select({
        userId: users.id,
        displayName: performers.displayName,
        handle: performers.handle,
        userDisplayName: users.displayName
      })
      .from(users)
      .leftJoin(performers, eq(performers.ownerUserId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return null;
    return {
      userId: row.userId,
      displayName: row.displayName || row.userDisplayName || 'Sway creator',
      handle: row.handle
    };
  }

  async function createPairingToken(input: {
    createdByUserId: string;
    purpose: unknown;
    tokenHash: unknown;
    idempotencyKey: unknown;
    connectionLabel?: unknown;
  }) {
    if (!isPairingPurpose(input.purpose)) {
      throw Object.assign(new Error('Pairing purpose must be request_files or send_files.'), { status: 422 });
    }
    if (typeof input.tokenHash !== 'string' || !TOKEN_HASH_PATTERN.test(input.tokenHash)) {
      throw Object.assign(new Error('A SHA-256 token hash is required.'), { status: 422 });
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length < 8) {
      throw Object.assign(new Error('An idempotency key is required.'), { status: 422 });
    }

    const idempotencyKey = input.idempotencyKey.trim().slice(0, 128);
    const connectionLabel = typeof input.connectionLabel === 'string'
      ? input.connectionLabel.trim().slice(0, 120) || null
      : null;

    const [existing] = await db
      .select()
      .from(audioFilePairingTokens)
      .where(and(
        eq(audioFilePairingTokens.createdByUserId, input.createdByUserId),
        eq(audioFilePairingTokens.idempotencyKey, idempotencyKey)
      ))
      .limit(1);

    if (existing) {
      return {
        tokenId: existing.id,
        purpose: existing.purpose,
        expiresAt: existing.expiresAt.toISOString(),
        pairingPath: AUDIO_FILE_CONNECTION_QR_CONTRACT.pairingPath,
        reused: true as const
      };
    }

    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    const [created] = await db
      .insert(audioFilePairingTokens)
      .values({
        createdByUserId: input.createdByUserId,
        purpose: input.purpose,
        idempotencyKey,
        tokenHash: input.tokenHash,
        connectionLabel,
        expiresAt
      })
      .returning();

    await writeAudit(db, {
      actorId: input.createdByUserId,
      entityType: 'audio_file_pairing_token',
      entityId: created.id,
      eventType: 'audio_file_pairing.token_issue',
      metadata: { purpose: input.purpose, expiresAt: expiresAt.toISOString() }
    });

    return {
      tokenId: created.id,
      purpose: created.purpose,
      expiresAt: created.expiresAt.toISOString(),
      pairingPath: AUDIO_FILE_CONNECTION_QR_CONTRACT.pairingPath,
      reused: false as const
    };
  }

  async function previewPairingToken(input: {
    claimingUserId: string;
    rawToken: string;
  }) {
    const tokenHash = hashAudioFilePairingToken(input.rawToken);
    const [token] = await db
      .select()
      .from(audioFilePairingTokens)
      .where(eq(audioFilePairingTokens.tokenHash, tokenHash))
      .limit(1);
    if (!token) {
      throw Object.assign(new Error('This file connection QR is invalid.'), { status: 410 });
    }

    try {
      assertAudioFilePairingClaim({
        createdByUserId: token.createdByUserId,
        claimingUserId: input.claimingUserId,
        expiresAt: token.expiresAt,
        consumedAt: token.consumedAt,
        revokedAt: token.revokedAt
      });
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error('Unable to preview this QR.'), { status: 410 });
    }

    const creator = await resolveCreatorIdentity(token.createdByUserId);
    if (!creator) {
      throw Object.assign(new Error('Creator account is unavailable.'), { status: 410 });
    }

    return {
      purpose: token.purpose,
      connectionLabel: token.connectionLabel,
      expiresAt: token.expiresAt.toISOString(),
      creator,
      grantsProjectAccess: AUDIO_FILE_CONNECTION_QR_CONTRACT.projectAccessGrantedAtPairing,
      grantsRoomAccess: AUDIO_FILE_CONNECTION_QR_CONTRACT.roomOrGigAccessGranted
    };
  }

  async function claimPairingToken(input: {
    claimingUserId: string;
    rawToken: string;
  }) {
    const tokenHash = hashAudioFilePairingToken(input.rawToken);

    try {
      return await db.transaction(async (tx) => {
        const [token] = await tx
          .select()
          .from(audioFilePairingTokens)
          .where(eq(audioFilePairingTokens.tokenHash, tokenHash))
          .limit(1);
        if (!token) {
          throw Object.assign(new Error('This file connection QR is invalid.'), { status: 410 });
        }

        try {
          assertAudioFilePairingClaim({
            createdByUserId: token.createdByUserId,
            claimingUserId: input.claimingUserId,
            expiresAt: token.expiresAt,
            consumedAt: token.consumedAt,
            revokedAt: token.revokedAt
          });
        } catch (error) {
          throw auditableClaimDenial(
            error,
            token.id,
            claimDenialReason(token, input.claimingUserId)
          );
        }

        const pair = canonicalMemberPair(token.createdByUserId, input.claimingUserId);
        const [activeConnection] = await tx
          .select()
          .from(audioFileConnections)
          .where(and(
            eq(audioFileConnections.memberOneUserId, pair.memberOneUserId),
            eq(audioFileConnections.memberTwoUserId, pair.memberTwoUserId),
            isNull(audioFileConnections.revokedAt)
          ))
          .limit(1);

        let connection = activeConnection;
        let reusedExisting = Boolean(activeConnection);

        if (!connection) {
          const [created] = await tx
            .insert(audioFileConnections)
            .values({
              memberOneUserId: pair.memberOneUserId,
              memberTwoUserId: pair.memberTwoUserId,
              createdByUserId: token.createdByUserId,
              createdFromPurpose: token.purpose,
              metadata: token.connectionLabel ? { connectionLabel: token.connectionLabel } : null
            })
            .returning();
          connection = created;
          reusedExisting = false;

          await tx.insert(audioFileConnectionEvents).values({
            connectionId: connection.id,
            actorUserId: input.claimingUserId,
            eventType: 'connected',
            pairingTokenId: token.id,
            metadata: { purpose: token.purpose, reusedExisting: false }
          });
        }

        const [consumed] = await tx
          .update(audioFilePairingTokens)
          .set({
            consumedAt: new Date(),
            consumedByUserId: input.claimingUserId,
            connectionId: connection.id,
            connectionMemberOneUserId: connection.memberOneUserId,
            connectionMemberTwoUserId: connection.memberTwoUserId
          })
          .where(and(
            eq(audioFilePairingTokens.id, token.id),
            isNull(audioFilePairingTokens.consumedAt),
            isNull(audioFilePairingTokens.revokedAt),
            gt(audioFilePairingTokens.expiresAt, new Date())
          ))
          .returning();

        if (!consumed) {
          throw auditableClaimDenial(
            new Error('This file connection QR has already been used.'),
            token.id,
            'concurrent_consumption_replay'
          );
        }

        await tx.insert(auditEvents).values({
          actorType: 'performer',
          actorId: input.claimingUserId,
          entityType: 'audio_file_connection',
          entityId: connection.id,
          eventType: 'audio_file_pairing.claim',
          previousStatus: null,
          nextStatus: null,
          metadata: {
            pairingTokenId: token.id,
            purpose: token.purpose,
            reusedExisting
          }
        });

        const counterpartyId = connection.memberOneUserId === input.claimingUserId
          ? connection.memberTwoUserId
          : connection.memberOneUserId;
        const counterparty = await resolveCreatorIdentity(counterpartyId);

        return {
          connectionId: connection.id,
          purpose: token.purpose,
          reusedExisting,
          connectedAt: connection.connectedAt.toISOString(),
          counterparty,
          grantsProjectAccess: false
        };
      });
    } catch (error) {
      const denial = error as PairingClaimDenial;
      if (denial.pairingTokenId) {
        await writeAudit(db, {
          actorId: input.claimingUserId,
          entityType: 'audio_file_pairing_token',
          entityId: denial.pairingTokenId,
          eventType: 'audio_file_pairing.claim_denied',
          metadata: { reason: denial.denialReason ?? 'claim_denied' }
        });
      }
      throw error;
    }
  }

  async function listConnections(input: { userId: string }) {
    const rows = await db
      .select()
      .from(audioFileConnections)
      .where(and(
        or(
          eq(audioFileConnections.memberOneUserId, input.userId),
          eq(audioFileConnections.memberTwoUserId, input.userId)
        ),
        isNull(audioFileConnections.revokedAt)
      ))
      .orderBy(desc(audioFileConnections.connectedAt));

    const results = [];
    for (const row of rows) {
      const otherUserId = row.memberOneUserId === input.userId ? row.memberTwoUserId : row.memberOneUserId;
      const other = await resolveCreatorIdentity(otherUserId);
      results.push({
        connectionId: row.id,
        purpose: row.createdFromPurpose,
        connectedAt: row.connectedAt.toISOString(),
        counterparty: other
      });
    }
    return results;
  }

  async function revokeConnection(input: {
    userId: string;
    connectionId: string;
    reason?: string | null;
  }) {
    return db.transaction(async (tx) => {
      const [connection] = await tx
        .select()
        .from(audioFileConnections)
        .where(and(
          eq(audioFileConnections.id, input.connectionId),
          isNull(audioFileConnections.revokedAt)
        ))
        .limit(1);
      if (!connection) {
        throw Object.assign(new Error('Connection not found.'), { status: 404 });
      }
      if (connection.memberOneUserId !== input.userId && connection.memberTwoUserId !== input.userId) {
        throw Object.assign(new Error('Only connection members can revoke.'), { status: 403 });
      }

      const revokedAt = new Date();
      const revocationReason = input.reason?.trim().slice(0, 240) || null;
      const [revoked] = await tx
        .update(audioFileConnections)
        .set({
          revokedAt,
          revokedByUserId: input.userId,
          revocationReason,
          updatedAt: revokedAt
        })
        .where(and(
          eq(audioFileConnections.id, input.connectionId),
          isNull(audioFileConnections.revokedAt)
        ))
        .returning();
      if (!revoked) {
        throw Object.assign(new Error('Connection not found.'), { status: 404 });
      }

      await tx
        .update(audioFileAccessGrants)
        .set({
          revokedAt,
          revokedByUserId: input.userId,
          revocationReason: revocationReason || 'File connection removed.'
        })
        .where(and(
          eq(audioFileAccessGrants.connectionId, revoked.id),
          isNull(audioFileAccessGrants.revokedAt)
        ));
      await tx.insert(audioFileConnectionEvents).values({
        connectionId: revoked.id,
        actorUserId: input.userId,
        eventType: 'connection_removed',
        metadata: { reason: revoked.revocationReason }
      });
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.userId,
        entityType: 'audio_file_connection',
        entityId: revoked.id,
        eventType: 'audio_file_pairing.connection_revoked',
        previousStatus: null,
        nextStatus: null,
        metadata: { cascadedFileGrantRevocation: true }
      });

      return { connectionId: revoked.id, revokedAt: revoked.revokedAt!.toISOString() };
    });
  }

  return {
    createPairingToken,
    previewPairingToken,
    claimPairingToken,
    listConnections,
    revokeConnection,
    hashPairingTokenForTests: hashAudioFilePairingToken,
    newIdempotencyKey: () => randomUUID()
  };
}

export type AudioFilePairingService = ReturnType<typeof createAudioFilePairingService>;
