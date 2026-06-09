import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const providerSource = readFileSync(join(root, 'src/server/payment-provider.ts'), 'utf8');
const webhookSource = readFileSync(join(root, 'src/server/payment-webhook.ts'), 'utf8');
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');

const failures = [];

// The provider must verify and parse Stripe webhook signatures for real.
const requiredProviderTerms = [
  'verifyWebhookSignature',
  'parseWebhookEvent',
  'stripe.webhooks.constructEvent',
  'STRIPE_WEBHOOK_SECRET'
];

for (const term of requiredProviderTerms) {
  if (!providerSource.includes(term)) {
    failures.push(`Webhook provider missing required Stripe verification term: ${term}`);
  }
}

// The webhook service must require signatures and resolve the payment from the
// verified provider intent id, then drive a durable lifecycle transition.
const requiredWebhookTerms = [
  'ingestWebhook',
  'signatureHeader',
  'Webhook signature verification is required',
  'provider.verifyWebhookSignature',
  'Webhook signature verification failed',
  'provider.parseWebhookEvent',
  'mapProviderEventToPaymentState',
  'resolvePaymentIdByIntent',
  'transitionPaymentState',
  "actorType: 'provider_webhook'"
];

for (const term of requiredWebhookTerms) {
  if (!webhookSource.includes(term)) {
    failures.push(`Webhook service missing required verification term: ${term}`);
  }
}

// The server must mount a webhook route over a raw body so signatures verify.
const requiredServerTerms = [
  '/api/payment/webhook',
  'rawBody',
  'stripe-signature'
];

for (const term of requiredServerTerms) {
  if (!serverSource.includes(term)) {
    failures.push(`Server missing required webhook wiring term: ${term}`);
  }
}

// Boundary-only language must not return.
const bannedTerms = [
  /blocked in Slice 5 boundary mode/i,
  /createBoundaryOnlyProviderAdapter/,
  /boundary[- ]only/i
];

const combined = `${providerSource}\n${webhookSource}`;
for (const pattern of bannedTerms) {
  if (pattern.test(combined)) {
    failures.push(`Webhook layer contains banned boundary pattern: ${pattern}`);
  }
}

if (failures.length) {
  console.error('Stripe webhook verification contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Stripe webhook verification contract passed.');
