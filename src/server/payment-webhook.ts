import type { PaymentProviderAdapter } from './payment-provider';
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
  'transfer.paid': 'paid_out',
  'transfer.paid_out': 'paid_out',
  'payment_intent.canceled': 'voided'
};

export function mapProviderEventToPaymentState(providerType: string): PaymentState | null {
  return providerEventToPaymentState[providerType] ?? null;
}

/**
 * Stripe webhook ingestion. Signature verification is mandatory: events without
 * a verified `Stripe-Signature` header are rejected before any state change.
 * The payment is resolved from the verified provider PaymentIntent id, never from
 * client-supplied identifiers.
 */
export function createPaymentWebhookService({
  databaseUrl,
  provider
}: {
  databaseUrl?: string;
  provider: PaymentProviderAdapter;
}) {
  const service = createPaymentService({ databaseUrl, provider });

  async function ingestWebhook(input: {
    rawBody: string;
    signatureHeader: string | null;
  }) {
    if (!input.signatureHeader) {
      throw new Error('Webhook signature verification is required: signature header missing.');
    }

    const isValidSignature = await provider.verifyWebhookSignature({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader
    });

    if (!isValidSignature) {
      throw new Error('Webhook signature verification failed.');
    }

    const providerEvent = await provider.parseWebhookEvent({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader
    });

    const mappedState = mapProviderEventToPaymentState(providerEvent.providerType);
    if (!mappedState) {
      return { status: 'ignored' as const };
    }

    if (!providerEvent.processorPaymentIntentId) {
      return { status: 'unresolved' as const };
    }

    const paymentId = await service.resolvePaymentIdByIntent(providerEvent.processorPaymentIntentId);
    if (!paymentId) {
      return { status: 'unresolved' as const };
    }

    return service.transitionPaymentState({
      paymentId,
      processor: provider.processor,
      nextStatus: mappedState,
      eventType: providerEvent.providerType,
      processorEventId: providerEvent.providerEventId,
      actorType: 'provider_webhook',
      allowOutOfOrderNoop: true,
      metadata: {
        providerPayload: providerEvent.metadata ?? {},
        processorPaymentIntentId: providerEvent.processorPaymentIntentId ?? null,
        processorChargeId: providerEvent.processorChargeId ?? null
      }
    });
  }

  return {
    hasDurableStore: service.hasDurableStore,
    ingestWebhook
  };
}
