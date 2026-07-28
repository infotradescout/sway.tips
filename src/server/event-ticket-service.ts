import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  sql
} from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  auditEvents,
  eventTicketOffers,
  eventTickets,
  performerEvents,
  performers,
  ticketAdmissionEvents,
  ticketLedgerEntries,
  ticketOrders,
  ticketPaymentOperations,
  ticketProcessorEvents,
  users
} from '../db/schema';
import {
  NATIVE_TICKET_BUYER_TERMS_HASH,
  NATIVE_TICKET_BUYER_TERMS_TEXT,
  NATIVE_TICKET_EXCLUSIVE_FEE_CAP_CENTS,
  NATIVE_TICKET_SELLER_TERMS_HASH,
  NATIVE_TICKET_SELLER_TERMS_TEXT,
  NATIVE_TICKET_TERMS_VERSION,
  buildNativeTicketBuyerTermsSnapshot,
  buildNativeTicketSellerTermsSnapshot,
  calculateNativeTicketPrice,
  resolveNativeTicketPerformanceLocation,
  resolveNativeTicketRuntimeConfig,
  type NativeTicketRuntimeConfig
} from './event-ticket-contract';
import {
  createConfiguredEventTicketStripeProvider,
  type EventTicketStripeProvider,
  type EventTicketStripeWebhookEnvelope
} from './event-ticket-stripe-provider';
import {
  issueEventTicketQrToken,
  verifyEventTicketQrToken
} from './event-ticket-token';
import { loadPartnerEntitlementStateForPerformer } from './partner-entitlement-store';

type DbExecutor = SwayDb | any;
type OfferRow = typeof eventTicketOffers.$inferSelect;
type OrderRow = typeof ticketOrders.$inferSelect;
type TicketRow = typeof eventTickets.$inferSelect;
type OperationRow = typeof ticketPaymentOperations.$inferSelect;
type ProcessorEventRow = typeof ticketProcessorEvents.$inferSelect;
type EventRow = typeof performerEvents.$inferSelect;

type TicketOperationType =
  | 'create_checkout'
  | 'expire_checkout'
  | 'create_seller_transfer'
  | 'create_buyer_refund';

type TicketStatus = TicketRow['status'];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CAPACITY = 100_000;
const MAX_CANCELLATION_REASON_LENGTH = 500;
const OPERATION_LEASE_SECONDS = 60;
const PROCESSOR_EVENT_RETRY_SECONDS = 30;
const PROCESSOR_EVENT_LEASE_SECONDS = 120;
const RESERVED_ORDER_STATUSES: OrderRow['status'][] = [
  'checkout_pending',
  'checkout_open',
  'payment_processing',
  'paid',
  'refund_pending',
  'disputed'
];
const BUYER_EVENT_LIMIT_STATUSES: OrderRow['status'][] = [
  ...RESERVED_ORDER_STATUSES,
  'refunded'
];
const UNPAID_ORDER_STATUSES: OrderRow['status'][] = [
  'checkout_pending',
  'checkout_open',
  'payment_processing'
];
const CHECKOUT_RECONCILIATION_STATUSES: OrderRow['status'][] = [
  ...UNPAID_ORDER_STATUSES,
  'payment_failed',
  'expired',
  'voided'
];

export class EventTicketServiceError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { retryable?: boolean } = {}
  ) {
    super(message);
    this.name = 'EventTicketServiceError';
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

class RetryableOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableOperationError';
  }
}

class TerminalOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalOperationError';
  }
}

export type OwnerTicketOfferDto = {
  id: string;
  eventId: string;
  performerId: string;
  status: OfferRow['status'];
  capacity: number;
  faceValueCents: number;
  mandatoryFeeCents: number;
  advertisedTotalCents: number;
  sellerTransferAmountCents: number;
  currency: 'USD';
  taxMode: OfferRow['taxMode'];
  stripeTaxCode: string | null;
  settlementPolicy: 'refund_only';
  checkoutReservationMinutes: number;
  refundGraceMinutes: number;
  sellerSupportEmail: string;
  salesOpenAt: string;
  salesCloseAt: string;
  sellerTermsVersion: string;
  sellerTermsHash: string;
  sellerTermsAcceptedAt: string;
  activatedAt: string | null;
  salesClosedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicTicketOfferDto = {
  mode: 'native_ga';
  salesStatus: 'scheduled' | 'on_sale' | 'sold_out' | 'closed' | 'cancelled';
  currency: 'USD';
  faceValueCents: number;
  mandatoryFeeCents: number;
  unitAllInPriceCents: number;
  remainingCount: number;
  termsVersion: string;
  termsHash: string;
  refundGraceMinutes: number;
  sellerSupportEmail: string;
};

export type BuyerTicketOrderDto = {
  id: string;
  status: string;
  checkoutUrl: string | null;
  allInTotalCents: number;
  currency: 'USD';
  checkoutExpiresAt: string | null;
  failureMessage: string | null;
  ticketIds: string[];
  event: {
    id: string;
    title: string;
    eventPath: string;
  };
};

export type BuyerTicketWalletItemDto = {
  id: string;
  status: string;
  settlementStatus: TicketStatus;
  allInPriceCents: number;
  currency: 'USD';
  createdAt: string;
  checkedInAt: string | null;
  refundedAt: string | null;
  event: {
    id: string;
    title: string;
    eventPath: string;
    startsAt: string;
    endsAt: string | null;
    timeZone: string;
    locationName: string | null;
    locationAddress: string | null;
    city: string | null;
    locationIsTba: boolean;
    performerName: string;
  };
};

export type BuyerTicketPassDto = BuyerTicketWalletItemDto & {
  ticketNumber: string;
  manualCode: string | null;
  qrToken: string | null;
  qrExpiresAt: string | null;
  admissionStatus: 'scheduled' | 'open' | 'closed' | 'cancelled';
  admissionOpensAt: string;
  admissionClosesAt: string;
  termsVersion: string;
  termsHash: string;
  refundGraceMinutes: number;
  refundRequestedAt: string | null;
};

export type PerformerDoorSummaryDto = {
  event: {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string | null;
    timeZone: string;
    status: string;
  };
  canCheckIn: boolean;
  admissionWindow: {
    status: 'scheduled' | 'open' | 'closed' | 'cancelled';
    opensAt: string;
    closesAt: string;
  };
  counts: {
    sold: number;
    active: number;
    checkedIn: number;
    refundPending: number;
    refunded: number;
  };
};

export type EventTicketServiceOptions = {
  db: DbExecutor;
  provider?: EventTicketStripeProvider | null;
  runtimeConfig?: NativeTicketRuntimeConfig;
  expectedStripeLivemode?: boolean;
  now?: () => Date;
  workerId?: string;
};

function serviceError(
  status: number,
  code: string,
  message: string,
  options: { retryable?: boolean } = {}
): never {
  throw new EventTicketServiceError(status, code, message, options);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    serviceError(422, 'invalid_uuid', `${label} must be a UUID.`);
  }
}

function requireBooleanTrue(value: unknown, code: string, message: string) {
  if (value !== true) serviceError(422, code, message);
}

function normalizeRequiredText(value: unknown, label: string, maximumLength: number) {
  if (typeof value !== 'string') {
    serviceError(422, 'invalid_text', `${label} is required.`);
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > maximumLength) {
    serviceError(
      422,
      'invalid_text',
      `${label} is required and must be ${maximumLength} characters or fewer.`
    );
  }
  return normalized;
}

function parseExpectedUpdatedAt(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    serviceError(422, 'event_version_required', 'expectedUpdatedAt is required.');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    serviceError(422, 'event_version_invalid', 'expectedUpdatedAt must be an ISO date-time.');
  }
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function recordString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function normalizeHostedCheckoutUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeProcessorError(error: unknown) {
  const fields: string[] = [];
  let cursor: unknown = error;
  for (let depth = 0; cursor && depth < 4; depth += 1) {
    const candidate = cursor as {
      type?: unknown;
      code?: unknown;
      statusCode?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof candidate.type === 'string') fields.push(candidate.type);
    if (typeof candidate.code === 'string') fields.push(candidate.code);
    if (Number.isInteger(candidate.statusCode)) fields.push(String(candidate.statusCode));
    if (typeof candidate.message === 'string') fields.push(candidate.message);
    cursor = candidate.cause;
  }
  // Root causes carry the useful constraint/provider detail; keep them before
  // verbose query wrappers when the persisted diagnostic must be truncated.
  fields.reverse();
  return fields.join(': ').slice(0, 1_000) || 'Ticket processor operation failed.';
}

function operationRetryAt(now: Date, attemptCount: number) {
  const seconds = Math.min(3_600, 5 * (2 ** Math.max(0, attemptCount - 1)));
  return new Date(now.getTime() + seconds * 1_000);
}

function iso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}

function serializeOwnerOffer(offer: OfferRow): OwnerTicketOfferDto {
  return {
    id: offer.id,
    eventId: offer.eventId,
    performerId: offer.performerId,
    status: offer.status,
    capacity: offer.capacity,
    faceValueCents: offer.faceValueCents,
    mandatoryFeeCents: offer.mandatoryFeeCents,
    advertisedTotalCents: offer.advertisedTotalCents,
    sellerTransferAmountCents: offer.sellerTransferAmountCents,
    currency: 'USD',
    taxMode: offer.taxMode,
    stripeTaxCode: offer.stripeTaxCode,
    settlementPolicy: 'refund_only',
    checkoutReservationMinutes: offer.checkoutReservationMinutes,
    refundGraceMinutes: offer.refundGraceMinutes,
    sellerSupportEmail: recordString(asRecord(offer.sellerTermsSnapshot), 'sellerSupportEmail') ?? '',
    salesOpenAt: offer.salesOpenAt.toISOString(),
    salesCloseAt: offer.salesCloseAt.toISOString(),
    sellerTermsVersion: offer.sellerTermsVersion,
    sellerTermsHash: offer.sellerTermsHash,
    sellerTermsAcceptedAt: offer.sellerTermsAcceptedAt.toISOString(),
    activatedAt: iso(offer.activatedAt),
    salesClosedAt: iso(offer.salesClosedAt),
    cancelledAt: iso(offer.cancelledAt),
    createdAt: offer.createdAt.toISOString(),
    updatedAt: offer.updatedAt.toISOString()
  };
}

function publicOrderStatus(status: OrderRow['status']) {
  if (status === 'expired') return 'checkout_expired';
  if (status === 'voided') return 'cancelled';
  return status;
}

function publicTicketStatus(status: TicketStatus) {
  if (status === 'held') return 'active';
  if (status === 'release_pending' || status === 'released') return 'checked_in';
  if (status === 'voided') return 'cancelled';
  return status;
}

function orderFailureMessage(status: OrderRow['status']) {
  switch (status) {
    case 'payment_failed':
      return 'The payment processor did not confirm this purchase. No ticket was issued.';
    case 'expired':
      return 'The hosted checkout expired before Sway confirmed payment. No ticket was issued.';
    case 'voided':
      return 'This order is no longer valid. No ticket was issued.';
    case 'refunded':
      return 'The processor confirmed a full refund to the original payment method.';
    default:
      return null;
  }
}

function requireSalesConfiguration(config: NativeTicketRuntimeConfig) {
  if (!config.salesEnabled) {
    serviceError(
      503,
      'native_ticket_sales_disabled',
      'Native ticket sales are unavailable until every payment, fee, tax, and admission setting is configured.',
      { retryable: true }
    );
  }
  if (
    config.feeBps === null
    || config.feeFixedCents === null
    || config.taxMode === null
    || !config.qrSecret
    || !config.appBaseUrl
  ) {
    serviceError(
      503,
      'native_ticket_configuration_incomplete',
      'Native ticket sales configuration is incomplete.',
      { retryable: true }
    );
  }
  return {
    feeBps: config.feeBps,
    feeFixedCents: config.feeFixedCents,
    taxMode: config.taxMode,
    stripeTaxCode: config.stripeTaxCode,
    qrSecret: config.qrSecret,
    appBaseUrl: config.appBaseUrl,
    supportEmail: config.supportEmail
  };
}

function requireAdmissionConfiguration(config: NativeTicketRuntimeConfig) {
  if (!config.qrSecret) {
    serviceError(
      503,
      'native_ticket_admission_configuration_incomplete',
      'Ticket admission is temporarily unavailable.',
      { retryable: true }
    );
  }
  return { qrSecret: config.qrSecret };
}

type TicketSellerReadiness = {
  isActive: boolean;
  onboardingStatus: string;
  paymentAccountStatus: string;
  kycStatus: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  stripeConnectedAccountId: string | null;
  payoutHoldReason: string | null;
};

function sellerIsReady(performer: TicketSellerReadiness) {
  return (
    performer.isActive
    && performer.onboardingStatus !== 'suspended'
    && performer.paymentAccountStatus === 'payouts_enabled'
    && ['not_required', 'verified'].includes(performer.kycStatus)
    && performer.chargesEnabled === true
    && performer.payoutsEnabled === true
    && Boolean(performer.stripeConnectedAccountId?.trim())
    && !performer.payoutHoldReason
  );
}

function assertSellerReady(performer: TicketSellerReadiness) {
  if (!performer.isActive || performer.onboardingStatus === 'suspended') {
    serviceError(403, 'ticket_seller_inactive', 'Activate the performer account before selling tickets.');
  }
  if (!sellerIsReady(performer)) {
    serviceError(
      409,
      'ticket_seller_payout_not_ready',
      'Complete Stripe identity, transfer, and payout onboarding before selling native tickets.'
    );
  }
}

function manualCodeForTicket(ticketId: string, secret: string) {
  const digest = createHmac('sha256', secret)
    .update(`manual-admission:v1:${ticketId}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return digest.match(/.{1,4}/g)?.join('-') ?? digest;
}

function normalizeManualCode(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.toUpperCase().replace(/[^A-F0-9]/g, '');
  return /^[A-F0-9]{16}$/.test(normalized) ? normalized : null;
}

function manualCredentialHash(manualCode: string) {
  return sha256(manualCode.replace(/-/g, '').toUpperCase());
}

function manualCodeForStoredTicket(
  ticket: TicketRow,
  config: NativeTicketRuntimeConfig
) {
  const secrets = [
    config.qrSecret,
    ...config.qrPreviousSecrets
  ].filter((value): value is string => Boolean(value));
  for (const secret of secrets) {
    const candidate = manualCodeForTicket(ticket.id, secret);
    if (manualCredentialHash(candidate) === ticket.admissionCredentialHash) {
      return candidate;
    }
  }
  return null;
}

function maskBuyerEmail(email: string | null) {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!local || !domain) return null;
  return `${local.slice(0, 1)}***@${domain}`;
}

function sellerTransferGroup(orderId: string) {
  return `sway_ticket_${orderId}`;
}

function assertSellerTransferEvidence(input: {
  transferId: string;
  destinationAccountId: string | null;
  sourceChargeId: string | null;
  amountCents: number | null;
  currency: string | null;
  transferGroup: string | null;
  reversed?: boolean;
  expectedDestinationAccountId: string;
  expectedSourceChargeId: string;
  expectedAmountCents: number;
  expectedTransferGroup: string;
}) {
  if (
    !input.transferId
    || input.destinationAccountId !== input.expectedDestinationAccountId
    || input.sourceChargeId !== input.expectedSourceChargeId
    || input.amountCents !== input.expectedAmountCents
    || input.currency?.toUpperCase() !== 'USD'
    || input.transferGroup !== input.expectedTransferGroup
    || input.reversed === true
  ) {
    throw new TerminalOperationError(
      'Stripe performer transfer evidence does not match the immutable ticket settlement.'
    );
  }
}

function operationKey(orderId: string, operationType: TicketOperationType) {
  return `sway.ticket.${orderId}.${operationType}.v1`;
}

function ledgerKey(orderId: string, suffix: string) {
  return `sway.ticket.${orderId}.ledger.${suffix}.v1`;
}

function eventPath(eventId: string) {
  return `/e/${eventId}`;
}

function admissionWindowFor(event: EventRow, offer: OfferRow, now: Date) {
  if (!event.doorOpensAt) {
    serviceError(
      409,
      'ticket_door_time_missing',
      'This native ticket event does not have a valid door-opening time.'
    );
  }
  const opensAt = event.doorOpensAt;
  const closesAt = new Date(
    (event.endsAt ?? event.startsAt).getTime() + offer.refundGraceMinutes * 60_000
  );
  let status: 'scheduled' | 'open' | 'closed' | 'cancelled';
  if (
    event.status === 'cancelled'
    || event.ticketingMode !== 'native_ga'
    || offer.status === 'cancelled'
  ) {
    status = 'cancelled';
  } else if (now.getTime() < opensAt.getTime()) {
    status = 'scheduled';
  } else if (now.getTime() > closesAt.getTime() || event.status !== 'published') {
    status = 'closed';
  } else {
    status = 'open';
  }
  return { status, opensAt, closesAt };
}

async function writeTicketAudit(
  executor: DbExecutor,
  input: {
    actorType: string;
    actorId: string | null;
    entityType: string;
    entityId: string;
    eventType: string;
    previousStatus?: string | null;
    nextStatus?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  await executor.insert(auditEvents).values({
    actorType: input.actorType,
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    previousStatus: input.previousStatus ?? null,
    nextStatus: input.nextStatus ?? null,
    metadata: input.metadata ?? {}
  });
}

async function insertLedgerEntries(
  executor: DbExecutor,
  entries: Array<typeof ticketLedgerEntries.$inferInsert>
) {
  if (!entries.length) return;
  await executor
    .insert(ticketLedgerEntries)
    .values(entries)
    .onConflictDoNothing();
}

export function createEventTicketService(options: EventTicketServiceOptions) {
  const db = options.db;
  const runtimeConfig = options.runtimeConfig ?? resolveNativeTicketRuntimeConfig();
  const provider = options.provider === undefined
    ? createConfiguredEventTicketStripeProvider()
    : options.provider;
  const expectedStripeLivemode = options.expectedStripeLivemode
    ?? runtimeConfig.expectedStripeLivemode;
  const clock = options.now ?? (() => new Date());
  const defaultWorkerId = options.workerId ?? `ticket-worker-${randomUUID()}`;

  function requireCheckoutAvailability() {
    const config = requireSalesConfiguration(runtimeConfig);
    if (!provider) {
      serviceError(
        503,
        'ticket_processor_unavailable',
        'Native ticket checkout is temporarily unavailable.',
        { retryable: true }
      );
    }
    if (
      provider.tax.mode !== config.taxMode
      || (
        provider.tax.mode === 'stripe_automatic'
        && provider.tax.productTaxCode !== config.stripeTaxCode
      )
    ) {
      serviceError(
        503,
        'ticket_processor_tax_policy_mismatch',
        'Native ticket tax configuration does not match the active payment processor.',
        { retryable: true }
      );
    }
    return { config, provider };
  }

  function offerMatchesActivePolicy(
    offer: OfferRow,
    config: ReturnType<typeof requireSalesConfiguration>
  ) {
    const activeTaxCode = config.taxMode === 'stripe_automatic'
      ? config.stripeTaxCode
      : null;
    const snapshot = asRecord(offer.sellerTermsSnapshot);
    const expectedPrice = calculateNativeTicketPrice({
      faceValueCents: offer.faceValueCents,
      feeBps: config.feeBps,
      feeFixedCents: config.feeFixedCents,
      feeCapCents: snapshot.isSwayExclusive === true
        ? NATIVE_TICKET_EXCLUSIVE_FEE_CAP_CENTS
        : null
    });
    return !(
      offer.mandatoryFeeBps !== expectedPrice.feeBps
      || offer.mandatoryFeeFixedCents !== expectedPrice.feeFixedCents
      || offer.mandatoryFeeCents !== expectedPrice.mandatoryFeeCents
      || offer.advertisedTotalCents !== expectedPrice.totalPriceCents
      || offer.taxMode !== config.taxMode
      || offer.stripeTaxCode !== activeTaxCode
    );
  }

  function assertOfferMatchesActivePolicy(
    offer: OfferRow,
    config: ReturnType<typeof requireSalesConfiguration>
  ) {
    if (!offerMatchesActivePolicy(offer, config)) {
      serviceError(
        409,
        'ticket_offer_policy_stale',
        'Ticket fee or tax policy changed. Create a new offer before selling tickets.'
      );
    }
  }

  async function offerMatchesCurrentSeller(
    offer: OfferRow,
    performer: TicketSellerReadiness,
    executor: DbExecutor = db
  ) {
    const partner = await loadPartnerEntitlementStateForPerformer(executor, offer.performerId);
    const snapshot = asRecord(offer.sellerTermsSnapshot);
    const snapshotExclusive = snapshot.isSwayExclusive === true;
    const currentExclusive = Boolean(partner?.isEffective);
    return (
      sellerIsReady(performer)
      && offer.sellerStripeAccountIdSnapshot === performer.stripeConnectedAccountId
      && offer.sellerPaymentAccountStatusSnapshot === performer.paymentAccountStatus
      && offer.sellerKycStatusSnapshot === performer.kycStatus
      && offer.sellerChargesEnabledSnapshot === performer.chargesEnabled
      && offer.sellerPayoutsEnabledSnapshot === performer.payoutsEnabled
      && offer.sellerTermsVersion === NATIVE_TICKET_TERMS_VERSION
      && offer.sellerTermsHash === NATIVE_TICKET_SELLER_TERMS_HASH
      && snapshotExclusive === currentExclusive
      && recordString(snapshot, 'exclusiveEntitlementHash') === (partner?.isEffective ? partner.termsHash : null)
    );
  }

  function getNativeTicketSalesCapability() {
    const reasonCodes = [...runtimeConfig.disabledReasons];
    if (!provider) reasonCodes.push('ticket_processor_unavailable');
    if (
      provider
      && runtimeConfig.taxMode
      && (
        provider.tax.mode !== runtimeConfig.taxMode
        || (
          provider.tax.mode === 'stripe_automatic'
          && provider.tax.productTaxCode !== runtimeConfig.stripeTaxCode
        )
      )
    ) {
      reasonCodes.push('ticket_processor_tax_policy_mismatch');
    }
    return {
      salesAvailable: runtimeConfig.salesEnabled
        && Boolean(provider)
        && reasonCodes.length === 0,
      reasonCodes: [...new Set(reasonCodes)],
      feeBps: runtimeConfig.feeBps,
      feeFixedCents: runtimeConfig.feeFixedCents,
      taxMode: runtimeConfig.taxMode,
      supportEmail: null,
      reservationMinutes: runtimeConfig.reservationMinutes,
      refundGraceMinutes: runtimeConfig.refundGraceMinutes,
      termsVersion: NATIVE_TICKET_TERMS_VERSION,
      termsHash: NATIVE_TICKET_SELLER_TERMS_HASH
    };
  }

  async function getOwnerNativeTicketSalesCapability(input: {
    performerId: string;
    actorUserId: string;
  }) {
    assertUuid(input.performerId, 'performerId');
    assertUuid(input.actorUserId, 'actorUserId');
    const capability = getNativeTicketSalesCapability();
    const [performer] = await db
      .select()
      .from(performers)
      .where(and(
        eq(performers.id, input.performerId),
        eq(performers.ownerUserId, input.actorUserId)
      ))
      .limit(1);
    if (!performer) {
      serviceError(403, 'ticket_event_owner_required', 'Only the performer owner can manage native tickets.');
    }
    const reasonCodes = [...capability.reasonCodes];
    try {
      assertSellerReady(performer);
    } catch (error) {
      if (error instanceof EventTicketServiceError) {
        reasonCodes.push(error.code);
      } else {
        throw error;
      }
    }
    return {
      ...capability,
      salesAvailable: capability.salesAvailable && reasonCodes.length === 0,
      reasonCodes: [...new Set(reasonCodes)]
    };
  }

  async function requireOwnerContext(
    executor: DbExecutor,
    input: {
      eventId: string;
      performerId: string;
      actorUserId: string;
      lock?: boolean;
    }
  ) {
    assertUuid(input.eventId, 'eventId');
    assertUuid(input.performerId, 'performerId');
    assertUuid(input.actorUserId, 'actorUserId');
    const [sellerAccount] = await executor
      .select({
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt
      })
      .from(users)
      .where(eq(users.id, input.actorUserId))
      .limit(1);
    const query = executor
      .select({
        event: performerEvents,
        performerId: performers.id,
        ownerUserId: performers.ownerUserId,
        performerDisplayName: performers.displayName,
        isActive: performers.isActive,
        onboardingStatus: performers.onboardingStatus,
        paymentAccountStatus: performers.paymentAccountStatus,
        kycStatus: performers.kycStatus,
        chargesEnabled: performers.chargesEnabled,
        payoutsEnabled: performers.payoutsEnabled,
        stripeConnectedAccountId: performers.stripeConnectedAccountId,
        payoutHoldReason: performers.payoutHoldReason
      })
      .from(performerEvents)
      .innerJoin(performers, eq(performers.id, performerEvents.performerId))
      .where(and(
        eq(performerEvents.id, input.eventId),
        eq(performerEvents.performerId, input.performerId),
        eq(performers.ownerUserId, input.actorUserId)
      ));
    const [row] = input.lock
      ? await query.for('update').limit(1)
      : await query.limit(1);
    if (!row) {
      serviceError(403, 'ticket_event_owner_required', 'Only the performer owner can manage this ticket event.');
    }
    if (!sellerAccount?.email || !sellerAccount.emailVerifiedAt) {
      serviceError(
        409,
        'ticket_seller_support_email_required',
        'Verify the seller account email before offering native tickets.'
      );
    }
    return {
      ...row,
      sellerSupportEmail: sellerAccount.email,
      sellerSupportEmailVerifiedAt: sellerAccount.emailVerifiedAt
    };
  }

  async function requireVerifiedBuyer(executor: DbExecutor, buyerUserId: string) {
    assertUuid(buyerUserId, 'buyerUserId');
    const [buyer] = await executor
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        emailVerifiedAt: users.emailVerifiedAt
      })
      .from(users)
      .where(eq(users.id, buyerUserId))
      .limit(1);
    if (!buyer) {
      serviceError(401, 'ticket_buyer_auth_required', 'Log in before buying or viewing tickets.');
    }
    if (!buyer.emailVerifiedAt || !buyer.email) {
      serviceError(403, 'ticket_buyer_email_verification_required', 'Verify your email before buying tickets.');
    }
    return buyer;
  }

  async function getOfferByEvent(
    executor: DbExecutor,
    eventId: string,
    lock = false
  ): Promise<OfferRow | null> {
    const query = executor
      .select()
      .from(eventTicketOffers)
      .where(eq(eventTicketOffers.eventId, eventId));
    const [offer] = lock
      ? await query.for('update').limit(1)
      : await query.limit(1);
    return offer ?? null;
  }

  async function getOwnerTicketOffer(input: {
    eventId: string;
    performerId: string;
    actorUserId: string;
  }): Promise<OwnerTicketOfferDto | null> {
    await requireOwnerContext(db, input);
    const offer = await getOfferByEvent(db, input.eventId);
    return offer ? serializeOwnerOffer(offer) : null;
  }

  async function updateOwnerTicketOffer(input: {
    eventId: string;
    performerId: string;
    actorUserId: string;
    capacity: number;
    faceValueCents: number;
    termsAccepted: boolean;
  }): Promise<OwnerTicketOfferDto> {
    const { config } = requireCheckoutAvailability();
    const partner = await loadPartnerEntitlementStateForPerformer(db, input.performerId);
    requireBooleanTrue(
      input.termsAccepted,
      'ticket_seller_terms_required',
      'Accept the current native ticket seller terms before saving this offer.'
    );
    if (!Number.isSafeInteger(input.capacity) || input.capacity < 1 || input.capacity > MAX_CAPACITY) {
      serviceError(422, 'ticket_capacity_invalid', `Capacity must be between 1 and ${MAX_CAPACITY}.`);
    }
    return db.transaction(async (tx: DbExecutor) => {
      const owner = await requireOwnerContext(tx, { ...input, lock: true });
      const isSwayExclusive = Boolean(partner?.isEffective);
      const price = calculateNativeTicketPrice({
        faceValueCents: input.faceValueCents,
        feeBps: config.feeBps,
        feeFixedCents: config.feeFixedCents,
        feeCapCents: isSwayExclusive ? NATIVE_TICKET_EXCLUSIVE_FEE_CAP_CENTS : null
      });
      const sellerTermsSnapshot = buildNativeTicketSellerTermsSnapshot(runtimeConfig, {
        supportEmail: owner.sellerSupportEmail,
        isSwayExclusive,
        exclusiveEntitlementVersion: partner?.isEffective ? partner.termsVersion : null,
        exclusiveEntitlementHash: partner?.isEffective ? partner.termsHash : null
      });
      if (owner.event.ticketingMode !== 'native_ga') {
        serviceError(409, 'native_ticket_mode_required', 'This event is not configured for native general admission.');
      }
      if (owner.event.status !== 'draft') {
        serviceError(409, 'ticket_offer_locked', 'Native ticket price and capacity lock when the event is published.');
      }
      if (!owner.event.endsAt) {
        serviceError(422, 'native_ticket_event_end_required', 'A native ticket event requires an end time.');
      }
      const now = clock();
      if (
        !owner.event.doorOpensAt
        || owner.event.doorOpensAt.getTime() <= now.getTime()
      ) {
        serviceError(
          409,
          'event_door_not_future',
          'Set a future door-opening time before offering native tickets.'
        );
      }
      if (owner.event.startsAt.getTime() <= now.getTime()) {
        serviceError(409, 'event_start_not_future', 'Only a future event can offer native tickets.');
      }
      assertSellerReady(owner);

      const existing = await getOfferByEvent(tx, input.eventId, true);
      if (existing && existing.status !== 'draft') {
        serviceError(409, 'ticket_offer_locked', 'This native ticket offer can no longer be edited.');
      }
      if (existing) {
        const [{ count: orderCount }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(ticketOrders)
          .where(eq(ticketOrders.offerId, existing.id));
        if (Number(orderCount) > 0) {
          serviceError(409, 'ticket_offer_has_orders', 'Ticket terms cannot change after checkout activity begins.');
        }
      }

      const values = {
        eventId: input.eventId,
        performerId: input.performerId,
        status: 'draft' as const,
        capacity: input.capacity,
        faceValueCents: price.faceValueCents,
        mandatoryFeeBps: price.feeBps,
        mandatoryFeeFixedCents: price.feeFixedCents,
        mandatoryFeeCents: price.mandatoryFeeCents,
        advertisedTotalCents: price.totalPriceCents,
        sellerTransferAmountCents: price.faceValueCents,
        currency: 'USD',
        taxMode: config.taxMode,
        stripeTaxCode: config.taxMode === 'stripe_automatic' ? config.stripeTaxCode : null,
        settlementPolicy: 'refund_only' as const,
        checkoutReservationMinutes: runtimeConfig.reservationMinutes,
        refundGraceMinutes: runtimeConfig.refundGraceMinutes,
        salesOpenAt: now,
        salesCloseAt: owner.event.startsAt,
        sellerStripeAccountIdSnapshot: owner.stripeConnectedAccountId!,
        sellerPaymentAccountStatusSnapshot: owner.paymentAccountStatus,
        sellerKycStatusSnapshot: owner.kycStatus,
        sellerChargesEnabledSnapshot: owner.chargesEnabled,
        sellerPayoutsEnabledSnapshot: owner.payoutsEnabled,
        payoutReadinessCheckedAt: now,
        sellerTermsVersion: NATIVE_TICKET_TERMS_VERSION,
        sellerTermsHash: NATIVE_TICKET_SELLER_TERMS_HASH,
        sellerTermsText: NATIVE_TICKET_SELLER_TERMS_TEXT,
        sellerTermsSnapshot,
        sellerTermsAcceptedByUserId: input.actorUserId,
        sellerTermsAcceptedAt: now,
        createdByActorUserId: input.actorUserId,
        lastMutationActorUserId: input.actorUserId,
        updatedAt: now
      };

      const [saved] = existing
        ? await tx
            .update(eventTicketOffers)
            .set(values)
            .where(and(
              eq(eventTicketOffers.id, existing.id),
              eq(eventTicketOffers.status, 'draft')
            ))
            .returning()
        : await tx
            .insert(eventTicketOffers)
            .values({ id: randomUUID(), ...values, createdAt: now })
            .returning();
      if (!saved) {
        serviceError(409, 'ticket_offer_version_conflict', 'Ticket offer changed in another session.');
      }

      await writeTicketAudit(tx, {
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'event_ticket_offer',
        entityId: saved.id,
        eventType: existing ? 'event_ticket_offer.update' : 'event_ticket_offer.create',
        previousStatus: existing?.status ?? null,
        nextStatus: saved.status,
        metadata: {
          eventId: input.eventId,
          performerId: input.performerId,
          capacity: saved.capacity,
          advertisedTotalCents: saved.advertisedTotalCents,
          termsVersion: saved.sellerTermsVersion,
          termsHash: saved.sellerTermsHash
        }
      });
      return serializeOwnerOffer(saved);
    });
  }

  async function publishNativeEvent(input: {
    eventId: string;
    performerId: string;
    actorUserId: string;
    expectedUpdatedAt: string;
  }) {
    const { config } = requireCheckoutAvailability();
    const expectedUpdatedAt = parseExpectedUpdatedAt(input.expectedUpdatedAt);
    return db.transaction(async (tx: DbExecutor) => {
      const owner = await requireOwnerContext(tx, { ...input, lock: true });
      assertSellerReady(owner);
      const offer = await getOfferByEvent(tx, input.eventId, true);
      if (!offer) {
        serviceError(409, 'ticket_offer_required', 'Save the native ticket price, capacity, and terms before publishing.');
      }
      assertOfferMatchesActivePolicy(offer, config);
      if (owner.event.ticketingMode !== 'native_ga') {
        serviceError(409, 'native_ticket_mode_required', 'This event is not configured for native general admission.');
      }
      if (
        owner.event.status === 'published'
        && offer.status === 'on_sale'
      ) {
        return { event: owner.event, offer: serializeOwnerOffer(offer) };
      }
      if (owner.event.status !== 'draft' || offer.status !== 'draft') {
        serviceError(409, 'native_ticket_publish_state_invalid', 'This event or ticket offer cannot be published.');
      }
      if (owner.event.updatedAt.toISOString() !== expectedUpdatedAt.toISOString()) {
        serviceError(409, 'event_version_conflict', 'Event changed in another session. Reload before publishing.');
      }
      const now = clock();
      if (
        !owner.event.doorOpensAt
        || owner.event.doorOpensAt.getTime() <= now.getTime()
        || !owner.event.endsAt
        || owner.event.startsAt.getTime() <= now.getTime()
      ) {
        serviceError(
          422,
          'native_ticket_event_window_invalid',
          'Native ticket events require a future door-opening time, a future start, and an end time.'
        );
      }
      if (!resolveNativeTicketPerformanceLocation(owner.event)) {
        serviceError(
          422,
          'native_ticket_performance_location_required',
          'Native ticket events require a complete US street address, city, state, and ZIP code for ticket tax.'
        );
      }
      if (
        offer.sellerTermsVersion !== NATIVE_TICKET_TERMS_VERSION
        || offer.sellerTermsHash !== NATIVE_TICKET_SELLER_TERMS_HASH
      ) {
        serviceError(409, 'ticket_seller_terms_stale', 'Review and accept the current native ticket seller terms.');
      }
      if (
        offer.sellerStripeAccountIdSnapshot !== owner.stripeConnectedAccountId
        || offer.sellerPaymentAccountStatusSnapshot !== owner.paymentAccountStatus
        || offer.sellerKycStatusSnapshot !== owner.kycStatus
        || !offer.sellerChargesEnabledSnapshot
        || !offer.sellerPayoutsEnabledSnapshot
      ) {
        serviceError(409, 'ticket_seller_snapshot_stale', 'Save the ticket offer again after refreshing payout readiness.');
      }
      const mutationTime = new Date(Math.max(now.getTime(), owner.event.updatedAt.getTime() + 1));
      const [published] = await tx
        .update(performerEvents)
        .set({
          status: 'published',
          publishedAt: mutationTime,
          lastMutationActorUserId: input.actorUserId,
          updatedAt: mutationTime
        })
        .where(and(
          eq(performerEvents.id, input.eventId),
          eq(performerEvents.status, 'draft'),
          eq(performerEvents.updatedAt, owner.event.updatedAt)
        ))
        .returning();
      const [activated] = await tx
        .update(eventTicketOffers)
        .set({
          status: 'on_sale',
          salesOpenAt: mutationTime,
          salesCloseAt: owner.event.startsAt,
          activatedAt: mutationTime,
          lastMutationActorUserId: input.actorUserId,
          updatedAt: mutationTime
        })
        .where(and(
          eq(eventTicketOffers.id, offer.id),
          eq(eventTicketOffers.status, 'draft')
        ))
        .returning();
      if (!published || !activated) {
        serviceError(409, 'native_ticket_publish_conflict', 'Event changed in another session. Reload before publishing.');
      }
      await writeTicketAudit(tx, {
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'event_ticket_offer',
        entityId: activated.id,
        eventType: 'event_ticket_offer.publish',
        previousStatus: 'draft',
        nextStatus: 'on_sale',
        metadata: { eventId: input.eventId, performerId: input.performerId }
      });
      return { event: published, offer: serializeOwnerOffer(activated) };
    });
  }

  async function enqueueOperation(
    executor: DbExecutor,
    input: {
      orderId: string;
      ticketId?: string | null;
      operationType: TicketOperationType;
      amountCents?: number | null;
      requestPayload: Record<string, unknown>;
      now: Date;
    }
  ): Promise<OperationRow> {
    const [inserted] = await executor
      .insert(ticketPaymentOperations)
      .values({
        id: randomUUID(),
        orderId: input.orderId,
        ticketId: input.ticketId ?? null,
        operationType: input.operationType,
        status: 'pending',
        processor: 'stripe',
        idempotencyKey: operationKey(input.orderId, input.operationType),
        amountCents: input.amountCents ?? null,
        currency: 'USD',
        requestPayload: input.requestPayload,
        availableAt: input.now,
        createdAt: input.now,
        updatedAt: input.now
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    const [existing] = await executor
      .select()
      .from(ticketPaymentOperations)
      .where(and(
        eq(ticketPaymentOperations.orderId, input.orderId),
        eq(ticketPaymentOperations.operationType, input.operationType)
      ))
      .limit(1);
    if (!existing) {
      serviceError(500, 'ticket_operation_persistence_failed', 'Ticket payment operation could not be persisted.');
    }
    return existing;
  }

  async function cancelNativeEvent(input: {
    eventId: string;
    performerId: string;
    actorUserId: string;
    expectedUpdatedAt: string;
    cancellationReason: string;
  }) {
    const expectedUpdatedAt = parseExpectedUpdatedAt(input.expectedUpdatedAt);
    const reason = normalizeRequiredText(
      input.cancellationReason,
      'Cancellation reason',
      MAX_CANCELLATION_REASON_LENGTH
    );
    return db.transaction(async (tx: DbExecutor) => {
      const owner = await requireOwnerContext(tx, { ...input, lock: true });
      const offer = await getOfferByEvent(tx, input.eventId, true);
      if (!offer || owner.event.ticketingMode !== 'native_ga') {
        serviceError(409, 'native_ticket_offer_required', 'This event does not have a native ticket offer.');
      }
      if (owner.event.status === 'cancelled') {
        if (owner.event.cancellationReason !== reason) {
          serviceError(409, 'event_already_cancelled', 'This event was already cancelled with a different reason.');
        }
        return {
          event: owner.event,
          offer: serializeOwnerOffer(offer),
          refundsQueued: 0,
          admittedTicketsPreserved: 0,
          disputedTicketsPreserved: 0
        };
      }
      if (owner.event.status !== 'published' || offer.status === 'cancelled') {
        serviceError(409, 'native_ticket_cancel_state_invalid', 'Only a published native ticket event can be cancelled.');
      }
      if (owner.event.updatedAt.toISOString() !== expectedUpdatedAt.toISOString()) {
        serviceError(409, 'event_version_conflict', 'Event changed in another session. Reload before cancelling.');
      }

      const now = clock();
      const orderRows = await tx
        .select({ order: ticketOrders, ticket: eventTickets })
        .from(ticketOrders)
        .leftJoin(eventTickets, eq(eventTickets.orderId, ticketOrders.id))
        .where(and(
          eq(ticketOrders.eventId, input.eventId),
          inArray(ticketOrders.status, RESERVED_ORDER_STATUSES)
        ))
        .for('update', { of: ticketOrders });
      let refundsQueued = 0;
      let admittedTicketsPreserved = 0;
      let disputedTicketsPreserved = 0;
      for (const row of orderRows) {
        const isDisputed = (
          row.order.status === 'disputed'
          || row.ticket?.status === 'disputed'
        );
        if (isDisputed) {
          disputedTicketsPreserved += 1;
          continue;
        }
        const isAdmitted = Boolean(
          row.ticket?.admissionAcceptedAt
          || (
            row.ticket
            && ['release_pending', 'released'].includes(row.ticket.status)
          )
        );
        if (isAdmitted) {
          admittedTicketsPreserved += 1;
          continue;
        }
        if (
          row.ticket
          && row.order.chargedTotalCents
          && row.order.processorPaymentIntentId
          && row.ticket.status === 'held'
        ) {
          await tx
            .update(eventTickets)
            .set({ status: 'refund_pending', refundPendingAt: now, updatedAt: now })
            .where(and(eq(eventTickets.id, row.ticket.id), eq(eventTickets.status, 'held')));
          await tx
            .update(ticketOrders)
            .set({ status: 'refund_pending', refundPendingAt: now, updatedAt: now })
            .where(eq(ticketOrders.id, row.order.id));
          await enqueueOperation(tx, {
            orderId: row.order.id,
            ticketId: row.ticket.id,
            operationType: 'create_buyer_refund',
            amountCents: row.order.chargedTotalCents,
            requestPayload: {
              reason: 'seller_event_cancellation',
              paymentIntentId: row.order.processorPaymentIntentId
            },
            now
          });
          refundsQueued += 1;
        } else {
          await tx
            .update(ticketOrders)
            .set({ status: 'voided', voidedAt: now, updatedAt: now })
            .where(and(
              eq(ticketOrders.id, row.order.id),
              inArray(ticketOrders.status, ['checkout_pending', 'checkout_open'])
            ));
          if (row.order.processorCheckoutSessionId) {
            await enqueueOperation(tx, {
              orderId: row.order.id,
              operationType: 'expire_checkout',
              requestPayload: {
                reason: 'seller_event_cancellation',
                checkoutSessionId: row.order.processorCheckoutSessionId
              },
              now
            });
          }
        }
      }

      const mutationTime = new Date(Math.max(now.getTime(), owner.event.updatedAt.getTime() + 1));
      const [cancelledEvent] = await tx
        .update(performerEvents)
        .set({
          status: 'cancelled',
          cancelledAt: mutationTime,
          cancellationReason: reason,
          lastMutationActorUserId: input.actorUserId,
          updatedAt: mutationTime
        })
        .where(and(
          eq(performerEvents.id, input.eventId),
          eq(performerEvents.status, 'published'),
          eq(performerEvents.updatedAt, owner.event.updatedAt)
        ))
        .returning();
      const [cancelledOffer] = await tx
        .update(eventTicketOffers)
        .set({
          status: 'cancelled',
          cancelledAt: mutationTime,
          lastMutationActorUserId: input.actorUserId,
          updatedAt: mutationTime
        })
        .where(and(
          eq(eventTicketOffers.id, offer.id),
          ne(eventTicketOffers.status, 'cancelled')
        ))
        .returning();
      if (!cancelledEvent || !cancelledOffer) {
        serviceError(409, 'native_ticket_cancel_conflict', 'Event changed in another session. Reload before cancelling.');
      }
      await writeTicketAudit(tx, {
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'event_ticket_offer',
        entityId: offer.id,
        eventType: 'event_ticket_offer.cancel',
        previousStatus: offer.status,
        nextStatus: 'cancelled',
        metadata: {
          eventId: input.eventId,
          performerId: input.performerId,
          cancellationReason: reason,
          refundsQueued,
          admittedTicketsPreserved,
          disputedTicketsPreserved,
          admittedSettlementPolicy: 'continue_without_clawback',
          disputedSettlementPolicy: 'controlled_support'
        }
      });
      return {
        event: cancelledEvent,
        offer: serializeOwnerOffer(cancelledOffer),
        refundsQueued,
        admittedTicketsPreserved,
        disputedTicketsPreserved
      };
    });
  }

  async function reservedOrderCount(executor: DbExecutor, offerId: string) {
    const [{ count }] = await executor
      .select({ count: sql<number>`count(*)::int` })
      .from(ticketOrders)
      .where(and(
        eq(ticketOrders.offerId, offerId),
        inArray(ticketOrders.status, RESERVED_ORDER_STATUSES),
        sql`not (${ticketOrders.status} = 'disputed' and ${ticketOrders.refundedAt} is not null)`,
        sql`not (
          ${ticketOrders.status} = 'refund_pending'
          and (
            ${ticketOrders.expiredAt} is not null
            or ${ticketOrders.paymentFailedAt} is not null
            or ${ticketOrders.voidedAt} is not null
          )
        )`
      ));
    return Number(count ?? 0);
  }

  function projectedSalesStatus(
    event: EventRow,
    offer: OfferRow,
    remainingCount: number,
    now: Date
  ): PublicTicketOfferDto['salesStatus'] {
    if (event.status === 'cancelled' || offer.status === 'cancelled') return 'cancelled';
    if (offer.status === 'draft' || now.getTime() < offer.salesOpenAt.getTime()) return 'scheduled';
    if (
      offer.status === 'sales_closed'
      || event.status !== 'published'
      || now.getTime() >= offer.salesCloseAt.getTime()
      || now.getTime() + offer.checkoutReservationMinutes * 60_000
        > offer.salesCloseAt.getTime()
    ) return 'closed';
    if (remainingCount <= 0) return 'sold_out';
    return 'on_sale';
  }

  async function getPublicOfferProjection(input: {
    eventId: string;
    now?: Date;
  }): Promise<PublicTicketOfferDto | null> {
    assertUuid(input.eventId, 'eventId');
    const [row] = await db
      .select({
        event: performerEvents,
        offer: eventTicketOffers,
        performer: performers
      })
      .from(performerEvents)
      .innerJoin(eventTicketOffers, eq(eventTicketOffers.eventId, performerEvents.id))
      .innerJoin(performers, eq(performers.id, performerEvents.performerId))
      .where(and(
        eq(performerEvents.id, input.eventId),
        eq(performerEvents.ticketingMode, 'native_ga'),
        inArray(performerEvents.status, ['published', 'cancelled'])
      ))
      .limit(1);
    if (!row) return null;
    const reserved = await reservedOrderCount(db, row.offer.id);
    const remainingCount = Math.max(0, row.offer.capacity - reserved);
    const salesStatus = projectedSalesStatus(
      row.event,
      row.offer,
      remainingCount,
      input.now ?? clock()
    );
    const activeOfferPolicy = (
      runtimeConfig.feeBps !== null
      && runtimeConfig.feeFixedCents !== null
      && runtimeConfig.taxMode !== null
      && offerMatchesActivePolicy(row.offer, {
        feeBps: runtimeConfig.feeBps,
        feeFixedCents: runtimeConfig.feeFixedCents,
        taxMode: runtimeConfig.taxMode,
        stripeTaxCode: runtimeConfig.stripeTaxCode,
        qrSecret: runtimeConfig.qrSecret ?? '',
        appBaseUrl: runtimeConfig.appBaseUrl ?? '',
        supportEmail: runtimeConfig.supportEmail ?? ''
      })
    );
    const capability = getNativeTicketSalesCapability();
    const activeSeller = await offerMatchesCurrentSeller(row.offer, row.performer);
    const sellerSupportEmail = recordString(asRecord(row.offer.sellerTermsSnapshot), 'sellerSupportEmail') ?? '';
    return {
      mode: 'native_ga',
      salesStatus: salesStatus === 'on_sale'
        && (!capability.salesAvailable || !activeOfferPolicy || !activeSeller)
        ? 'closed'
        : salesStatus,
      currency: 'USD',
      faceValueCents: row.offer.faceValueCents,
      mandatoryFeeCents: row.offer.mandatoryFeeCents,
      unitAllInPriceCents: row.offer.advertisedTotalCents,
      remainingCount,
      termsVersion: NATIVE_TICKET_TERMS_VERSION,
      termsHash: NATIVE_TICKET_BUYER_TERMS_HASH,
      refundGraceMinutes: row.offer.refundGraceMinutes,
      sellerSupportEmail
    };
  }

  async function loadCheckoutOperation(executor: DbExecutor, orderId: string) {
    const [operation] = await executor
      .select()
      .from(ticketPaymentOperations)
      .where(and(
        eq(ticketPaymentOperations.orderId, orderId),
        eq(ticketPaymentOperations.operationType, 'create_checkout')
      ))
      .limit(1);
    return operation ?? null;
  }

  async function checkoutResponse(order: OrderRow) {
    const operation = await loadCheckoutOperation(db, order.id);
    const result = asRecord(operation?.resultPayload);
    const checkoutUrl = ['checkout_pending', 'checkout_open'].includes(order.status)
      ? normalizeHostedCheckoutUrl(recordString(result, 'checkoutUrl'))
      : null;
    const [ticket] = await db
      .select({ id: eventTickets.id })
      .from(eventTickets)
      .where(eq(eventTickets.orderId, order.id))
      .limit(1);
    return {
      orderId: order.id,
      checkoutUrl,
      ticketId: ticket?.id ?? null,
      status: publicOrderStatus(order.status)
    };
  }

  async function createCheckoutOrder(input: {
    eventId: string;
    buyerUserId: string;
    clientRequestId: string;
    termsAccepted: boolean;
  }) {
    const { config } = requireCheckoutAvailability();
    assertUuid(input.eventId, 'eventId');
    assertUuid(input.clientRequestId, 'clientRequestId');
    requireBooleanTrue(
      input.termsAccepted,
      'ticket_buyer_terms_required',
      'Accept the current native ticket purchase terms before checkout.'
    );
    const fingerprint = sha256(canonicalJson({
      eventId: input.eventId,
      quantity: 1,
      termsVersion: NATIVE_TICKET_TERMS_VERSION,
      termsHash: NATIVE_TICKET_BUYER_TERMS_HASH
    }));

    const created = await db.transaction(async (tx: DbExecutor) => {
      const buyer = await requireVerifiedBuyer(tx, input.buyerUserId);
      const [event] = await tx
        .select({ event: performerEvents, performer: performers })
        .from(performerEvents)
        .innerJoin(performers, eq(performers.id, performerEvents.performerId))
        .where(eq(performerEvents.id, input.eventId))
        .for('update')
        .limit(1);
      const offer = await getOfferByEvent(tx, input.eventId, true);
      if (!event || !offer) {
        serviceError(404, 'ticket_offer_not_found', 'Native ticket offer not found.');
      }
      if (event.performer.ownerUserId === input.buyerUserId) {
        serviceError(
          403,
          'ticket_seller_self_purchase_forbidden',
          'A performer owner cannot buy their own native event ticket.'
        );
      }

      const [existing] = await tx
        .select()
        .from(ticketOrders)
        .where(and(
          eq(ticketOrders.buyerUserId, input.buyerUserId),
          eq(ticketOrders.clientRequestId, input.clientRequestId)
        ))
        .limit(1);
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          serviceError(409, 'ticket_order_idempotency_conflict', 'clientRequestId was already used for a different ticket checkout.');
        }
        if (['expired', 'payment_failed', 'voided', 'refunded'].includes(existing.status)) {
          serviceError(409, 'ticket_order_request_consumed', 'This checkout request is already closed. Start a new checkout.');
        }
        return { order: existing, operationId: null as string | null, created: false };
      }
      const [activeBuyerOrder] = await tx
        .select({ id: ticketOrders.id })
        .from(ticketOrders)
        .where(and(
          eq(ticketOrders.offerId, offer.id),
          eq(ticketOrders.buyerUserId, input.buyerUserId),
          inArray(ticketOrders.status, BUYER_EVENT_LIMIT_STATUSES)
        ))
        .limit(1);
      if (activeBuyerOrder) {
        serviceError(
          409,
          'ticket_buyer_offer_limit',
          'This verified Sway account already has an issued, paid, or pending ticket record for this event.'
        );
      }

      assertSellerReady(event.performer);
      const now = clock();
      if (
        event.event.status !== 'published'
        || event.event.ticketingMode !== 'native_ga'
        || offer.status !== 'on_sale'
        || now.getTime() < offer.salesOpenAt.getTime()
        || now.getTime() >= offer.salesCloseAt.getTime()
        || now.getTime() + offer.checkoutReservationMinutes * 60_000
          > offer.salesCloseAt.getTime()
      ) {
        serviceError(409, 'ticket_sales_not_open', 'Native ticket sales are not open for this event.');
      }
      if (!await offerMatchesCurrentSeller(offer, event.performer, tx)) {
        serviceError(409, 'ticket_offer_snapshot_stale', 'The performer must refresh this ticket offer before checkout.');
      }
      assertOfferMatchesActivePolicy(offer, config);
      const reserved = await reservedOrderCount(tx, offer.id);
      if (reserved >= offer.capacity) {
        serviceError(409, 'ticket_offer_sold_out', 'This native ticket offer is sold out.');
      }

      const buyerTermsSnapshot = buildNativeTicketBuyerTermsSnapshot({
        eventId: event.event.id,
        offerId: offer.id,
        performerId: offer.performerId,
        performerDisplayName: event.performer.displayName,
        sellerSupportEmail: recordString(asRecord(offer.sellerTermsSnapshot), 'sellerSupportEmail')
          ?? serviceError(409, 'ticket_seller_support_email_missing', 'The seller support contact is missing.'),
        eventTitle: event.event.title,
        startsAt: event.event.startsAt.toISOString(),
        endsAt: event.event.endsAt!.toISOString(),
        timeZone: event.event.timeZone,
        locationName: event.event.locationName,
        locationAddress: event.event.locationAddress,
        city: event.event.city,
        locationIsTba: event.event.locationIsTba,
        salesCloseAt: offer.salesCloseAt.toISOString(),
        admissionOpensAt: event.event.doorOpensAt!.toISOString(),
        admissionClosesAt: new Date(
          event.event.endsAt!.getTime() + offer.refundGraceMinutes * 60_000
        ).toISOString(),
        faceValueCents: offer.faceValueCents,
        mandatoryFeeCents: offer.mandatoryFeeCents,
        totalPriceCents: offer.advertisedTotalCents,
        quantity: 1,
        currency: 'USD',
        taxMode: offer.taxMode,
        refundGraceMinutes: offer.refundGraceMinutes
      });
      const orderId = randomUUID();
      const reservationExpiresAt = new Date(
        Math.min(
          now.getTime() + offer.checkoutReservationMinutes * 60_000,
          offer.salesCloseAt.getTime()
        )
      );
      const [order] = await tx
        .insert(ticketOrders)
        .values({
          id: orderId,
          offerId: offer.id,
          eventId: offer.eventId,
          performerId: offer.performerId,
          buyerUserId: input.buyerUserId,
          clientRequestId: input.clientRequestId,
          requestFingerprint: fingerprint,
          quantity: 1,
          faceValueCents: offer.faceValueCents,
          mandatoryFeeCents: offer.mandatoryFeeCents,
          advertisedTotalCents: offer.advertisedTotalCents,
          sellerTransferAmountCents: offer.sellerTransferAmountCents,
          currency: 'USD',
          taxModeSnapshot: offer.taxMode,
          stripeTaxCodeSnapshot: offer.stripeTaxCode,
          buyerTermsVersion: NATIVE_TICKET_TERMS_VERSION,
          buyerTermsHash: NATIVE_TICKET_BUYER_TERMS_HASH,
          buyerTermsText: NATIVE_TICKET_BUYER_TERMS_TEXT,
          buyerTermsSnapshot,
          buyerTermsAcceptedAt: now,
          status: 'checkout_pending',
          processor: 'stripe',
          chargeAccount: 'platform',
          captureMode: 'automatic',
          checkoutExpiresAt: reservationExpiresAt,
          createdAt: now,
          updatedAt: now
        })
        .returning();
      const operation = await enqueueOperation(tx, {
        orderId,
        operationType: 'create_checkout',
        amountCents: offer.advertisedTotalCents,
        requestPayload: {
          orderId,
          eventId: event.event.id,
          offerId: offer.id,
          buyerAccountId: buyer.id,
          buyerEmail: buyer.email,
          ticketName: `General admission — ${event.event.title}`,
          ticketDescription: 'One Sway general-admission ticket.',
          amountTotalCents: offer.advertisedTotalCents,
          currency: 'USD',
          successUrl: `${config.appBaseUrl}/tickets/orders/${orderId}/return?checkout={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${config.appBaseUrl}${eventPath(event.event.id)}`,
          expiresAtUnixSeconds: Math.floor(reservationExpiresAt.getTime() / 1_000),
          termsHash: NATIVE_TICKET_BUYER_TERMS_HASH,
          transferGroup: sellerTransferGroup(orderId)
        },
        now
      });
      await writeTicketAudit(tx, {
        actorType: 'account',
        actorId: input.buyerUserId,
        entityType: 'ticket_order',
        entityId: order.id,
        eventType: 'ticket_order.checkout_requested',
        previousStatus: null,
        nextStatus: 'checkout_pending',
        metadata: {
          eventId: input.eventId,
          offerId: offer.id,
          clientRequestId: input.clientRequestId,
          advertisedTotalCents: offer.advertisedTotalCents,
          termsVersion: order.buyerTermsVersion,
          termsHash: order.buyerTermsHash
        }
      });
      return { order, operationId: operation.id, created: true };
    });

    if (created.operationId) {
      await runSpecificOperation(created.operationId, `${defaultWorkerId}:checkout`);
    } else {
      const existingOperation = await loadCheckoutOperation(db, created.order.id);
      if (
        existingOperation
        && ['pending', 'retryable_failed'].includes(existingOperation.status)
      ) {
        await runSpecificOperation(existingOperation.id, `${defaultWorkerId}:checkout-replay`);
      }
    }
    const [latest] = await db
      .select()
      .from(ticketOrders)
      .where(eq(ticketOrders.id, created.order.id))
      .limit(1);
    const response = await checkoutResponse(latest ?? created.order);
    if (
      !response.checkoutUrl
      && !response.ticketId
      && !['paid', 'refund_pending', 'refunded'].includes((latest ?? created.order).status)
    ) {
      serviceError(
        503,
        'ticket_checkout_pending',
        'Ticket checkout is still being prepared. Retry with the same clientRequestId.',
        { retryable: true }
      );
    }
    return response;
  }

  async function getBuyerOrder(input: {
    orderId: string;
    buyerUserId: string;
  }): Promise<BuyerTicketOrderDto> {
    assertUuid(input.orderId, 'orderId');
    await requireVerifiedBuyer(db, input.buyerUserId);
    const [row] = await db
      .select({ order: ticketOrders, event: performerEvents })
      .from(ticketOrders)
      .innerJoin(performerEvents, eq(performerEvents.id, ticketOrders.eventId))
      .where(and(
        eq(ticketOrders.id, input.orderId),
        eq(ticketOrders.buyerUserId, input.buyerUserId)
      ))
      .limit(1);
    if (!row) serviceError(404, 'ticket_order_not_found', 'Ticket order not found.');
    const tickets = await db
      .select({ id: eventTickets.id })
      .from(eventTickets)
      .where(eq(eventTickets.orderId, row.order.id));
    const checkout = await checkoutResponse(row.order);
    return {
      id: row.order.id,
      status: publicOrderStatus(row.order.status),
      checkoutUrl: checkout.checkoutUrl,
      allInTotalCents: row.order.chargedTotalCents ?? row.order.advertisedTotalCents,
      currency: 'USD',
      checkoutExpiresAt: iso(row.order.checkoutExpiresAt),
      failureMessage: orderFailureMessage(row.order.status),
      ticketIds: tickets.map((ticket) => ticket.id),
      event: {
        id: row.event.id,
        title: row.event.title,
        eventPath: eventPath(row.event.id)
      }
    };
  }

  async function listBuyerOrders(input: {
    buyerUserId: string;
    limit?: number;
  }): Promise<BuyerTicketOrderDto[]> {
    await requireVerifiedBuyer(db, input.buyerUserId);
    const limit = Math.max(1, Math.min(25, Math.trunc(Number(input.limit) || 10)));
    const orders = await db
      .select({ id: ticketOrders.id })
      .from(ticketOrders)
      .where(eq(ticketOrders.buyerUserId, input.buyerUserId))
      .orderBy(desc(ticketOrders.createdAt))
      .limit(limit);
    return Promise.all(orders.map(({ id }) => getBuyerOrder({
      orderId: id,
      buyerUserId: input.buyerUserId
    })));
  }

  async function ticketViewRows(input: {
    buyerUserId: string;
    ticketId?: string;
  }) {
    await requireVerifiedBuyer(db, input.buyerUserId);
    if (input.ticketId) assertUuid(input.ticketId, 'ticketId');
    return db
      .select({
        ticket: eventTickets,
        order: ticketOrders,
        offer: eventTicketOffers,
        event: performerEvents,
        performerName: performers.displayName
      })
      .from(eventTickets)
      .innerJoin(ticketOrders, eq(ticketOrders.id, eventTickets.orderId))
      .innerJoin(eventTicketOffers, eq(eventTicketOffers.id, eventTickets.offerId))
      .innerJoin(performerEvents, eq(performerEvents.id, eventTickets.eventId))
      .innerJoin(performers, eq(performers.id, eventTickets.performerId))
      .where(and(
        eq(eventTickets.buyerUserId, input.buyerUserId),
        ...(input.ticketId ? [eq(eventTickets.id, input.ticketId)] : [])
      ))
      .orderBy(desc(eventTickets.createdAt));
  }

  function walletItem(row: Awaited<ReturnType<typeof ticketViewRows>>[number]): BuyerTicketWalletItemDto {
    return {
      id: row.ticket.id,
      status: publicTicketStatus(row.ticket.status),
      settlementStatus: row.ticket.status,
      allInPriceCents: row.order.chargedTotalCents ?? row.order.advertisedTotalCents,
      currency: 'USD',
      createdAt: row.ticket.createdAt.toISOString(),
      checkedInAt: iso(row.ticket.admissionAcceptedAt),
      refundedAt: iso(row.ticket.refundedAt),
      event: {
        id: row.event.id,
        title: row.event.title,
        eventPath: eventPath(row.event.id),
        startsAt: row.event.startsAt.toISOString(),
        endsAt: iso(row.event.endsAt),
        timeZone: row.event.timeZone,
        locationName: row.event.locationName,
        locationAddress: row.event.locationAddress,
        city: row.event.city,
        locationIsTba: row.event.locationIsTba,
        performerName: row.performerName
      }
    };
  }

  async function listBuyerTickets(input: {
    buyerUserId: string;
  }): Promise<BuyerTicketWalletItemDto[]> {
    const rows = await ticketViewRows(input);
    return rows.map(walletItem);
  }

  async function getBuyerTicketPass(input: {
    ticketId: string;
    buyerUserId: string;
  }): Promise<BuyerTicketPassDto> {
    const [row] = await ticketViewRows(input);
    if (!row) serviceError(404, 'event_ticket_not_found', 'Ticket not found.');
    const admissionWindow = admissionWindowFor(row.event, row.offer, clock());
    let qrToken: string | null = null;
    let qrExpiresAt: string | null = null;
    const credentialAvailable = (
      row.ticket.status === 'held'
      && admissionWindow.status === 'open'
    );
    if (credentialAvailable && runtimeConfig.qrSecret) {
      const issued = issueEventTicketQrToken({
        ticketId: row.ticket.id,
        eventId: row.ticket.eventId,
        secret: runtimeConfig.qrSecret,
        now: clock()
      });
      qrToken = issued.token;
      qrExpiresAt = issued.expiresAt.toISOString();
    }
    return {
      ...walletItem(row),
      ticketNumber: row.ticket.id.slice(0, 8).toUpperCase(),
      manualCode: credentialAvailable
        ? manualCodeForStoredTicket(row.ticket, runtimeConfig)
        : null,
      qrToken,
      qrExpiresAt,
      admissionStatus: admissionWindow.status,
      admissionOpensAt: admissionWindow.opensAt.toISOString(),
      admissionClosesAt: admissionWindow.closesAt.toISOString(),
      termsVersion: row.order.buyerTermsVersion,
      termsHash: row.order.buyerTermsHash,
      refundGraceMinutes: row.offer.refundGraceMinutes,
      refundRequestedAt: iso(row.ticket.refundPendingAt)
    };
  }

  async function getDoorSummary(input: {
    eventId: string;
    performerId: string;
    actorUserId: string;
  }): Promise<PerformerDoorSummaryDto> {
    const owner = await requireOwnerContext(db, input);
    const offer = await getOfferByEvent(db, input.eventId);
    if (!offer || owner.event.ticketingMode !== 'native_ga') {
      serviceError(404, 'native_ticket_door_not_found', 'Native ticket door not found.');
    }
    const counts = await db
      .select({ status: eventTickets.status, count: sql<number>`count(*)::int` })
      .from(eventTickets)
      .where(eq(eventTickets.eventId, input.eventId))
      .groupBy(eventTickets.status);
    const count = (statuses: TicketStatus[]) => counts
      .filter((row: { status: TicketStatus }) => statuses.includes(row.status))
      .reduce((sum: number, row: { count: number }) => sum + Number(row.count), 0);
    const admissionWindow = admissionWindowFor(owner.event, offer, clock());
    return {
      event: {
        id: owner.event.id,
        title: owner.event.title,
        startsAt: owner.event.startsAt.toISOString(),
        endsAt: iso(owner.event.endsAt),
        timeZone: owner.event.timeZone,
        status: owner.event.status
      },
      canCheckIn: admissionWindow.status === 'open',
      admissionWindow: {
        status: admissionWindow.status,
        opensAt: admissionWindow.opensAt.toISOString(),
        closesAt: admissionWindow.closesAt.toISOString()
      },
      counts: {
        sold: count(['held', 'release_pending', 'released', 'refund_pending', 'refunded', 'disputed']),
        active: count(['held']),
        checkedIn: count(['release_pending', 'released']),
        refundPending: count(['refund_pending']),
        refunded: count(['refunded'])
      }
    };
  }

  async function checkIn(input: {
    eventId: string;
    performerId: string;
    actorUserId: string;
    clientRequestId: string;
    qrToken?: string;
    manualCode?: string;
  }) {
    assertUuid(input.clientRequestId, 'clientRequestId');
    const hasQr = typeof input.qrToken === 'string' && input.qrToken.trim().length > 0;
    const normalizedManual = normalizeManualCode(input.manualCode);
    if (hasQr === Boolean(normalizedManual)) {
      serviceError(422, 'ticket_admission_credential_invalid', 'Provide exactly one current QR token or manual code.');
    }

    let ticketIdFromQr: string | null = null;
    let presentedCredentialHash: string;
    let credentialType: 'rotating_qr' | 'manual_code';
    if (hasQr) {
      const config = requireAdmissionConfiguration(runtimeConfig);
      const verified = verifyEventTicketQrToken({
        token: input.qrToken!,
        eventId: input.eventId,
        secret: config.qrSecret,
        now: clock()
      });
      if (!verified) {
        serviceError(422, 'ticket_qr_invalid', 'This rotating ticket QR is invalid or expired.');
      }
      ticketIdFromQr = verified.ticketId;
      presentedCredentialHash = sha256(input.qrToken!.trim());
      credentialType = 'rotating_qr';
    } else {
      presentedCredentialHash = sha256(normalizedManual!);
      credentialType = 'manual_code';
    }

    return db.transaction(async (tx: DbExecutor) => {
      const owner = await requireOwnerContext(tx, { ...input, lock: true });
      const offer = await getOfferByEvent(tx, input.eventId, true);
      if (!offer || admissionWindowFor(owner.event, offer, clock()).status !== 'open') {
        serviceError(409, 'ticket_door_closed', 'The online admission window is not open for this event.');
      }

      const [existingRequest] = await tx
        .select({ admission: ticketAdmissionEvents, ticket: eventTickets })
        .from(ticketAdmissionEvents)
        .innerJoin(eventTickets, eq(eventTickets.id, ticketAdmissionEvents.ticketId))
        .where(and(
          eq(ticketAdmissionEvents.acceptedByUserId, input.actorUserId),
          eq(ticketAdmissionEvents.clientRequestId, input.clientRequestId)
        ))
        .limit(1);

      const ticketQuery = tx
        .select({ ticket: eventTickets, order: ticketOrders, buyerEmail: users.email })
        .from(eventTickets)
        .innerJoin(ticketOrders, eq(ticketOrders.id, eventTickets.orderId))
        .innerJoin(users, eq(users.id, eventTickets.buyerUserId))
        .where(and(
          eq(eventTickets.eventId, input.eventId),
          ...(ticketIdFromQr
            ? [eq(eventTickets.id, ticketIdFromQr)]
            : [eq(eventTickets.admissionCredentialHash, presentedCredentialHash)])
        ));
      const matching = await ticketQuery.for('update').limit(2);
      if (matching.length !== 1) {
        serviceError(404, 'event_ticket_not_found', 'No valid ticket matches this admission credential.');
      }
      const row = matching[0];
      if (existingRequest) {
        if (existingRequest.ticket.id !== row.ticket.id) {
          serviceError(409, 'ticket_checkin_idempotency_conflict', 'clientRequestId was already used for a different ticket.');
        }
        return {
          result: 'already_accepted' as const,
          acceptedAt: existingRequest.admission.acceptedAt.toISOString(),
          releaseStatus: existingRequest.ticket.status === 'released' ? 'recorded' as const : 'pending' as const,
          ticket: {
            id: existingRequest.ticket.id,
            ordinal: null,
            maskedBuyerLabel: maskBuyerEmail(row.buyerEmail)
          }
        };
      }
      const [existingAdmission] = await tx
        .select()
        .from(ticketAdmissionEvents)
        .where(eq(ticketAdmissionEvents.ticketId, row.ticket.id))
        .limit(1);
      if (existingAdmission || row.ticket.status === 'release_pending' || row.ticket.status === 'released') {
        return {
          result: 'already_accepted' as const,
          acceptedAt: (existingAdmission?.acceptedAt ?? row.ticket.admissionAcceptedAt)!.toISOString(),
          releaseStatus: row.ticket.status === 'released' ? 'recorded' as const : 'pending' as const,
          ticket: {
            id: row.ticket.id,
            ordinal: null,
            maskedBuyerLabel: maskBuyerEmail(row.buyerEmail)
          }
        };
      }
      if (row.ticket.status !== 'held' || row.order.status !== 'paid') {
        serviceError(409, 'event_ticket_not_active', 'This ticket is not valid for admission.');
      }
      if (
        !row.order.processorChargeId
        || !row.order.processorPaymentIntentId
        || row.order.sellerTransferAmountCents <= 0
      ) {
        serviceError(409, 'ticket_payment_evidence_missing', 'Ticket payment evidence is incomplete; admission was not recorded.');
      }

      const now = clock();
      const admissionIdempotencyKey = `sway.ticket.${row.ticket.id}.admission.v1`;
      const evidence = {
        credentialType,
        onlineConfirmed: true,
        eventId: input.eventId,
        actorUserId: input.actorUserId
      };
      const evidenceHash = sha256(canonicalJson({
        ...evidence,
        ticketId: row.ticket.id,
        presentedCredentialHash
      }));
      const [accepted] = await tx
        .update(eventTickets)
        .set({
          status: 'release_pending',
          admissionAcceptedAt: now,
          admissionAcceptedByUserId: input.actorUserId,
          admissionIdempotencyKey,
          admissionEvidenceHash: evidenceHash,
          releasePendingAt: now,
          updatedAt: now
        })
        .where(and(
          eq(eventTickets.id, row.ticket.id),
          eq(eventTickets.status, 'held')
        ))
        .returning();
      if (!accepted) {
        serviceError(409, 'ticket_checkin_conflict', 'Ticket changed during admission. Reload the door before retrying.');
      }
      await tx
        .insert(ticketAdmissionEvents)
        .values({
          id: randomUUID(),
          ticketId: row.ticket.id,
          orderId: row.order.id,
          offerId: row.ticket.offerId,
          eventId: row.ticket.eventId,
          performerId: row.ticket.performerId,
          acceptedByUserId: input.actorUserId,
          clientRequestId: input.clientRequestId,
          idempotencyKey: admissionIdempotencyKey,
          admissionCredentialVersion: row.ticket.admissionCredentialVersion,
          presentedCredentialHash,
          evidence,
          acceptedAt: now,
          createdAt: now
        });
      await enqueueOperation(tx, {
        orderId: row.order.id,
        ticketId: row.ticket.id,
        operationType: 'create_seller_transfer',
        amountCents: row.order.sellerTransferAmountCents,
        requestPayload: {
          destinationAccountId: offer.sellerStripeAccountIdSnapshot,
          sourceChargeId: row.order.processorChargeId,
          transferGroup: sellerTransferGroup(row.order.id)
        },
        now
      });
      await writeTicketAudit(tx, {
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'event_ticket',
        entityId: row.ticket.id,
        eventType: 'event_ticket.admission_accepted',
        previousStatus: 'held',
        nextStatus: 'release_pending',
        metadata: {
          eventId: input.eventId,
          orderId: row.order.id,
          credentialType,
          performerTransferStatus: 'pending'
        }
      });
      return {
        result: 'accepted' as const,
        acceptedAt: now.toISOString(),
        releaseStatus: 'pending' as const,
        ticket: {
          id: row.ticket.id,
          ordinal: null,
          maskedBuyerLabel: maskBuyerEmail(row.buyerEmail)
        }
      };
    });
  }

  async function resolveOrderForEnvelope(
    executor: DbExecutor,
    envelope: EventTicketStripeWebhookEnvelope
  ): Promise<OrderRow | null> {
    const candidates = new Map<string, OrderRow>();
    const addCandidate = (order: OrderRow | undefined) => {
      if (order) candidates.set(order.id, order);
    };
    const metadataOrderId = envelope.metadata.sway_ticket_order_id;
    if (typeof metadataOrderId === 'string' && UUID_PATTERN.test(metadataOrderId)) {
      const [order] = await executor
        .select()
        .from(ticketOrders)
        .where(eq(ticketOrders.id, metadataOrderId))
        .limit(1);
      addCandidate(order);
    }
    const conditions = [
      envelope.checkoutSessionId
        ? eq(ticketOrders.processorCheckoutSessionId, envelope.checkoutSessionId)
        : null,
      envelope.paymentIntentId
        ? eq(ticketOrders.processorPaymentIntentId, envelope.paymentIntentId)
        : null,
      envelope.chargeId
        ? eq(ticketOrders.processorChargeId, envelope.chargeId)
        : null
    ].filter(Boolean);
    for (const condition of conditions) {
      const [order] = await executor
        .select()
        .from(ticketOrders)
        .where(condition)
        .limit(1);
      addCandidate(order);
    }
    if (envelope.transferId) {
      const [operation] = await executor
        .select({ order: ticketOrders })
        .from(ticketPaymentOperations)
        .innerJoin(ticketOrders, eq(ticketOrders.id, ticketPaymentOperations.orderId))
        .where(eq(ticketPaymentOperations.processorObjectId, envelope.transferId))
        .limit(1);
      addCandidate(operation?.order);
    }
    if (candidates.size > 1) {
      throw new TerminalOperationError('Processor event identity signals resolve to different ticket orders.');
    }
    const order = candidates.values().next().value as OrderRow | undefined;
    if (!order) return null;

    const metadataMatches: Array<[string, string]> = [
      ['sway_ticket_order_id', order.id],
      ['sway_ticket_event_id', order.eventId],
      ['sway_ticket_offer_id', order.offerId],
      ['sway_ticket_buyer_account_id', order.buyerUserId],
      ['sway_ticket_terms_hash', order.buyerTermsHash]
    ];
    for (const [key, expected] of metadataMatches) {
      const actual = envelope.metadata[key];
      if (typeof actual === 'string' && actual !== expected) {
        throw new TerminalOperationError(`Processor event ${key} does not match the ticket order.`);
      }
    }
    if (
      typeof envelope.metadata.sway_ticket_lane === 'string'
      && envelope.metadata.sway_ticket_lane !== 'native_ga'
    ) {
      throw new TerminalOperationError('Processor event ticket lane is invalid.');
    }
    if (
      envelope.checkoutSessionId
      && order.processorCheckoutSessionId
      && envelope.checkoutSessionId !== order.processorCheckoutSessionId
    ) {
      throw new TerminalOperationError('Checkout Session does not match the ticket order.');
    }
    if (
      envelope.paymentIntentId
      && order.processorPaymentIntentId
      && envelope.paymentIntentId !== order.processorPaymentIntentId
    ) {
      throw new TerminalOperationError('PaymentIntent does not match the ticket order.');
    }
    if (
      envelope.chargeId
      && order.processorChargeId
      && envelope.chargeId !== order.processorChargeId
    ) {
      throw new TerminalOperationError('Charge does not match the ticket order.');
    }
    if (
      envelope.transferGroup
      && envelope.transferGroup !== sellerTransferGroup(order.id)
    ) {
      throw new TerminalOperationError('Transfer group does not match the ticket order.');
    }
    return order;
  }

  async function ensureTicketForConfirmedPayment(
    executor: DbExecutor,
    input: {
      order: OrderRow;
      offer: OfferRow;
      event: EventRow;
      now: Date;
      refundRequired: boolean;
    }
  ) {
    const [existing] = await executor
      .select()
      .from(eventTickets)
      .where(eq(eventTickets.orderId, input.order.id))
      .limit(1);
    if (existing) return existing;
    const config = requireAdmissionConfiguration(runtimeConfig);
    const ticketId = randomUUID();
    const manualCode = manualCodeForTicket(ticketId, config.qrSecret);
    const [ticket] = await executor
      .insert(eventTickets)
      .values({
        id: ticketId,
        orderId: input.order.id,
        offerId: input.order.offerId,
        eventId: input.order.eventId,
        performerId: input.order.performerId,
        buyerUserId: input.order.buyerUserId,
        status: input.refundRequired ? 'refund_pending' : 'held',
        admissionCredentialVersion: 1,
        admissionCredentialHash: manualCredentialHash(manualCode),
        refundPendingAt: input.refundRequired ? input.now : null,
        createdAt: input.now,
        updatedAt: input.now
      })
      .onConflictDoNothing()
      .returning();
    if (ticket) return ticket;
    const [concurrent] = await executor
      .select()
      .from(eventTickets)
      .where(eq(eventTickets.orderId, input.order.id))
      .limit(1);
    if (!concurrent) {
      serviceError(500, 'event_ticket_issue_failed', 'Confirmed ticket could not be persisted.');
    }
    return concurrent;
  }

  async function confirmCapturedPayment(input: {
    orderId: string;
    paymentIntentId: string;
    chargeId: string;
    amountCents: number;
    currency: string;
    transferGroup: string;
    balanceTransactionId: string;
    processingFeeCents: number;
    netCents: number;
    occurredAt?: Date;
  }) {
    if (
      !input.paymentIntentId
      || !input.chargeId
      || !Number.isSafeInteger(input.amountCents)
      || input.amountCents <= 0
      || input.currency.toUpperCase() !== 'USD'
      || !input.balanceTransactionId
      || !Number.isSafeInteger(input.processingFeeCents)
      || input.processingFeeCents < 0
      || !Number.isSafeInteger(input.netCents)
      || input.netCents <= 0
      || input.netCents + input.processingFeeCents !== input.amountCents
    ) {
      throw new TerminalOperationError('Confirmed ticket payment evidence is invalid.');
    }
    return db.transaction(async (tx: DbExecutor) => {
      const [row] = await tx
        .select({
          order: ticketOrders,
          offer: eventTicketOffers,
          event: performerEvents
        })
        .from(ticketOrders)
        .innerJoin(eventTicketOffers, eq(eventTicketOffers.id, ticketOrders.offerId))
        .innerJoin(performerEvents, eq(performerEvents.id, ticketOrders.eventId))
        .where(eq(ticketOrders.id, input.orderId))
        .for('update')
        .limit(1);
      if (!row) throw new RetryableOperationError('Ticket order is not yet available.');
      if (
        row.order.processorPaymentIntentId
        && row.order.processorPaymentIntentId !== input.paymentIntentId
      ) {
        throw new TerminalOperationError('PaymentIntent does not match the ticket order.');
      }
      if (row.order.processorChargeId && row.order.processorChargeId !== input.chargeId) {
        throw new TerminalOperationError('Charge does not match the ticket order.');
      }
      if (
        row.order.processorBalanceTransactionId
        && row.order.processorBalanceTransactionId !== input.balanceTransactionId
      ) {
        throw new TerminalOperationError('Balance transaction does not match the ticket order.');
      }
      if (input.transferGroup !== sellerTransferGroup(row.order.id)) {
        throw new TerminalOperationError('Payment transfer group does not match the ticket order.');
      }
      if (input.amountCents < row.order.advertisedTotalCents) {
        throw new TerminalOperationError('Captured amount is below the immutable ticket total.');
      }
      const taxTotalCents = input.amountCents - row.order.advertisedTotalCents;
      if (row.order.taxModeSnapshot === 'not_required' && taxTotalCents !== 0) {
        throw new TerminalOperationError('Unexpected tax was added to a no-tax ticket order.');
      }
      const alreadyFinal = ['refunded', 'disputed'].includes(row.order.status);
      if (alreadyFinal) return row.order;

      const occurredAt = input.occurredAt ?? clock();
      const now = clock();
      const refundRequired = (
        ['expired', 'payment_failed', 'voided', 'refund_pending'].includes(row.order.status)
        || row.event.status === 'cancelled'
        || row.offer.status === 'cancelled'
        || now.getTime() >= row.offer.salesCloseAt.getTime()
        || !row.event.endsAt
        || now.getTime() >= row.event.endsAt.getTime() + row.offer.refundGraceMinutes * 60_000
      );
      const [updatedOrder] = await tx
        .update(ticketOrders)
        .set({
          status: refundRequired ? 'refund_pending' : 'paid',
          processorPaymentIntentId: input.paymentIntentId,
          processorChargeId: input.chargeId,
          processorBalanceTransactionId: input.balanceTransactionId,
          processorFeeCents: input.processingFeeCents,
          processorNetCents: input.netCents,
          taxTotalCents,
          chargedTotalCents: input.amountCents,
          chargedAt: row.order.chargedAt ?? occurredAt,
          refundPendingAt: refundRequired ? row.order.refundPendingAt ?? now : null,
          updatedAt: now
        })
        .where(eq(ticketOrders.id, row.order.id))
        .returning();
      const ticket = await ensureTicketForConfirmedPayment(tx, {
        ...row,
        order: updatedOrder,
        now,
        refundRequired
      });

      const captureTransactionKey =
        `stripe:balance-transaction:${input.balanceTransactionId}`;
      const captureEntries: Array<typeof ticketLedgerEntries.$inferInsert> = [
        {
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: ticket.id,
          entryType: 'charge_captured',
          account: 'platform_cash',
          direction: 'debit',
          amountCents: input.netCents,
          currency: 'USD',
          transactionKey: captureTransactionKey,
          idempotencyKey: ledgerKey(row.order.id, 'charge-platform-cash'),
          processorReference: input.balanceTransactionId,
          metadata: {
            chargeId: input.chargeId,
            taxTotalCents,
            advertisedTotalCents: row.order.advertisedTotalCents,
            processingFeeCents: input.processingFeeCents,
            grossCapturedCents: input.amountCents
          },
          occurredAt,
          createdAt: now
        },
        {
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: ticket.id,
          entryType: 'funds_held',
          account: 'ticket_funds_held',
          direction: 'credit',
          amountCents: row.order.sellerTransferAmountCents,
          currency: 'USD',
          transactionKey: captureTransactionKey,
          idempotencyKey: ledgerKey(row.order.id, 'performer-funds-held'),
          processorReference: input.balanceTransactionId,
          metadata: {
            chargeId: input.chargeId,
            transferTrigger: 'admission_accept'
          },
          occurredAt,
          createdAt: now
        }
      ];
      if (input.processingFeeCents > 0) {
        captureEntries.push({
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: ticket.id,
          entryType: 'processor_fee_recorded',
          account: 'processor_fee_expense',
          direction: 'debit',
          amountCents: input.processingFeeCents,
          currency: 'USD',
          transactionKey: captureTransactionKey,
          idempotencyKey: ledgerKey(row.order.id, 'charge-processor-fee'),
          processorReference: input.balanceTransactionId,
          metadata: {
            chargeId: input.chargeId,
            grossCapturedCents: input.amountCents,
            processorNetCents: input.netCents
          },
          occurredAt,
          createdAt: now
        });
      }
      if (row.order.mandatoryFeeCents > 0) {
        captureEntries.push({
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: ticket.id,
          entryType: 'charge_captured',
          account: 'platform_fee_revenue',
          direction: 'credit',
          amountCents: row.order.mandatoryFeeCents,
          currency: 'USD',
          transactionKey: captureTransactionKey,
          idempotencyKey: ledgerKey(row.order.id, 'charge-platform-fee'),
          processorReference: input.balanceTransactionId,
          metadata: { chargeId: input.chargeId },
          occurredAt,
          createdAt: now
        });
      }
      if (taxTotalCents > 0) {
        captureEntries.push({
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: ticket.id,
          entryType: 'charge_captured',
          account: 'ticket_tax_payable',
          direction: 'credit',
          amountCents: taxTotalCents,
          currency: 'USD',
          transactionKey: captureTransactionKey,
          idempotencyKey: ledgerKey(row.order.id, 'charge-ticket-tax'),
          processorReference: input.balanceTransactionId,
          metadata: { chargeId: input.chargeId },
          occurredAt,
          createdAt: now
        });
      }
      await insertLedgerEntries(tx, captureEntries);
      if (refundRequired) {
        await enqueueOperation(tx, {
          orderId: row.order.id,
          ticketId: ticket.id,
          operationType: 'create_buyer_refund',
          amountCents: input.amountCents,
          requestPayload: {
            reason: row.event.status === 'cancelled'
              ? 'seller_event_cancellation'
              : 'late_or_invalid_payment',
            paymentIntentId: input.paymentIntentId
          },
          now
        });
      }
      await writeTicketAudit(tx, {
        actorType: 'provider_webhook',
        actorId: null,
        entityType: 'ticket_order',
        entityId: row.order.id,
        eventType: 'ticket_order.payment_confirmed',
        previousStatus: row.order.status,
        nextStatus: updatedOrder.status,
        metadata: {
          paymentIntentId: input.paymentIntentId,
          chargeId: input.chargeId,
          balanceTransactionId: input.balanceTransactionId,
          chargedTotalCents: input.amountCents,
          processingFeeCents: input.processingFeeCents,
          processorNetCents: input.netCents,
          taxTotalCents,
          ticketId: ticket.id,
          refundRequired
        }
      });
      return updatedOrder;
    });
  }

  async function confirmRefund(input: {
    orderId: string;
    amountCents: number;
    processorReference: string | null;
    paymentOperationId?: string | null;
    occurredAt?: Date;
  }) {
    return db.transaction(async (tx: DbExecutor) => {
      const [row] = await tx
        .select({ order: ticketOrders, ticket: eventTickets })
        .from(ticketOrders)
        .leftJoin(eventTickets, eq(eventTickets.orderId, ticketOrders.id))
        .where(eq(ticketOrders.id, input.orderId))
        .for('update', { of: ticketOrders })
        .limit(1);
      if (!row || !row.ticket || !row.order.chargedTotalCents) {
        throw new RetryableOperationError('Refunded ticket order is not yet fully linked.');
      }
      if (
        !Number.isSafeInteger(input.amountCents)
        || input.amountCents <= 0
        || input.amountCents > row.order.chargedTotalCents
      ) {
        throw new TerminalOperationError('Processor refund amount is invalid for this ticket order.');
      }
      if (row.order.status === 'refunded' && row.ticket.status === 'refunded') {
        return row.order;
      }
      const now = input.occurredAt ?? clock();
      const exceptionalProcessorRefund = (
        input.amountCents < row.order.chargedTotalCents
        || Boolean(row.ticket.admissionAcceptedAt)
        || row.order.status === 'disputed'
        || row.ticket.status === 'disputed'
      );
      if (exceptionalProcessorRefund) {
        const [{ amount: recordedAmount }] = await tx
          .select({
            amount: sql<number>`coalesce(sum(${ticketLedgerEntries.amountCents}), 0)::int`
          })
          .from(ticketLedgerEntries)
          .where(and(
            eq(ticketLedgerEntries.orderId, row.order.id),
            eq(ticketLedgerEntries.entryType, 'processor_adjustment'),
            eq(ticketLedgerEntries.account, 'platform_cash'),
            eq(ticketLedgerEntries.direction, 'credit')
          ));
        const alreadyRecordedCents = Number(recordedAmount ?? 0);
        const adjustmentCents = input.amountCents - alreadyRecordedCents;
        if (adjustmentCents < 0) {
          throw new TerminalOperationError('Processor cumulative refund amount moved backwards.');
        }
        const [exceptionOrder] = await tx
          .update(ticketOrders)
          .set({
            status: 'disputed',
            disputedAt: row.order.disputedAt ?? now,
            updatedAt: now
          })
          .where(and(
            eq(ticketOrders.id, row.order.id),
            inArray(ticketOrders.status, ['paid', 'refund_pending'])
          ))
          .returning();
        await tx
          .update(eventTickets)
          .set({
            status: 'disputed',
            disputedAt: row.ticket.disputedAt ?? now,
            updatedAt: now
          })
          .where(and(
            eq(eventTickets.id, row.ticket.id),
            inArray(eventTickets.status, [
              'held',
              'release_pending',
              'released',
              'refund_pending'
            ])
          ));
        if (adjustmentCents > 0) {
          const cumulativeKey = `external-refund-${input.amountCents}`;
          const transactionKey = input.processorReference
            ? `stripe:refund-exception:${input.processorReference}`
            : `ticket:refund-exception:${row.order.id}`;
          await insertLedgerEntries(tx, [
            {
              id: randomUUID(),
              orderId: row.order.id,
              ticketId: row.ticket.id,
              paymentOperationId: input.paymentOperationId ?? null,
              entryType: 'processor_adjustment',
              account: 'buyer_refunds',
              direction: 'debit',
              amountCents: adjustmentCents,
              currency: 'USD',
              transactionKey,
              idempotencyKey: ledgerKey(row.order.id, `${cumulativeKey}-exception`),
              processorReference: input.processorReference,
              metadata: {
                cumulativeRefundCents: input.amountCents,
                chargedTotalCents: row.order.chargedTotalCents,
                admissionAccepted: Boolean(row.ticket.admissionAcceptedAt),
                resolution: 'controlled_support'
              },
              occurredAt: now,
              createdAt: clock()
            },
            {
              id: randomUUID(),
              orderId: row.order.id,
              ticketId: row.ticket.id,
              paymentOperationId: input.paymentOperationId ?? null,
              entryType: 'processor_adjustment',
              account: 'platform_cash',
              direction: 'credit',
              amountCents: adjustmentCents,
              currency: 'USD',
              transactionKey,
              idempotencyKey: ledgerKey(row.order.id, `${cumulativeKey}-cash`),
              processorReference: input.processorReference,
              metadata: {
                cumulativeRefundCents: input.amountCents,
                resolution: 'controlled_support'
              },
              occurredAt: now,
              createdAt: clock()
            }
          ]);
          await writeTicketAudit(tx, {
            actorType: 'provider_webhook',
            actorId: null,
            entityType: 'ticket_order',
            entityId: row.order.id,
            eventType: 'ticket_order.exceptional_refund_confirmed',
            previousStatus: row.order.status,
            nextStatus: 'disputed',
            metadata: {
              ticketId: row.ticket.id,
              cumulativeRefundCents: input.amountCents,
              adjustmentCents,
              admissionAccepted: Boolean(row.ticket.admissionAcceptedAt),
              processorReference: input.processorReference,
              resolution: 'controlled_support'
            }
          });
        }
        return exceptionOrder ?? row.order;
      }
      if (row.order.status === 'paid' && row.ticket.status === 'held') {
        await tx
          .update(ticketOrders)
          .set({
            status: 'refund_pending',
            refundPendingAt: row.order.refundPendingAt ?? now,
            updatedAt: now
          })
          .where(and(
            eq(ticketOrders.id, row.order.id),
            eq(ticketOrders.status, 'paid')
          ));
        await tx
          .update(eventTickets)
          .set({
            status: 'refund_pending',
            refundPendingAt: row.ticket.refundPendingAt ?? now,
            updatedAt: now
          })
          .where(and(
            eq(eventTickets.id, row.ticket.id),
            eq(eventTickets.status, 'held')
          ));
      } else if (
        row.order.status !== 'refund_pending'
        || row.ticket.status !== 'refund_pending'
      ) {
        throw new TerminalOperationError('Refund confirmation does not match a refundable ticket state.');
      }
      const [refundedOrder] = await tx
        .update(ticketOrders)
        .set({
          status: 'refunded',
          refundPendingAt: row.order.refundPendingAt ?? now,
          refundedAt: now,
          updatedAt: now
        })
        .where(and(
          eq(ticketOrders.id, row.order.id),
          eq(ticketOrders.status, 'refund_pending')
        ))
        .returning();
      if (!refundedOrder) {
        throw new RetryableOperationError('Ticket refund state changed concurrently.');
      }
      await tx
        .update(eventTickets)
        .set({
          status: 'refunded',
          refundPendingAt: row.ticket.refundPendingAt ?? now,
          refundedAt: now,
          updatedAt: now
        })
        .where(and(
          eq(eventTickets.id, row.ticket.id),
          eq(eventTickets.status, 'refund_pending')
        ));
      const refundEntries: Array<typeof ticketLedgerEntries.$inferInsert> = [
        {
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: row.ticket.id,
          paymentOperationId: input.paymentOperationId ?? null,
          entryType: 'buyer_refund_succeeded',
          account: 'platform_cash',
          direction: 'credit',
          amountCents: row.order.chargedTotalCents,
          currency: 'USD',
          transactionKey: input.processorReference
            ? `stripe:refund:${input.processorReference}`
            : `ticket:refund:${row.order.id}`,
          idempotencyKey: ledgerKey(row.order.id, 'refund-platform-cash'),
          processorReference: input.processorReference,
          occurredAt: now,
          createdAt: now
        },
        {
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: row.ticket.id,
          paymentOperationId: input.paymentOperationId ?? null,
          entryType: 'buyer_refund_succeeded',
          account: 'ticket_funds_held',
          direction: 'debit',
          amountCents: row.order.sellerTransferAmountCents,
          currency: 'USD',
          transactionKey: input.processorReference
            ? `stripe:refund:${input.processorReference}`
            : `ticket:refund:${row.order.id}`,
          idempotencyKey: ledgerKey(row.order.id, 'refund-performer-funds-held'),
          processorReference: input.processorReference,
          occurredAt: now,
          createdAt: now
        }
      ];
      if (row.order.mandatoryFeeCents > 0) {
        refundEntries.push({
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: row.ticket.id,
          paymentOperationId: input.paymentOperationId ?? null,
          entryType: 'buyer_refund_succeeded',
          account: 'platform_fee_revenue',
          direction: 'debit',
          amountCents: row.order.mandatoryFeeCents,
          currency: 'USD',
          transactionKey: input.processorReference
            ? `stripe:refund:${input.processorReference}`
            : `ticket:refund:${row.order.id}`,
          idempotencyKey: ledgerKey(row.order.id, 'refund-platform-fee'),
          processorReference: input.processorReference,
          occurredAt: now,
          createdAt: now
        });
      }
      if ((row.order.taxTotalCents ?? 0) > 0) {
        refundEntries.push({
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: row.ticket.id,
          paymentOperationId: input.paymentOperationId ?? null,
          entryType: 'buyer_refund_succeeded',
          account: 'ticket_tax_payable',
          direction: 'debit',
          amountCents: row.order.taxTotalCents!,
          currency: 'USD',
          transactionKey: input.processorReference
            ? `stripe:refund:${input.processorReference}`
            : `ticket:refund:${row.order.id}`,
          idempotencyKey: ledgerKey(row.order.id, 'refund-ticket-tax'),
          processorReference: input.processorReference,
          occurredAt: now,
          createdAt: now
        });
      }
      await insertLedgerEntries(tx, refundEntries);
      return refundedOrder;
    });
  }

  async function confirmSellerTransfer(input: {
    orderId: string;
    ticketId: string;
    transferId: string;
    paymentOperationId?: string | null;
    occurredAt?: Date;
  }) {
    return db.transaction(async (tx: DbExecutor) => {
      const [row] = await tx
        .select({ order: ticketOrders, ticket: eventTickets })
        .from(ticketOrders)
        .innerJoin(eventTickets, eq(eventTickets.orderId, ticketOrders.id))
        .where(and(
          eq(ticketOrders.id, input.orderId),
          eq(eventTickets.id, input.ticketId)
        ))
        .for('update')
        .limit(1);
      if (!row) throw new RetryableOperationError('Transferred ticket order is not yet available.');
      if (row.ticket.status === 'released') return row.ticket;
      const settlementDuringDispute = row.ticket.status === 'disputed'
        && Boolean(row.ticket.admissionAcceptedAt);
      if (
        (row.ticket.status !== 'release_pending' && !settlementDuringDispute)
        || !row.ticket.admissionAcceptedAt
      ) {
        throw new TerminalOperationError('Performer transfer cannot complete without a confirmed admission.');
      }
      const now = input.occurredAt ?? clock();
      let released: TicketRow | null = null;
      if (!settlementDuringDispute) {
        [released] = await tx
          .update(eventTickets)
          .set({ status: 'released', releasedAt: now, updatedAt: now })
          .where(and(
            eq(eventTickets.id, row.ticket.id),
            eq(eventTickets.status, 'release_pending')
          ))
          .returning();
        if (!released) throw new RetryableOperationError('Ticket release state changed concurrently.');
      } else {
        [released] = await tx
          .update(eventTickets)
          .set({
            releasedAt: row.ticket.releasedAt ?? now,
            updatedAt: now
          })
          .where(and(
            eq(eventTickets.id, row.ticket.id),
            eq(eventTickets.status, 'disputed')
          ))
          .returning();
        if (!released) throw new RetryableOperationError('Disputed ticket settlement state changed concurrently.');
      }
      const entries: Array<typeof ticketLedgerEntries.$inferInsert> = [
        {
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: row.ticket.id,
          paymentOperationId: input.paymentOperationId ?? null,
          entryType: 'seller_transfer_succeeded',
          account: 'ticket_funds_held',
          direction: 'debit',
          amountCents: row.order.sellerTransferAmountCents,
          currency: 'USD',
          transactionKey: `stripe:transfer:${input.transferId}`,
          idempotencyKey: ledgerKey(row.order.id, 'transfer-performer-funds-held'),
          processorReference: input.transferId,
          occurredAt: now,
          createdAt: now
        },
        {
          id: randomUUID(),
          orderId: row.order.id,
          ticketId: row.ticket.id,
          paymentOperationId: input.paymentOperationId ?? null,
          entryType: 'seller_transfer_succeeded',
          account: 'platform_cash',
          direction: 'credit',
          amountCents: row.order.sellerTransferAmountCents,
          currency: 'USD',
          transactionKey: `stripe:transfer:${input.transferId}`,
          idempotencyKey: ledgerKey(row.order.id, 'transfer-platform-cash'),
          processorReference: input.transferId,
          occurredAt: now,
          createdAt: now
        }
      ];
      await insertLedgerEntries(tx, entries);
      await writeTicketAudit(tx, {
        actorType: 'processor_worker',
        actorId: null,
        entityType: 'event_ticket',
        entityId: row.ticket.id,
        eventType: settlementDuringDispute
          ? 'event_ticket.performer_transfer_confirmed_during_dispute'
          : 'event_ticket.performer_transfer_confirmed',
        previousStatus: row.ticket.status,
        nextStatus: settlementDuringDispute ? 'disputed' : 'released',
        metadata: {
          orderId: row.order.id,
          transferId: input.transferId,
          resolution: settlementDuringDispute ? 'controlled_support' : 'complete'
        }
      });
      return released ?? row.ticket;
    });
  }

  async function processEnvelope(
    processorEvent: ProcessorEventRow,
    envelope: EventTicketStripeWebhookEnvelope
  ) {
    if (envelope.kind === 'unsupported') {
      return { ignored: true, orderId: null as string | null };
    }
    let order = await resolveOrderForEnvelope(db, envelope);
    if (!order) throw new RetryableOperationError('Ticket order could not yet be resolved from the processor event.');

    if (envelope.kind === 'checkout_completed') {
      const checkoutCompletedStatus = inArrayValue(
        order.status,
        ['checkout_pending', 'checkout_open']
      )
        ? 'payment_processing'
        : order.status;
      await db
        .update(ticketOrders)
        .set({
          status: checkoutCompletedStatus,
          processorCheckoutSessionId: envelope.checkoutSessionId ?? order.processorCheckoutSessionId,
          processorPaymentIntentId: envelope.paymentIntentId ?? order.processorPaymentIntentId,
          updatedAt: clock()
        })
        .where(eq(ticketOrders.id, order.id));
    } else if (envelope.kind === 'checkout_expired') {
      if (UNPAID_ORDER_STATUSES.includes(order.status)) {
        const now = clock();
        await db
          .update(ticketOrders)
          .set({ status: 'expired', expiredAt: now, updatedAt: now })
          .where(and(
            eq(ticketOrders.id, order.id),
            inArray(ticketOrders.status, UNPAID_ORDER_STATUSES)
          ));
      }
    } else if (envelope.kind === 'payment_succeeded') {
      let paymentIntentId = envelope.paymentIntentId;
      let chargeId = envelope.chargeId;
      let amountCents = envelope.amountCents;
      let currency = envelope.currency;
      let transferGroup = envelope.transferGroup;
      if (!paymentIntentId) throw new RetryableOperationError('PaymentIntent id is missing.');
      if (!provider) throw new RetryableOperationError('Stripe retrieval is unavailable.');
      const retrieved = await provider.retrievePaymentIntent(paymentIntentId);
      if (retrieved.status !== 'succeeded') {
        throw new RetryableOperationError('Stripe PaymentIntent is not yet durably succeeded.');
      }
      if (
        (chargeId && retrieved.chargeId && chargeId !== retrieved.chargeId)
        || (amountCents && amountCents !== retrieved.amountReceivedCents)
        || (currency && currency.toUpperCase() !== retrieved.currency.toUpperCase())
        || (transferGroup && retrieved.transferGroup && transferGroup !== retrieved.transferGroup)
      ) {
        throw new TerminalOperationError('Signed payment event does not match retrieved Stripe evidence.');
      }
      chargeId = retrieved.chargeId;
      amountCents = retrieved.amountReceivedCents;
      currency = retrieved.currency;
      transferGroup = retrieved.transferGroup;
      if (!chargeId || !amountCents || !currency || !transferGroup) {
        throw new RetryableOperationError('Captured charge evidence is incomplete.');
      }
      if (
        !retrieved.balanceTransactionId
        || retrieved.processingFeeCents === null
        || retrieved.netCents === null
      ) {
        throw new RetryableOperationError(
          'Stripe balance-transaction fee evidence is not yet available.'
        );
      }
      await confirmCapturedPayment({
        orderId: order.id,
        paymentIntentId,
        chargeId,
        amountCents,
        currency,
        transferGroup,
        balanceTransactionId: retrieved.balanceTransactionId,
        processingFeeCents: retrieved.processingFeeCents,
        netCents: retrieved.netCents,
        occurredAt: new Date(envelope.createdAtUnixSeconds * 1_000)
      });
    } else if (envelope.kind === 'payment_failed') {
      if (UNPAID_ORDER_STATUSES.includes(order.status)) {
        const now = clock();
        await db
          .update(ticketOrders)
          .set({
            processorPaymentIntentId: envelope.paymentIntentId ?? order.processorPaymentIntentId,
            paymentFailedAt: now,
            updatedAt: now
          })
          .where(and(
            eq(ticketOrders.id, order.id),
            inArray(ticketOrders.status, UNPAID_ORDER_STATUSES)
          ));
      }
    } else if (envelope.kind === 'charge_refunded') {
      if (!envelope.amountCents) throw new RetryableOperationError('Refund amount is missing.');
      const [operation] = await db
        .select()
        .from(ticketPaymentOperations)
        .where(and(
          eq(ticketPaymentOperations.orderId, order.id),
          eq(ticketPaymentOperations.operationType, 'create_buyer_refund')
        ))
        .limit(1);
      const refundOutcome = await confirmRefund({
        orderId: order.id,
        amountCents: envelope.amountCents,
        processorReference: envelope.refundId ?? envelope.chargeId,
        paymentOperationId: operation?.id ?? null,
        occurredAt: new Date(envelope.createdAtUnixSeconds * 1_000)
      });
      if (
        operation
        && refundOutcome.status === 'refunded'
        && envelope.amountCents === refundOutcome.chargedTotalCents
      ) {
        const now = clock();
        await db
          .update(ticketPaymentOperations)
          .set({
            status: 'succeeded',
            resultPayload: envelope,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
            completedAt: now,
            updatedAt: now
          })
          .where(eq(ticketPaymentOperations.id, operation.id));
      }
    } else if (envelope.kind === 'refund_updated' && envelope.status === 'succeeded') {
      if (!envelope.refundId || !envelope.amountCents) {
        throw new RetryableOperationError('Succeeded refund evidence is incomplete.');
      }
      const [operation] = await db
        .select()
        .from(ticketPaymentOperations)
        .where(and(
          eq(ticketPaymentOperations.orderId, order.id),
          eq(ticketPaymentOperations.operationType, 'create_buyer_refund')
        ))
        .limit(1);
      if (
        operation
        && order.chargedTotalCents
        && envelope.amountCents === order.chargedTotalCents
      ) {
        const refundOutcome = await confirmRefund({
          orderId: order.id,
          amountCents: envelope.amountCents,
          processorReference: envelope.refundId,
          paymentOperationId: operation.id,
          occurredAt: new Date(envelope.createdAtUnixSeconds * 1_000)
        });
        if (refundOutcome.status === 'refunded') {
          const now = clock();
          await db
            .update(ticketPaymentOperations)
            .set({
              status: 'succeeded',
              processorObjectId: envelope.refundId,
              resultPayload: envelope,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastError: null,
              completedAt: now,
              updatedAt: now
            })
            .where(eq(ticketPaymentOperations.id, operation.id));
        }
      } else {
        await writeTicketAudit(db, {
          actorType: 'provider_webhook',
          actorId: null,
          entityType: 'ticket_order',
          entityId: order.id,
          eventType: 'ticket_order.external_refund_item_observed',
          previousStatus: order.status,
          nextStatus: order.status,
          metadata: {
            refundId: envelope.refundId,
            refundAmountCents: envelope.amountCents,
            chargedTotalCents: order.chargedTotalCents,
            resolution: 'awaiting_cumulative_charge_refund_evidence'
          }
        });
      }
    } else if (
      envelope.kind === 'refund_updated'
      || envelope.kind === 'refund_failed'
    ) {
      const [operation] = await db
        .select()
        .from(ticketPaymentOperations)
        .where(and(
          eq(ticketPaymentOperations.orderId, order.id),
          eq(ticketPaymentOperations.operationType, 'create_buyer_refund')
        ))
        .limit(1);
      const now = clock();
      const failed = envelope.kind === 'refund_failed'
        || ['failed', 'canceled'].includes(envelope.status ?? '');
      if (operation && operation.status !== 'succeeded') {
        await db
          .update(ticketPaymentOperations)
          .set({
            status: 'retryable_failed',
            processorObjectId: envelope.refundId ?? operation.processorObjectId,
            resultPayload: envelope,
            availableAt: operationRetryAt(now, Math.max(1, operation.attemptCount)),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: failed
              ? `Stripe refund failed: ${envelope.refundFailureReason ?? envelope.status ?? 'unknown'}.`
              : `Stripe refund remains pending: ${envelope.refundPendingReason ?? envelope.status ?? 'unknown'}.`,
            completedAt: null,
            updatedAt: now
          })
          .where(eq(ticketPaymentOperations.id, operation.id));
      }
      await writeTicketAudit(db, {
        actorType: 'provider_webhook',
        actorId: null,
        entityType: 'ticket_order',
        entityId: order.id,
        eventType: failed
          ? 'ticket_order.refund_failed'
          : 'ticket_order.refund_pending',
        previousStatus: order.status,
        nextStatus: order.status,
        metadata: {
          refundId: envelope.refundId,
          refundStatus: envelope.status,
          refundFailureReason: envelope.refundFailureReason,
          refundPendingReason: envelope.refundPendingReason,
          resolution: failed ? 'controlled_support' : 'processor_pending'
        }
      });
    } else if (envelope.kind === 'charge_disputed') {
      const now = new Date(envelope.createdAtUnixSeconds * 1_000);
      if (
        !envelope.disputeId
        || !envelope.chargeId
        || !envelope.amountCents
        || envelope.amountCents <= 0
        || envelope.currency?.toUpperCase() !== 'USD'
      ) {
        throw new TerminalOperationError('Stripe dispute evidence is incomplete.');
      }
      await db.transaction(async (tx: DbExecutor) => {
        const [row] = await tx
          .select({
            order: ticketOrders,
            ticket: eventTickets,
            event: performerEvents,
            offer: eventTicketOffers
          })
          .from(ticketOrders)
          .innerJoin(eventTickets, eq(eventTickets.orderId, ticketOrders.id))
          .innerJoin(performerEvents, eq(performerEvents.id, ticketOrders.eventId))
          .innerJoin(eventTicketOffers, eq(eventTicketOffers.id, ticketOrders.offerId))
          .where(eq(ticketOrders.id, order!.id))
          .for('update')
          .limit(1);
        if (
          !row
          || !row.order.chargedAt
          || !row.order.chargedTotalCents
          || !row.order.processorChargeId
          || !['paid', 'refund_pending', 'refunded', 'disputed'].includes(row.order.status)
        ) {
          throw new RetryableOperationError(
            'Ticket capture and issuance must be durable before a dispute can be recorded.'
          );
        }
        if (row.order.processorChargeId !== envelope.chargeId) {
          throw new TerminalOperationError('Disputed charge does not match the ticket order.');
        }
        if (envelope.amountCents > row.order.chargedTotalCents) {
          throw new TerminalOperationError('Dispute amount exceeds the captured ticket charge.');
        }
        const [disputedOrder] = await tx
          .update(ticketOrders)
          .set({ status: 'disputed', disputedAt: now, updatedAt: now })
          .where(and(
            eq(ticketOrders.id, row.order.id),
            inArray(ticketOrders.status, ['paid', 'refund_pending', 'refunded', 'disputed'])
          ))
          .returning();
        const [disputedTicket] = await tx
          .update(eventTickets)
          .set({ status: 'disputed', disputedAt: now, updatedAt: now })
          .where(and(
            eq(eventTickets.id, row.ticket.id),
            inArray(eventTickets.status, [
              'held',
              'release_pending',
              'released',
              'refund_pending',
              'refunded',
              'disputed'
            ])
          ))
          .returning();
        if (!disputedOrder || !disputedTicket) {
          throw new RetryableOperationError('Ticket dispute state changed concurrently.');
        }
        const disputeReference = envelope.disputeId;
        await insertLedgerEntries(tx, [
          {
            id: randomUUID(),
            orderId: row.order.id,
            ticketId: row.ticket.id,
            entryType: 'dispute_opened',
            account: 'processor_disputes',
            direction: 'debit',
            amountCents: envelope.amountCents,
            currency: 'USD',
            transactionKey: `stripe:dispute:${disputeReference}`,
            idempotencyKey: ledgerKey(row.order.id, `dispute-${disputeReference}-expense`),
            processorReference: envelope.disputeId,
            occurredAt: now,
            createdAt: now
          },
          {
            id: randomUUID(),
            orderId: row.order.id,
            ticketId: row.ticket.id,
            entryType: 'dispute_opened',
            account: 'platform_cash',
            direction: 'credit',
            amountCents: envelope.amountCents,
            currency: 'USD',
            transactionKey: `stripe:dispute:${disputeReference}`,
            idempotencyKey: ledgerKey(row.order.id, `dispute-${disputeReference}-cash`),
            processorReference: envelope.disputeId,
            occurredAt: now,
            createdAt: now
          }
        ]);
        await writeTicketAudit(tx, {
          actorType: 'provider_webhook',
          actorId: null,
          entityType: 'ticket_order',
          entityId: row.order.id,
          eventType: 'ticket_order.dispute_opened',
          previousStatus: row.order.status,
          nextStatus: 'disputed',
          metadata: {
            ticketId: row.ticket.id,
            disputeId: envelope.disputeId,
            disputeStatus: envelope.status,
            disputeReason: envelope.disputeReason,
            amountCents: envelope.amountCents
          }
        });
      });
    } else if (envelope.kind === 'charge_dispute_closed') {
      if (
        !envelope.disputeId
        || !envelope.amountCents
        || envelope.amountCents <= 0
        || envelope.currency?.toUpperCase() !== 'USD'
      ) {
        throw new TerminalOperationError('Closed Stripe dispute evidence is incomplete.');
      }
      const now = new Date(envelope.createdAtUnixSeconds * 1_000);
      await db.transaction(async (tx: DbExecutor) => {
        const [row] = await tx
          .select({
            order: ticketOrders,
            ticket: eventTickets,
            event: performerEvents,
            offer: eventTicketOffers
          })
          .from(ticketOrders)
          .innerJoin(eventTickets, eq(eventTickets.orderId, ticketOrders.id))
          .innerJoin(performerEvents, eq(performerEvents.id, ticketOrders.eventId))
          .innerJoin(eventTicketOffers, eq(eventTicketOffers.id, ticketOrders.offerId))
          .where(eq(ticketOrders.id, order!.id))
          .for('update')
          .limit(1);
        if (!row) throw new RetryableOperationError('Disputed ticket is not yet available.');
        const [openedEvidence] = await tx
          .select({ id: ticketLedgerEntries.id })
          .from(ticketLedgerEntries)
          .where(and(
            eq(ticketLedgerEntries.orderId, row.order.id),
            eq(ticketLedgerEntries.entryType, 'dispute_opened'),
            eq(ticketLedgerEntries.account, 'processor_disputes'),
            eq(ticketLedgerEntries.processorReference, envelope.disputeId)
          ))
          .limit(1);
        if (!openedEvidence) {
          throw new RetryableOperationError(
            'Dispute closure arrived before its durable dispute-open evidence.'
          );
        }
        const disputeWon = ['won', 'warning_closed'].includes(envelope.status ?? '');
        const disputeLost = envelope.status === 'lost';
        const cancelledUnusedRefundRequired = (
          disputeWon
          && !row.ticket.admissionAcceptedAt
          && !row.ticket.refundedAt
          && (row.event.status === 'cancelled' || row.offer.status === 'cancelled')
        );
        let restoredTicketStatus: TicketStatus | null = null;
        let restoredOrderStatus: OrderRow['status'] | null = null;
        if (disputeWon) {
          restoredTicketStatus = row.ticket.refundedAt
            ? 'refunded'
            : row.ticket.admissionAcceptedAt
              ? row.ticket.releasedAt
                ? 'released'
                : 'release_pending'
              : cancelledUnusedRefundRequired || row.ticket.refundPendingAt
                ? 'refund_pending'
                : 'held';
          restoredOrderStatus = restoredTicketStatus === 'refunded'
            ? 'refunded'
            : restoredTicketStatus === 'refund_pending'
              ? 'refund_pending'
              : 'paid';
          await tx
            .update(ticketOrders)
            .set({
              status: restoredOrderStatus,
              refundPendingAt: restoredOrderStatus === 'refund_pending'
                ? row.order.refundPendingAt ?? now
                : row.order.refundPendingAt,
              updatedAt: now
            })
            .where(and(
              eq(ticketOrders.id, row.order.id),
              eq(ticketOrders.status, 'disputed')
            ));
          await tx
            .update(eventTickets)
            .set({
              status: restoredTicketStatus,
              refundPendingAt: restoredTicketStatus === 'refund_pending'
                ? row.ticket.refundPendingAt ?? now
                : row.ticket.refundPendingAt,
              updatedAt: now
            })
            .where(and(
              eq(eventTickets.id, row.ticket.id),
              eq(eventTickets.status, 'disputed')
            ));
          if (cancelledUnusedRefundRequired) {
            if (!row.order.chargedTotalCents || !row.order.processorPaymentIntentId) {
              throw new RetryableOperationError(
                'Cancelled disputed ticket is missing captured-payment evidence for its refund.'
              );
            }
            await enqueueOperation(tx, {
              orderId: row.order.id,
              ticketId: row.ticket.id,
              operationType: 'create_buyer_refund',
              amountCents: row.order.chargedTotalCents,
              requestPayload: {
                reason: 'dispute_won_after_seller_event_cancellation',
                paymentIntentId: row.order.processorPaymentIntentId
              },
              now
            });
          }
        }
        if (disputeWon || disputeLost) {
          const closureType = disputeWon ? 'dispute_won' as const : 'dispute_lost' as const;
          await insertLedgerEntries(tx, [
            {
              id: randomUUID(),
              orderId: row.order.id,
              ticketId: row.ticket.id,
              entryType: closureType,
              account: disputeWon ? 'platform_cash' : 'buyer_refunds',
              direction: 'debit',
              amountCents: envelope.amountCents,
              currency: 'USD',
              transactionKey: `stripe:dispute:${envelope.disputeId}:closed`,
              idempotencyKey: ledgerKey(
                row.order.id,
                `dispute-${envelope.disputeId}-${disputeWon ? 'won-cash' : 'lost-expense'}`
              ),
              processorReference: envelope.disputeId,
              metadata: { disputeStatus: envelope.status },
              occurredAt: now,
              createdAt: clock()
            },
            {
              id: randomUUID(),
              orderId: row.order.id,
              ticketId: row.ticket.id,
              entryType: closureType,
              account: 'processor_disputes',
              direction: 'credit',
              amountCents: envelope.amountCents,
              currency: 'USD',
              transactionKey: `stripe:dispute:${envelope.disputeId}:closed`,
              idempotencyKey: ledgerKey(
                row.order.id,
                `dispute-${envelope.disputeId}-${disputeWon ? 'won-recovery' : 'lost-close'}`
              ),
              processorReference: envelope.disputeId,
              metadata: { disputeStatus: envelope.status },
              occurredAt: now,
              createdAt: clock()
            }
          ]);
        }
        await writeTicketAudit(tx, {
          actorType: 'provider_webhook',
          actorId: null,
          entityType: 'ticket_order',
          entityId: row.order.id,
          eventType: disputeWon
            ? 'ticket_order.dispute_won'
            : disputeLost
              ? 'ticket_order.dispute_lost'
              : 'ticket_order.dispute_closed_for_support',
          previousStatus: row.order.status,
          nextStatus: disputeWon ? restoredOrderStatus : 'disputed',
          metadata: {
            ticketId: row.ticket.id,
            disputeId: envelope.disputeId,
            disputeStatus: envelope.status,
            disputeReason: envelope.disputeReason,
            amountCents: envelope.amountCents,
            resolution: cancelledUnusedRefundRequired
              ? 'refund_queued_after_cancellation'
              : disputeWon
                ? 'restored'
                : 'controlled_support'
          }
        });
      });
    } else if (envelope.kind === 'transfer_created') {
      const [operation] = await db
        .select()
        .from(ticketPaymentOperations)
        .where(and(
          eq(ticketPaymentOperations.orderId, order.id),
          eq(ticketPaymentOperations.operationType, 'create_seller_transfer')
        ))
        .limit(1);
      if (!operation?.ticketId || !envelope.transferId) {
        throw new RetryableOperationError('Performer transfer operation is not yet linked.');
      }
      const context = await loadOperationContext(operation);
      if (!context.ticket || context.ticket.id !== operation.ticketId) {
        throw new RetryableOperationError('Performer transfer ticket is not yet linked.');
      }
      assertSellerTransferEvidence({
        ...envelope,
        transferId: envelope.transferId,
        expectedDestinationAccountId: context.offer.sellerStripeAccountIdSnapshot,
        expectedSourceChargeId: context.order.processorChargeId ?? '',
        expectedAmountCents: context.order.sellerTransferAmountCents,
        expectedTransferGroup: sellerTransferGroup(context.order.id)
      });
      await confirmSellerTransfer({
        orderId: order.id,
        ticketId: operation.ticketId,
        transferId: envelope.transferId,
        paymentOperationId: operation.id,
        occurredAt: new Date(envelope.createdAtUnixSeconds * 1_000)
      });
      const now = clock();
      await db
        .update(ticketPaymentOperations)
        .set({
          status: 'succeeded',
          processorObjectId: envelope.transferId,
          resultPayload: envelope,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now
        })
        .where(eq(ticketPaymentOperations.id, operation.id));
    }
    return { ignored: false, orderId: order.id };
  }

  function inArrayValue<T>(value: T, values: T[]) {
    return values.includes(value);
  }

  async function ingestVerifiedWebhook(input: {
    rawBody: string | Buffer;
    signatureHeader: string | null;
  }) {
    if (!provider) {
      serviceError(503, 'ticket_webhook_provider_unavailable', 'Ticket webhook verification is unavailable.', { retryable: true });
    }
    let envelope: EventTicketStripeWebhookEnvelope;
    try {
      envelope = provider.parseVerifiedWebhookEvent(input);
    } catch {
      serviceError(
        400,
        'ticket_webhook_signature_invalid',
        'Stripe webhook signature verification failed.'
      );
    }
    if (envelope.livemode !== expectedStripeLivemode) {
      serviceError(
        400,
        'ticket_webhook_livemode_mismatch',
        'Stripe webhook mode does not match this Sway environment.'
      );
    }
    if (envelope.accountId !== null) {
      // Native tickets use platform charges. A correctly signed Connect event
      // belongs to another payment lane and must fall through on the shared
      // endpoint rather than being persisted as native-ticket evidence.
      return { status: 'not_ticket' as const };
    }
    const ticketMarkerPresent = envelope.metadata.sway_ticket_lane === 'native_ga'
      || (
        typeof envelope.metadata.sway_ticket_order_id === 'string'
        && envelope.metadata.sway_ticket_order_id.trim().length > 0
      );
    const preResolvedOrder = await resolveOrderForEnvelope(db, envelope);
    if (!ticketMarkerPresent && !preResolvedOrder) {
      return { status: 'not_ticket' as const };
    }
    const rawBody = typeof input.rawBody === 'string'
      ? input.rawBody
      : input.rawBody.toString('utf8');
    const payloadSha256 = sha256(rawBody);
    const now = clock();
    const [inserted] = await db
      .insert(ticketProcessorEvents)
      .values({
        id: randomUUID(),
        processor: 'stripe',
        processorEventId: envelope.providerEventId,
        eventType: envelope.providerType,
        payloadSha256,
        payload: envelope,
        livemode: envelope.livemode,
        status: 'pending',
        nextAttemptAt: now,
        receivedAt: now
      })
      .onConflictDoNothing()
      .returning();
    let processorEvent = inserted;
    if (!processorEvent) {
      [processorEvent] = await db
        .select()
        .from(ticketProcessorEvents)
        .where(and(
          eq(ticketProcessorEvents.processor, 'stripe'),
          eq(ticketProcessorEvents.processorEventId, envelope.providerEventId)
        ))
        .limit(1);
      if (!processorEvent) {
        serviceError(500, 'ticket_webhook_dedupe_failed', 'Ticket webhook could not be persisted.');
      }
      if (processorEvent.payloadSha256 !== payloadSha256) {
        serviceError(409, 'ticket_webhook_payload_conflict', 'Processor event id was reused with a different signed payload.');
      }
      if (['processed', 'ignored'].includes(processorEvent.status)) {
        return { status: 'duplicate' as const, processorEventId: processorEvent.id };
      }
      if (processorEvent.status === 'terminal_failed') {
        return {
          status: 'terminal_failed' as const,
          processorEventId: processorEvent.id
        };
      }
    }

    const staleProcessingBefore = new Date(
      now.getTime() - PROCESSOR_EVENT_LEASE_SECONDS * 1_000
    );
    const [claimedProcessorEvent] = await db
      .update(ticketProcessorEvents)
      .set({
        status: 'processing',
        processingStartedAt: now,
        attemptCount: sql`${ticketProcessorEvents.attemptCount} + 1`,
        lastError: null
      })
      .where(and(
        eq(ticketProcessorEvents.id, processorEvent.id),
        or(
          inArray(ticketProcessorEvents.status, ['pending', 'retryable_failed']),
          and(
            eq(ticketProcessorEvents.status, 'processing'),
            lte(ticketProcessorEvents.processingStartedAt, staleProcessingBefore)
          )
        )
      ))
      .returning();
    if (!claimedProcessorEvent) {
      return {
        status: 'in_progress' as const,
        processorEventId: processorEvent.id
      };
    }
    processorEvent = claimedProcessorEvent;
    try {
      const outcome = await processEnvelope(processorEvent, envelope);
      const processedAt = clock();
      await db
        .update(ticketProcessorEvents)
        .set({
          status: outcome.ignored ? 'ignored' : 'processed',
          orderId: outcome.orderId,
          processedAt,
          processingStartedAt: null,
          lastError: null
        })
        .where(eq(ticketProcessorEvents.id, processorEvent.id));
      return {
        status: outcome.ignored ? 'ignored' as const : 'processed' as const,
        processorEventId: processorEvent.id,
        orderId: outcome.orderId
      };
    } catch (error) {
      const terminal = error instanceof TerminalOperationError;
      await db
        .update(ticketProcessorEvents)
        .set({
          status: terminal ? 'terminal_failed' : 'retryable_failed',
          nextAttemptAt: new Date(clock().getTime() + PROCESSOR_EVENT_RETRY_SECONDS * 1_000),
          processingStartedAt: null,
          lastError: safeProcessorError(error)
        })
        .where(eq(ticketProcessorEvents.id, processorEvent.id));
      return {
        status: terminal ? 'terminal_failed' as const : 'retryable_failed' as const,
        processorEventId: processorEvent.id
      };
    }
  }

  async function claimOperation(
    workerId: string,
    operationId?: string
  ): Promise<OperationRow | null> {
    return db.transaction(async (tx: DbExecutor) => {
      const now = clock();
      const query = tx
        .select()
        .from(ticketPaymentOperations)
        .where(and(
          ...(operationId ? [eq(ticketPaymentOperations.id, operationId)] : []),
          lte(ticketPaymentOperations.availableAt, now),
          or(
            inArray(ticketPaymentOperations.status, ['pending', 'retryable_failed']),
            and(
              eq(ticketPaymentOperations.status, 'leased'),
              lte(ticketPaymentOperations.leaseExpiresAt, now)
            )
          )
        ))
        .orderBy(asc(ticketPaymentOperations.availableAt), asc(ticketPaymentOperations.id));
      const [operation] = await query.for('update', { skipLocked: true }).limit(1);
      if (!operation) return null;
      const leaseExpiresAt = new Date(now.getTime() + OPERATION_LEASE_SECONDS * 1_000);
      const [leased] = await tx
        .update(ticketPaymentOperations)
        .set({
          status: 'leased',
          attemptCount: operation.attemptCount + 1,
          leaseOwner: workerId,
          leaseExpiresAt,
          lastAttemptAt: now,
          lastError: null,
          updatedAt: now
        })
        .where(eq(ticketPaymentOperations.id, operation.id))
        .returning();
      return leased ?? null;
    });
  }

  async function markOperationSucceeded(
    operation: OperationRow,
    input: {
      processorObjectId?: string | null;
      resultPayload: Record<string, unknown>;
    },
    executor: DbExecutor = db
  ) {
    const now = clock();
    await executor
      .update(ticketPaymentOperations)
      .set({
        status: 'succeeded',
        processorObjectId: input.processorObjectId ?? null,
        resultPayload: input.resultPayload,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        completedAt: now,
        updatedAt: now
      })
      .where(and(
        eq(ticketPaymentOperations.id, operation.id),
        eq(ticketPaymentOperations.status, 'leased'),
        eq(ticketPaymentOperations.leaseOwner, operation.leaseOwner!)
      ));
  }

  async function markOperationFailed(operation: OperationRow, error: unknown) {
    const now = clock();
    const terminal = error instanceof TerminalOperationError;
    const needsManualReview = !terminal && operation.attemptCount >= operation.maxAttempts;
    await db
      .update(ticketPaymentOperations)
      .set({
        status: terminal ? 'terminal_failed' : 'retryable_failed',
        availableAt: operationRetryAt(now, operation.attemptCount),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: `${
          needsManualReview ? 'Manual review required; automatic reconciliation continues. ' : ''
        }${safeProcessorError(error)}`,
        completedAt: terminal ? now : null,
        updatedAt: now
      })
      .where(and(
        eq(ticketPaymentOperations.id, operation.id),
        eq(ticketPaymentOperations.status, 'leased'),
        eq(ticketPaymentOperations.leaseOwner, operation.leaseOwner!)
      ));
    if (needsManualReview && operation.attemptCount === operation.maxAttempts) {
      await writeTicketAudit(db, {
        actorType: 'system',
        actorId: null,
        entityType: 'ticket_payment_operation',
        entityId: operation.id,
        eventType: 'ticket_payment_operation.manual_review_required',
        previousStatus: 'leased',
        nextStatus: 'retryable_failed',
        metadata: {
          orderId: operation.orderId,
          ticketId: operation.ticketId,
          operationType: operation.operationType,
          attemptCount: operation.attemptCount,
          automaticReconciliationContinues: true
        }
      });
    }
  }

  async function loadOperationContext(operation: OperationRow) {
    const [row] = await db
      .select({
        order: ticketOrders,
        offer: eventTicketOffers,
        event: performerEvents,
        performer: performers,
        buyerEmail: users.email,
        ticket: eventTickets
      })
      .from(ticketOrders)
      .innerJoin(eventTicketOffers, eq(eventTicketOffers.id, ticketOrders.offerId))
      .innerJoin(performerEvents, eq(performerEvents.id, ticketOrders.eventId))
      .innerJoin(performers, eq(performers.id, ticketOrders.performerId))
      .innerJoin(users, eq(users.id, ticketOrders.buyerUserId))
      .leftJoin(eventTickets, eq(eventTickets.orderId, ticketOrders.id))
      .where(eq(ticketOrders.id, operation.orderId))
      .limit(1);
    if (!row) throw new TerminalOperationError('Ticket operation order no longer exists.');
    return row;
  }

  async function executeClaimedOperation(operation: OperationRow) {
    if (!provider) throw new RetryableOperationError('Ticket processor provider is unavailable.');
    const context = await loadOperationContext(operation);
    const payload = asRecord(operation.requestPayload);

    if (operation.operationType === 'create_checkout') {
      if (
        context.event.status !== 'published'
        || context.offer.status !== 'on_sale'
        || context.order.status !== 'checkout_pending'
      ) {
        throw new TerminalOperationError('Ticket checkout is no longer eligible to open.');
      }
      const expiresAtUnixSeconds = Number(payload.expiresAtUnixSeconds);
      if (
        !Number.isSafeInteger(expiresAtUnixSeconds)
        || expiresAtUnixSeconds * 1_000 <= clock().getTime()
      ) {
        throw new TerminalOperationError('Ticket checkout reservation already expired.');
      }
      const performanceLocation = resolveNativeTicketPerformanceLocation(context.event);
      if (!performanceLocation) {
        throw new TerminalOperationError(
          'Ticket checkout requires the event’s complete US street address, city, state, and ZIP code.'
        );
      }
      const checkout = await provider.createCheckoutSession({
        orderId: context.order.id,
        eventId: context.event.id,
        offerId: context.offer.id,
        buyerAccountId: context.order.buyerUserId,
        buyerEmail: recordString(payload, 'buyerEmail') ?? context.buyerEmail ?? '',
        ticketName: recordString(payload, 'ticketName') ?? `General admission — ${context.event.title}`,
        ticketDescription: recordString(payload, 'ticketDescription') ?? undefined,
        amountTotalCents: context.order.advertisedTotalCents,
        currency: 'USD',
        successUrl: recordString(payload, 'successUrl') ?? '',
        cancelUrl: recordString(payload, 'cancelUrl') ?? '',
        expiresAtUnixSeconds,
        termsHash: context.order.buyerTermsHash,
        transferGroup: sellerTransferGroup(context.order.id),
        idempotencyKey: operation.idempotencyKey,
        performanceLocation: {
          ...performanceLocation,
          description: [context.event.locationName, context.event.title]
            .filter(Boolean)
            .join(' — ')
        },
        metadata: {
          sway_ticket_order_id: context.order.id,
          sway_ticket_event_id: context.event.id,
          sway_ticket_offer_id: context.offer.id
        }
      });
      const checkoutUrl = normalizeHostedCheckoutUrl(checkout.checkoutUrl);
      if (!checkoutUrl) {
        throw new TerminalOperationError('Stripe Checkout did not return a safe HTTPS hosted URL.');
      }
      await db.transaction(async (tx: DbExecutor) => {
        const [currentOrder] = await tx
          .select()
          .from(ticketOrders)
          .where(eq(ticketOrders.id, context.order.id))
          .for('update')
          .limit(1);
        if (!currentOrder) {
          throw new TerminalOperationError('Ticket checkout order no longer exists.');
        }
        const [openedOrder] = await tx
          .update(ticketOrders)
          .set({
            status: 'checkout_open',
            processorCheckoutSessionId: checkout.checkoutSessionId,
            processorPaymentIntentId: checkout.paymentIntentId,
            checkoutExpiresAt: new Date(checkout.expiresAtUnixSeconds * 1_000),
            updatedAt: clock()
          })
          .where(and(
            eq(ticketOrders.id, context.order.id),
            eq(ticketOrders.status, 'checkout_pending')
          ))
          .returning({ id: ticketOrders.id });
        if (!openedOrder) {
          await tx
            .update(ticketOrders)
            .set({
              processorCheckoutSessionId: checkout.checkoutSessionId,
              processorPaymentIntentId:
                checkout.paymentIntentId ?? currentOrder.processorPaymentIntentId,
              updatedAt: clock()
            })
            .where(eq(ticketOrders.id, context.order.id));
          if (
            currentOrder.status !== 'checkout_open'
            && CHECKOUT_RECONCILIATION_STATUSES.includes(currentOrder.status)
          ) {
            await enqueueOperation(tx, {
              orderId: context.order.id,
              operationType: 'expire_checkout',
              requestPayload: {
                reason: 'checkout_order_closed_during_creation',
                checkoutSessionId: checkout.checkoutSessionId
              },
              now: clock()
            });
          }
        }
        await markOperationSucceeded(operation, {
          processorObjectId: checkout.checkoutSessionId,
          resultPayload: {
            checkoutSessionId: checkout.checkoutSessionId,
            checkoutUrl,
            paymentIntentId: checkout.paymentIntentId,
            expiresAtUnixSeconds: checkout.expiresAtUnixSeconds
          }
        }, tx);
      });
      return;
    }

    if (operation.operationType === 'expire_checkout') {
      if (!CHECKOUT_RECONCILIATION_STATUSES.includes(context.order.status)) {
        await markOperationSucceeded(operation, {
          resultPayload: { outcome: 'noop_order_not_unpaid' }
        });
        return;
      }
      if (!context.order.processorCheckoutSessionId) {
        throw new TerminalOperationError('Checkout Session id is missing.');
      }
      const currentSession = await provider.retrieveCheckoutSession(
        context.order.processorCheckoutSessionId
      );
      if (currentSession.paymentStatus === 'paid' && currentSession.paymentIntentId) {
        const intent = await provider.retrievePaymentIntent(currentSession.paymentIntentId);
        if (intent.status === 'succeeded' && intent.chargeId) {
          if (!intent.transferGroup) {
            throw new RetryableOperationError('Captured ticket payment transfer group is missing.');
          }
          if (
            !intent.balanceTransactionId
            || intent.processingFeeCents === null
            || intent.netCents === null
          ) {
            throw new RetryableOperationError(
              'Stripe balance-transaction fee evidence is not yet available.'
            );
          }
          await confirmCapturedPayment({
            orderId: context.order.id,
            paymentIntentId: intent.paymentIntentId,
            chargeId: intent.chargeId,
            amountCents: intent.amountReceivedCents,
            currency: intent.currency,
            transferGroup: intent.transferGroup,
            balanceTransactionId: intent.balanceTransactionId,
            processingFeeCents: intent.processingFeeCents,
            netCents: intent.netCents
          });
          await markOperationSucceeded(operation, {
            resultPayload: { outcome: 'payment_reconciled_before_expiration' }
          });
          return;
        }
      }
      const expired = currentSession.checkoutStatus === 'expired'
        ? currentSession
        : await provider.expireCheckoutSession({
            checkoutSessionId: context.order.processorCheckoutSessionId,
            idempotencyKey: operation.idempotencyKey
          });
      const now = clock();
      await db.transaction(async (tx: DbExecutor) => {
        await tx
          .update(ticketOrders)
          .set({ status: 'expired', expiredAt: now, updatedAt: now })
          .where(and(
            eq(ticketOrders.id, context.order.id),
            inArray(ticketOrders.status, UNPAID_ORDER_STATUSES)
          ));
        await markOperationSucceeded(operation, {
          resultPayload: {
            checkoutSessionId: expired.checkoutSessionId,
            checkoutStatus: expired.checkoutStatus
          }
        }, tx);
      });
      return;
    }

    if (operation.operationType === 'create_seller_transfer') {
      if (!context.ticket || !operation.ticketId || context.ticket.id !== operation.ticketId) {
        throw new TerminalOperationError('Performer transfer ticket is missing.');
      }
      if (context.ticket.status === 'released') {
        await markOperationSucceeded(operation, {
          processorObjectId: operation.processorObjectId,
          resultPayload: { outcome: 'noop_already_released' }
        });
        return;
      }
      if (context.ticket.status === 'disputed' || context.order.status === 'disputed') {
        throw new RetryableOperationError(
          'Performer transfer is paused while the payment dispute remains open.'
        );
      }
      if (context.ticket.status !== 'release_pending' || !context.ticket.admissionAcceptedAt) {
        throw new TerminalOperationError('Performer transfer requires confirmed online admission.');
      }
      assertSellerReady(context.performer);
      if (
        context.performer.stripeConnectedAccountId !== context.offer.sellerStripeAccountIdSnapshot
      ) {
        throw new RetryableOperationError('Performer Stripe destination changed; transfer remains pending for review.');
      }
      if (!context.order.processorChargeId) {
        throw new RetryableOperationError('Source charge is not yet available.');
      }
      const transfer = await provider.transferProceeds({
        destinationAccountId: context.offer.sellerStripeAccountIdSnapshot,
        sourceChargeId: context.order.processorChargeId,
        amountCents: context.order.sellerTransferAmountCents,
        currency: 'USD',
        transferGroup: sellerTransferGroup(context.order.id),
        idempotencyKey: operation.idempotencyKey,
        metadata: {
          sway_ticket_order_id: context.order.id,
          sway_ticket_event_id: context.event.id,
          sway_ticket_id: context.ticket.id
        }
      });
      assertSellerTransferEvidence({
        ...transfer,
        expectedDestinationAccountId: context.offer.sellerStripeAccountIdSnapshot,
        expectedSourceChargeId: context.order.processorChargeId,
        expectedAmountCents: context.order.sellerTransferAmountCents,
        expectedTransferGroup: sellerTransferGroup(context.order.id)
      });
      await confirmSellerTransfer({
        orderId: context.order.id,
        ticketId: context.ticket.id,
        transferId: transfer.transferId,
        paymentOperationId: operation.id
      });
      await markOperationSucceeded(operation, {
        processorObjectId: transfer.transferId,
        resultPayload: {
          transferId: transfer.transferId,
          amountCents: transfer.amountCents,
          destinationAccountId: transfer.destinationAccountId
        }
      });
      return;
    }

    if (operation.operationType === 'create_buyer_refund') {
      if (!context.ticket || !operation.ticketId || context.ticket.id !== operation.ticketId) {
        throw new TerminalOperationError('Refund ticket is missing.');
      }
      if (context.order.status === 'refunded' && context.ticket.status === 'refunded') {
        await markOperationSucceeded(operation, {
          processorObjectId: operation.processorObjectId,
          resultPayload: { outcome: 'noop_already_refunded' }
        });
        return;
      }
      if (
        context.order.status !== 'refund_pending'
        || context.ticket.status !== 'refund_pending'
        || context.ticket.admissionAcceptedAt
      ) {
        throw new TerminalOperationError('Ticket is not eligible for the automatic full-refund path.');
      }
      if (!context.order.processorPaymentIntentId || !context.order.chargedTotalCents) {
        throw new RetryableOperationError('PaymentIntent or final charged total is not yet available.');
      }
      const refund = await provider.refundPayment({
        paymentIntentId: context.order.processorPaymentIntentId,
        amountCents: context.order.chargedTotalCents,
        idempotencyKey: operation.idempotencyKey,
        metadata: {
          sway_ticket_order_id: context.order.id,
          sway_ticket_event_id: context.event.id,
          sway_ticket_id: context.ticket.id
        }
      });
      if (refund.amountCents !== context.order.chargedTotalCents) {
        throw new TerminalOperationError('Stripe refund amount does not match the immutable full-refund request.');
      }
      if (refund.status !== 'succeeded') {
        if (refund.status === 'pending' || refund.status === 'requires_action') {
          throw new RetryableOperationError(`Stripe refund remains ${refund.status}.`);
        }
        throw new TerminalOperationError(`Stripe refund entered non-success status ${refund.status ?? 'unknown'}.`);
      }
      await confirmRefund({
        orderId: context.order.id,
        amountCents: refund.amountCents,
        processorReference: refund.refundId,
        paymentOperationId: operation.id
      });
      await markOperationSucceeded(operation, {
        processorObjectId: refund.refundId,
        resultPayload: {
          refundId: refund.refundId,
          status: refund.status,
          amountCents: refund.amountCents
        }
      });
    }
  }

  async function runSpecificOperation(operationId: string, workerId: string) {
    const operation = await claimOperation(workerId, operationId);
    if (!operation) return { claimed: false, succeeded: false };
    try {
      await executeClaimedOperation(operation);
      return { claimed: true, succeeded: true };
    } catch (error) {
      await markOperationFailed(operation, error);
      return { claimed: true, succeeded: false, error: safeProcessorError(error) };
    }
  }

  async function runDueOperations(input: {
    limit?: number;
    workerId?: string;
  } = {}) {
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit) || 25)));
    const workerId = normalizeRequiredText(
      input.workerId ?? defaultWorkerId,
      'workerId',
      200
    );
    const result = { claimed: 0, succeeded: 0, failed: 0 };
    for (let index = 0; index < limit; index += 1) {
      const operation = await claimOperation(workerId);
      if (!operation) break;
      result.claimed += 1;
      try {
        await executeClaimedOperation(operation);
        result.succeeded += 1;
      } catch (error) {
        await markOperationFailed(operation, error);
        result.failed += 1;
      }
    }
    return result;
  }

  async function queueExpiredReservation(orderId: string) {
    return db.transaction(async (tx: DbExecutor) => {
      const [order] = await tx
        .select()
        .from(ticketOrders)
        .where(eq(ticketOrders.id, orderId))
        .for('update')
        .limit(1);
      if (!order || !UNPAID_ORDER_STATUSES.includes(order.status)) return false;
      const now = clock();
      if (!order.checkoutExpiresAt || order.checkoutExpiresAt.getTime() > now.getTime()) {
        return false;
      }
      if (!order.processorCheckoutSessionId) {
        await tx
          .update(ticketOrders)
          .set({ status: 'expired', expiredAt: now, updatedAt: now })
          .where(eq(ticketOrders.id, order.id));
        await tx
          .update(ticketPaymentOperations)
          .set({
            status: 'terminal_failed',
            completedAt: now,
            lastError: 'Reservation expired before Checkout Session creation.',
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now
          })
          .where(and(
            eq(ticketPaymentOperations.orderId, order.id),
            eq(ticketPaymentOperations.operationType, 'create_checkout'),
            inArray(ticketPaymentOperations.status, ['pending', 'retryable_failed'])
          ));
        return true;
      }
      await enqueueOperation(tx, {
        orderId: order.id,
        operationType: 'expire_checkout',
        requestPayload: {
          reason: 'checkout_reservation_expired',
          checkoutSessionId: order.processorCheckoutSessionId
        },
        now
      });
      return true;
    });
  }

  async function queueNoShowRefund(ticketId: string) {
    return db.transaction(async (tx: DbExecutor) => {
      const [row] = await tx
        .select({
          ticket: eventTickets,
          order: ticketOrders,
          offer: eventTicketOffers,
          event: performerEvents
        })
        .from(eventTickets)
        .innerJoin(ticketOrders, eq(ticketOrders.id, eventTickets.orderId))
        .innerJoin(eventTicketOffers, eq(eventTicketOffers.id, eventTickets.offerId))
        .innerJoin(performerEvents, eq(performerEvents.id, eventTickets.eventId))
        .where(eq(eventTickets.id, ticketId))
        .for('update')
        .limit(1);
      if (
        !row
        || row.ticket.status !== 'held'
        || row.order.status !== 'paid'
        || !row.order.chargedTotalCents
        || !row.order.processorPaymentIntentId
        || !row.event.endsAt
      ) return false;
      const now = clock();
      const deadline = row.event.status === 'cancelled'
        ? row.event.cancelledAt ?? now
        : new Date(row.event.endsAt.getTime() + row.offer.refundGraceMinutes * 60_000);
      if (deadline.getTime() > now.getTime()) return false;
      await tx
        .update(eventTickets)
        .set({ status: 'refund_pending', refundPendingAt: now, updatedAt: now })
        .where(and(eq(eventTickets.id, row.ticket.id), eq(eventTickets.status, 'held')));
      await tx
        .update(ticketOrders)
        .set({ status: 'refund_pending', refundPendingAt: now, updatedAt: now })
        .where(and(eq(ticketOrders.id, row.order.id), eq(ticketOrders.status, 'paid')));
      await enqueueOperation(tx, {
        orderId: row.order.id,
        ticketId: row.ticket.id,
        operationType: 'create_buyer_refund',
        amountCents: row.order.chargedTotalCents,
        requestPayload: {
          reason: row.event.status === 'cancelled'
            ? 'seller_event_cancellation'
            : 'unaccepted_after_grace',
          paymentIntentId: row.order.processorPaymentIntentId
        },
        now
      });
      await writeTicketAudit(tx, {
        actorType: 'system',
        actorId: null,
        entityType: 'event_ticket',
        entityId: row.ticket.id,
        eventType: 'event_ticket.refund_queued',
        previousStatus: 'held',
        nextStatus: 'refund_pending',
        metadata: {
          orderId: row.order.id,
          reason: row.event.status === 'cancelled'
            ? 'seller_event_cancellation'
            : 'unaccepted_after_grace'
        }
      });
      return true;
    });
  }

  async function retryStoredProcessorEvent(processorEvent: ProcessorEventRow) {
    const envelope = processorEvent.payload as EventTicketStripeWebhookEnvelope;
    const now = clock();
    const [claimedProcessorEvent] = await db
      .update(ticketProcessorEvents)
      .set({
        status: 'processing',
        processingStartedAt: now,
        attemptCount: processorEvent.attemptCount + 1,
        lastError: null
      })
      .where(and(
        eq(ticketProcessorEvents.id, processorEvent.id),
        eq(ticketProcessorEvents.status, 'retryable_failed')
      ))
      .returning();
    if (!claimedProcessorEvent) return false;
    try {
      const outcome = await processEnvelope(claimedProcessorEvent, envelope);
      await db
        .update(ticketProcessorEvents)
        .set({
          status: outcome.ignored ? 'ignored' : 'processed',
          orderId: outcome.orderId,
          processedAt: clock(),
          processingStartedAt: null,
          lastError: null
        })
        .where(eq(ticketProcessorEvents.id, processorEvent.id));
      return true;
    } catch (error) {
      const terminal = error instanceof TerminalOperationError;
      await db
        .update(ticketProcessorEvents)
        .set({
          status: terminal ? 'terminal_failed' : 'retryable_failed',
          nextAttemptAt: new Date(clock().getTime() + PROCESSOR_EVENT_RETRY_SECONDS * 1_000),
          processingStartedAt: null,
          lastError: safeProcessorError(error)
        })
        .where(eq(ticketProcessorEvents.id, processorEvent.id));
      return false;
    }
  }

  async function runMaintenance(input: { limit?: number } = {}) {
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(input.limit) || 100)));
    const now = clock();
    const staleProcessingBefore = new Date(
      now.getTime() - PROCESSOR_EVENT_LEASE_SECONDS * 1_000
    );
    const staleProcessorEvents = await db
      .update(ticketProcessorEvents)
      .set({
        status: 'retryable_failed',
        nextAttemptAt: now,
        processingStartedAt: null,
        lastError: 'Recovered abandoned processor-event lease.'
      })
      .where(and(
        eq(ticketProcessorEvents.status, 'processing'),
        lte(ticketProcessorEvents.processingStartedAt, staleProcessingBefore)
      ))
      .returning({ id: ticketProcessorEvents.id });
    await db
      .update(eventTicketOffers)
      .set({ status: 'sales_closed', salesClosedAt: now, updatedAt: now })
      .where(and(
        eq(eventTicketOffers.status, 'on_sale'),
        lte(eventTicketOffers.salesCloseAt, now)
      ));

    const expiredCandidates = await db
      .select({ id: ticketOrders.id })
      .from(ticketOrders)
      .where(and(
        inArray(ticketOrders.status, UNPAID_ORDER_STATUSES),
        lte(ticketOrders.checkoutExpiresAt, now)
      ))
      .orderBy(asc(ticketOrders.checkoutExpiresAt), asc(ticketOrders.id))
      .limit(limit);
    let expiredReservationsQueued = 0;
    for (const candidate of expiredCandidates) {
      if (await queueExpiredReservation(candidate.id)) expiredReservationsQueued += 1;
    }

    const heldCandidates = await db
      .select({ id: eventTickets.id })
      .from(eventTickets)
      .innerJoin(performerEvents, eq(performerEvents.id, eventTickets.eventId))
      .where(and(
        eq(eventTickets.status, 'held'),
        isNotNull(performerEvents.endsAt)
      ))
      .orderBy(asc(performerEvents.endsAt), asc(eventTickets.id))
      .limit(limit);
    let noShowRefundsQueued = 0;
    for (const candidate of heldCandidates) {
      if (await queueNoShowRefund(candidate.id)) noShowRefundsQueued += 1;
    }

    const processorEvents = await db
      .select()
      .from(ticketProcessorEvents)
      .where(and(
        eq(ticketProcessorEvents.status, 'retryable_failed'),
        lte(ticketProcessorEvents.nextAttemptAt, now)
      ))
      .orderBy(asc(ticketProcessorEvents.nextAttemptAt), asc(ticketProcessorEvents.id))
      .limit(limit);
    let processorEventsRecovered = 0;
    for (const processorEvent of processorEvents) {
      if (await retryStoredProcessorEvent(processorEvent)) processorEventsRecovered += 1;
    }
    return {
      expiredReservationsQueued,
      noShowRefundsQueued,
      staleProcessorEventsRequeued: staleProcessorEvents.length,
      processorEventsRecovered
    };
  }

  return {
    getNativeTicketSalesCapability,
    getOwnerNativeTicketSalesCapability,
    getOwnerTicketOffer,
    updateOwnerTicketOffer,
    publishNativeEvent,
    cancelNativeEvent,
    getPublicOfferProjection,
    createCheckoutOrder,
    getBuyerOrder,
    listBuyerOrders,
    listBuyerTickets,
    getBuyerTicketPass,
    getDoorSummary,
    checkIn,
    ingestVerifiedWebhook,
    runDueOperations,
    runMaintenance
  };
}

export type EventTicketService = ReturnType<typeof createEventTicketService>;
