import { createHash, timingSafeEqual } from 'node:crypto';
import type { PatronStatusReceiptRecord } from '../types';

export const PATRON_STATUS_RECEIPT_TTL_MS = 48 * 60 * 60 * 1000;
export const MAX_ACTIVE_PATRON_STATUS_RECEIPTS = 4;

const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECEIPT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isValidPatronStatusReceipt(receipt: unknown): receipt is string {
  return typeof receipt === 'string' && RECEIPT_PATTERN.test(receipt);
}

export function hashPatronStatusReceipt(receipt: string) {
  return createHash('sha256').update(receipt, 'utf8').digest('hex');
}

function isUnexpiredRecord(record: PatronStatusReceiptRecord, now: Date) {
  if (!RECEIPT_HASH_PATTERN.test(record.receiptHash)) return false;
  const issuedAt = new Date(record.issuedAt).getTime();
  const expiresAt = new Date(record.expiresAt).getTime();
  return Number.isFinite(issuedAt)
    && Number.isFinite(expiresAt)
    && issuedAt <= now.getTime()
    && expiresAt > now.getTime()
    && expiresAt - issuedAt <= PATRON_STATUS_RECEIPT_TTL_MS;
}

export function normalizePatronStatusReceiptRecords(
  records: PatronStatusReceiptRecord[] | undefined,
  now = new Date()
) {
  const deduplicated = new Map<string, PatronStatusReceiptRecord>();

  for (const record of records ?? []) {
    if (!record || !isUnexpiredRecord(record, now)) continue;
    deduplicated.set(record.receiptHash, record);
  }

  return [...deduplicated.values()]
    .sort((left, right) => new Date(left.issuedAt).getTime() - new Date(right.issuedAt).getTime())
    .slice(-MAX_ACTIVE_PATRON_STATUS_RECEIPTS);
}

export function registerPatronStatusReceipt(input: {
  receipt: unknown;
  existingRecords?: PatronStatusReceiptRecord[];
  now?: Date;
}) {
  if (!isValidPatronStatusReceipt(input.receipt)) return null;

  const now = input.now ?? new Date();
  const receiptHash = hashPatronStatusReceipt(input.receipt);
  const existingRecords = normalizePatronStatusReceiptRecords(input.existingRecords, now);
  const existingRecord = existingRecords.find((record) => record.receiptHash === receiptHash);

  if (existingRecord) {
    return {
      record: existingRecord,
      records: existingRecords
    };
  }

  const record: PatronStatusReceiptRecord = {
    receiptHash,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PATRON_STATUS_RECEIPT_TTL_MS).toISOString()
  };

  return {
    record,
    records: normalizePatronStatusReceiptRecords([...existingRecords, record], now)
  };
}

export function findMatchingPatronStatusReceipt(
  records: PatronStatusReceiptRecord[] | undefined,
  rawReceipt: unknown,
  now = new Date()
) {
  if (!isValidPatronStatusReceipt(rawReceipt)) return null;
  const candidateHash = Buffer.from(hashPatronStatusReceipt(rawReceipt), 'hex');

  for (const record of normalizePatronStatusReceiptRecords(records, now)) {
    const storedHash = Buffer.from(record.receiptHash, 'hex');
    if (storedHash.length === candidateHash.length && timingSafeEqual(storedHash, candidateHash)) {
      return record;
    }
  }

  return null;
}
