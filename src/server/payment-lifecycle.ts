import { and, eq } from 'drizzle-orm';
import { createSwayDb } from '../db/client';
import { auditEvents, paymentEvents, payments, paymentStatusEnum } from '../db/schema';

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
  paid_out: []
};

export function isFinitePaymentState(input: string): input is PaymentState {
  return paymentStatusEnum.enumValues.includes(input as PaymentState);
}

export function canTransitionPaymentState(from: PaymentState, to: PaymentState): boolean {
  return paymentTransitionGraph[from].includes(to);
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
};

export function createPaymentLifecycleService(databaseUrl?: string) {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;

  async function transitionPaymentState(input: TransitionPaymentInput) {
    if (!db) {
      return { status: 'unavailable' as const };
    }

    if (input.processorEventId) {
      const duplicateRows = await db
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

    const currentRows = await db
      .select({
        id: payments.id,
        paymentStatus: payments.paymentStatus
      })
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .limit(1);

    if (!currentRows.length) {
      return { status: 'missing' as const };
    }

    const previousStatus = currentRows[0].paymentStatus;
    if (previousStatus === input.nextStatus) {
      return {
        status: 'noop_current_state' as const,
        previousStatus,
        nextStatus: input.nextStatus
      };
    }

    if (!canTransitionPaymentState(previousStatus, input.nextStatus)) {
      if (input.allowOutOfOrderNoop) {
        return {
          status: 'ignored_out_of_order' as const,
          previousStatus,
          nextStatus: input.nextStatus
        };
      }
      assertPaymentTransition(previousStatus, input.nextStatus);
    }

    return db.transaction(async (tx) => {
      if (input.processorEventId) {
        const duplicateRows = await tx
          .select({ paymentId: paymentEvents.paymentId })
          .from(paymentEvents)
          .where(eq(paymentEvents.processorEventId, input.processorEventId))
          .limit(1);

        if (duplicateRows.length) {
          return {
            status: 'duplicate_event' as const,
            previousStatus,
            nextStatus: input.nextStatus
          };
        }
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

  return {
    hasDurableStore: Boolean(db),
    canTransitionPaymentState,
    transitionPaymentState
  };
}
