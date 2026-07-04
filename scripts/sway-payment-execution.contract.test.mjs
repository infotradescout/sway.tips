import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const providerSource = readFileSync(join(root, 'src/server/payment-provider.ts'), 'utf8');
const serviceSource = readFileSync(join(root, 'src/server/payment-service.ts'), 'utf8');
const lifecycleSource = readFileSync(join(root, 'src/server/payment-lifecycle.ts'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const failures = [];

// Real Stripe provider execution must exist (no boundary stubs).
const requiredProviderTerms = [
  "import Stripe from 'stripe'",
  'createStripeProviderAdapter',
  'createConfiguredPaymentProvider',
  'STRIPE_API_VERSION',
  "apiVersion: STRIPE_API_VERSION",
  '2026-06-24.dahlia',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  "capture_method: 'manual'",
  "automatic_payment_methods: { enabled: true, allow_redirects: 'never' }",
  'stripe.paymentIntents.create',
  'stripe.paymentIntents.retrieve',
  'stripe.paymentIntents.capture',
  'stripe.paymentIntents.cancel',
  'stripe.refunds.create'
];

for (const term of requiredProviderTerms) {
  if (!providerSource.includes(term)) {
    failures.push(`Payment provider missing required Stripe execution term: ${term}`);
  }
}

if (packageJson.dependencies?.stripe !== '^22.3.0') {
  failures.push(`Stripe SDK must stay on the verified current release (^22.3.0); found ${packageJson.dependencies?.stripe ?? 'missing'}.`);
}

// Orchestration must create provider-backed authorizations, capture on approval,
// void/refund on denial, and aggregate closeout totals from the database.
const requiredServiceTerms = [
  'authorizeAction',
  'confirmAuthorizedAction',
  'captureAuthorization',
  'voidOrRefund',
  'aggregateCapturedTotals',
  'database_captured_payments',
  "inArray(payments.paymentStatus, ['captured', 'paid_out'])",
  'insert(payments)',
  'isEnabled',
  "status: 'failed'",
  'payment.authorization.failed',
  // Authorization must be gated on a real hold (requires_capture); otherwise the
  // caller is told confirmation is required and no app state is created.
  "status: 'requires_confirmation'",
  "authorization.status === 'requires_capture'"
];

for (const term of requiredServiceTerms) {
  if (!serviceSource.includes(term)) {
    failures.push(`Payment service missing required execution term: ${term}`);
  }
}

// Finite-state lifecycle + durable persistence must remain.
const requiredLifecycleTerms = [
  'type PaymentState',
  'const paymentTransitionGraph',
  "authorized: ['captured', 'voided', 'failed', 'refunded']",
  "captured: ['refunded', 'disputed', 'paid_out']",
  'assertPaymentTransition',
  'transitionPaymentState',
  'duplicate_event',
  'noop_current_state',
  'ignored_out_of_order',
  'concurrent_noop',
  'db.transaction',
  'update(payments)',
  'insert(paymentEvents).values',
  "entityType: 'payment'",
  'insert(auditEvents).values',
  'previousStatus',
  'nextStatus'
];

for (const term of requiredLifecycleTerms) {
  if (!lifecycleSource.includes(term)) {
    failures.push(`Payment lifecycle missing required term: ${term}`);
  }
}

// Boundary-only / simulated payment language must not return.
const bannedTerms = [
  /blocked in Slice 5 boundary mode/i,
  /createBoundaryOnlyProviderAdapter/,
  /boundary[- ]only/i,
  /simulate(d)?\s+payment/i,
  /fake\s*checkout/i,
  /test\s*checkout/i,
  /local-only\s+financial/i,
  /apple\s*pay/i,
  /google\s*pay/i
];

const combined = `${providerSource}\n${serviceSource}\n${lifecycleSource}`;
for (const pattern of bannedTerms) {
  if (pattern.test(combined)) {
    failures.push(`Payment execution layer contains banned boundary/simulation pattern: ${pattern}`);
  }
}

if (failures.length) {
  console.error('Payment execution contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Payment execution contract passed.');
