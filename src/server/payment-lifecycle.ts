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
};

export function createPaymentLifecycleService(databaseUrl?: string) {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;

  async function transitionPaymentState(input: TransitionPaymentInput) {
    if (!db) {
      return { status: 'unavailable' as const };
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
    assertPaymentTransition(previousStatus, input.nextStatus);

    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({
          paymentStatus: input.nextStatus,
          updatedAt: new Date()
        })
        .where(and(
          eq(payments.id, input.paymentId),
          eq(payments.paymentStatus, previousStatus)
        ));

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
    });

    return {
      status: 'transitioned' as const,
      previousStatus,
      nextStatus: input.nextStatus
    };
  }

  return {
    hasDurableStore: Boolean(db),
    canTransitionPaymentState,
    transitionPaymentState
  };
}