import { and, eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import { createSwayDb, type SwayDb } from '../db/client';
import { clientPendingActions, idempotencyKeys } from '../db/schema';

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
const IDEMPOTENCY_TTL_HOURS = 48;

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
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'misuse' }
  | { kind: 'expired' };

function hashResponseBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? {}))
    .digest('hex');
}

function parseExpiresAt(expiresAt?: string | null) {
  if (!expiresAt) return new Date(Date.now() + PENDING_ACTION_TTL_MS);
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) return new Date(Date.now() + PENDING_ACTION_TTL_MS);
  return parsed;
}

export function createIdempotencyStore(databaseUrl?: string) {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;

  async function loadDurableActionRecord(idempotencyKey: string, intentFingerprint?: string): Promise<IdempotencyReplay> {
    if (!db) return { kind: 'new' };

    const existing = await db
      .select({
        intentFingerprint: idempotencyKeys.intentFingerprint,
        firstResponseStatus: idempotencyKeys.firstResponseStatus,
        firstResponseBody: idempotencyKeys.firstResponseBody,
        expiresAt: idempotencyKeys.expiresAt
      })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.idempotencyKey, idempotencyKey))
      .limit(1);

    if (!existing.length) return { kind: 'new' };

    const record = existing[0];
    if (intentFingerprint && record.intentFingerprint !== intentFingerprint) return { kind: 'misuse' };
    if (Date.now() > record.expiresAt.getTime()) return { kind: 'expired' };
    if (record.firstResponseStatus && record.firstResponseBody) {
      return { kind: 'replay', status: record.firstResponseStatus, body: record.firstResponseBody };
    }
    return { kind: 'new' };
  }

  async function reservePendingAction(input: DurableActionInput): Promise<IdempotencyReplay> {
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
      return { kind: 'new' };
    }

    await db.insert(clientPendingActions).values({
      clientRequestId: input.clientRequestId,
      idempotencyKey: input.idempotencyKey,
      gigId: input.gigId,
      actionType: input.actionType,
      payloadHash: input.payloadHash,
      expiresAt,
      lastAttemptAt: new Date(),
      attemptCount: 1,
      status: 'pending'
    }).onConflictDoUpdate({
      target: clientPendingActions.clientRequestId,
      set: {
        idempotencyKey: input.idempotencyKey,
        payloadHash: input.payloadHash,
        expiresAt,
        lastAttemptAt: new Date(),
        attemptCount: 1,
        status: 'pending',
        lastError: null
      }
    });

    await db.insert(idempotencyKeys).values({
      idempotencyKey: input.idempotencyKey,
      patronDeviceIdHash: input.patronDeviceIdHash,
      actorId: null,
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
    }).onConflictDoNothing();

    return { kind: 'new' };
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
      return { kind: 'new' };
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
      const replay = await loadDurableActionRecord(input.idempotencyKey, input.intentFingerprint);
      if (replay.kind === 'new') return { kind: 'replay', status: 202, body: { success: true, pending: true } };
      return replay;
    }

    return { kind: 'new' };
  }

  async function completePendingAction(input: {
    clientRequestId: string;
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

    await db.update(clientPendingActions)
      .set({
        status: 'reconciled',
        lastAttemptAt: new Date(),
        lastError: null
      })
      .where(and(
        eq(clientPendingActions.clientRequestId, input.clientRequestId),
        eq(clientPendingActions.idempotencyKey, input.idempotencyKey)
      ));
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

  async function reconcilePendingAction(input: { clientRequestId: string; idempotencyKey: string }) {
    if (!db) return { status: 'unavailable' as const };

    const rows = await db
      .select({
        pendingStatus: clientPendingActions.status,
        expiresAt: clientPendingActions.expiresAt,
        responseStatus: idempotencyKeys.firstResponseStatus,
        responseBody: idempotencyKeys.firstResponseBody
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
    if (Date.now() > row.expiresAt.getTime()) return { status: 'expired' as const };
    if (row.responseStatus && row.responseBody) {
      return { status: 'reconciled' as const, responseStatus: row.responseStatus, responseBody: row.responseBody };
    }
    return { status: row.pendingStatus };
  }

  return {
    hasDurableStore: Boolean(db),
    reservePendingAction,
    reserveDurableActorAction,
    completePendingAction,
    completeDurableActorAction,
    reconcilePendingAction
  };
}
