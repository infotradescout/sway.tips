import { and, eq } from 'drizzle-orm';
import { createSwayDb } from '../db/client';
import { auditEvents, paymentEvents, payments, paymentStatusEnum, performers } from '../db/schema';

export type PaymentState = (typeof paymentStatusEnum.enumValues)[number];

const paymentTransitionGraph: Record<PaymentState, ReadonlyArray<PaymentState>> = {
  created: ['payment_pending', 'failed', 'voided'],
  payment_pending: ['authorized', 'failed', 'voided'],
  authorized: ['captured', 'voided', 'failed', 'refunded'],
  captured: ['refunded', 'disputed', 'paid_out'],
  voided: [],
  refunded: [],
  failed: [],
  disputed: ['refunded', 'paid_out'],
  // Destination-charge refunds can occur after funds were paid out; Stripe's
  // full refund truth must still supersede the earlier payout terminal.
  paid_out: ['refunded', 'disputed']
};

const providerTruthRecoveryTransitions: Partial<Record<PaymentState, ReadonlyArray<PaymentState>>> = {
  failed: ['payment_pending', 'authorized', 'captured', 'voided']
};

export function isFinitePaymentState(input: string): input is PaymentState {
  return paymentStatusEnum.enumValues.includes(input as PaymentState);
}

export function canTransitionPaymentState(from: PaymentState, to: PaymentState): boolean {
  return paymentTransitionGraph[from].includes(to);
}

export function isKnownPredecessorPaymentState(candidate: PaymentState, current: PaymentState): boolean {
  if (candidate === current) return false;
  const pending = [candidate];
  const visited = new Set<PaymentState>();

  while (pending.length) {
    const state = pending.shift()!;
    if (visited.has(state)) continue;
    visited.add(state);
    const nextStates = [
      ...paymentTransitionGraph[state],
      ...(providerTruthRecoveryTransitions[state] ?? [])
    ];
    if (nextStates.includes(current)) return true;
    pending.push(...nextStates.filter((nextState) => !visited.has(nextState)));
  }

  return false;
}

export function assertPaymentTransition(from: PaymentState, to: PaymentState) {
  if (!canTransitionPaymentState(from, to)) {
    throw new Error(`Invalid payment transition: ${from} -> ${to}`);
  }
}

export type TransitionPaymentInput = {
  paymentId: string;
  processor: string;
  nextStatus: PaymentState;
  eventType: string;
  processorEventId?: string | null;
  actorType: 'system' | 'provider_webhook' | 'operator';
  actorId?: string | null;
  metadata?: Record<string, unknown>;
  allowOutOfOrderNoop?: boolean;
  allowProviderTruthRecovery?: boolean;
};

export function createPaymentLifecycleService(databaseUrl?: string) {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;

  async function transitionPaymentState(input: TransitionPaymentInput) {
    if (!db) {
      return { status: 'unavailable' as const };
    }

    // Every payment mutation follows one global lock order: performer first,
    // then payment. Withdrawals use the same order before calculating an
    // available balance, so a refund/dispute cannot race a cash-out snapshot.
    const [identity] = await db.select({ performerId: payments.performerId })
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1);
    if (!identity) return { status: 'missing' as const };

    return db.transaction(async (tx) => {
      const [performer] = await tx.select({ id: performers.id })
        .from(performers)
        .where(eq(performers.id, identity.performerId))
        .for('update')
        .limit(1);
      if (!performer) return { status: 'missing' as const };

      const [current] = await tx.select({
        performerId: payments.performerId,
        paymentStatus: payments.paymentStatus
      })
        .from(payments)
        .where(eq(payments.id, input.paymentId))
        .for('update')
        .limit(1);
      if (!current || current.performerId !== performer.id) return { status: 'missing' as const };

      if (input.processorEventId) {
        const duplicateRows = await tx
          .select({
            paymentId: paymentEvents.paymentId,
            previousStatus: paymentEvents.previousStatus,
            nextStatus: paymentEvents.nextStatus
          })
          .from(paymentEvents)
          .where(eq(paymentEvents.processorEventId, input.processorEventId))
          .limit(1);

        if (duplicateRows.length) {
          return {
            status: 'duplicate_event' as const,
            previousStatus: duplicateRows[0].previousStatus,
            nextStatus: duplicateRows[0].nextStatus
          };
        }
      }

      const previousStatus = current.paymentStatus;
      if (previousStatus === input.nextStatus) {
        return {
          status: 'noop_current_state' as const,
          previousStatus,
          nextStatus: input.nextStatus
        };
      }

      const providerTruthRecovery = input.allowProviderTruthRecovery === true
        && (providerTruthRecoveryTransitions[previousStatus] ?? []).includes(input.nextStatus);
      if (!canTransitionPaymentState(previousStatus, input.nextStatus) && !providerTruthRecovery) {
        if (input.allowOutOfOrderNoop) {
          return {
            status: 'ignored_out_of_order' as const,
            previousStatus,
            nextStatus: input.nextStatus
          };
        }
        assertPaymentTransition(previousStatus, input.nextStatus);
      }

      const updatedRows = await tx
        .update(payments)
        .set({
          paymentStatus: input.nextStatus,
          updatedAt: new Date()
        })
        .where(and(
          eq(payments.id, input.paymentId),
          eq(payments.paymentStatus, previousStatus)
        ))
        .returning({ id: payments.id });

      if (!updatedRows.length) {
        return {
          status: 'concurrent_noop' as const,
          previousStatus,
          nextStatus: input.nextStatus
        };
      }

      await tx.insert(paymentEvents).values({
        paymentId: input.paymentId,
        processor: input.processor,
        processorEventId: input.processorEventId ?? null,
        eventType: input.eventType,
        previousStatus,
        nextStatus: input.nextStatus,
        payload: input.metadata ?? {}
      });

      await tx.insert(auditEvents).values({
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        entityType: 'payment',
        entityId: input.paymentId,
        eventType: `payment.${input.eventType}`,
        previousStatus,
        nextStatus: input.nextStatus,
        metadata: {
          processor: input.processor,
          processorEventId: input.processorEventId ?? null,
          ...(input.metadata ?? {})
        }
      });

      return {
        status: 'transitioned' as const,
        previousStatus,
        nextStatus: input.nextStatus
      };
    });
  }

  async function markRefundPending(input: {
    paymentId: string;
    processor: string;
    actorType: 'system' | 'provider_webhook' | 'operator';
    actorId?: string | null;
    source: string;
  }) {
    if (!db) return { status: 'unavailable' as const };
    const [identity] = await db.select({ performerId: payments.performerId })
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1);
    if (!identity) return { status: 'missing' as const };

    return db.transaction(async (tx) => {
      const [performer] = await tx.select({ id: performers.id })
        .from(performers)
        .where(eq(performers.id, identity.performerId))
        .for('update')
        .limit(1);
      if (!performer) return { status: 'missing' as const };
      const [payment] = await tx.select({
        performerId: payments.performerId,
        paymentStatus: payments.paymentStatus,
        refundStatus: payments.refundStatus
      })
        .from(payments)
        .where(eq(payments.id, input.paymentId))
        .for('update')
        .limit(1);
      if (!payment || payment.performerId !== performer.id) return { status: 'missing' as const };
      if (payment.paymentStatus === 'refunded' || payment.refundStatus === 'refunded') {
        return { status: 'already_refunded' as const };
      }
      if (payment.refundStatus === 'pending') return { status: 'already_pending' as const };

      await tx.update(payments).set({ refundStatus: 'pending', updatedAt: new Date() })
        .where(eq(payments.id, input.paymentId));
      await tx.insert(auditEvents).values({
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        entityType: 'payment',
        entityId: input.paymentId,
        eventType: 'payment.refund.pending',
        previousStatus: payment.paymentStatus,
        nextStatus: payment.paymentStatus,
        metadata: { processor: input.processor, source: input.source }
      });
      return { status: 'updated' as const };
    });
  }

  return {
    hasDurableStore: Boolean(db),
    canTransitionPaymentState,
    transitionPaymentState,
    markRefundPending
  };
}
