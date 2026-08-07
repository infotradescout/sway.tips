import { createHash, randomUUID } from 'crypto';
import { and, asc, eq, inArray, lte, ne, or } from 'drizzle-orm';
import { createSwayDb } from '../db/client';
import { liveRoomProcessorEvents, payments } from '../db/schema';
import type { PaymentProviderAdapter, ProviderWebhookEnvelope } from './payment-provider';
import type { PaymentState } from './payment-lifecycle';
import { createPaymentService } from './payment-service';

const providerEventToPaymentState: Record<string, PaymentState> = {
  'payment_intent.requires_action': 'payment_pending',
  'payment_intent.amount_capturable_updated': 'authorized',
  'payment_intent.succeeded': 'captured',
  'charge.captured': 'captured',
  'charge.refunded': 'refunded',
  'charge.failed': 'failed',
  'payment_intent.payment_failed': 'failed',
  'charge.dispute.created': 'disputed',
  'charge.dispute.opened': 'disputed',
  'payment_intent.canceled': 'voided'
};

const EVENT_LEASE_MS = 30_000;

export function mapProviderEventToPaymentState(providerType: string): PaymentState | null {
  return providerEventToPaymentState[providerType] ?? null;
}

function payloadHash(rawBody: string) {
  return createHash('sha256').update(rawBody).digest('hex');
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1_000) : 'unknown_webhook_error';
}

function retryAt(attemptCount: number) {
  const seconds = Math.min(300, Math.max(2, 2 ** Math.min(attemptCount, 8)));
  return new Date(Date.now() + seconds * 1_000);
}

function minimizedPayload(event: ProviderWebhookEnvelope): Record<string, unknown> {
  return {
    processorPaymentIntentId: event.processorPaymentIntentId ?? null,
    processorChargeId: event.processorChargeId ?? null,
    providerStatus: event.providerStatus ?? null,
    amountCents: event.amountCents ?? null,
    amountRefundedCents: event.amountRefundedCents ?? null,
    fullyRefunded: event.fullyRefunded ?? null,
    metadata: event.metadata ?? {}
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function recordString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Verified live-room processor events are durably received before a 2xx is
 * returned. Resolution and state transition are leased/retryable, so an early,
 * duplicated, delayed, or temporarily unresolved webhook is not discarded.
 */
export function createPaymentWebhookService({
  databaseUrl,
  provider,
  hooks,
  expectedLivemode = false
}: {
  databaseUrl?: string;
  provider: PaymentProviderAdapter;
  hooks?: {
    afterClaim?: (event: typeof liveRoomProcessorEvents.$inferSelect) => Promise<void>;
  };
  /** Must match STRIPE_SECRET_KEY mode: false for sk_test_, true for sk_live_. */
  expectedLivemode?: boolean;
}) {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;
  const service = createPaymentService({ databaseUrl, provider });

  function assertLivemodeMatch(livemode: boolean, context: string) {
    if (livemode !== expectedLivemode) {
      throw new Error(
        livemode
          ? `${context}: live-mode Stripe event received while Sway is configured for test keys.`
          : `${context}: test-mode Stripe event received while Sway is configured for live keys.`
      );
    }
  }

  async function receiveVerifiedEvent(rawBody: string, event: ProviderWebhookEnvelope) {
    if (!db) throw new Error('Durable webhook inbox is unavailable.');
    const hash = payloadHash(rawBody);
    const [created] = await db
      .insert(liveRoomProcessorEvents)
      .values({
        processor: provider.processor,
        processorEventId: event.providerEventId,
        eventType: event.providerType,
        payloadSha256: hash,
        payload: minimizedPayload(event),
        livemode: event.livemode
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { row: created, duplicate: false };

    const [existing] = await db
      .select()
      .from(liveRoomProcessorEvents)
      .where(and(
        eq(liveRoomProcessorEvents.processor, provider.processor),
        eq(liveRoomProcessorEvents.processorEventId, event.providerEventId)
      ))
      .limit(1);
    if (!existing) throw new Error('Verified webhook could not be persisted.');
    if (existing.payloadSha256 !== hash || existing.eventType !== event.providerType) {
      throw new Error('Processor event id was reused with a different signed payload.');
    }
    return { row: existing, duplicate: true };
  }

  async function claimEvent(eventId?: string) {
    if (!db) return null;
    return db.transaction(async (tx) => {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - EVENT_LEASE_MS);
      const [row] = await tx
        .select()
        .from(liveRoomProcessorEvents)
        .where(and(
          ...(eventId ? [eq(liveRoomProcessorEvents.id, eventId)] : []),
          lte(liveRoomProcessorEvents.nextAttemptAt, now),
          or(
            inArray(liveRoomProcessorEvents.status, ['pending', 'retryable_failed']),
            and(
              eq(liveRoomProcessorEvents.status, 'processing'),
              lte(liveRoomProcessorEvents.processingStartedAt, staleBefore)
            )
          )
        ))
        .orderBy(asc(liveRoomProcessorEvents.nextAttemptAt), asc(liveRoomProcessorEvents.receivedAt))
        .for('update', { skipLocked: true })
        .limit(1);
      if (!row) return null;
      const processingLeaseOwner = `live-room-webhook:${process.pid}:${randomUUID()}`;
      const [claimed] = await tx
        .update(liveRoomProcessorEvents)
        .set({
          status: 'processing',
          attemptCount: row.attemptCount + 1,
          processingStartedAt: now,
          processingLeaseOwner,
          lastError: null
        })
        .where(eq(liveRoomProcessorEvents.id, row.id))
        .returning();
      return claimed ?? null;
    });
  }

  async function markProcessed(event: typeof liveRoomProcessorEvents.$inferSelect, input: {
    status: 'processed' | 'ignored';
    paymentId?: string | null;
  }) {
    if (!db || !event.processingLeaseOwner) return false;
    const updated = await db
      .update(liveRoomProcessorEvents)
      .set({
        status: input.status,
        paymentId: input.paymentId ?? null,
        processingStartedAt: null,
        processingLeaseOwner: null,
        processedAt: new Date(),
        lastError: null
      })
      .where(and(
        eq(liveRoomProcessorEvents.id, event.id),
        eq(liveRoomProcessorEvents.status, 'processing'),
        eq(liveRoomProcessorEvents.processingLeaseOwner, event.processingLeaseOwner)
      ))
      .returning({ id: liveRoomProcessorEvents.id });
    return updated.length === 1;
  }

  async function markFailed(
    event: typeof liveRoomProcessorEvents.$inferSelect,
    error: unknown,
    input: { terminal?: boolean } = {}
  ) {
    if (!db || !event.processingLeaseOwner) return false;
    const terminal = input.terminal === true || event.attemptCount >= 20;
    const updated = await db
      .update(liveRoomProcessorEvents)
      .set({
        status: terminal ? 'terminal_failed' : 'retryable_failed',
        processingStartedAt: null,
        processingLeaseOwner: null,
        nextAttemptAt: retryAt(event.attemptCount),
        lastError: safeError(error)
      })
      .where(and(
        eq(liveRoomProcessorEvents.id, event.id),
        eq(liveRoomProcessorEvents.status, 'processing'),
        eq(liveRoomProcessorEvents.processingLeaseOwner, event.processingLeaseOwner)
      ))
      .returning({ id: liveRoomProcessorEvents.id });
    return updated.length === 1;
  }

  async function processClaimedEvent(event: typeof liveRoomProcessorEvents.$inferSelect) {
    if (!db) throw new Error('Durable webhook inbox is unavailable.');
    assertLivemodeMatch(event.livemode, 'processClaimedEvent');
    const mappedState = mapProviderEventToPaymentState(event.eventType);
    if (!mappedState) {
      await markProcessed(event, { status: 'ignored' });
      return { status: 'ignored' as const };
    }

    const payload = asRecord(event.payload);
    const metadata = asRecord(payload.metadata);
    const processorPaymentIntentId = recordString(payload.processorPaymentIntentId);
    const processorChargeId = recordString(payload.processorChargeId);
    const metadataPaymentId = recordString(metadata.sway_payment_id);
    if (!processorPaymentIntentId && !metadataPaymentId) {
      throw new Error('Verified payment event has no resolvable payment identity.');
    }

    const paymentId = await service.resolvePaymentIdByIntent(
      processorPaymentIntentId ?? '',
      metadataPaymentId
    );
    if (!paymentId) throw new Error('Verified payment event arrived before its payment record.');

    const [payment] = await db
      .select({
        processorPaymentIntentId: payments.processorPaymentIntentId,
        processorChargeId: payments.processorChargeId,
        amountTotal: payments.amountTotal,
        paymentStatus: payments.paymentStatus,
        refundStatus: payments.refundStatus
      })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    if (!payment) throw new Error('Verified payment event resolved to a missing payment.');
    if (
      payment.processorPaymentIntentId
      && processorPaymentIntentId
      && payment.processorPaymentIntentId !== processorPaymentIntentId
    ) throw new Error('Verified payment event identity conflicts with the stored PaymentIntent.');

    // Bind provider identity before refund convergence. A refund can be the
    // first webhook we see after an authorize/capture response was lost, and
    // the durable reverse operation needs the PaymentIntent identity to
    // retrieve provider truth rather than waiting for a predecessor event.
    await db
      .update(payments)
      .set({
        processorPaymentIntentId: payment.processorPaymentIntentId ?? processorPaymentIntentId,
        processorChargeId: payment.processorChargeId ?? processorChargeId,
        updatedAt: new Date()
      })
      .where(eq(payments.id, paymentId));

    if (mappedState === 'refunded') {
      const eventAmountCents = Number(payload.amountCents);
      const amountRefundedCents = Number(payload.amountRefundedCents);
      const eventProvesFullRefund = (
        payload.fullyRefunded !== true
        || !Number.isFinite(eventAmountCents)
        || !Number.isFinite(amountRefundedCents)
        || eventAmountCents !== payment.amountTotal
        || amountRefundedCents < payment.amountTotal
      ) === false;
      if (payment.paymentStatus !== 'refunded') {
        await db
          .update(payments)
          .set({ refundStatus: 'pending', updatedAt: new Date() })
          .where(and(
            eq(payments.id, paymentId),
            ne(payments.paymentStatus, 'refunded'),
            ne(payments.refundStatus, 'refunded')
          ));

        // Reconcile every refund from current provider truth, including a full
        // refund delivered before its capture predecessor. For partial refunds,
        // the same durable reverse operation refunds the remaining destination
        // charge and application fee so accounting has one terminal policy.
        const reversal = await service.voidOrRefund(paymentId);
        if (!['noop', 'refunded'].includes(reversal.status)) {
          throw new Error(eventProvesFullRefund
            ? 'Full refund provider truth is still pending convergence.'
            : 'Partial refund detected; full reversal is still pending.');
        }
      }

      const [converged] = await db
        .select({ paymentStatus: payments.paymentStatus, refundStatus: payments.refundStatus })
        .from(payments)
        .where(eq(payments.id, paymentId))
        .limit(1);
      if (converged?.paymentStatus !== 'refunded' || converged.refundStatus !== 'refunded') {
        throw new Error(eventProvesFullRefund
          ? 'Full refund provider truth is still pending convergence.'
          : 'Partial refund detected; full reversal is still pending.');
      }
    }

    const transition = await service.transitionPaymentState({
      paymentId,
      processor: provider.processor,
      nextStatus: mappedState,
      eventType: event.eventType,
      processorEventId: event.processorEventId,
      actorType: 'provider_webhook',
      allowOutOfOrderNoop: true,
      allowProviderTruthRecovery: true,
      metadata: {
        providerPayload: payload,
        processorPaymentIntentId,
        processorChargeId
      }
    });
    if (transition.status === 'missing' || transition.status === 'unavailable') {
      throw new Error(`Payment webhook transition ${transition.status}.`);
    }
    if (transition.status === 'ignored_out_of_order' || transition.status === 'concurrent_noop') {
      throw new Error(`Payment webhook transition ${transition.status}; retry after predecessor state.`);
    }
    if (mappedState === 'refunded') {
      await db
        .update(payments)
        .set({ refundStatus: 'refunded', updatedAt: new Date() })
        .where(eq(payments.id, paymentId));
    }
    if (mappedState === 'authorized' && processorPaymentIntentId) {
      await service.recordAuthorizationFromWebhook(paymentId, processorPaymentIntentId, recordString(payload.providerStatus));
    }
    await markProcessed(event, { status: 'processed', paymentId });
    return { status: 'processed' as const, paymentId, transition };
  }

  async function processEvent(eventId?: string) {
    const event = await claimEvent(eventId);
    if (!event) return { status: 'not_claimed' as const };
    try {
      await hooks?.afterClaim?.(event);
      return await processClaimedEvent(event);
    } catch (error) {
      await markFailed(event, error);
      return { status: 'accepted_pending' as const, reason: safeError(error) };
    }
  }

  async function ingestWebhook(input: {
    rawBody: string;
    signatureHeader: string | null;
  }) {
    if (!input.signatureHeader) {
      throw new Error('Webhook signature verification is required: signature header missing.');
    }
    const isValidSignature = await provider.verifyWebhookSignature(input);
    if (!isValidSignature) {
      throw new Error('Webhook signature verification failed.');
    }
    const providerEvent = await provider.parseWebhookEvent(input);
    const received = await receiveVerifiedEvent(input.rawBody, providerEvent);
    try {
      assertLivemodeMatch(received.row.livemode, 'ingestWebhook');
    } catch (error) {
      const claimed = await claimEvent(received.row.id);
      if (claimed) {
        await markFailed(claimed, error, { terminal: true });
      }
      throw error;
    }
    if (['processed', 'ignored'].includes(received.row.status)) {
      return { status: 'duplicate' as const };
    }
    return processEvent(received.row.id);
  }

  async function runDueEvents(input: { limit?: number } = {}) {
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit) || 25)));
    const result = { claimed: 0, processed: 0, pending: 0 };
    for (let index = 0; index < limit; index += 1) {
      const outcome = await processEvent();
      if (outcome.status === 'not_claimed') break;
      result.claimed += 1;
      if (outcome.status === 'processed' || outcome.status === 'ignored') result.processed += 1;
      else result.pending += 1;
    }
    return result;
  }

  return {
    hasDurableStore: service.hasDurableStore,
    ingestWebhook,
    runDueEvents
  };
}
