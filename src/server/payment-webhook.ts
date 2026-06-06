import type { PaymentProviderAdapter } from './payment-provider';
import type { PaymentState } from './payment-lifecycle';
import { createPaymentLifecycleService } from './payment-lifecycle';

const providerEventToPaymentState: Record<string, PaymentState> = {
  'payment.intent.requires_action': 'payment_pending',
  'payment.intent.succeeded': 'authorized',
  'charge.captured': 'captured',
  'charge.refunded': 'refunded',
  'charge.failed': 'failed',
  'charge.dispute.opened': 'disputed',
  'transfer.paid_out': 'paid_out',
  'payment.intent.canceled': 'voided'
};

export function mapProviderEventToPaymentState(providerType: string): PaymentState | null {
  return providerEventToPaymentState[providerType] ?? null;
}

export function createPaymentWebhookService({
  databaseUrl,
  provider
}: {
  databaseUrl?: string;
  provider: PaymentProviderAdapter;
}) {
  const lifecycle = createPaymentLifecycleService(databaseUrl);

  async function ingestWebhook(input: {
    paymentId: string;
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

    const providerEvent = await provider.parseWebhookEvent({ rawBody: input.rawBody });
    const mappedState = mapProviderEventToPaymentState(providerEvent.providerType);
    if (!mappedState) {
      return { status: 'ignored' as const };
    }

    return lifecycle.transitionPaymentState({
      paymentId: input.paymentId,
      processor: provider.processor,
      nextStatus: mappedState,
      eventType: providerEvent.providerType,
      processorEventId: providerEvent.providerEventId,
      actorType: 'provider_webhook',
      metadata: {
        providerPayload: providerEvent.metadata ?? {},
        processorPaymentIntentId: providerEvent.processorPaymentIntentId ?? null,
        processorChargeId: providerEvent.processorChargeId ?? null
      }
    });
  }

  return {
    hasDurableStore: lifecycle.hasDurableStore,
    ingestWebhook
  };
}