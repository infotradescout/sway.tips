import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const lifecycleFile = join(root, 'src/server/payment-lifecycle.ts');
const source = readFileSync(lifecycleFile, 'utf8');

const failures = [];

const requiredStateTerms = [
  "type PaymentState",
  'const paymentTransitionGraph',
  "created: ['payment_pending', 'failed', 'voided']",
  "payment_pending: ['authorized', 'failed', 'voided']",
  "authorized: ['captured', 'voided', 'failed', 'refunded']",
  "captured: ['refunded', 'disputed', 'paid_out']",
  'voided: []',
  'refunded: []',
  'failed: []',
  "disputed: ['refunded', 'paid_out']",
  'paid_out: []',
  'isFinitePaymentState',
  'canTransitionPaymentState',
  'assertPaymentTransition'
];

for (const term of requiredStateTerms) {
  if (!source.includes(term)) {
    failures.push(`Payment lifecycle missing required finite-state term: ${term}`);
  }
}

const requiredPersistenceTerms = [
  'transitionPaymentState',
  'db.transaction',
  'update(payments)',
  'insert(paymentEvents).values',
  "entityType: 'payment'",
  'insert(auditEvents).values',
  'previousStatus',
  'nextStatus'
];

for (const term of requiredPersistenceTerms) {
  if (!source.includes(term)) {
    failures.push(`Payment lifecycle missing required persistence term: ${term}`);
  }
}

const bannedExecutionTerms = [
  /stripe\.paymentIntents/i,
  /stripe\.charges/i,
  /capturePaymentIntent/i,
  /refundPaymentIntent/i,
  /voidPaymentIntent/i,
  /apple\s*pay/i,
  /google\s*pay/i
];

for (const pattern of bannedExecutionTerms) {
  if (pattern.test(source)) {
    failures.push(`Payment lifecycle contains banned live provider execution pattern: ${pattern}`);
  }
}

if (failures.length) {
  console.error('Payment lifecycle boundary contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Payment lifecycle boundary contract passed.');