import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { PatronRequestStatus, RequestItem } from '../types';

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

export function projectPatronRequestStatus(request: RequestItem): PatronRequestStatus {
  return {
    actionType: request.type,
    status: request.hidden || request.removed ? 'unavailable' : request.status,
    title: request.title,
    submittedAt: request.createdAt
  };
}

export function projectPatronBoostStatus(boost: RequestItem['boosts'][number], request: RequestItem): PatronRequestStatus {
  return {
    actionType: 'boost',
    status: request.hidden || request.removed ? 'unavailable' : 'fulfilled',
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

  return {
    actionType: input.actionType,
    status: input.status as PatronRequestStatus['status'],
    title: input.title,
    submittedAt: input.submittedAt
  };
}
