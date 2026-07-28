import Stripe from 'stripe';
import { STRIPE_API_VERSION } from './payment-provider';

export type EventTicketStripeTaxConfiguration =
  | {
      mode: 'stripe_automatic';
      productTaxCode: string;
    }
  | {
      mode: 'not_required';
      productTaxCode?: never;
    };

export type EventTicketStripeProviderConfig = {
  secretKey: string;
  webhookSecret: string;
  tax: EventTicketStripeTaxConfiguration;
  createPerformanceLocation?: (input: {
    eventId: string;
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country: 'US';
    description: string;
  }) => Promise<string>;
};

export type EventTicketStripeMetadata = Record<string, string>;

export type CreateEventTicketCheckoutInput = {
  orderId: string;
  eventId: string;
  offerId: string;
  buyerAccountId: string;
  buyerEmail: string;
  ticketName: string;
  ticketDescription?: string;
  amountTotalCents: number;
  currency: 'USD';
  successUrl: string;
  cancelUrl: string;
  expiresAtUnixSeconds: number;
  termsHash: string;
  transferGroup: string;
  idempotencyKey: string;
  performanceLocation: {
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country: 'US';
    description: string;
  };
  metadata?: EventTicketStripeMetadata;
};

export type EventTicketCheckoutResult = {
  checkoutSessionId: string;
  checkoutUrl: string | null;
  checkoutStatus: string | null;
  paymentStatus: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  amountSubtotalCents: number | null;
  amountTaxCents: number | null;
  amountTotalCents: number | null;
  currency: string | null;
  expiresAtUnixSeconds: number;
  metadata: EventTicketStripeMetadata;
};

export type EventTicketPaymentIntentResult = {
  paymentIntentId: string;
  chargeId: string | null;
  balanceTransactionId: string | null;
  processingFeeCents: number | null;
  netCents: number | null;
  status: string;
  amountCents: number;
  amountReceivedCents: number;
  currency: string;
  transferGroup: string | null;
  metadata: EventTicketStripeMetadata;
};

export type RefundEventTicketPaymentInput = {
  paymentIntentId: string;
  amountCents?: number;
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
  idempotencyKey: string;
  metadata?: EventTicketStripeMetadata;
};

export type EventTicketRefundResult = {
  refundId: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  amountCents: number;
  currency: string;
  status: string | null;
  metadata: EventTicketStripeMetadata;
};

export type TransferEventTicketProceedsInput = {
  destinationAccountId: string;
  sourceChargeId: string;
  amountCents: number;
  currency: 'USD';
  transferGroup: string;
  idempotencyKey: string;
  metadata?: EventTicketStripeMetadata;
};

export type EventTicketTransferResult = {
  transferId: string;
  destinationAccountId: string | null;
  sourceChargeId: string | null;
  amountCents: number;
  amountReversedCents: number;
  currency: string;
  transferGroup: string | null;
  reversed: boolean;
  metadata: EventTicketStripeMetadata;
};

export type ExpireEventTicketCheckoutInput = {
  checkoutSessionId: string;
  idempotencyKey: string;
};

export type EventTicketStripeWebhookKind =
  | 'checkout_completed'
  | 'checkout_expired'
  | 'payment_succeeded'
  | 'payment_failed'
  | 'charge_refunded'
  | 'refund_updated'
  | 'refund_failed'
  | 'charge_disputed'
  | 'charge_dispute_closed'
  | 'transfer_created'
  | 'unsupported';

export type EventTicketStripeWebhookEnvelope = {
  providerEventId: string;
  providerType: string;
  kind: EventTicketStripeWebhookKind;
  livemode: boolean;
  accountId: string | null;
  createdAtUnixSeconds: number;
  checkoutSessionId: string | null;
  paymentIntentId: string | null;
  chargeId: string | null;
  refundId: string | null;
  disputeId: string | null;
  transferId: string | null;
  destinationAccountId: string | null;
  sourceChargeId: string | null;
  status: string | null;
  amountCents: number | null;
  amountTaxCents: number | null;
  currency: string | null;
  transferGroup: string | null;
  refundFailureReason: string | null;
  refundPendingReason: string | null;
  disputeReason: string | null;
  disputeIsChargeRefundable: boolean | null;
  metadata: EventTicketStripeMetadata;
};

export type EventTicketStripeProvider = {
  readonly processor: 'stripe';
  readonly tax: EventTicketStripeTaxConfiguration;
  createCheckoutSession: (
    input: CreateEventTicketCheckoutInput
  ) => Promise<EventTicketCheckoutResult>;
  retrieveCheckoutSession: (
    checkoutSessionId: string
  ) => Promise<EventTicketCheckoutResult>;
  retrievePaymentIntent: (
    paymentIntentId: string
  ) => Promise<EventTicketPaymentIntentResult>;
  refundPayment: (
    input: RefundEventTicketPaymentInput
  ) => Promise<EventTicketRefundResult>;
  transferProceeds: (
    input: TransferEventTicketProceedsInput
  ) => Promise<EventTicketTransferResult>;
  expireCheckoutSession: (
    input: ExpireEventTicketCheckoutInput
  ) => Promise<EventTicketCheckoutResult>;
  parseVerifiedWebhookEvent: (input: {
    rawBody: string | Buffer;
    signatureHeader: string | null;
  }) => EventTicketStripeWebhookEnvelope;
};

const EVENT_TICKET_METADATA_PREFIX = 'sway_ticket';
const STRIPE_IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const STRIPE_TAX_LOCATION_API_VERSION = '2026-02-25.preview';

function requireNonEmpty(value: string, field: string, maximumLength = 500) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(`${field} is required and must not exceed ${maximumLength} characters.`);
  }
  return normalized;
}

function requirePerformanceLocation(
  input: CreateEventTicketCheckoutInput['performanceLocation']
) {
  const state = requireNonEmpty(input.state, 'Event state', 2).toUpperCase();
  const postalCode = requireNonEmpty(input.postalCode, 'Event postal code', 10);
  if (!/^[A-Z]{2}$/.test(state) || !/^\d{5}(?:-\d{4})?$/.test(postalCode)) {
    throw new Error('Event performance location must contain a valid US state and postal code.');
  }
  return {
    line1: requireNonEmpty(input.line1, 'Event address', 240),
    city: requireNonEmpty(input.city, 'Event city', 120),
    state,
    postalCode,
    country: input.country,
    description: requireNonEmpty(input.description, 'Event location description', 500)
  };
}

function requireIdempotencyKey(value: string) {
  return requireNonEmpty(
    value,
    'Stripe idempotency key',
    STRIPE_IDEMPOTENCY_KEY_MAX_LENGTH
  );
}

function requirePositiveCents(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer number of cents.`);
  }
  return value;
}

function requireUnixSeconds(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive Unix timestamp in seconds.`);
  }
  return value;
}

function requireHttpUrl(value: string, field: string) {
  const normalized = requireNonEmpty(value, field, 2_048);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${field} must be a valid HTTP or HTTPS URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${field} must be a valid HTTP or HTTPS URL.`);
  }
  return normalized;
}

function requireStripeTaxCode(value: string) {
  const normalized = requireNonEmpty(value, 'Stripe product tax code', 64);
  if (!/^txcd_\d+$/.test(normalized)) {
    throw new Error('Stripe product tax code must use the txcd_<digits> format.');
  }
  return normalized;
}

function normalizeMetadata(
  metadata: EventTicketStripeMetadata | undefined,
  reserved: EventTicketStripeMetadata = {}
) {
  const normalized: EventTicketStripeMetadata = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const normalizedKey = requireNonEmpty(key, 'Stripe metadata key', 40);
    normalized[normalizedKey] = requireNonEmpty(value, `Stripe metadata value for ${normalizedKey}`);
  }
  return { ...normalized, ...reserved };
}

function expandableId(
  value: string | { id: string } | null | undefined
): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function extractPaymentIntentChargeId(intent: Stripe.PaymentIntent) {
  return expandableId(intent.latest_charge);
}

function requireSafeIntegerCents(
  value: number,
  field: string,
  options: { positive?: boolean } = {}
) {
  if (
    !Number.isSafeInteger(value)
    || (options.positive ? value <= 0 : value < 0)
  ) {
    const range = options.positive ? 'positive' : 'non-negative';
    throw new Error(`${field} must be a ${range} integer number of cents.`);
  }
  return value;
}

function extractCaptureBalanceEvidence(intent: Stripe.PaymentIntent): {
  balanceTransactionId: string | null;
  processingFeeCents: number | null;
  netCents: number | null;
} {
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') {
    return {
      balanceTransactionId: null,
      processingFeeCents: null,
      netCents: null
    };
  }

  const balanceTransaction = charge.balance_transaction;
  if (!balanceTransaction || typeof balanceTransaction === 'string') {
    return {
      balanceTransactionId: null,
      processingFeeCents: null,
      netCents: null
    };
  }

  const balanceTransactionId = requireNonEmpty(
    balanceTransaction.id,
    'Stripe capture balance transaction id',
    255
  );
  const amountCents = requireSafeIntegerCents(
    balanceTransaction.amount,
    'Stripe capture balance transaction amount',
    { positive: true }
  );
  const processingFeeCents = requireSafeIntegerCents(
    balanceTransaction.fee,
    'Stripe capture processing fee'
  );
  const netCents = requireSafeIntegerCents(
    balanceTransaction.net,
    'Stripe capture net'
  );
  const chargeAmountCents = requireSafeIntegerCents(
    charge.amount_captured,
    'Stripe captured charge amount',
    { positive: true }
  );
  const intentAmountReceivedCents = requireSafeIntegerCents(
    intent.amount_received,
    'Stripe PaymentIntent amount received',
    { positive: true }
  );
  const intentCurrency = intent.currency.toLowerCase();
  const chargeCurrency = charge.currency.toLowerCase();
  const balanceCurrency = balanceTransaction.currency.toLowerCase();
  if (
    intentCurrency !== 'usd'
    || chargeCurrency !== intentCurrency
    || balanceCurrency !== intentCurrency
  ) {
    throw new Error(
      'Stripe ticket capture currency must be coherent USD across the PaymentIntent, Charge, and balance transaction.'
    );
  }
  if (
    amountCents !== chargeAmountCents
    || chargeAmountCents !== intentAmountReceivedCents
  ) {
    throw new Error(
      'Stripe ticket capture amounts must match across the PaymentIntent, Charge, and balance transaction.'
    );
  }
  if (netCents !== amountCents - processingFeeCents) {
    throw new Error(
      'Stripe capture balance transaction net must equal its amount less its processing fee.'
    );
  }
  const sourceId = expandableId(balanceTransaction.source);
  if (sourceId !== charge.id) {
    throw new Error(
      'Stripe capture balance transaction source must match the latest Charge.'
    );
  }

  return {
    balanceTransactionId,
    processingFeeCents,
    netCents
  };
}

function extractCheckoutPaymentIntent(session: Stripe.Checkout.Session) {
  if (!session.payment_intent) {
    return { paymentIntentId: null, chargeId: null };
  }
  if (typeof session.payment_intent === 'string') {
    return { paymentIntentId: session.payment_intent, chargeId: null };
  }
  return {
    paymentIntentId: session.payment_intent.id,
    chargeId: extractPaymentIntentChargeId(session.payment_intent)
  };
}

function mapCheckoutSession(session: Stripe.Checkout.Session): EventTicketCheckoutResult {
  const payment = extractCheckoutPaymentIntent(session);
  return {
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    checkoutStatus: session.status,
    paymentStatus: session.payment_status,
    paymentIntentId: payment.paymentIntentId,
    chargeId: payment.chargeId,
    amountSubtotalCents: session.amount_subtotal,
    amountTaxCents: session.total_details?.amount_tax ?? null,
    amountTotalCents: session.amount_total,
    currency: session.currency,
    expiresAtUnixSeconds: session.expires_at,
    metadata: session.metadata ?? {}
  };
}

function mapPaymentIntent(intent: Stripe.PaymentIntent): EventTicketPaymentIntentResult {
  const balanceEvidence = extractCaptureBalanceEvidence(intent);
  return {
    paymentIntentId: intent.id,
    chargeId: extractPaymentIntentChargeId(intent),
    ...balanceEvidence,
    status: intent.status,
    amountCents: intent.amount,
    amountReceivedCents: intent.amount_received,
    currency: intent.currency,
    transferGroup: intent.transfer_group,
    metadata: intent.metadata
  };
}

function mapRefund(refund: Stripe.Refund): EventTicketRefundResult {
  return {
    refundId: refund.id,
    paymentIntentId: expandableId(refund.payment_intent),
    chargeId: expandableId(refund.charge),
    amountCents: refund.amount,
    currency: refund.currency,
    status: refund.status,
    metadata: refund.metadata ?? {}
  };
}

function mapTransfer(transfer: Stripe.Transfer): EventTicketTransferResult {
  return {
    transferId: transfer.id,
    destinationAccountId: expandableId(transfer.destination),
    sourceChargeId: expandableId(transfer.source_transaction),
    amountCents: transfer.amount,
    amountReversedCents: transfer.amount_reversed,
    currency: transfer.currency,
    transferGroup: transfer.transfer_group,
    reversed: transfer.reversed,
    metadata: transfer.metadata
  };
}

const STRIPE_EVENT_TYPES = {
  checkoutCompleted: 'checkout.session.completed',
  checkoutExpired: 'checkout.session.expired',
  paymentSucceeded: 'payment_intent.succeeded',
  paymentFailed: 'payment_intent.payment_failed',
  chargeRefunded: 'charge.refunded',
  refundUpdated: 'refund.updated',
  refundFailed: 'refund.failed',
  chargeDisputeCreated: 'charge.dispute.created',
  chargeDisputeClosed: 'charge.dispute.closed',
  transferCreated: 'transfer.created'
} as const satisfies Record<string, Stripe.Event.Type>;

function webhookKind(providerType: string): EventTicketStripeWebhookKind {
  switch (providerType) {
    case STRIPE_EVENT_TYPES.checkoutCompleted:
      return 'checkout_completed';
    case STRIPE_EVENT_TYPES.checkoutExpired:
      return 'checkout_expired';
    case STRIPE_EVENT_TYPES.paymentSucceeded:
      return 'payment_succeeded';
    case STRIPE_EVENT_TYPES.paymentFailed:
      return 'payment_failed';
    case STRIPE_EVENT_TYPES.chargeRefunded:
      return 'charge_refunded';
    case STRIPE_EVENT_TYPES.refundUpdated:
      return 'refund_updated';
    case STRIPE_EVENT_TYPES.refundFailed:
      return 'refund_failed';
    case STRIPE_EVENT_TYPES.chargeDisputeCreated:
      return 'charge_disputed';
    case STRIPE_EVENT_TYPES.chargeDisputeClosed:
      return 'charge_dispute_closed';
    case STRIPE_EVENT_TYPES.transferCreated:
      return 'transfer_created';
    default:
      return 'unsupported';
  }
}

function normalizeWebhookEvent(event: Stripe.Event): EventTicketStripeWebhookEnvelope {
  const providerType = event.type as string;
  const kind = webhookKind(providerType);
  const object = event.data.object;

  const base: EventTicketStripeWebhookEnvelope = {
    providerEventId: event.id,
    providerType,
    kind,
    livemode: event.livemode,
    accountId: event.account ?? null,
    createdAtUnixSeconds: event.created,
    checkoutSessionId: null,
    paymentIntentId: null,
    chargeId: null,
    refundId: null,
    disputeId: null,
    transferId: null,
    destinationAccountId: null,
    sourceChargeId: null,
    status: null,
    amountCents: null,
    amountTaxCents: null,
    currency: null,
    transferGroup: null,
    refundFailureReason: null,
    refundPendingReason: null,
    disputeReason: null,
    disputeIsChargeRefundable: null,
    metadata: {}
  };

  if (kind === 'checkout_completed' || kind === 'checkout_expired') {
    const session = object as Stripe.Checkout.Session;
    const payment = extractCheckoutPaymentIntent(session);
    return {
      ...base,
      checkoutSessionId: session.id,
      paymentIntentId: payment.paymentIntentId,
      chargeId: payment.chargeId,
      status: session.status,
      amountCents: session.amount_total,
      amountTaxCents: session.total_details?.amount_tax ?? null,
      currency: session.currency,
      metadata: session.metadata ?? {}
    };
  }

  if (kind === 'payment_succeeded' || kind === 'payment_failed') {
    const intent = object as Stripe.PaymentIntent;
    return {
      ...base,
      paymentIntentId: intent.id,
      chargeId: extractPaymentIntentChargeId(intent),
      status: intent.status,
      amountCents: kind === 'payment_succeeded' ? intent.amount_received : intent.amount,
      currency: intent.currency,
      transferGroup: intent.transfer_group,
      metadata: intent.metadata
    };
  }

  if (kind === 'charge_refunded') {
    const charge = object as Stripe.Charge;
    return {
      ...base,
      paymentIntentId: expandableId(charge.payment_intent),
      chargeId: charge.id,
      status: charge.refunded ? 'refunded' : 'partially_refunded',
      amountCents: charge.amount_refunded,
      currency: charge.currency,
      transferGroup: charge.transfer_group,
      metadata: charge.metadata
    };
  }

  if (kind === 'refund_updated' || kind === 'refund_failed') {
    const refund = object as Stripe.Refund;
    return {
      ...base,
      paymentIntentId: expandableId(refund.payment_intent),
      chargeId: expandableId(refund.charge),
      refundId: refund.id,
      status: refund.status,
      amountCents: refund.amount,
      currency: refund.currency,
      refundFailureReason: refund.failure_reason ?? null,
      refundPendingReason: refund.pending_reason ?? null,
      metadata: refund.metadata ?? {}
    };
  }

  if (kind === 'charge_disputed' || kind === 'charge_dispute_closed') {
    const dispute = object as Stripe.Dispute;
    return {
      ...base,
      paymentIntentId: expandableId(dispute.payment_intent),
      chargeId: expandableId(dispute.charge),
      disputeId: dispute.id,
      status: dispute.status,
      amountCents: dispute.amount,
      currency: dispute.currency,
      disputeReason: dispute.reason,
      disputeIsChargeRefundable: dispute.is_charge_refundable,
      metadata: dispute.metadata
    };
  }

  if (kind === 'transfer_created') {
    const transfer = object as Stripe.Transfer;
    return {
      ...base,
      transferId: transfer.id,
      destinationAccountId: expandableId(transfer.destination),
      sourceChargeId: expandableId(transfer.source_transaction),
      status: 'created',
      amountCents: transfer.amount,
      currency: transfer.currency,
      transferGroup: transfer.transfer_group,
      metadata: transfer.metadata
    };
  }

  return base;
}

/**
 * Ticket checkout intentionally creates a platform charge with automatic
 * capture. No destination or transfer_data is accepted by this adapter.
 * Performer proceeds move only through the separate transferProceeds call.
 */
export function createEventTicketStripeProvider(
  config: EventTicketStripeProviderConfig
): EventTicketStripeProvider {
  const secretKey = requireNonEmpty(config.secretKey, 'Stripe secret key', 512);
  const webhookSecret = requireNonEmpty(config.webhookSecret, 'Stripe webhook secret', 512);
  const tax: EventTicketStripeTaxConfiguration = config.tax.mode === 'stripe_automatic'
    ? {
        mode: 'stripe_automatic',
        productTaxCode: requireStripeTaxCode(config.tax.productTaxCode)
      }
    : { mode: 'not_required' };
  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });

  return {
    processor: 'stripe',
    tax,

    async createCheckoutSession(input) {
      const orderId = requireNonEmpty(input.orderId, 'Ticket order id', 255);
      const eventId = requireNonEmpty(input.eventId, 'Event id', 255);
      const offerId = requireNonEmpty(input.offerId, 'Ticket offer id', 255);
      const buyerAccountId = requireNonEmpty(input.buyerAccountId, 'Buyer account id', 255);
      const buyerEmail = requireNonEmpty(input.buyerEmail, 'Buyer email', 320);
      const ticketName = requireNonEmpty(input.ticketName, 'Ticket name', 127);
      const ticketDescription = input.ticketDescription
        ? requireNonEmpty(input.ticketDescription, 'Ticket description', 500)
        : undefined;
      const amountTotalCents = requirePositiveCents(
        input.amountTotalCents,
        'Ticket checkout amount'
      );
      const successUrl = requireHttpUrl(input.successUrl, 'Ticket checkout success URL');
      const cancelUrl = requireHttpUrl(input.cancelUrl, 'Ticket checkout cancel URL');
      const expiresAt = requireUnixSeconds(
        input.expiresAtUnixSeconds,
        'Ticket checkout expiration'
      );
      const termsHash = requireNonEmpty(input.termsHash, 'Ticket terms hash', 128);
      const transferGroup = requireNonEmpty(input.transferGroup, 'Ticket transfer group', 255);
      const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
      const performanceLocation = requirePerformanceLocation(input.performanceLocation);
      const metadata = normalizeMetadata(input.metadata, {
        [`${EVENT_TICKET_METADATA_PREFIX}_lane`]: 'native_ga',
        [`${EVENT_TICKET_METADATA_PREFIX}_order_id`]: orderId,
        [`${EVENT_TICKET_METADATA_PREFIX}_event_id`]: eventId,
        [`${EVENT_TICKET_METADATA_PREFIX}_offer_id`]: offerId,
        [`${EVENT_TICKET_METADATA_PREFIX}_buyer_account_id`]: buyerAccountId,
        [`${EVENT_TICKET_METADATA_PREFIX}_terms_hash`]: termsHash
      });
      const taxLocationId = config.createPerformanceLocation
        ? await config.createPerformanceLocation({ eventId, ...performanceLocation })
        : (await stripe.rawRequest(
            'POST',
            '/v1/tax/locations',
            {
              type: 'performance',
              address: {
                line1: performanceLocation.line1,
                city: performanceLocation.city,
                state: performanceLocation.state,
                postal_code: performanceLocation.postalCode,
                country: performanceLocation.country
              },
              description: performanceLocation.description
            },
            {
              idempotencyKey: requireIdempotencyKey(`ticket.tax-location.${eventId}.v1`),
              additionalHeaders: { 'Stripe-Version': STRIPE_TAX_LOCATION_API_VERSION }
            }
          ) as { id?: unknown }).id;
      const performanceLocationId = typeof taxLocationId === 'string'
        && /^taxloc_[A-Za-z0-9]+$/.test(taxLocationId)
        ? taxLocationId
        : null;
      if (!performanceLocationId) {
        throw new Error('Stripe did not return a valid event performance location.');
      }

      const session = await stripe.checkout.sessions.create(
        {
          mode: 'payment',
          ui_mode: 'hosted_page',
          success_url: successUrl,
          cancel_url: cancelUrl,
          client_reference_id: orderId,
          customer_email: buyerEmail,
          expires_at: expiresAt,
          payment_method_types: ['card'],
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: input.currency.toLowerCase(),
                unit_amount: amountTotalCents,
                ...(tax.mode === 'stripe_automatic'
                  ? { tax_behavior: 'exclusive' as const }
                  : {}),
                product_data: {
                  name: ticketName,
                  ...(ticketDescription ? { description: ticketDescription } : {}),
                  ...(tax.mode === 'stripe_automatic'
                    ? {
                        tax_details: {
                          tax_code: tax.productTaxCode,
                          performance_location: performanceLocationId
                        }
                      }
                    : {})
                }
              }
            }
          ],
          ...(tax.mode === 'stripe_automatic'
            ? { automatic_tax: { enabled: true } }
            : {}),
          payment_intent_data: {
            capture_method: 'automatic',
            transfer_group: transferGroup,
            metadata
          },
          metadata
        },
        { idempotencyKey }
      );

      return mapCheckoutSession(session);
    },

    async retrieveCheckoutSession(checkoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(
        requireNonEmpty(checkoutSessionId, 'Stripe Checkout Session id', 255),
        { expand: ['payment_intent.latest_charge'] }
      );
      return mapCheckoutSession(session);
    },

    async retrievePaymentIntent(paymentIntentId) {
      const intent = await stripe.paymentIntents.retrieve(
        requireNonEmpty(paymentIntentId, 'Stripe PaymentIntent id', 255),
        { expand: ['latest_charge.balance_transaction'] }
      );
      return mapPaymentIntent(intent);
    },

    async refundPayment(input) {
      const paymentIntentId = requireNonEmpty(
        input.paymentIntentId,
        'Stripe PaymentIntent id',
        255
      );
      const amount = input.amountCents === undefined
        ? undefined
        : requirePositiveCents(input.amountCents, 'Ticket refund amount');
      const metadata = normalizeMetadata(input.metadata, {
        [`${EVENT_TICKET_METADATA_PREFIX}_operation`]: 'refund'
      });
      const refund = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
          ...(amount === undefined ? {} : { amount }),
          ...(input.reason ? { reason: input.reason } : {}),
          metadata
        },
        { idempotencyKey: requireIdempotencyKey(input.idempotencyKey) }
      );
      return mapRefund(refund);
    },

    async transferProceeds(input) {
      const destinationAccountId = requireNonEmpty(
        input.destinationAccountId,
        'Stripe connected account id',
        255
      );
      const sourceChargeId = requireNonEmpty(
        input.sourceChargeId,
        'Stripe source charge id',
        255
      );
      const amountCents = requirePositiveCents(
        input.amountCents,
        'Ticket performer transfer amount'
      );
      const transferGroup = requireNonEmpty(
        input.transferGroup,
        'Ticket transfer group',
        255
      );
      const metadata = normalizeMetadata(input.metadata, {
        [`${EVENT_TICKET_METADATA_PREFIX}_operation`]: 'performer_transfer'
      });
      const transfer = await stripe.transfers.create(
        {
          destination: destinationAccountId,
          source_transaction: sourceChargeId,
          amount: amountCents,
          currency: input.currency.toLowerCase(),
          transfer_group: transferGroup,
          metadata
        },
        { idempotencyKey: requireIdempotencyKey(input.idempotencyKey) }
      );
      return mapTransfer(transfer);
    },

    async expireCheckoutSession(input) {
      const session = await stripe.checkout.sessions.expire(
        requireNonEmpty(input.checkoutSessionId, 'Stripe Checkout Session id', 255),
        {},
        { idempotencyKey: requireIdempotencyKey(input.idempotencyKey) }
      );
      return mapCheckoutSession(session);
    },

    parseVerifiedWebhookEvent(input) {
      if (!input.signatureHeader) {
        throw new Error('Stripe webhook signature header is required.');
      }
      const event = stripe.webhooks.constructEvent(
        input.rawBody,
        input.signatureHeader,
        webhookSecret
      );
      return normalizeWebhookEvent(event);
    }
  };
}

export function createConfiguredEventTicketStripeProvider(
  env: NodeJS.ProcessEnv = process.env
): EventTicketStripeProvider | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = (
    env.STRIPE_TICKET_WEBHOOK_SECRET
    || env.STRIPE_WEBHOOK_SECRET
  )?.trim();
  const taxMode = env.SWAY_TICKET_TAX_MODE;

  if (!secretKey || !webhookSecret) return null;
  const production = env.NODE_ENV === 'production';
  if (
    (production && !/^(?:sk|rk)_live_/.test(secretKey))
    || (!production && !/^(?:sk|rk)_test_/.test(secretKey))
  ) {
    return null;
  }
  if (taxMode === 'stripe_automatic') {
    const productTaxCode = env.SWAY_TICKET_STRIPE_TAX_CODE?.trim();
    if (!productTaxCode) return null;
    return createEventTicketStripeProvider({
      secretKey,
      webhookSecret,
      tax: { mode: 'stripe_automatic', productTaxCode }
    });
  }
  if (taxMode === 'not_required') {
    return createEventTicketStripeProvider({
      secretKey,
      webhookSecret,
      tax: { mode: 'not_required' }
    });
  }
  return null;
}
