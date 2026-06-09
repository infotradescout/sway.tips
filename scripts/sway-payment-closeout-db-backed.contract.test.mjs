import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
const serviceSource = readFileSync(join(root, 'src/server/payment-service.ts'), 'utf8');

const failures = [];

// Closeout totals must be aggregated from captured payment records in the
// database, not recomputed from runtime arrays.
const requiredServerTerms = [
  'paymentService.aggregateCapturedTotals',
  'closeoutTotalsSource',
  'capturedSubtotalCents',
  // Capture only happens on performer approval / fulfillment.
  'paymentService.captureAuthorization',
  // Denials and moderation removals release funds.
  'paymentService.voidOrRefundMany'
];

for (const term of requiredServerTerms) {
  if (!serverSource.includes(term)) {
    failures.push(`Server missing required DB-backed closeout / settlement term: ${term}`);
  }
}

// Paid boosts must remain behind approval: only approved, visible items qualify.
const requiredBoostGate = [
  "request.status === 'approved'",
  '!request.shadowBanned',
  '!request.hidden',
  '!request.removed'
];

for (const term of requiredBoostGate) {
  if (!serverSource.includes(term)) {
    failures.push(`Paid boost approval gate missing required term: ${term}`);
  }
}

// The aggregation source of truth must be captured payment rows.
const requiredServiceTerms = [
  'database_captured_payments',
  "inArray(payments.paymentStatus, ['captured', 'paid_out'])"
];

for (const term of requiredServiceTerms) {
  if (!serviceSource.includes(term)) {
    failures.push(`Closeout aggregation missing required captured-payment term: ${term}`);
  }
}

// Closeout must not derive financial totals from the runtime request array.
if (/closeout[\s\S]{0,400}recalculateTotals\(state\)[\s\S]{0,200}totalTips\s*=/i.test(serverSource)) {
  failures.push('Closeout totals must not be recomputed from runtime arrays.');
}

if (failures.length) {
  console.error('Payment closeout DB-backed contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Payment closeout DB-backed contract passed.');
