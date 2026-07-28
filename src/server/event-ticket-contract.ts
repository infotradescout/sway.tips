import { createHash } from 'node:crypto';

export const NATIVE_TICKET_TERMS_VERSION = '2026-07-28.native-ga.v3';
export const NATIVE_TICKET_STANDARD_FEE_BPS = 1_000;
export const NATIVE_TICKET_EXCLUSIVE_FEE_CAP_CENTS = 100;

export const NATIVE_TICKET_SELLER_TERMS_TEXT = [
  'Sway native general-admission ticket sales addendum.',
  'The performer is the seller of record for the event and confirms they have authority to offer admission.',
  'The performer, not Sway, is responsible for event questions, entry policies, scheduling, attendee service, and the event refund or cancellation policy. The performer support email shown before purchase is the customer contact for those matters.',
  'Sway provides payment, account, security, and platform infrastructure support only.',
  'Sway charges the customer on Sway’s platform payment account. Sway does not transfer the performer share until a valid ticket is accepted at the door.',
  'The held amount is a contractual payment hold recorded in Sway’s ticket ledger. It is not represented as a bank account, trust account, protected account, or regulated escrow account.',
  'This version supports refund-only settlement for tickets that are not accepted. A performer cancellation or an unaccepted ticket after the disclosed grace window is queued for a full customer refund.',
  'The performer must complete required identity, tax, and payout onboarding before a native ticket event can be published.',
  'Sway charges the customer a mandatory service fee equal to 10% of the admission price. For a performer with an active, accepted Sway Brand Partner entitlement, that 10% fee is capped at $1 per ticket.',
  'The total customer price, including the mandatory Sway ticket fee, is displayed before checkout. Stripe Automatic Tax calculates and discloses applicable government tax before payment.',
  'Refund-only v1 allows one issued or pending ticket record per verified Sway account for each event.',
  'Online admission opens at the disclosed door-opening time and closes after the disclosed post-event grace window.',
  'A queued or pending refund is not complete until the payment provider confirms it.',
  'Credits, no-show forfeitures, ticket resale, and paid holder transfers are not part of this version.',
  'Processor availability, disputes, chargebacks, refunds, tax obligations, and compliance reviews can delay or reverse settlement.',
  'Location details are event information only. They do not create a venue account, role, or authority boundary.'
].join('\n');

export const NATIVE_TICKET_BUYER_TERMS_TEXT = [
  'Sway native general-admission ticket purchase terms.',
  'The prominently displayed ticket total includes the admission price and every mandatory Sway ticket fee. Stripe Automatic Tax calculates and displays applicable government tax before payment.',
  'The performer selling the ticket—not Sway—is responsible for event questions, entry policies, scheduling, attendee service, and the event refund or cancellation policy. The performer support email is included with the purchase record.',
  'Sway charges the customer now, but does not transfer the performer share until a valid ticket is accepted at the door.',
  'The held amount is a contractual payment hold recorded in Sway’s ticket ledger. It is not represented as a bank account, trust account, protected account, or regulated escrow account.',
  'Each ticket uses a rotating, short-lived admission QR. A valid first acceptance admits the current ticket holder; a repeat scan does not create another admission or transfer.',
  'Refund-only v1 allows one issued or pending ticket record per verified Sway account for each event.',
  'The admission pass becomes scannable at the disclosed door-opening time.',
  'This version is refund-only for unaccepted tickets. If the performer cancels, or if a ticket remains unaccepted after the disclosed post-event grace window, Sway queues a full refund to the original payment method.',
  'A queued or pending refund is not complete until the payment provider confirms it.',
  'Credits, no-show forfeitures, ticket resale, and paid holder transfers are not part of this version.',
  'Payment-processor timelines, disputes, chargebacks, and failed or pending refunds can affect when money is returned.'
].join('\n');

export const NATIVE_TICKET_SELLER_TERMS_HASH = createHash('sha256')
  .update(NATIVE_TICKET_SELLER_TERMS_TEXT)
  .digest('hex');

export const NATIVE_TICKET_BUYER_TERMS_HASH = createHash('sha256')
  .update(NATIVE_TICKET_BUYER_TERMS_TEXT)
  .digest('hex');

// `not_required` remains readable for immutable historical offer/order snapshots.
// New runtime configuration only enables `stripe_automatic`.
export type NativeTicketTaxMode = 'stripe_automatic' | 'not_required';

export type NativeTicketRuntimeConfig = {
  salesEnabled: boolean;
  disabledReasons: string[];
  expectedStripeLivemode: boolean;
  productionApprovalVersion: string | null;
  feeBps: number | null;
  feeFixedCents: number | null;
  taxMode: NativeTicketTaxMode | null;
  stripeTaxCode: string | null;
  reservationMinutes: number;
  refundGraceMinutes: number;
  qrSecret: string | null;
  qrPreviousSecrets: string[];
  appBaseUrl: string | null;
  supportEmail: string | null;
};

const MIN_RESERVATION_MINUTES = 31;
const MAX_RESERVATION_MINUTES = 60;
const MIN_REFUND_GRACE_MINUTES = 60;
const MAX_REFUND_GRACE_MINUTES = 7 * 24 * 60;

function parseBoundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number
): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return null;
  return parsed;
}

function parseBoolean(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

function stripeKeyMatchesEnvironment(value: string, isProduction: boolean) {
  return isProduction
    ? /^(?:sk|rk)_live_/.test(value)
    : /^(?:sk|rk)_test_/.test(value);
}

function normalizeBaseUrl(value: string | undefined, isProduction: boolean): string | null {
  if (!value?.trim()) return isProduction ? 'https://app.sway.tips' : null;
  try {
    const url = new URL(value.trim());
    if (isProduction && url.protocol !== 'https:') return null;
    if (!isProduction && !['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeSupportEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (
    !normalized
    || normalized.length > 254
    || normalized.includes('..')
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function resolveNativeTicketRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  isProduction = env.NODE_ENV === 'production'
): NativeTicketRuntimeConfig {
  const requested = parseBoolean(env.SWAY_NATIVE_TICKETS_ENABLED);
  const productionApprovalVersion = env.SWAY_TICKET_PRODUCTION_APPROVAL_VERSION?.trim() || null;
  const feeBps = NATIVE_TICKET_STANDARD_FEE_BPS;
  const feeFixedCents = 0;
  const taxMode = env.SWAY_TICKET_TAX_MODE === 'stripe_automatic'
    ? env.SWAY_TICKET_TAX_MODE
    : null;
  const stripeTaxCode = env.SWAY_TICKET_STRIPE_TAX_CODE?.trim() || null;
  const qrSecret = env.SWAY_TICKET_QR_SECRET?.trim() || null;
  const rawPreviousSecrets = env.SWAY_TICKET_QR_PREVIOUS_SECRETS?.trim() || '';
  const parsedPreviousSecrets = rawPreviousSecrets
    ? rawPreviousSecrets.split(',').map((value) => value.trim()).filter(Boolean)
    : [];
  const previousSecretsValid = parsedPreviousSecrets.every(
    (value) => value.length >= 32
  );
  const qrPreviousSecrets = previousSecretsValid
    ? [...new Set(parsedPreviousSecrets.filter((value) => value !== qrSecret))]
    : [];
  const appBaseUrl = normalizeBaseUrl(
    env.SWAY_APP_BASE_URL || env.APP_URL,
    isProduction
  );
  const rawSupportEmail = env.SWAY_TICKET_SUPPORT_EMAIL?.trim() || '';
  const supportEmail = rawSupportEmail ? normalizeSupportEmail(rawSupportEmail) : null;
  const reservationMinutes = parseBoundedInteger(
    env.SWAY_TICKET_RESERVATION_MINUTES,
    MIN_RESERVATION_MINUTES,
    MAX_RESERVATION_MINUTES
  ) ?? MIN_RESERVATION_MINUTES;
  const refundGraceMinutes = parseBoundedInteger(
    env.SWAY_TICKET_REFUND_GRACE_MINUTES,
    MIN_REFUND_GRACE_MINUTES,
    MAX_REFUND_GRACE_MINUTES
  ) ?? 24 * 60;

  const disabledReasons: string[] = [];
  if (!requested) disabledReasons.push('native_ticket_sales_not_enabled');
  if (!taxMode) disabledReasons.push('ticket_tax_mode_missing');
  if (taxMode === 'stripe_automatic' && !stripeTaxCode) {
    disabledReasons.push('ticket_tax_code_missing');
  }
  if (!qrSecret || qrSecret.length < 32) disabledReasons.push('ticket_qr_secret_missing');
  if (!previousSecretsValid) disabledReasons.push('ticket_qr_previous_secrets_invalid');
  if (!appBaseUrl) disabledReasons.push('ticket_app_base_url_missing');
  if (rawSupportEmail && !supportEmail) {
    disabledReasons.push('ticket_support_email_invalid');
  }
  const stripeSecretKey = env.STRIPE_SECRET_KEY?.trim();
  if (
    requested
    && stripeSecretKey
    && !stripeKeyMatchesEnvironment(stripeSecretKey, isProduction)
  ) {
    disabledReasons.push('ticket_stripe_key_mode_mismatch');
  }
  if (
    isProduction
    && requested
    && productionApprovalVersion !== NATIVE_TICKET_TERMS_VERSION
  ) {
    disabledReasons.push('ticket_production_approval_missing');
  }

  return {
    salesEnabled: requested && disabledReasons.length === 0,
    disabledReasons,
    expectedStripeLivemode: isProduction,
    productionApprovalVersion,
    feeBps,
    feeFixedCents,
    taxMode,
    stripeTaxCode,
    reservationMinutes,
    refundGraceMinutes,
    qrSecret,
    qrPreviousSecrets,
    appBaseUrl,
    supportEmail
  };
}

export function calculateNativeTicketPrice(input: {
  faceValueCents: number;
  feeBps: number;
  feeFixedCents: number;
  feeCapCents?: number | null;
}) {
  if (!Number.isSafeInteger(input.faceValueCents) || input.faceValueCents < 100) {
    throw new Error('Ticket face value must be at least 100 cents.');
  }
  if (!Number.isSafeInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 5_000) {
    throw new Error('Ticket fee basis points are invalid.');
  }
  if (
    !Number.isSafeInteger(input.feeFixedCents)
    || input.feeFixedCents < 0
    || input.feeFixedCents > 10_000
  ) {
    throw new Error('Ticket fixed fee is invalid.');
  }

  const uncappedFeeCents = Math.ceil(input.faceValueCents * input.feeBps / 10_000)
    + input.feeFixedCents;
  const feeCapCents = input.feeCapCents ?? null;
  if (
    feeCapCents !== null
    && (!Number.isSafeInteger(feeCapCents) || feeCapCents < 0 || feeCapCents > 10_000)
  ) {
    throw new Error('Ticket fee cap is invalid.');
  }
  const mandatoryFeeCents = feeCapCents === null
    ? uncappedFeeCents
    : Math.min(uncappedFeeCents, feeCapCents);
  const totalPriceCents = input.faceValueCents + mandatoryFeeCents;

  if (!Number.isSafeInteger(totalPriceCents) || totalPriceCents > 1_000_000) {
    throw new Error('Ticket total must not exceed 10,000 USD.');
  }

  return {
    faceValueCents: input.faceValueCents,
    mandatoryFeeCents,
    totalPriceCents,
    feeBps: mandatoryFeeCents === uncappedFeeCents ? input.feeBps : 0,
    feeFixedCents: mandatoryFeeCents === uncappedFeeCents ? input.feeFixedCents : mandatoryFeeCents
  };
}

export function buildNativeTicketSellerTermsSnapshot(
  config: NativeTicketRuntimeConfig,
  seller: {
    supportEmail: string;
    isSwayExclusive: boolean;
    exclusiveEntitlementVersion: string | null;
    exclusiveEntitlementHash: string | null;
  }
) {
  if (
    config.feeBps === null
    || config.feeFixedCents === null
    || config.taxMode === null
  ) {
    throw new Error('Native ticket seller terms require a complete fee and tax policy.');
  }

  return {
    version: NATIVE_TICKET_TERMS_VERSION,
    termsHash: NATIVE_TICKET_SELLER_TERMS_HASH,
    settlementPolicy: 'refund_only' as const,
    feeBps: config.feeBps,
    feeFixedCents: config.feeFixedCents,
    exclusiveFeeCapCents: seller.isSwayExclusive
      ? NATIVE_TICKET_EXCLUSIVE_FEE_CAP_CENTS
      : null,
    isSwayExclusive: seller.isSwayExclusive,
    exclusiveEntitlementVersion: seller.exclusiveEntitlementVersion,
    exclusiveEntitlementHash: seller.exclusiveEntitlementHash,
    sellerSupportEmail: seller.supportEmail,
    taxMode: config.taxMode,
    stripeTaxCode: config.stripeTaxCode,
    reservationMinutes: config.reservationMinutes,
    refundGraceMinutes: config.refundGraceMinutes,
    performerTransferTrigger: 'admission_accept' as const,
    perVerifiedAccountTicketLimit: 1,
    fundsDescription: 'captured_on_platform_not_yet_transferred' as const
  };
}

export function buildNativeTicketBuyerTermsSnapshot(input: {
  eventId: string;
  offerId: string;
  performerId: string;
  performerDisplayName: string;
  sellerSupportEmail: string;
  eventTitle: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  locationName: string | null;
  locationAddress: string | null;
  city: string | null;
  locationIsTba: boolean;
  salesCloseAt: string;
  admissionOpensAt: string;
  admissionClosesAt: string;
  faceValueCents: number;
  mandatoryFeeCents: number;
  totalPriceCents: number;
  quantity: number;
  currency: 'USD';
  taxMode: NativeTicketTaxMode;
  refundGraceMinutes: number;
}) {
  return {
    version: NATIVE_TICKET_TERMS_VERSION,
    termsHash: NATIVE_TICKET_BUYER_TERMS_HASH,
    settlementPolicy: 'refund_only' as const,
    performerTransferTrigger: 'admission_accept' as const,
    perVerifiedAccountTicketLimit: 1,
    fundsDescription: 'captured_on_platform_not_yet_transferred' as const,
    ...input
  };
}
