import { and, asc, eq, gt, inArray, lte, ne, or } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { createSwayDb } from '../db/client';
import { liveRoomPaymentOperations, payments } from '../db/schema';

type OperationRow = typeof liveRoomPaymentOperations.$inferSelect;
type OperationType = OperationRow['operationType'];

const LEASE_MS = 30_000;
export const CURRENT_LIVE_ROOM_POSITIVE_EXECUTOR_GENERATION = 1;

function retryAt(attemptCount: number) {
  const seconds = Math.min(300, Math.max(2, 2 ** Math.min(attemptCount, 8)));
  return new Date(Date.now() + seconds * 1_000);
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1_000) : 'unknown_operation_error';
}

export function createLiveRoomPaymentOperationStore(databaseUrl?: string) {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;

  async function enqueue(input: {
    paymentId: string;
    gigId: string;
    performerId: string;
    requestId?: string | null;
    requestBoostId?: string | null;
    operationType: OperationType;
    processor: string;
    idempotencyKey: string;
    destinationAccountId: string;
    requestPayload: Record<string, unknown>;
  }) {
    if (!db) return null;
    const [created] = await db
      .insert(liveRoomPaymentOperations)
      .values({
        paymentId: input.paymentId,
        gigId: input.gigId,
        performerId: input.performerId,
        requestId: input.requestId ?? null,
        requestBoostId: input.requestBoostId ?? null,
        operationType: input.operationType,
        processor: input.processor,
        idempotencyKey: input.idempotencyKey,
        destinationAccountId: input.destinationAccountId,
        requestPayload: input.requestPayload
      })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [existing] = await db
      .select()
      .from(liveRoomPaymentOperations)
      .where(eq(liveRoomPaymentOperations.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!existing) throw new Error('live_room_payment_operation_conflict');
    if (
      existing.paymentId !== input.paymentId
      || existing.gigId !== input.gigId
      || existing.performerId !== input.performerId
      || existing.requestId !== (input.requestId ?? null)
      || existing.requestBoostId !== (input.requestBoostId ?? null)
      || existing.operationType !== input.operationType
      || existing.destinationAccountId !== input.destinationAccountId
    ) {
      throw new Error('live_room_payment_operation_identity_conflict');
    }
    if (existing.status === 'terminal_failed' && input.operationType === 'reverse') {
      const [revived] = await db
        .update(liveRoomPaymentOperations)
        .set({
          status: 'retryable_failed',
          attemptCount: 0,
          availableAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseExecutorGeneration: null,
          completedAt: null,
          lastError: 'reversal_reopened_for_provider_truth_reconciliation',
          updatedAt: new Date()
        })
        .where(and(
          eq(liveRoomPaymentOperations.id, existing.id),
          eq(liveRoomPaymentOperations.status, 'terminal_failed')
        ))
        .returning();
      return revived ?? existing;
    }
    return existing;
  }

  async function claim(workerId: string, operationId?: string): Promise<OperationRow | null> {
    if (!db) return null;
    return db.transaction(async (tx) => {
      const now = new Date();
      const candidates = await tx
        .select()
        .from(liveRoomPaymentOperations)
        .where(and(
          ...(operationId ? [eq(liveRoomPaymentOperations.id, operationId)] : []),
          lte(liveRoomPaymentOperations.availableAt, now),
          or(
            inArray(liveRoomPaymentOperations.status, ['pending', 'retryable_failed']),
            and(
              eq(liveRoomPaymentOperations.status, 'leased'),
              lte(liveRoomPaymentOperations.leaseExpiresAt, now)
            )
          )
        ))
        .orderBy(asc(liveRoomPaymentOperations.availableAt), asc(liveRoomPaymentOperations.id))
        .for('update', { skipLocked: true })
        .limit(operationId ? 1 : 25);
      for (const operation of candidates) {
        const positiveOperation = operation.operationType === 'authorize' || operation.operationType === 'capture';
        if (
          positiveOperation
          && operation.minimumExecutorGeneration > CURRENT_LIVE_ROOM_POSITIVE_EXECUTOR_GENERATION
        ) continue;
        // Serialize every operation for one payment through the payment row.
        // If this payment already has a live sibling lease, keep scanning so
        // one blocked payment cannot starve unrelated rooms or customers.
        await tx
          .select({ id: payments.id })
          .from(payments)
          .where(eq(payments.id, operation.paymentId))
          .for('update')
          .limit(1);
        const [leasedSibling] = await tx
          .select({ id: liveRoomPaymentOperations.id })
          .from(liveRoomPaymentOperations)
          .where(and(
            eq(liveRoomPaymentOperations.paymentId, operation.paymentId),
            eq(liveRoomPaymentOperations.status, 'leased'),
            ne(liveRoomPaymentOperations.id, operation.id),
            gt(liveRoomPaymentOperations.leaseExpiresAt, now)
          ))
          .limit(1);
        if (leasedSibling) continue;
        const leaseToken = `${workerId}:${randomUUID()}`;
        const [leased] = await tx
          .update(liveRoomPaymentOperations)
          .set({
            status: 'leased',
            attemptCount: operation.attemptCount + 1,
            leaseOwner: leaseToken,
            leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
            leaseExecutorGeneration: positiveOperation
              ? CURRENT_LIVE_ROOM_POSITIVE_EXECUTOR_GENERATION
              : null,
            lastAttemptAt: now,
            lastError: null,
            updatedAt: now
          })
          .where(eq(liveRoomPaymentOperations.id, operation.id))
          .returning();
        if (leased) return leased;
      }
      return null;
    });
  }

  async function markAwaitingCustomer(operation: OperationRow, input: {
    processorObjectId: string;
    resultPayload: Record<string, unknown>;
  }) {
    if (!db || !operation.leaseOwner) return;
    await db
      .update(liveRoomPaymentOperations)
      .set({
        status: 'awaiting_customer',
        processorObjectId: input.processorObjectId,
        resultPayload: input.resultPayload,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseExecutorGeneration: null,
        lastError: null,
        updatedAt: new Date()
      })
      .where(and(
        eq(liveRoomPaymentOperations.id, operation.id),
        eq(liveRoomPaymentOperations.status, 'leased'),
        eq(liveRoomPaymentOperations.leaseOwner, operation.leaseOwner)
      ));
  }

  async function markSucceeded(operation: OperationRow, input: {
    processorObjectId?: string | null;
    resultPayload: Record<string, unknown>;
  }) {
    if (!db || !operation.leaseOwner) return;
    const now = new Date();
    await db
      .update(liveRoomPaymentOperations)
      .set({
        status: 'succeeded',
        processorObjectId: input.processorObjectId ?? null,
        resultPayload: input.resultPayload,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseExecutorGeneration: null,
        lastError: null,
        completedAt: now,
        updatedAt: now
      })
      .where(and(
        eq(liveRoomPaymentOperations.id, operation.id),
        eq(liveRoomPaymentOperations.status, 'leased'),
        eq(liveRoomPaymentOperations.leaseOwner, operation.leaseOwner)
      ));
  }

  async function markAuthorizeSucceeded(paymentId: string, input: {
    processorObjectId: string;
    resultPayload: Record<string, unknown>;
  }) {
    if (!db) return;
    const now = new Date();
    await db
      .update(liveRoomPaymentOperations)
      .set({
        status: 'succeeded',
        processorObjectId: input.processorObjectId,
        resultPayload: input.resultPayload,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseExecutorGeneration: null,
        lastError: null,
        completedAt: now,
        updatedAt: now
      })
      .where(and(
        eq(liveRoomPaymentOperations.paymentId, paymentId),
        eq(liveRoomPaymentOperations.operationType, 'authorize'),
        inArray(liveRoomPaymentOperations.status, ['awaiting_customer', 'pending', 'retryable_failed', 'leased'])
      ));
  }

  async function markFailed(
    operation: OperationRow,
    error: unknown,
    terminal = false,
    neverTerminal = false
  ) {
    if (!db || !operation.leaseOwner) return false;
    const now = new Date();
    const shouldTerminate = !neverTerminal && (terminal || operation.attemptCount >= operation.maxAttempts);
    const updated = await db
      .update(liveRoomPaymentOperations)
      .set({
        status: shouldTerminate ? 'terminal_failed' : 'retryable_failed',
        availableAt: retryAt(operation.attemptCount),
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseExecutorGeneration: null,
        lastError: safeError(error),
        completedAt: shouldTerminate ? now : null,
        updatedAt: now
      })
      .where(and(
        eq(liveRoomPaymentOperations.id, operation.id),
        eq(liveRoomPaymentOperations.status, 'leased'),
        eq(liveRoomPaymentOperations.leaseOwner, operation.leaseOwner)
      ))
      .returning({ id: liveRoomPaymentOperations.id });
    return shouldTerminate && updated.length === 1;
  }

  async function supersedePendingCaptureForCloseout(paymentId: string) {
    if (!db) return;
    const now = new Date();
    await db
      .update(liveRoomPaymentOperations)
      .set({
        status: 'terminal_failed',
        completedAt: now,
        lastError: 'capture_superseded_by_room_closeout',
        updatedAt: now
      })
      .where(and(
        eq(liveRoomPaymentOperations.paymentId, paymentId),
        eq(liveRoomPaymentOperations.operationType, 'capture'),
        inArray(liveRoomPaymentOperations.status, ['pending', 'retryable_failed'])
      ));
  }

  async function prepareAuthorizationForCloseout(paymentId: string) {
    if (!db) return { status: 'unavailable' as const };
    return db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(liveRoomPaymentOperations)
        .where(and(
          eq(liveRoomPaymentOperations.paymentId, paymentId),
          eq(liveRoomPaymentOperations.operationType, 'authorize')
        ))
        .for('update')
        .limit(1);
      if (!operation) return { status: 'missing' as const };
      await tx
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .for('update')
        .limit(1);
      const now = new Date();
      if (
        operation.status === 'leased'
        && operation.leaseExpiresAt
        && operation.leaseExpiresAt > now
      ) return { status: 'in_flight' as const };
      if (['awaiting_customer', 'succeeded'].includes(operation.status)) {
        return { status: 'provider_known' as const, operationId: operation.id };
      }
      if (operation.attemptCount > 0) {
        const [reopened] = await tx
          .update(liveRoomPaymentOperations)
          .set({
            status: 'retryable_failed',
            attemptCount: Math.min(operation.attemptCount, operation.maxAttempts - 1),
            availableAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
            leaseExecutorGeneration: null,
            completedAt: null,
            lastError: 'authorization_reopened_for_closeout_reconciliation',
            updatedAt: now
          })
          .where(eq(liveRoomPaymentOperations.id, operation.id))
          .returning({ id: liveRoomPaymentOperations.id });
        return reopened
          ? { status: 'reconcile' as const, operationId: reopened.id }
          : { status: 'in_flight' as const };
      }
      if (!['pending', 'retryable_failed', 'terminal_failed'].includes(operation.status)) {
        return { status: 'in_flight' as const };
      }
      await tx
        .update(liveRoomPaymentOperations)
        .set({
          status: 'terminal_failed',
          completedAt: now,
          lastError: 'authorization_canceled_by_room_closeout',
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseExecutorGeneration: null,
          updatedAt: now
        })
        .where(eq(liveRoomPaymentOperations.id, operation.id));
      return { status: 'canceled' as const };
    });
  }

  async function load(operationId: string) {
    if (!db) return null;
    const [row] = await db
      .select()
      .from(liveRoomPaymentOperations)
      .where(eq(liveRoomPaymentOperations.id, operationId))
      .limit(1);
    return row ?? null;
  }

  return {
    hasDurableStore: Boolean(db),
    enqueue,
    claim,
    load,
    markAwaitingCustomer,
    markSucceeded,
    markAuthorizeSucceeded,
    markFailed,
    supersedePendingCaptureForCloseout,
    prepareAuthorizationForCloseout
  };
}

export type LiveRoomPaymentOperationStore = ReturnType<typeof createLiveRoomPaymentOperationStore>;
