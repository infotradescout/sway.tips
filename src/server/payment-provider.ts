import Stripe from 'stripe';

export const STRIPE_API_VERSION = '2026-06-24.dahlia' as const;

export type ProviderWebhookEnvelope = {
  providerEventId: string;
  providerType: string;
  livemode: boolean;
  processorPaymentIntentId?: string | null;
  processorChargeId?: string | null;
  providerStatus?: string | null;
  amountCents?: number | null;
  amountRefundedCents?: number | null;
  fullyRefunded?: boolean | null;
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
  // Required destination-charge target. Live-room money must never fall back
  // to the platform balance when a performer is not payout-ready.
  // routes the charge (minus applicationFeeAmountCents) to this connected
  // account once the PaymentIntent is captured.
  destinationAccountId?: string;
  applicationFeeAmountCents?: number;
};

export type ProviderAuthorizeResult = {
  processorPaymentIntentId: string;
  processorChargeId: string | null;
  status: string;
  clientSecret: string | null;
  amountCents: number;
  amountReceivedCents: number;
  amountCapturableCents: number;
  amountRefundedCents?: number | null;
  fullyRefunded?: boolean | null;
  metadata?: Record<string, string>;
};

export type ProviderCaptureInput = {
  processorPaymentIntentId: string;
  idempotencyKey?: string;
};

export type ProviderActionResult = {
  processorPaymentIntentId: string;
  processorChargeId: string | null;
  processorRefundId?: string | null;
  status: string;
};

export type ProviderVoidInput = {
  processorPaymentIntentId: string;
  idempotencyKey?: string;
};

export type ProviderRefundInput = {
  processorPaymentIntentId: string;
  idempotencyKey?: string;
  reverseTransfer: boolean;
  refundApplicationFee: boolean;
};

export type PaymentProviderAdapter = {
  readonly processor: string;
  verifyWebhookSignature: (input: ProviderSignatureVerificationInput) => Promise<boolean>;
  parseWebhookEvent: (input: { rawBody: string; signatureHeader: string | null }) => Promise<ProviderWebhookEnvelope>;
  authorizePayment: (input: ProviderAuthorizeInput) => Promise<ProviderAuthorizeResult>;
  retrievePaymentAuthorization: (processorPaymentIntentId: string) => Promise<ProviderAuthorizeResult>;
  capturePayment: (input: ProviderCaptureInput) => Promise<ProviderActionResult>;
  refundPayment: (input: ProviderRefundInput) => Promise<ProviderActionResult>;
  voidPayment: (input: ProviderVoidInput) => Promise<ProviderActionResult>;
};

function extractChargeId(intent: Stripe.PaymentIntent): string | null {
  const latest = intent.latest_charge;
  if (!latest) return null;
  return typeof latest === 'string' ? latest : latest.id;
}

function paymentIntentResult(intent: Stripe.PaymentIntent): ProviderAuthorizeResult {
  const expandedCharge = intent.latest_charge && typeof intent.latest_charge !== 'string'
    ? intent.latest_charge
    : null;
  return {
    processorPaymentIntentId: intent.id,
    processorChargeId: extractChargeId(intent),
    status: intent.status,
    clientSecret: intent.client_secret,
    amountCents: intent.amount,
    amountReceivedCents: intent.amount_received,
    amountCapturableCents: intent.amount_capturable,
    amountRefundedCents: expandedCharge?.amount_refunded ?? null,
    fullyRefunded: expandedCharge
      ? expandedCharge.refunded && expandedCharge.amount_refunded >= expandedCharge.amount
      : null,
    metadata: intent.metadata
  };
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
      const object = event.data?.object as Stripe.PaymentIntent | Stripe.Charge | Stripe.Dispute | undefined;

      let processorPaymentIntentId: string | null = null;
      let processorChargeId: string | null = null;
      let providerStatus: string | null = null;
      let amountCents: number | null = null;
      let amountRefundedCents: number | null = null;
      let fullyRefunded: boolean | null = null;
      let objectMetadata: Record<string, unknown> = {};

      if (object && 'object' in object) {
        if (object.object === 'payment_intent') {
          const intent = object as Stripe.PaymentIntent;
          processorPaymentIntentId = intent.id;
          processorChargeId = extractChargeId(intent);
          providerStatus = intent.status;
          amountCents = intent.amount;
          objectMetadata = intent.metadata;
        } else if (object.object === 'charge') {
          const charge = object as Stripe.Charge;
          processorChargeId = charge.id;
          processorPaymentIntentId = typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id ?? null;
          providerStatus = charge.status;
          amountCents = charge.amount;
          amountRefundedCents = charge.amount_refunded;
          fullyRefunded = charge.refunded && charge.amount_refunded >= charge.amount;
          objectMetadata = charge.metadata;
        } else if (object.object === 'dispute') {
          const dispute = object as Stripe.Dispute;
          processorChargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id ?? null;
          processorPaymentIntentId = typeof dispute.payment_intent === 'string'
            ? dispute.payment_intent
            : dispute.payment_intent?.id ?? null;
          providerStatus = dispute.status;
          amountCents = dispute.amount;
          objectMetadata = dispute.metadata;
        }
      }

      return {
        providerEventId: event.id,
        providerType: event.type,
        livemode: event.livemode,
        processorPaymentIntentId,
        processorChargeId,
        providerStatus,
        amountCents,
        amountRefundedCents,
        fullyRefunded,
        metadata: objectMetadata
      };
    },

    async authorizePayment(input) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: input.amountTotalCents,
          currency: input.currency.toLowerCase(),
          capture_method: 'manual',
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
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

      return paymentIntentResult(intent);
    },

    async retrievePaymentAuthorization(processorPaymentIntentId) {
      // Refund state lives on the Charge, while a refunded PaymentIntent keeps
      // reporting `succeeded`. Always expand the latest Charge for reconciliation
      // so closeout can distinguish captured, partially refunded, and fully
      // refunded money without depending on webhook delivery order.
      const intent = await stripe.paymentIntents.retrieve(processorPaymentIntentId, {
        expand: ['latest_charge']
      });
      return paymentIntentResult(intent);
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
        {
          payment_intent: input.processorPaymentIntentId,
          reverse_transfer: input.reverseTransfer,
          refund_application_fee: input.refundApplicationFee
        },
        input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined
      );

      return {
        processorPaymentIntentId: input.processorPaymentIntentId,
        processorChargeId: typeof refund.charge === 'string' ? refund.charge : refund.charge?.id ?? null,
        processorRefundId: refund.id,
        // A missing status is not proof that money returned. The payment
        // service only marks a refund terminal when Stripe says `succeeded`.
        status: refund.status ?? 'unknown'
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
  if (!secretKey || !webhookSecret || !secretKey.startsWith('sk_test_')) {
    return null;
  }
  return createStripeProviderAdapter({ secretKey, webhookSecret });
}
