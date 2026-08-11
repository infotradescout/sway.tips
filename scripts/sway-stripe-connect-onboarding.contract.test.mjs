import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
const connectSource = readFileSync(join(root, 'src/server/stripe-connect.ts'), 'utf8');
const onboardingSource = readFileSync(join(root, 'src/server/stripe-connect-onboarding.ts'), 'utf8');
const onboardingStoreSource = readFileSync(join(root, 'src/server/stripe-connect-onboarding-store.ts'), 'utf8');
const accountClaimSource = readFileSync(join(root, 'src/server/account-claim.ts'), 'utf8');
const schemaSource = readFileSync(join(root, 'src/db/schema.ts'), 'utf8');
const migrationName = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .find((name) => readFileSync(join(root, 'drizzle', name), 'utf8').includes('stripe_connect_onboarding_operations'));
const migrationSource = migrationName ? readFileSync(join(root, 'drizzle', migrationName), 'utf8') : '';
const talentDashboardSource = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');

const failures = [];

const requiredServerTerms = [
  "app.post('/api/talent/connect/onboard'",
  'stripeConnectService.createOnboardingLink',
  'provisionStripeConnectRecipient',
  'createStripeConnectOnboardingUrl',
  'A verified performer account email is required before Stripe onboarding.',
  "app.get('/talent/connect/refresh', async (req, res)",
  'accessControl.requireTalentAccess(req)',
  'emailVerifiedAt: users.emailVerifiedAt',
  'createStripeConnectOnboardingUrl(owner.stripeAccountId)',
  'res.redirect(303, url)',
  'liveRoomPaymentRuntimeConfig.connectEnabled',
  "console.error('Stripe Connect onboarding failed.'",
  'Stripe Connect onboarding could not be started',
  'return res.status(502).json'
];

for (const term of requiredServerTerms) {
  if (!serverSource.includes(term)) {
    failures.push(`Connect onboarding route missing required JSON failure term: ${term}`);
  }
}

const requiredConnectTerms = [
  'STRIPE_API_VERSION',
  "!secretKey?.startsWith('sk_test_') && !secretKey?.startsWith('sk_live_')",
  "apiVersion: STRIPE_API_VERSION",
  'stripe.v2.core.accounts.create',
  'contact_email: input.contactEmail',
  'sway_connect_operation_key: input.operationKey',
  "applied_configurations: ['recipient']",
  '{ idempotencyKey: input.operationKey }',
  'stripe.v2.core.accountLinks.create',
  "type: 'account_onboarding'",
  "configurations: ['recipient']",
  'configuration:',
  'recipient:',
  'stripe_transfers',
  "dashboard: 'express'",
  'stripe.parseEventNotification',
  'v2.core.account_link.returned',
  "event.type !== 'account.updated'"
];

for (const term of requiredConnectTerms) {
  if (!connectSource.includes(term)) {
    failures.push(`Connect service missing required Accounts v2 term: ${term}`);
  }
}

for (const term of [
  'stripeConnectOnboardingOperations',
  'operationKey',
  'ownerUserId',
  'stripeAccountId',
  'leaseToken',
  'leaseExpiresAt',
  'attemptCount'
]) {
  if (!schemaSource.includes(term)) failures.push(`Connect provisioning schema missing durable term: ${term}`);
}

for (const term of [
  'stripeConnectOnboardingOperations',
  'stripe_connect_provisioning_in_progress',
  'payment_account_configured',
  ".for('update')"
]) {
  if (!accountClaimSource.includes(term)) failures.push(`Performer ownership transfer fence missing term: ${term}`);
}

for (const term of [
  'CREATE TABLE "stripe_connect_onboarding_operations"',
  'stripe_connect_onboarding_operations_key_idx',
  'stripe_connect_onboarding_operations_account_idx',
  'stripe_connect_onboarding_operations_lease_consistent'
]) {
  if (!migrationSource.includes(term)) failures.push(`Connect provisioning migration missing term: ${term}`);
}

for (const term of [
  'if (!owner.contactEmail || !owner.emailVerifiedAt)',
  ".for('update')",
  'onConflictDoNothing',
  "status: 'provisioning'",
  "status: 'bound'",
  'stripe_connect.account_bound',
  'stripe_connect_operation_lease_conflict'
]) {
  if (!onboardingStoreSource.includes(term)) failures.push(`Connect provisioning store missing term: ${term}`);
}

for (const term of [
  'input.store.reserve',
  'input.stripe.createRecipientAccount',
  'input.store.complete',
  'input.store.fail'
]) {
  if (!onboardingSource.includes(term)) failures.push(`Connect provisioning coordinator missing term: ${term}`);
}

if (/app\.get\('\/talent\/connect\/refresh',\s*\(_req,\s*res\)\s*=>\s*\{\s*res\.redirect\('\/talent'\)/.test(serverSource)) {
  failures.push('Expired Stripe Account Links must not refresh to a dead-end performer redirect.');
}

const behavior = spawnSync(process.execPath, [
  '--import',
  'tsx',
  join(root, 'scripts/sway-stripe-connect-provisioning.behavior.test.ts')
], { cwd: root, encoding: 'utf8' });
if (behavior.status !== 0) {
  failures.push(`Stripe Connect provisioning behavior test failed: ${behavior.stderr || behavior.stdout || 'unknown error'}`);
} else if (behavior.stdout) {
  process.stdout.write(behavior.stdout);
}

const integration = spawnSync(process.execPath, [
  '--import',
  'tsx',
  join(root, 'scripts/sway-stripe-connect-onboarding.integration.test.ts')
], { cwd: root, encoding: 'utf8' });
if (integration.status !== 0) {
  failures.push(`Stripe Connect onboarding store integration test failed: ${integration.stderr || integration.stdout || 'unknown error'}`);
} else if (integration.stdout) {
  process.stdout.write(integration.stdout);
}

const ownershipConcurrency = spawnSync(process.execPath, [
  '--import',
  'tsx',
  join(root, 'scripts/sway-stripe-connect-ownership-concurrency.integration.test.ts')
], { cwd: root, encoding: 'utf8' });
if (ownershipConcurrency.status !== 0) {
  failures.push(`Stripe Connect ownership concurrency integration test failed: ${ownershipConcurrency.stderr || ownershipConcurrency.stdout || 'unknown error'}`);
} else if (ownershipConcurrency.stdout) {
  process.stdout.write(ownershipConcurrency.stdout);
}

const bannedConnectPatterns = [
  /accounts\.create\(\s*\{\s*type:\s*['"]express['"]/,
  /type:\s*['"]custom['"]/,
  /type:\s*['"]standard['"]/
];

for (const pattern of bannedConnectPatterns) {
  if (pattern.test(connectSource)) {
    failures.push(`Connect service contains banned legacy account-type pattern: ${pattern}`);
  }
}

const connectRouteStart = serverSource.indexOf("app.post('/api/talent/connect/onboard'");
const connectRouteEnd = serverSource.indexOf("app.get('/talent/connect/refresh'", connectRouteStart);
const connectRouteSource = connectRouteStart >= 0 && connectRouteEnd > connectRouteStart
  ? serverSource.slice(connectRouteStart, connectRouteEnd)
  : '';

if (!/try\s*\{[\s\S]*provisionStripeConnectRecipient[\s\S]*createStripeConnectOnboardingUrl[\s\S]*\}\s*catch\s*\(error\)/.test(connectRouteSource)) {
  failures.push('Connect onboarding durable provisioning and link creation must be wrapped in try/catch.');
}

if (!talentDashboardSource.includes('await response.json().catch(() => null)')) {
  failures.push('Talent dashboard must tolerate non-JSON Connect onboarding failures.');
}

if (!talentDashboardSource.includes("disabled={previewMode || (liveRoomPaymentMode !== 'test' && liveRoomPaymentMode !== 'live') || stripeConnectStatus === 'submitting'}")) {
  failures.push('Talent dashboard must disable Connect onboarding unless the server verifies Stripe test or live mode.');
}

if (/Unexpected token.*DOCTYPE/i.test(talentDashboardSource)) {
  failures.push('Talent dashboard must not expose raw HTML parse errors for Connect onboarding.');
}

if (failures.length) {
  console.error('Stripe Connect onboarding contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Stripe Connect onboarding contract passed.');
