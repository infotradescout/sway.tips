import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { createSwayDb, type SwayDb } from '../db/client';
import { clientPendingActions, idempotencyKeys, requestBoosts, requests } from '../db/schema';
import { hashPatronStatusReceipt, isPatronStatusReceipt } from './patron-status-receipt';

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
const PENDING_ACTION_LEASE_MS = 30 * 1000;
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
  | { kind: 'pending' }
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
        expiresAt: idempotencyKeys.expiresAt,
        pendingExpiresAt: clientPendingActions.expiresAt
      })
      .from(idempotencyKeys)
      .leftJoin(clientPendingActions, eq(clientPendingActions.idempotencyKey, idempotencyKeys.idempotencyKey))
      .where(eq(idempotencyKeys.idempotencyKey, idempotencyKey))
      .limit(1);

    if (!existing.length) return { kind: 'new' };

    const record = existing[0];
    if (intentFingerprint && record.intentFingerprint !== intentFingerprint) return { kind: 'misuse' };
    if (Date.now() > record.expiresAt.getTime()) return { kind: 'expired' };
    if (record.firstResponseStatus && record.firstResponseBody) {
      return { kind: 'replay', status: record.firstResponseStatus, body: record.firstResponseBody };
    }
    if (record.pendingExpiresAt && Date.now() > record.pendingExpiresAt.getTime()) return { kind: 'expired' };
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
          const replay = await loadDurableActionRecord(input.idempotencyKey, input.intentFingerprint);
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
      const replay = await loadDurableActionRecord(input.idempotencyKey, input.intentFingerprint);
      if (replay.kind === 'new') return { kind: 'pending' };
      return replay;
    }

    return { kind: 'new' };
  }

  async function completePendingAction(input: {
    clientRequestId: string;
    idempotencyKey: string;
    gigId: string;
    actionType: 'request' | 'tip' | 'boost';
    receiptHash: string;
    status: number;
    body: unknown;
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

  async function completePendingActionFailure(input: {
    clientRequestId: string;
    idempotencyKey: string;
    gigId: string;
    actionType: 'request' | 'tip' | 'boost';
    status: number;
    body: unknown;
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
          actionType: clientPendingActions.actionType
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
      if (action && action.status !== 'payment_pending') {
        throw new Error('pending_action_terminal_state_conflict');
      }

      // Fence both direct activation and a worker that selected this row just
      // before terminal provider truth arrived. Missing action rows are valid
      // for admission/cap failures that happen after the idempotency owner is
      // established but before a business row is inserted.
      if (action) {
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

  async function reconcilePendingAction(input: { clientRequestId: string; idempotencyKey: string }) {
    if (!db) return { status: 'unavailable' as const };

    const rows = await db
      .select({
        pendingStatus: clientPendingActions.status,
        gigId: clientPendingActions.gigId,
        actionType: clientPendingActions.actionType,
        expiresAt: clientPendingActions.expiresAt,
        idempotencyExpiresAt: idempotencyKeys.expiresAt,
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
    if (row.idempotencyExpiresAt && Date.now() > row.idempotencyExpiresAt.getTime()) return { status: 'expired' as const };
    if (row.responseStatus && row.responseBody) {
      return { status: 'reconciled' as const, responseStatus: row.responseStatus, responseBody: row.responseBody };
    }
    if (Date.now() > row.expiresAt.getTime()) return { status: 'expired' as const };
    return { status: row.pendingStatus, gigId: row.gigId, actionType: row.actionType };
  }

  return {
    hasDurableStore: Boolean(db),
    loadDurableActionRecord,
    reservePendingAction,
    reserveDurableActorAction,
    completePendingAction,
    completePendingActionFailure,
    completeDurableActorAction,
    reconcilePendingAction
  };
}
