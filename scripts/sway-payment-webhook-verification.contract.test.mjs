import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const providerSource = readFileSync(join(root, 'src/server/payment-provider.ts'), 'utf8');
const webhookSource = readFileSync(join(root, 'src/server/payment-webhook.ts'), 'utf8');

const failures = [];

const requiredProviderBoundaryTerms = [
  'type PaymentProviderAdapter',
  'verifyWebhookSignature',
  'parseWebhookEvent',
  'authorizePayment',
  'capturePayment',
  'refundPayment',
  'voidPayment',
  'createBoundaryOnlyProviderAdapter',
  'Live provider',
  'blocked in Slice 5 boundary mode'
];

for (const term of requiredProviderBoundaryTerms) {
  if (!providerSource.includes(term)) {
    failures.push(`Provider boundary missing required term: ${term}`);
  }
}

const requiredWebhookVerificationTerms = [
  'ingestWebhook',
  'signatureHeader',
  'Webhook signature verification is required',
  'provider.verifyWebhookSignature',
  'Webhook signature verification failed',
  'provider.parseWebhookEvent',
  'mapProviderEventToPaymentState',
  'transitionPaymentState',
  "actorType: 'provider_webhook'"
];

for (const term of requiredWebhookVerificationTerms) {
  if (!webhookSource.includes(term)) {
    failures.push(`Webhook boundary missing required term: ${term}`);
  }
}

const bannedRuntimeTerms = [
  /new\s+Stripe/i,
  /stripe\.webhooks\.constructEvent/i,
  /stripe\.paymentIntents/i,
  /apple\s*pay/i,
  /native\s*payment/i,
  /payout\s*promise/i,
  /kyc\s*expansion/i
];

for (const pattern of bannedRuntimeTerms) {
  if (pattern.test(providerSource) || pattern.test(webhookSource)) {
    failures.push(`Webhook/provider boundary contains banned execution term: ${pattern}`);
  }
}

if (failures.length) {
  console.error('Payment webhook verification boundary contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Payment webhook verification boundary contract passed.');