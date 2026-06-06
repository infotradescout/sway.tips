import type { paymentStatusEnum } from '../db/schema';

export type PaymentState = (typeof paymentStatusEnum.enumValues)[number];

export type ProviderWebhookEnvelope = {
  providerEventId: string;
  providerType: string;
  processorPaymentIntentId?: string | null;
  processorChargeId?: string | null;
  metadata?: Record<string, unknown>;
};

export type ProviderSignatureVerificationInput = {
  rawBody: string;
  signatureHeader: string | null;
};

export type PaymentProviderAdapter = {
  readonly processor: string;
  verifyWebhookSignature: (input: ProviderSignatureVerificationInput) => Promise<boolean>;
  parseWebhookEvent: (input: { rawBody: string }) => Promise<ProviderWebhookEnvelope>;
  authorizePayment: (input: Record<string, unknown>) => Promise<never>;
  capturePayment: (input: Record<string, unknown>) => Promise<never>;
  refundPayment: (input: Record<string, unknown>) => Promise<never>;
  voidPayment: (input: Record<string, unknown>) => Promise<never>;
};

function unsupportedProviderAction(action: string): never {
  throw new Error(`Live provider ${action} execution is blocked in Slice 5 boundary mode.`);
}

export function createBoundaryOnlyProviderAdapter(processor: string): PaymentProviderAdapter {
  return {
    processor,

    async verifyWebhookSignature() {
      return false;
    },

    async parseWebhookEvent() {
      throw new Error('Webhook parsing is provider-specific and must be implemented by a verified adapter.');
    },

    async authorizePayment() {
      return unsupportedProviderAction('authorize');
    },

    async capturePayment() {
      return unsupportedProviderAction('capture');
    },

    async refundPayment() {
      return unsupportedProviderAction('refund');
    },

    async voidPayment() {
      return unsupportedProviderAction('void');
    }
  };
}