import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'crypto';
import { createSwayDb, type SwayDb } from '../db/client';
import { clientPendingActions, idempotencyKeys, payments, requestBoosts, requests } from '../db/schema';
import { hashPatronStatusReceipt, isPatronStatusReceipt } from './patron-status-receipt';

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
const PENDING_ACTION_LEASE_MS = 30 * 1000;
const PENDING_ACTION_OWNER_LEASE_MS = 15 * 1000;
const IDEMPOTENCY_TTL_HOURS = 48;

export type PendingActionOwner = {
  token: string;
  generation: number;
  leaseExpiresAt: Date;
};

type PendingActionOwnerResult =
  | { status: 'acquired'; owner: PendingActionOwner }
  | { status: 'busy'; retryAfterMs: number }
  | { status: 'missing' | 'expired' | 'reconciled' | 'unavailable' | 'misuse' };

function matchesPendingActionOwner(
  pending: { ownerToken: string | null; ownerGeneration: number; ownerLeaseExpiresAt?: Date | null } | undefined,
  owner: PendingActionOwner
) {
  return Boolean(
    pending
    && pending.ownerToken === owner.token
    && pending.ownerGeneration === owner.generation
    && Boolean(pending.ownerLeaseExpiresAt)
    && pending.ownerLeaseExpiresAt!.getTime() > Date.now()
  );
}

export type DurableActionInput = {
  clientRequestId: string;
  idempotencyKey: string;
  patronDeviceIdHash: string;
  actorId?: string | null;
  gigId: string;
  actionType: string;
  amountCents: number;
  currency: string;
  targetEntityType?: string | null;
  targetEntityId?: string | null;
  payloadHash: string;
  intentFingerprint: string;
  expiresAt?: string | null;
};

export type DurableActorActionInput = Omit<DurableActionInput, 'clientRequestId' | 'patronDeviceIdHash'> & {
  actorId: string;
  actorScope: string;
};

export type IdempotencyReplay =
  | { kind: 'new' }
  | { kind: 'pending' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'misuse' }
  | { kind: 'expired' };

type DurableActionExpectation = {
  intentFingerprint?: string;
  clientRequestId?: string;
  gigId?: string;
  actionType?: string;
  patronDeviceIdHash?: string;
};

function hashResponseBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? {}))
    .digest('hex');
}

function parseExpiresAt(expiresAt?: string | null) {
  const maximum = new Date(Date.now() + PENDING_ACTION_TTL_MS);
  if (!expiresAt) return maximum;
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) return maximum;
  // The client may shorten the recovery window, but it cannot extend the
  // server's financial uncertainty budget with an arbitrary future date.
  return parsed > maximum ? maximum : parsed;
}

export function createIdempotencyStore(databaseUrl?: string) {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;

  async function isDurableActionVisible(input: {
    idempotencyKey: string;
    actionType: string;
    clientRequestId?: string | null;
  }) {
    if (!db) return false;
    const [row] = input.actionType === 'boost'
      ? await db
        .select({ activatedAt: requestBoosts.activatedAt })
        .from(requestBoosts)
        .where(and(
          eq(requestBoosts.idempotencyKey, input.idempotencyKey),
          ...(input.clientRequestId ? [eq(requestBoosts.clientRequestId, input.clientRequestId)] : [])
        ))
        .limit(1)
      : await db
        .select({ activatedAt: requests.activatedAt })
        .from(requests)
        .where(and(
          eq(requests.idempotencyKey, input.idempotencyKey),
          ...(input.clientRequestId ? [eq(requests.clientRequestId, input.clientRequestId)] : [])
        ))
        .limit(1);
    return Boolean(row?.activatedAt);
  }

  async function loadDurableActionRecord(
    idempotencyKey: string,
    expected?: DurableActionExpectation
  ): Promise<IdempotencyReplay> {
    if (!db) return { kind: 'new' };

    const existing = await db
      .select({
        intentFingerprint: idempotencyKeys.intentFingerprint,
        firstResponseStatus: idempotencyKeys.firstResponseStatus,
        firstResponseBody: idempotencyKeys.firstResponseBody,
        expiresAt: idempotencyKeys.expiresAt,
        pendingExpiresAt: clientPendingActions.expiresAt,
        pendingCreatedAt: clientPendingActions.createdAt,
        pendingClientRequestId: clientPendingActions.clientRequestId,
        gigId: idempotencyKeys.gigId,
        actionType: idempotencyKeys.actionType,
        patronDeviceIdHash: idempotencyKeys.patronDeviceIdHash
      })
      .from(idempotencyKeys)
      .leftJoin(clientPendingActions, eq(clientPendingActions.idempotencyKey, idempotencyKeys.idempotencyKey))
      .where(eq(idempotencyKeys.idempotencyKey, idempotencyKey))
      .limit(1);

    if (!existing.length) return { kind: 'new' };

    const record = existing[0];
    if (
      (expected?.intentFingerprint && record.intentFingerprint !== expected.intentFingerprint)
      || (expected?.clientRequestId && record.pendingClientRequestId !== expected.clientRequestId)
      || (expected?.gigId && record.gigId !== expected.gigId)
      || (expected?.actionType && record.actionType !== expected.actionType)
      || (expected?.patronDeviceIdHash && record.patronDeviceIdHash !== expected.patronDeviceIdHash)
    ) {
      return { kind: 'misuse' };
    }
    if (Date.now() > record.expiresAt.getTime()) return { kind: 'expired' };
    if (record.firstResponseStatus && record.firstResponseBody) {
      return { kind: 'replay', status: record.firstResponseStatus, body: record.firstResponseBody };
    }
    const pendingDeadline = record.pendingExpiresAt
      ? Math.min(
          record.pendingExpiresAt.getTime(),
          (record.pendingCreatedAt?.getTime() ?? record.pendingExpiresAt.getTime()) + PENDING_ACTION_TTL_MS
        )
      : null;
    if (pendingDeadline !== null && Date.now() > pendingDeadline) {
      if (await isDurableActionVisible({
        idempotencyKey,
        actionType: record.actionType,
        clientRequestId: record.pendingClientRequestId
      })) return { kind: 'pending' };
      return { kind: 'expired' };
    }
    return { kind: 'pending' };
  }

  async function reservePendingAction(input: DurableActionInput): Promise<IdempotencyReplay> {
    if (!db) return { kind: 'new' };

    const expiresAt = parseExpiresAt(input.expiresAt);
    if (Date.now() > expiresAt.getTime()) return { kind: 'expired' };

    try {
      return await db.transaction(async (tx): Promise<IdempotencyReplay> => {
        // The idempotency row is the single-owner lock for patron actions.
        // Concurrent duplicates wait/replay. Do not reclaim an HTTP owner:
        // without a fencing token, a stale process could resume after a newer
        // caller terminalized the same action. Stable action/payment rows are
        // recovered by the worker and reconciliation path; a pre-row crash
        // remains pending until its truthful expiry.
        const inserted = await tx.insert(idempotencyKeys).values({
          idempotencyKey: input.idempotencyKey,
          patronDeviceIdHash: input.patronDeviceIdHash,
          actorId: input.actorId ?? null,
          sessionId: null,
          gigId: input.gigId,
          actionType: input.actionType,
          amountCents: input.amountCents,
          currency: input.currency,
          targetEntityType: input.targetEntityType ?? null,
          targetEntityId: input.targetEntityId ?? null,
          payloadHash: input.payloadHash,
          intentFingerprint: input.intentFingerprint,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600000)
        }).onConflictDoNothing().returning({ id: idempotencyKeys.id });

        if (!inserted.length) {
          const replay = await loadDurableActionRecord(input.idempotencyKey, {
            intentFingerprint: input.intentFingerprint,
            clientRequestId: input.clientRequestId,
            gigId: input.gigId,
            actionType: input.actionType,
            patronDeviceIdHash: input.patronDeviceIdHash
          });
          return replay.kind === 'new' ? { kind: 'pending' } : replay;
        }

        const pendingInserted = await tx.insert(clientPendingActions).values({
          clientRequestId: input.clientRequestId,
          idempotencyKey: input.idempotencyKey,
          gigId: input.gigId,
          actionType: input.actionType,
          payloadHash: input.payloadHash,
          expiresAt,
          lastAttemptAt: new Date(),
          attemptCount: 1,
          status: 'pending'
        }).onConflictDoNothing().returning({ id: clientPendingActions.id });

        if (!pendingInserted.length) {
          const [existingPending] = await tx
            .select({
              idempotencyKey: clientPendingActions.idempotencyKey,
              gigId: clientPendingActions.gigId,
              actionType: clientPendingActions.actionType,
              payloadHash: clientPendingActions.payloadHash
            })
            .from(clientPendingActions)
            .where(eq(clientPendingActions.clientRequestId, input.clientRequestId))
            .limit(1);
          if (
            !existingPending
            || existingPending.idempotencyKey !== input.idempotencyKey
            || existingPending.gigId !== input.gigId
            || existingPending.actionType !== input.actionType
            || existingPending.payloadHash !== input.payloadHash
          ) {
            throw new Error('client_request_identity_conflict');
          }
          return { kind: 'pending' };
        }

        return { kind: 'new' };
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'client_request_identity_conflict') {
        return { kind: 'misuse' };
      }
      throw error;
    }
  }

  async function reserveDurableActorAction(input: DurableActorActionInput): Promise<IdempotencyReplay> {
    if (!db) return { kind: 'new' };

    const expiresAt = parseExpiresAt(input.expiresAt);
    if (Date.now() > expiresAt.getTime()) return { kind: 'expired' };

    const existing = await db
      .select({
        intentFingerprint: idempotencyKeys.intentFingerprint,
        firstResponseStatus: idempotencyKeys.firstResponseStatus,
        firstResponseBody: idempotencyKeys.firstResponseBody,
        expiresAt: idempotencyKeys.expiresAt
      })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (existing.length) {
      const record = existing[0];
      if (record.intentFingerprint !== input.intentFingerprint) return { kind: 'misuse' };
      if (Date.now() > record.expiresAt.getTime()) return { kind: 'expired' };
      if (record.firstResponseStatus && record.firstResponseBody) {
        return { kind: 'replay', status: record.firstResponseStatus, body: record.firstResponseBody };
      }
      const now = new Date();
      const [reclaimed] = await db
        .update(idempotencyKeys)
        .set({ updatedAt: now })
        .where(and(
          eq(idempotencyKeys.idempotencyKey, input.idempotencyKey),
          eq(idempotencyKeys.intentFingerprint, input.intentFingerprint),
          isNull(idempotencyKeys.firstResponseStatus),
          lte(idempotencyKeys.updatedAt, new Date(now.getTime() - PENDING_ACTION_LEASE_MS))
        ))
        .returning({ id: idempotencyKeys.id });
      return reclaimed ? { kind: 'new' } : { kind: 'pending' };
    }

    const inserted = await db.insert(idempotencyKeys).values({
      idempotencyKey: input.idempotencyKey,
      patronDeviceIdHash: input.actorScope,
      actorId: input.actorId,
      sessionId: null,
      gigId: input.gigId,
      actionType: input.actionType,
      amountCents: input.amountCents,
      currency: input.currency,
      targetEntityType: input.targetEntityType ?? null,
      targetEntityId: input.targetEntityId ?? null,
      payloadHash: input.payloadHash,
      intentFingerprint: input.intentFingerprint,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600000)
    }).onConflictDoNothing().returning({ id: idempotencyKeys.id });

    if (!inserted.length) {
      const replay = await loadDurableActionRecord(input.idempotencyKey, {
        intentFingerprint: input.intentFingerprint
      });
      if (replay.kind === 'new') return { kind: 'pending' };
      return replay;
    }

    return { kind: 'new' };
  }

  async function claimPendingActionOwner(input: {
    clientRequestId: string;
    idempotencyKey: string;
    expected?: {
      gigId: string;
      actionType: 'request' | 'tip' | 'boost';
      patronDeviceIdHash: string;
      intentFingerprint?: string;
    };
  }): Promise<PendingActionOwnerResult> {
    if (!db) return { status: 'unavailable' };

    return db.transaction(async (tx): Promise<PendingActionOwnerResult> => {
      const [pending] = await tx
        .select({
          status: clientPendingActions.status,
          expiresAt: clientPendingActions.expiresAt,
          createdAt: clientPendingActions.createdAt,
          ownerLeaseExpiresAt: clientPendingActions.ownerLeaseExpiresAt,
          gigId: clientPendingActions.gigId,
          actionType: clientPendingActions.actionType,
          patronDeviceIdHash: idempotencyKeys.patronDeviceIdHash,
          intentFingerprint: idempotencyKeys.intentFingerprint
        })
        .from(clientPendingActions)
        .innerJoin(idempotencyKeys, eq(clientPendingActions.idempotencyKey, idempotencyKeys.idempotencyKey))
        .where(and(
          eq(clientPendingActions.clientRequestId, input.clientRequestId),
          eq(clientPendingActions.idempotencyKey, input.idempotencyKey)
        ))
        .for('update')
        .limit(1);
      if (!pending) return { status: 'missing' };
      if (
        input.expected
        && (
          pending.gigId !== input.expected.gigId
          || pending.actionType !== input.expected.actionType
          || pending.patronDeviceIdHash !== input.expected.patronDeviceIdHash
          || (
            input.expected.intentFingerprint !== undefined
            && pending.intentFingerprint !== input.expected.intentFingerprint
          )
        )
      ) return { status: 'misuse' };
      if (pending.status === 'reconciled') return { status: 'reconciled' };

      const now = new Date();
      const effectiveDeadline = Math.min(
        pending.expiresAt.getTime(),
        pending.createdAt.getTime() + PENDING_ACTION_TTL_MS
      );
      if (effectiveDeadline <= now.getTime()) return { status: 'expired' };
      if (pending.ownerLeaseExpiresAt && pending.ownerLeaseExpiresAt.getTime() > now.getTime()) {
        return {
          status: 'busy',
          retryAfterMs: pending.ownerLeaseExpiresAt.getTime() - now.getTime()
        };
      }

      const token = randomUUID();
      const leaseExpiresAt = new Date(Math.min(
        effectiveDeadline,
        now.getTime() + PENDING_ACTION_OWNER_LEASE_MS
      ));
      const [claimed] = await tx
        .update(clientPendingActions)
        .set({
          ownerToken: token,
          ownerGeneration: sql`${clientPendingActions.ownerGeneration} + 1`,
          ownerLeaseExpiresAt: leaseExpiresAt,
          lastAttemptAt: now,
          attemptCount: sql`${clientPendingActions.attemptCount} + 1`
        })
        .where(and(
          eq(clientPendingActions.clientRequestId, input.clientRequestId),
          eq(clientPendingActions.idempotencyKey, input.idempotencyKey),
          inArray(clientPendingActions.status, ['pending', 'retrying'])
        ))
        .returning({ generation: clientPendingActions.ownerGeneration });
      if (!claimed) return { status: 'reconciled' };
      return {
        status: 'acquired',
        owner: { token, generation: claimed.generation, leaseExpiresAt }
      };
    });
  }

  async function releasePendingActionOwner(input: {
    clientRequestId: string;
    idempotencyKey: string;
    owner: PendingActionOwner;
  }) {
    if (!db) return false;
    const released = await db
      .update(clientPendingActions)
      .set({ ownerToken: null, ownerLeaseExpiresAt: null })
      .where(and(
        eq(clientPendingActions.clientRequestId, input.clientRequestId),
        eq(clientPendingActions.idempotencyKey, input.idempotencyKey),
        eq(clientPendingActions.ownerToken, input.owner.token),
        eq(clientPendingActions.ownerGeneration, input.owner.generation)
      ))
      .returning({ id: clientPendingActions.id });
    return released.length === 1;
  }

  async function refreshPendingActionOwner(input: {
    clientRequestId: string;
    idempotencyKey: string;
    owner: PendingActionOwner;
  }): Promise<PendingActionOwner | null> {
    if (!db) return null;
    return db.transaction(async (tx) => {
      const [pending] = await tx
        .select({
          status: clientPendingActions.status,
          expiresAt: clientPendingActions.expiresAt,
          createdAt: clientPendingActions.createdAt,
          ownerToken: clientPendingActions.ownerToken,
          ownerGeneration: clientPendingActions.ownerGeneration,
          ownerLeaseExpiresAt: clientPendingActions.ownerLeaseExpiresAt
        })
        .from(clientPendingActions)
        .where(and(
          eq(clientPendingActions.clientRequestId, input.clientRequestId),
          eq(clientPendingActions.idempotencyKey, input.idempotencyKey)
        ))
        .for('update')
        .limit(1);
      if (
        !pending
        || !['pending', 'retrying'].includes(pending.status)
        || pending.ownerToken !== input.owner.token
        || pending.ownerGeneration !== input.owner.generation
      ) return null;
      const now = new Date();
      const effectiveDeadline = Math.min(
        pending.expiresAt.getTime(),
        pending.createdAt.getTime() + PENDING_ACTION_TTL_MS
      );
      if (effectiveDeadline <= now.getTime()) return null;
      const leaseExpiresAt = new Date(Math.min(
        effectiveDeadline,
        now.getTime() + PENDING_ACTION_OWNER_LEASE_MS
      ));
      const refreshed = await tx
        .update(clientPendingActions)
        .set({ ownerLeaseExpiresAt: leaseExpiresAt, lastAttemptAt: now })
        .where(and(
          eq(clientPendingActions.clientRequestId, input.clientRequestId),
          eq(clientPendingActions.idempotencyKey, input.idempotencyKey),
          eq(clientPendingActions.ownerToken, input.owner.token),
          eq(clientPendingActions.ownerGeneration, input.owner.generation)
        ))
        .returning({ id: clientPendingActions.id });
      if (refreshed.length !== 1) return null;
      return { ...input.owner, leaseExpiresAt };
    });
  }

  async function completePendingAction(input: {
    clientRequestId: string;
    idempotencyKey: string;
    gigId: string;
    actionType: 'request' | 'tip' | 'boost';
    receiptHash: string;
    status: number;
    body: unknown;
    owner?: PendingActionOwner;
  }) {
    if (!db) return { status: input.status, body: input.body, completed: true };

    const responseRecord = input.body && typeof input.body === 'object' && !Array.isArray(input.body)
      ? input.body as Record<string, unknown>
      : null;
    const responseReceipt = responseRecord?.patron_status_receipt;
    if (
      !isPatronStatusReceipt(responseReceipt)
      || hashPatronStatusReceipt(responseReceipt) !== input.receiptHash
    ) throw new Error('patron_status_receipt_response_mismatch');

    const responseBodyHash = hashResponseBody(input.body);

    return db.transaction(async (tx) => {
      const now = new Date();
      const [record] = await tx
        .select({
          gigId: idempotencyKeys.gigId,
          actionType: idempotencyKeys.actionType,
          firstResponseStatus: idempotencyKeys.firstResponseStatus,
          firstResponseBody: idempotencyKeys.firstResponseBody
        })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.idempotencyKey, input.idempotencyKey))
        .for('update')
        .limit(1);
      if (
        !record
        || record.gigId !== input.gigId
        || record.actionType !== input.actionType
      ) throw new Error('pending_action_completion_identity_conflict');

      // Exactly one caller owns the patron receipt and first response. Any
      // concurrent original request or reconciliation poll replays that
      // canonical pair rather than rotating the action hash underneath it.
      if (record.firstResponseStatus && record.firstResponseBody) {
        return {
          status: record.firstResponseStatus,
          body: record.firstResponseBody,
          completed: false
        };
      }

      const [pendingOwner] = await tx
        .select({
          ownerToken: clientPendingActions.ownerToken,
          ownerGeneration: clientPendingActions.ownerGeneration,
          ownerLeaseExpiresAt: clientPendingActions.ownerLeaseExpiresAt
        })
        .from(clientPendingActions)
        .where(and(
          eq(clientPendingActions.clientRequestId, input.clientRequestId),
          eq(clientPendingActions.idempotencyKey, input.idempotencyKey)
        ))
        .for('update')
        .limit(1);
      if (
        input.owner
        && !matchesPendingActionOwner(pendingOwner, input.owner)
      ) throw new Error('pending_action_owner_fenced');

      const updatedAction = input.actionType === 'boost'
        ? await tx
          .update(requestBoosts)
          .set({
            runtimeBoostState: sql`jsonb_set(coalesce(${requestBoosts.runtimeBoostState}, '{}'::jsonb), '{patronStatusReceiptHash}', to_jsonb(${input.receiptHash}::text), true)`,
            stateRevision: sql`${requestBoosts.stateRevision} + 1`,
            updatedAt: now
          })
          .where(and(
            eq(requestBoosts.gigId, input.gigId),
            eq(requestBoosts.clientRequestId, input.clientRequestId),
            eq(requestBoosts.idempotencyKey, input.idempotencyKey),
            isNotNull(requestBoosts.activatedAt)
          ))
          .returning({ id: requestBoosts.id })
        : await tx
          .update(requests)
          .set({
            runtimeRequestState: sql`jsonb_set(coalesce(${requests.runtimeRequestState}, '{}'::jsonb), '{patronStatusReceiptHash}', to_jsonb(${input.receiptHash}::text), true)`,
            stateRevision: sql`${requests.stateRevision} + 1`,
            updatedAt: now
          })
          .where(and(
            eq(requests.gigId, input.gigId),
            eq(requests.clientRequestId, input.clientRequestId),
            eq(requests.idempotencyKey, input.idempotencyKey),
            isNotNull(requests.activatedAt)
          ))
          .returning({ id: requests.id });
      if (updatedAction.length !== 1) throw new Error('active_pending_action_not_found');

      const completed = await tx.update(idempotencyKeys)
        .set({
          firstResponseStatus: input.status,
          firstResponseBody: input.body,
          firstResponseBodyHash: responseBodyHash,
          updatedAt: now
        })
        .where(and(
          eq(idempotencyKeys.idempotencyKey, input.idempotencyKey),
          isNull(idempotencyKeys.firstResponseStatus)
        ))
        .returning({ id: idempotencyKeys.id });
      if (completed.length !== 1) throw new Error('pending_action_completion_conflict');

      await tx.update(clientPendingActions)
        .set({
          status: 'reconciled',
          ownerToken: null,
          ownerLeaseExpiresAt: null,
          lastAttemptAt: now,
          lastError: null
        })
        .where(and(
          eq(clientPendingActions.clientRequestId, input.clientRequestId),
          eq(clientPendingActions.idempotencyKey, input.idempotencyKey)
        ));

      return { status: input.status, body: input.body, completed: true };
    });
  }

  async function completeDurableActorAction(input: {
    idempotencyKey: string;
    status: number;
    body: unknown;
  }) {
    if (!db) return;

    const responseBodyHash = hashResponseBody(input.body);

    await db.update(idempotencyKeys)
      .set({
        firstResponseStatus: input.status,
        firstResponseBody: input.body,
        firstResponseBodyHash: responseBodyHash,
        updatedAt: new Date()
      })
      .where(eq(idempotencyKeys.idempotencyKey, input.idempotencyKey));
  }

  async function fencePendingActionFailure(input: {
    clientRequestId: string;
    idempotencyKey: string;
    gigId: string;
    actionType: 'request' | 'tip' | 'boost';
    owner: PendingActionOwner;
  }) {
    if (!db) return { status: 'unavailable' as const };
    return db.transaction(async (tx) => {
      const now = new Date();
      const [pending] = await tx
        .select({
          id: clientPendingActions.id,
          gigId: clientPendingActions.gigId,
          actionType: clientPendingActions.actionType,
          status: clientPendingActions.status,
          ownerToken: clientPendingActions.ownerToken,
          ownerGeneration: clientPendingActions.ownerGeneration,
          ownerLeaseExpiresAt: clientPendingActions.ownerLeaseExpiresAt
        })
        .from(clientPendingActions)
        .where(and(
          eq(clientPendingActions.clientRequestId, input.clientRequestId),
          eq(clientPendingActions.idempotencyKey, input.idempotencyKey)
        ))
        .for('update')
        .limit(1);
      if (
        !pending
        || pending.gigId !== input.gigId
        || pending.actionType !== input.actionType
      ) throw new Error('pending_action_completion_identity_conflict');
      if (!matchesPendingActionOwner(pending, input.owner)) {
        throw new Error('pending_action_owner_fenced');
      }
      if (pending.status === 'reconciled') return { status: 'reconciled' as const };

      const [action] = input.actionType === 'boost'
        ? await tx
          .select({ id: requestBoosts.id, activatedAt: requestBoosts.activatedAt, status: requestBoosts.status })
          .from(requestBoosts)
          .where(and(
            eq(requestBoosts.gigId, input.gigId),
            eq(requestBoosts.clientRequestId, input.clientRequestId),
            eq(requestBoosts.idempotencyKey, input.idempotencyKey)
          ))
          .for('update')
          .limit(1)
        : await tx
          .select({ id: requests.id, activatedAt: requests.activatedAt, status: requests.status })
          .from(requests)
          .where(and(
            eq(requests.gigId, input.gigId),
            eq(requests.clientRequestId, input.clientRequestId),
            eq(requests.idempotencyKey, input.idempotencyKey)
          ))
          .for('update')
          .limit(1);
      if (action?.activatedAt) return { status: 'already_visible' as const };
      if (action && !['payment_pending', 'denied'].includes(action.status)) {
        throw new Error('pending_action_terminal_state_conflict');
      }
      if (action?.status === 'payment_pending') {
        const fenced = input.actionType === 'boost'
          ? await tx
            .update(requestBoosts)
            .set({
              status: 'denied',
              stateRevision: sql`${requestBoosts.stateRevision} + 1`,
              updatedAt: now
            })
            .where(and(
              eq(requestBoosts.id, action.id),
              eq(requestBoosts.status, 'payment_pending'),
              isNull(requestBoosts.activatedAt)
            ))
            .returning({ id: requestBoosts.id })
          : await tx
            .update(requests)
            .set({
              status: 'denied',
              stateRevision: sql`${requests.stateRevision} + 1`,
              updatedAt: now
            })
            .where(and(
              eq(requests.id, action.id),
              eq(requests.status, 'payment_pending'),
              isNull(requests.activatedAt)
            ))
            .returning({ id: requests.id });
        if (fenced.length !== 1) throw new Error('pending_action_terminal_state_conflict');
      }

      await tx
        .update(clientPendingActions)
        .set({
          status: 'retrying',
          lastAttemptAt: now,
          lastError: 'payment_reversal_pending'
        })
        .where(eq(clientPendingActions.id, pending.id));
      return { status: 'fenced' as const };
    });
  }

  async function completePendingActionFailure(input: {
    clientRequestId: string;
    idempotencyKey: string;
    gigId: string;
    actionType: 'request' | 'tip' | 'boost';
    status: number;
    body: unknown;
    owner?: PendingActionOwner;
  }) {
    if (!db) return { status: input.status, body: input.body, completed: true };

    const responseBodyHash = hashResponseBody(input.body);
    return db.transaction(async (tx) => {
      const now = new Date();
      const [record] = await tx
        .select({
          gigId: idempotencyKeys.gigId,
          actionType: idempotencyKeys.actionType,
          firstResponseStatus: idempotencyKeys.firstResponseStatus,
          firstResponseBody: idempotencyKeys.firstResponseBody
        })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.idempotencyKey, input.idempotencyKey))
        .for('update')
        .limit(1);
      if (
        !record
        || record.gigId !== input.gigId
        || record.actionType !== input.actionType
      ) throw new Error('pending_action_completion_identity_conflict');
      if (record.firstResponseStatus && record.firstResponseBody) {
        return {
          status: record.firstResponseStatus,
          body: record.firstResponseBody,
          completed: false
        };
      }

      const [pendingAction] = await tx
        .select({
          clientRequestId: clientPendingActions.clientRequestId,
          gigId: clientPendingActions.gigId,
          actionType: clientPendingActions.actionType,
          ownerToken: clientPendingActions.ownerToken,
          ownerGeneration: clientPendingActions.ownerGeneration,
          ownerLeaseExpiresAt: clientPendingActions.ownerLeaseExpiresAt
        })
        .from(clientPendingActions)
        .where(eq(clientPendingActions.idempotencyKey, input.idempotencyKey))
        .for('update')
        .limit(1);
      if (
        !pendingAction
        || pendingAction.clientRequestId !== input.clientRequestId
        || pendingAction.gigId !== input.gigId
        || pendingAction.actionType !== input.actionType
      ) throw new Error('pending_action_completion_identity_conflict');
      if (
        input.owner
        && !matchesPendingActionOwner(pendingAction, input.owner)
      ) throw new Error('pending_action_owner_fenced');

      const [action] = input.actionType === 'boost'
        ? await tx
          .select({ id: requestBoosts.id, activatedAt: requestBoosts.activatedAt, status: requestBoosts.status })
          .from(requestBoosts)
          .where(and(
            eq(requestBoosts.gigId, input.gigId),
            eq(requestBoosts.clientRequestId, input.clientRequestId),
            eq(requestBoosts.idempotencyKey, input.idempotencyKey)
          ))
          .for('update')
          .limit(1)
        : await tx
          .select({ id: requests.id, activatedAt: requests.activatedAt, status: requests.status })
          .from(requests)
          .where(and(
            eq(requests.gigId, input.gigId),
            eq(requests.clientRequestId, input.clientRequestId),
            eq(requests.idempotencyKey, input.idempotencyKey)
          ))
          .for('update')
          .limit(1);
      if (action?.activatedAt) throw new Error('pending_action_already_visible');
      if (action && !['payment_pending', 'denied'].includes(action.status)) {
        throw new Error('pending_action_terminal_state_conflict');
      }

      // Fence both direct activation and a worker that selected this row just
      // before terminal provider truth arrived. Missing action rows are valid
      // for admission/cap failures that happen after the idempotency owner is
      // established but before a business row is inserted.
      if (action?.status === 'payment_pending') {
        const terminalizedAction = input.actionType === 'boost'
          ? await tx
            .update(requestBoosts)
            .set({
              status: 'denied',
              stateRevision: sql`${requestBoosts.stateRevision} + 1`,
              updatedAt: now
            })
            .where(and(
              eq(requestBoosts.id, action.id),
              eq(requestBoosts.status, 'payment_pending'),
              isNull(requestBoosts.activatedAt)
            ))
            .returning({ id: requestBoosts.id })
          : await tx
            .update(requests)
            .set({
              status: 'denied',
              stateRevision: sql`${requests.stateRevision} + 1`,
              updatedAt: now
            })
            .where(and(
              eq(requests.id, action.id),
              eq(requests.status, 'payment_pending'),
              isNull(requests.activatedAt)
            ))
            .returning({ id: requests.id });
        if (terminalizedAction.length !== 1) throw new Error('pending_action_terminal_state_conflict');
      }

      const completed = await tx
        .update(idempotencyKeys)
        .set({
          firstResponseStatus: input.status,
          firstResponseBody: input.body,
          firstResponseBodyHash: responseBodyHash,
          updatedAt: now
        })
        .where(and(
          eq(idempotencyKeys.idempotencyKey, input.idempotencyKey),
          isNull(idempotencyKeys.firstResponseStatus)
        ))
        .returning({ id: idempotencyKeys.id });
      if (completed.length !== 1) throw new Error('pending_action_completion_conflict');

      await tx
        .update(clientPendingActions)
        .set({
          status: 'reconciled',
          ownerToken: null,
          ownerLeaseExpiresAt: null,
          lastAttemptAt: now,
          lastError: null
        })
        .where(and(
          eq(clientPendingActions.clientRequestId, input.clientRequestId),
          eq(clientPendingActions.idempotencyKey, input.idempotencyKey)
        ));

      return { status: input.status, body: input.body, completed: true };
    });
  }

  async function expireStalePendingActions(input: { limit?: number } = {}) {
    if (!db) return {
      inspected: 0,
      fenced: 0,
      terminalized: 0,
      financiallyBlocked: 0,
      financiallyBlockedPaymentIds: [] as string[]
    };
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit) || 25)));
    const now = new Date();
    const candidates = await db
      .select({
        clientRequestId: clientPendingActions.clientRequestId,
        idempotencyKey: clientPendingActions.idempotencyKey,
        gigId: clientPendingActions.gigId,
        actionType: clientPendingActions.actionType
      })
      .from(clientPendingActions)
      .where(and(
        inArray(clientPendingActions.status, ['pending', 'retrying']),
        or(
          lte(clientPendingActions.expiresAt, now),
          lte(clientPendingActions.createdAt, new Date(now.getTime() - PENDING_ACTION_TTL_MS))
        )
      ))
      .limit(limit);

    let fenced = 0;
    let terminalized = 0;
    const financiallyBlockedPaymentIds: string[] = [];
    for (const candidate of candidates) {
      const fencedAction = await db.transaction(async (tx) => {
        const [pending] = await tx
          .select({
            id: clientPendingActions.id,
            status: clientPendingActions.status,
            expiresAt: clientPendingActions.expiresAt,
            createdAt: clientPendingActions.createdAt
          })
          .from(clientPendingActions)
          .where(and(
            eq(clientPendingActions.clientRequestId, candidate.clientRequestId),
            eq(clientPendingActions.idempotencyKey, candidate.idempotencyKey)
          ))
          .for('update')
          .limit(1);
        if (!pending || !['pending', 'retrying'].includes(pending.status)) return null;
        const effectiveDeadline = Math.min(
          pending.expiresAt.getTime(),
          pending.createdAt.getTime() + PENDING_ACTION_TTL_MS
        );
        if (effectiveDeadline > Date.now()) return null;

        const [action] = candidate.actionType === 'boost'
          ? await tx
            .select({
              id: requestBoosts.id,
              activatedAt: requestBoosts.activatedAt,
              status: requestBoosts.status
            })
            .from(requestBoosts)
            .where(and(
              eq(requestBoosts.gigId, candidate.gigId),
              eq(requestBoosts.clientRequestId, candidate.clientRequestId),
              eq(requestBoosts.idempotencyKey, candidate.idempotencyKey)
            ))
            .for('update')
            .limit(1)
          : await tx
            .select({
              id: requests.id,
              activatedAt: requests.activatedAt,
              status: requests.status
            })
            .from(requests)
            .where(and(
              eq(requests.gigId, candidate.gigId),
              eq(requests.clientRequestId, candidate.clientRequestId),
              eq(requests.idempotencyKey, candidate.idempotencyKey)
            ))
            .for('update')
            .limit(1);
        if (action?.activatedAt) return null;

        if (action?.status === 'payment_pending') {
          const fencedRows = candidate.actionType === 'boost'
            ? await tx
              .update(requestBoosts)
              .set({
                status: 'denied',
                stateRevision: sql`${requestBoosts.stateRevision} + 1`,
                updatedAt: now
              })
              .where(and(
                eq(requestBoosts.id, action.id),
                eq(requestBoosts.status, 'payment_pending'),
                isNull(requestBoosts.activatedAt)
              ))
              .returning({ id: requestBoosts.id })
            : await tx
              .update(requests)
              .set({
                status: 'denied',
                stateRevision: sql`${requests.stateRevision} + 1`,
                updatedAt: now
              })
              .where(and(
                eq(requests.id, action.id),
                eq(requests.status, 'payment_pending'),
                isNull(requests.activatedAt)
              ))
              .returning({ id: requests.id });
          if (fencedRows.length !== 1) return null;
        } else if (action && action.status !== 'denied') {
          return null;
        }

        const [payment] = !action
          ? []
          : candidate.actionType === 'boost'
            ? await tx
              .select({
                id: payments.id,
                paymentStatus: payments.paymentStatus,
                processorPaymentIntentId: payments.processorPaymentIntentId
              })
              .from(payments)
              .where(eq(payments.requestBoostId, action.id))
              .for('update')
              .limit(1)
            : await tx
              .select({
                id: payments.id,
                paymentStatus: payments.paymentStatus,
                processorPaymentIntentId: payments.processorPaymentIntentId
              })
              .from(payments)
              .where(eq(payments.requestId, action.id))
              .for('update')
              .limit(1);

        await tx
          .update(clientPendingActions)
          .set({
            status: 'retrying',
            ownerToken: null,
            ownerGeneration: sql`${clientPendingActions.ownerGeneration} + 1`,
            ownerLeaseExpiresAt: null,
            lastAttemptAt: now,
            lastError: payment ? 'expired_payment_reversal_pending' : 'expired_before_payment_creation'
          })
          .where(eq(clientPendingActions.id, pending.id));

        return { action, payment: payment ?? null };
      });

      if (!fencedAction) continue;
      fenced += 1;
      const payment = fencedAction.payment;
      const financiallyTerminal = !payment
        || ['voided', 'refunded'].includes(payment.paymentStatus)
        || (payment.paymentStatus === 'failed' && !payment.processorPaymentIntentId);
      if (!financiallyTerminal) {
        financiallyBlockedPaymentIds.push(payment!.id);
        continue;
      }

      try {
        const completed = await completePendingActionFailure({
          clientRequestId: candidate.clientRequestId,
          idempotencyKey: candidate.idempotencyKey,
          gigId: candidate.gigId,
          actionType: candidate.actionType === 'boost'
            ? 'boost'
            : candidate.actionType === 'tip'
              ? 'tip'
              : 'request',
          status: 410,
          body: {
            success: false,
            terminal: true,
            expired: true,
            payment_status: payment?.paymentStatus === 'voided' || payment?.paymentStatus === 'refunded'
              ? 'voided_or_refunded'
              : 'not_created',
            error: 'Pending action expired before confirmation was completed.'
          }
        });
        if (completed.completed) terminalized += 1;
      } catch (error) {
        if (!(error instanceof Error) || ![
          'pending_action_already_visible',
          'pending_action_completion_conflict'
        ].includes(error.message)) throw error;
      }
    }

    return {
      inspected: candidates.length,
      fenced,
      terminalized,
      financiallyBlocked: financiallyBlockedPaymentIds.length,
      financiallyBlockedPaymentIds
    };
  }

  async function reconcilePendingAction(input: { clientRequestId: string; idempotencyKey: string }) {
    if (!db) return { status: 'unavailable' as const };

    const rows = await db
      .select({
        pendingStatus: clientPendingActions.status,
        gigId: clientPendingActions.gigId,
        actionType: clientPendingActions.actionType,
        expiresAt: clientPendingActions.expiresAt,
        createdAt: clientPendingActions.createdAt,
        idempotencyExpiresAt: idempotencyKeys.expiresAt
      })
      .from(clientPendingActions)
      .leftJoin(idempotencyKeys, eq(clientPendingActions.idempotencyKey, idempotencyKeys.idempotencyKey))
      .where(and(
        eq(clientPendingActions.clientRequestId, input.clientRequestId),
        eq(clientPendingActions.idempotencyKey, input.idempotencyKey)
      ))
      .limit(1);

    if (!rows.length) return { status: 'missing' as const };
    const row = rows[0];
    if (row.idempotencyExpiresAt && Date.now() > row.idempotencyExpiresAt.getTime()) return { status: 'expired' as const };
    if (row.pendingStatus === 'reconciled') {
      return { status: 'reconciled' as const, gigId: row.gigId, actionType: row.actionType };
    }
    const effectiveDeadline = Math.min(
      row.expiresAt.getTime(),
      row.createdAt.getTime() + PENDING_ACTION_TTL_MS
    );
    if (Date.now() > effectiveDeadline) {
      if (await isDurableActionVisible({
        idempotencyKey: input.idempotencyKey,
        actionType: row.actionType,
        clientRequestId: input.clientRequestId
      })) return { status: row.pendingStatus, gigId: row.gigId, actionType: row.actionType };
      return { status: 'expired' as const };
    }
    return { status: row.pendingStatus, gigId: row.gigId, actionType: row.actionType };
  }

  return {
    hasDurableStore: Boolean(db),
    loadDurableActionRecord,
    reservePendingAction,
    reserveDurableActorAction,
    completePendingAction,
    fencePendingActionFailure,
    completePendingActionFailure,
    expireStalePendingActions,
    completeDurableActorAction,
    reconcilePendingAction,
    claimPendingActionOwner,
    releasePendingActionOwner,
    refreshPendingActionOwner
  };
}
