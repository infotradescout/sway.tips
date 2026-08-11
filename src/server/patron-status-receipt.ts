import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { PatronPaymentStatus, PatronRequestStatus, RequestItem } from '../types';

const PATRON_STATUS_RECEIPT_BYTES = 32;
const PATRON_STATUS_RECEIPT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const PATRON_REQUEST_STATUSES = new Set<PatronRequestStatus['status']>([
  'hold',
  'approved',
  'denied',
  'fulfilled',
  'unavailable'
]);
const PATRON_PAYMENT_STATUSES = new Set<PatronPaymentStatus>([
  'not_applicable',
  'processing',
  'authorized',
  'captured',
  'released',
  'refund_pending',
  'refunded',
  'failed',
  'disputed',
  'paid_out',
  'unavailable'
]);

export type PatronPaymentEvidence = {
  paymentStatus?: string | null;
  refundStatus?: string | null;
};

export type PatronPaymentEvidenceCandidate = PatronPaymentEvidence & { id: string };

export function selectPatronPaymentEvidence(input: {
  runtimePaymentId?: string | null;
  candidates: PatronPaymentEvidenceCandidate[];
}): PatronPaymentEvidence | undefined {
  if (input.runtimePaymentId) {
    const exact = input.candidates.find((candidate) => candidate.id === input.runtimePaymentId);
    return exact
      ? { paymentStatus: exact.paymentStatus, refundStatus: exact.refundStatus }
      : {};
  }
  if (input.candidates.length === 0) return undefined;
  if (input.candidates.length !== 1) return {};
  return {
    paymentStatus: input.candidates[0].paymentStatus,
    refundStatus: input.candidates[0].refundStatus
  };
}

export function projectPatronPaymentStatus(evidence?: PatronPaymentEvidence): PatronPaymentStatus {
  if (evidence?.refundStatus === 'pending') return 'refund_pending';
  if (evidence?.refundStatus === 'refunded' || evidence?.paymentStatus === 'refunded') return 'refunded';

  switch (evidence?.paymentStatus) {
    case 'not_applicable': return 'not_applicable';
    case 'created':
    case 'payment_pending': return 'processing';
    case 'authorized': return 'authorized';
    case 'captured': return 'captured';
    case 'voided': return 'released';
    case 'failed': return 'failed';
    case 'disputed': return 'disputed';
    case 'paid_out': return 'paid_out';
    default: return 'unavailable';
  }
}

function actionUnavailableFromPayment(paymentStatus: PatronPaymentStatus) {
  return paymentStatus === 'released'
    || paymentStatus === 'refund_pending'
    || paymentStatus === 'refunded'
    || paymentStatus === 'failed';
}

export function isPatronStatusReceipt(value: unknown): value is string {
  return typeof value === 'string' && PATRON_STATUS_RECEIPT_PATTERN.test(value);
}

export function hashPatronStatusReceipt(receipt: string): string {
  return createHash('sha256').update(receipt, 'utf8').digest('hex');
}

export function issuePatronStatusReceipt() {
  const receipt = randomBytes(PATRON_STATUS_RECEIPT_BYTES).toString('base64url');
  return {
    receipt,
    receiptHash: hashPatronStatusReceipt(receipt)
  };
}

export function matchesPatronStatusReceipt(receipt: unknown, storedReceiptHash: unknown): boolean {
  if (!isPatronStatusReceipt(receipt)) return false;
  if (typeof storedReceiptHash !== 'string' || !SHA256_HEX_PATTERN.test(storedReceiptHash)) return false;

  const providedHash = Buffer.from(hashPatronStatusReceipt(receipt), 'hex');
  const expectedHash = Buffer.from(storedReceiptHash, 'hex');
  return providedHash.length === expectedHash.length && timingSafeEqual(providedHash, expectedHash);
}

export function projectPatronRequestStatus(
  request: RequestItem,
  durablePaymentEvidence?: PatronPaymentEvidence
): PatronRequestStatus {
  const paymentStatus = projectPatronPaymentStatus(durablePaymentEvidence ?? request);
  const unavailable = request.hidden
    || request.removed
    || (request.status !== 'denied' && actionUnavailableFromPayment(paymentStatus));
  return {
    actionType: request.type,
    status: unavailable ? 'unavailable' : request.status,
    paymentStatus,
    title: request.title,
    submittedAt: request.createdAt
  };
}

export function projectPatronBoostStatus(
  boost: RequestItem['boosts'][number],
  request: RequestItem,
  durablePaymentEvidence?: PatronPaymentEvidence
): PatronRequestStatus {
  const paymentStatus = projectPatronPaymentStatus(durablePaymentEvidence ?? boost);
  return {
    actionType: 'boost',
    status: request.hidden || request.removed || actionUnavailableFromPayment(paymentStatus)
      ? 'unavailable'
      : 'fulfilled',
    paymentStatus,
    title: request.title,
    submittedAt: boost.timestamp
  };
}

export function sanitizePatronRequestStatus(value: unknown): PatronRequestStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.actionType !== 'request' && input.actionType !== 'tip' && input.actionType !== 'boost') return null;
  if (typeof input.status !== 'string' || !PATRON_REQUEST_STATUSES.has(input.status as PatronRequestStatus['status'])) {
    return null;
  }
  if (typeof input.title !== 'string' || typeof input.submittedAt !== 'string') return null;
  const paymentStatus = typeof input.paymentStatus === 'string'
    && PATRON_PAYMENT_STATUSES.has(input.paymentStatus as PatronPaymentStatus)
    ? input.paymentStatus as PatronPaymentStatus
    : 'unavailable';

  return {
    actionType: input.actionType,
    status: input.status as PatronRequestStatus['status'],
    paymentStatus,
    title: input.title,
    submittedAt: input.submittedAt
  };
}
