import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const providerSource = readFileSync(join(root, 'src/server/payment-provider.ts'), 'utf8');
const webhookSource = readFileSync(join(root, 'src/server/payment-webhook.ts'), 'utf8');
const lifecycleSource = readFileSync(join(root, 'src/server/payment-lifecycle.ts'), 'utf8');
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');

const failures = [];

// The provider must verify and parse Stripe webhook signatures for real.
const requiredProviderTerms = [
  'verifyWebhookSignature',
  'parseWebhookEvent',
  'stripe.webhooks.constructEvent',
  'if (!input.signatureHeader) return false',
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
  'allowOutOfOrderNoop: true',
  "actorType: 'provider_webhook'"
];

for (const term of requiredWebhookTerms) {
  if (!webhookSource.includes(term)) {
    failures.push(`Webhook service missing required verification term: ${term}`);
  }
}

const requiredReplayTerms = [
  'duplicate_event',
  'noop_current_state',
  'ignored_out_of_order',
  'concurrent_noop',
  'canTransitionPaymentState(previousStatus, input.nextStatus)'
];

for (const term of requiredReplayTerms) {
  if (!lifecycleSource.includes(term)) {
    failures.push(`Webhook lifecycle replay handling missing required term: ${term}`);
  }
}

// The server must mount a webhook route over a raw body so signatures verify.
const requiredServerTerms = [
  '/api/payment/webhook',
  'rawBody',
  'stripe-signature',
  'return res.status(400).json'
];

for (const term of requiredServerTerms) {
  if (!serverSource.includes(term)) {
    failures.push(`Server missing required webhook wiring term: ${term}`);
  }
}

const webhookRouteStart = serverSource.indexOf('app.post("/api/payment/webhook"');
const webhookRouteEnd = serverSource.indexOf('app.get("/api/state"', webhookRouteStart);
const webhookRouteSource = webhookRouteStart >= 0 && webhookRouteEnd > webhookRouteStart
  ? serverSource.slice(webhookRouteStart, webhookRouteEnd)
  : '';

if (!webhookRouteSource) {
  failures.push('Server webhook route source could not be isolated for signature guard checks.');
}

const requiredSignatureGuardPatterns = [
  /if\s*\(!input\.signatureHeader\)\s*\{[\s\S]*Webhook signature verification is required/,
  /if\s*\(!isValidSignature\)\s*\{[\s\S]*Webhook signature verification failed/,
  /catch\s*\(error\)\s*\{[\s\S]*return res\.status\(400\)\.json/
];

for (const pattern of requiredSignatureGuardPatterns) {
  if (!pattern.test(`${webhookSource}\n${webhookRouteSource}`)) {
    failures.push(`Webhook signature guard missing required rejection pattern: ${pattern}`);
  }
}

const bannedSignatureBypassPatterns = [
  /NODE_ENV[\s\S]{0,120}webhook/i,
  /isProduction[\s\S]{0,120}webhook/i,
  /development[\s\S]{0,120}signature/i,
  /signature[\s\S]{0,120}bypass/i,
  /skip[\s_-]?signature/i,
  /disable[\s_-]?signature/i
];

const signatureGuardSource = `${providerSource}\n${webhookSource}\n${webhookRouteSource}`;
for (const pattern of bannedSignatureBypassPatterns) {
  if (pattern.test(signatureGuardSource)) {
    failures.push(`Webhook signature guard contains a possible environment bypass: ${pattern}`);
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
