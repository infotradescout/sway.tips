import Stripe from 'stripe';

export const STRIPE_API_VERSION = '2026-06-24.dahlia' as const;

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

export type ProviderAuthorizeInput = {
  amountTotalCents: number;
  currency: string;
  idempotencyKey: string;
  paymentMethod?: string;
  confirm?: boolean;
  metadata?: Record<string, string>;
  // Passthrough (destination charge) target: when set, Stripe automatically
  // routes the charge (minus applicationFeeAmountCents) to this connected
  // account once the PaymentIntent is captured. Omitted entirely for callers
  // whose performer hasn't connected Stripe yet -- the charge still succeeds
  // into the platform balance in that case.
  destinationAccountId?: string;
  applicationFeeAmountCents?: number;
};

export type ProviderAuthorizeResult = {
  processorPaymentIntentId: string;
  processorChargeId: string | null;
  status: string;
  clientSecret: string | null;
};

export type ProviderCaptureInput = {
  processorPaymentIntentId: string;
  idempotencyKey?: string;
};

export type ProviderActionResult = {
  processorPaymentIntentId: string;
  processorChargeId: string | null;
  status: string;
};

export type ProviderVoidInput = {
  processorPaymentIntentId: string;
  idempotencyKey?: string;
};

export type ProviderRefundInput = {
  processorPaymentIntentId: string;
  idempotencyKey?: string;
};

export type PaymentProviderAdapter = {
  readonly processor: string;
  verifyWebhookSignature: (input: ProviderSignatureVerificationInput) => Promise<boolean>;
  parseWebhookEvent: (input: { rawBody: string; signatureHeader: string | null }) => Promise<ProviderWebhookEnvelope>;
  authorizePayment: (input: ProviderAuthorizeInput) => Promise<ProviderAuthorizeResult>;
  capturePayment: (input: ProviderCaptureInput) => Promise<ProviderActionResult>;
  refundPayment: (input: ProviderRefundInput) => Promise<ProviderActionResult>;
  voidPayment: (input: ProviderVoidInput) => Promise<ProviderActionResult>;
};

function extractChargeId(intent: Stripe.PaymentIntent): string | null {
  const latest = intent.latest_charge;
  if (!latest) return null;
  return typeof latest === 'string' ? latest : latest.id;
}

/**
 * Real Stripe test-mode provider adapter.
 *
 * Authorizations use manual-capture PaymentIntents so funds are held (authorized)
 * and only captured after the performer approves the request in Private Triage.
 * Denials/hides void (cancel) the authorization or refund a captured charge.
 */
export function createStripeProviderAdapter(config: {
  secretKey: string;
  webhookSecret: string;
  processor?: string;
}): PaymentProviderAdapter {
  const stripe = new Stripe(config.secretKey, { apiVersion: STRIPE_API_VERSION });
  const processor = config.processor ?? 'stripe';

  return {
    processor,

    async verifyWebhookSignature(input) {
      if (!input.signatureHeader) return false;
      try {
        stripe.webhooks.constructEvent(input.rawBody, input.signatureHeader, config.webhookSecret);
        return true;
      } catch {
        return false;
      }
    },

    async parseWebhookEvent(input) {
      if (!input.signatureHeader) {
        throw new Error('Webhook signature header is required to parse a Stripe event.');
      }
      const event = stripe.webhooks.constructEvent(input.rawBody, input.signatureHeader, config.webhookSecret);
      const object = event.data?.object as Stripe.PaymentIntent | Stripe.Charge | undefined;

      let processorPaymentIntentId: string | null = null;
      let processorChargeId: string | null = null;

      if (object && 'object' in object) {
        if (object.object === 'payment_intent') {
          const intent = object as Stripe.PaymentIntent;
          processorPaymentIntentId = intent.id;
          processorChargeId = extractChargeId(intent);
        } else if (object.object === 'charge') {
          const charge = object as Stripe.Charge;
          processorChargeId = charge.id;
          processorPaymentIntentId = typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id ?? null;
        }
      }

      return {
        providerEventId: event.id,
        providerType: event.type,
        processorPaymentIntentId,
        processorChargeId,
        metadata: { livemode: event.livemode }
      };
    },

    async authorizePayment(input) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amountTotalCents,
          currency: input.currency.toLowerCase(),
          capture_method: 'manual',
          ...(input.paymentMethod ? { payment_method: input.paymentMethod } : {}),
          ...(input.confirm ? { confirm: true } : {}),
          ...(input.destinationAccountId
            ? {
                transfer_data: { destination: input.destinationAccountId },
                application_fee_amount: input.applicationFeeAmountCents ?? 0
              }
            : {}),
          metadata: input.metadata ?? {}
        },
        { idempotencyKey: input.idempotencyKey }
      );

      return {
        processorPaymentIntentId: intent.id,
        processorChargeId: extractChargeId(intent),
        status: intent.status,
        clientSecret: intent.client_secret
      };
    },

    async capturePayment(input) {
      const intent = await stripe.paymentIntents.capture(
        input.processorPaymentIntentId,
        undefined,
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined
      );

      return {
        processorPaymentIntentId: intent.id,
        processorChargeId: extractChargeId(intent),
        status: intent.status
      };
    },

    async voidPayment(input) {
      const intent = await stripe.paymentIntents.cancel(
        input.processorPaymentIntentId,
        undefined,
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined
      );

      return {
        processorPaymentIntentId: intent.id,
        processorChargeId: extractChargeId(intent),
        status: intent.status
      };
    },

    async refundPayment(input) {
      const refund = await stripe.refunds.create(
        { payment_intent: input.processorPaymentIntentId },
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined
      );

      return {
        processorPaymentIntentId: input.processorPaymentIntentId,
        processorChargeId: typeof refund.charge === 'string' ? refund.charge : refund.charge?.id ?? null,
        status: refund.status ?? 'refunded'
      };
    }
  };
}

/**
 * Reads server-side environment variables and returns a configured Stripe adapter,
 * or null when execution is not provisioned. A null provider fails safe: no
 * authorization, capture, or financial state is ever created without real keys.
 */
export function createConfiguredPaymentProvider(env: NodeJS.ProcessEnv = process.env): PaymentProviderAdapter | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    return null;
  }
  return createStripeProviderAdapter({ secretKey, webhookSecret });
}
