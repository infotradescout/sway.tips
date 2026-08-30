import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
const connectSource = readFileSync(join(root, 'src/server/stripe-connect.ts'), 'utf8');
const onboardingSource = readFileSync(join(root, 'src/server/stripe-connect-onboarding.ts'), 'utf8');
const onboardingStoreSource = readFileSync(join(root, 'src/server/stripe-connect-onboarding-store.ts'), 'utf8');
const payoutDestinationSource = readFileSync(join(root, 'src/payout-destination.ts'), 'utf8');
const payoutDestinationStoreSource = readFileSync(join(root, 'src/server/payout-destination-store.ts'), 'utf8');
const payoutSetupSource = readFileSync(join(root, 'src/server/payout-setup.ts'), 'utf8');
const payoutCapabilitySource = readFileSync(join(root, 'src/server/payout-destination-capabilities.ts'), 'utf8');
const accountClaimSource = readFileSync(join(root, 'src/server/account-claim.ts'), 'utf8');
const schemaSource = readFileSync(join(root, 'src/db/schema.ts'), 'utf8');
const migrationName = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .find((name) => readFileSync(join(root, 'drizzle', name), 'utf8').includes('stripe_connect_onboarding_operations'));
const migrationSource = migrationName ? readFileSync(join(root, 'drizzle', migrationName), 'utf8') : '';
const accountUniqueMigrationName = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .find((name) => readFileSync(join(root, 'drizzle', name), 'utf8').includes('performers_stripe_connected_account_id_unique'));
const accountUniqueMigrationSource = accountUniqueMigrationName
  ? readFileSync(join(root, 'drizzle', accountUniqueMigrationName), 'utf8')
  : '';
const statusFreshnessMigrationName = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .find((name) => readFileSync(join(root, 'drizzle', name), 'utf8').includes('stripe_connect_status_checked_at'));
const statusFreshnessMigrationSource = statusFreshnessMigrationName
  ? readFileSync(join(root, 'drizzle', statusFreshnessMigrationName), 'utf8')
  : '';
const payoutPreferenceMigrationName = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .find((name) => readFileSync(join(root, 'drizzle', name), 'utf8').includes('performer_payout_preferences'));
const payoutPreferenceMigrationSource = payoutPreferenceMigrationName
  ? readFileSync(join(root, 'drizzle', payoutPreferenceMigrationName), 'utf8')
  : '';
const talentDashboardSource = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const connectStatusSource = readFileSync(join(root, 'src/server/stripe-connect-status.ts'), 'utf8');
const connectReturnSource = readFileSync(join(root, 'src/server/stripe-connect-return.ts'), 'utf8');
const connectWebhookSource = readFileSync(join(root, 'src/server/stripe-connect-webhook.ts'), 'utf8');

const failures = [];

const requiredServerTerms = [
  "app.post('/api/talent/connect/onboard'",
  'stripeConnectService.createOnboardingLink',
  'provisionStripeConnectRecipient',
  'createStripeConnectOnboardingUrl',
  'createStripeConnectManagementUrl',
  'A verified performer account email is required before Stripe onboarding.',
  "app.get('/talent/connect/refresh', async (req, res)",
  'accessControl.requireTalentAccess(req)',
  'emailVerifiedAt: users.emailVerifiedAt',
  'createStripeConnectOnboardingUrl(owner.stripeAccountId)',
  'res.redirect(303, url)',
  'liveRoomPaymentRuntimeConfig.connectEnabled',
  "console.error('Stripe Connect onboarding failed.'",
  'Secure payout setup could not be started',
  'return res.status(502).json',
  "app.get('/talent/connect/return', async (req, res)",
  'applyNoStoreHeaders(res)',
  'handleStripeConnectReturn({',
  'requireTalentAccess: (request) => accessControl.requireTalentAccess(request)',
  'loadOwnedPerformer: loadOwnedPerformerByActorUserId',
  'reconcileStripeConnectPerformerStatus({',
  "source: 'return'",
  'expectedPerformerId: performerId',
  'expectedOwnerUserId: ownerUserId',
  "console.error('Stripe Connect return reconciliation failed.'",
  'handleStripeConnectAccountStatusWebhook({',
  "source: event.eventType.startsWith('v2.') ? 'webhook_v2' : 'webhook_v1'",
  'providerEventId: event.providerEventId'
];

for (const term of requiredServerTerms) {
  if (!serverSource.includes(term)) {
    failures.push(`Connect onboarding route missing required JSON failure term: ${term}`);
  }
}

for (const term of [
  'normalizePayoutDestinationKind(req.body?.destinationKind)',
  "Object.prototype.hasOwnProperty.call(req.body, 'destinationKind')",
  'destinationKindProvided && !destinationKind',
  'canConfigurePayoutDestination(',
  'payoutDestinationCapabilities',
  'preparePayoutSetup({',
  'payoutDestinationStore.selectForOwner({',
  'destinationKind',
  "return res.status(422).json({ error: 'Choose a supported payout destination.' })",
  'payout_destination_kind: performerPayoutPreferences.destinationKind',
  ".leftJoin(performerPayoutPreferences, eq(performerPayoutPreferences.performerId, performers.id))"
]) {
  if (!serverSource.includes(term)) failures.push(`Payout destination route missing term: ${term}`);
}

for (const term of [
  'SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED',
  'SWAY_STRIPE_CONNECT_DEBIT_CARD_COLLECTION_CONFIRMED',
  "country === 'US'",
  'bank_account: externalAccountCollectionConfirmed',
  'debit_card: debitCardCollectionConfirmed && isUnitedStates',
  'cash_app_direct_deposit: externalAccountCollectionConfirmed && isUnitedStates',
  'venmo_direct_deposit: externalAccountCollectionConfirmed && isUnitedStates'
]) {
  if (!payoutCapabilitySource.includes(term)) failures.push(`Payout destination provider capability gate missing term: ${term}`);
}

for (const term of [
  'const provisioning = await input.provision()',
  'await input.createManagementLink(provisioning.accountId)',
  'await input.createOnboardingLink(provisioning.accountId)',
  'if (input.persistDestination)',
  'const preference = await input.persistDestination()',
  "if (preference.kind === 'not_found') return { kind: 'not_found' }"
]) {
  if (!payoutSetupSource.includes(term)) failures.push(`Payout setup ordering coordinator missing term: ${term}`);
}

for (const term of [
  'bank_account',
  'debit_card',
  'cash_app_direct_deposit',
  'venmo_direct_deposit',
  'normalizePayoutDestinationKind',
  'canConfigurePayoutDestination',
  'payoutDestinationLabel'
]) {
  if (!payoutDestinationSource.includes(term)) failures.push(`Payout destination catalog missing term: ${term}`);
}

for (const term of [
  'performerPayoutPreferences',
  '.for(\'update\')',
  'onConflictDoUpdate',
  "eventType: 'performer_payout_preference.select'",
  'storesSensitiveAccountData: false'
]) {
  if (!payoutDestinationStoreSource.includes(term)) failures.push(`Payout destination store missing term: ${term}`);
}

for (const term of [
  'CREATE TABLE "performer_payout_preferences"',
  'performer_payout_preferences_destination_kind_allowed',
  'cash_app_direct_deposit',
  'venmo_direct_deposit'
]) {
  if (!payoutPreferenceMigrationSource.includes(term)) failures.push(`Payout preference migration missing term: ${term}`);
}

for (const term of [
  'PAYOUT_DESTINATIONS.map',
  'Cash App and Venmo use their direct-deposit routing and account numbers',
  'Test bank account (simulated)',
  'Test debit card (simulated)',
  'Use the test bank details provided by Stripe. Do not enter real routing or account numbers.',
  'Cash App and Venmo are shown for clarity but cannot be selected until live payouts are enabled.',
  'normalizePayoutDestinationCapabilities(data?.payoutDestinationCapabilities)',
  'Unavailable until Sway confirms this payout rail is enabled in the configured Stripe account.',
  "destination.helpUrl && liveRoomPaymentMode === 'live' && setupAllowed",
  'Sway never stores your full bank or card numbers.',
  'body: JSON.stringify({ destinationKind: payoutDestinationKind })',
  'Review or change payout details'
]) {
  if (!talentDashboardSource.includes(term)) failures.push(`Talent dashboard payout chooser missing term: ${term}`);
}

const requiredConnectTerms = [
  'STRIPE_API_VERSION',
  "!secretKey?.startsWith('sk_test_') && !secretKey?.startsWith('sk_live_')",
  "apiVersion: STRIPE_API_VERSION",
  'stripe.v2.core.accounts.create',
  'limit: 20',
  'contact_email: input.contactEmail',
  'sway_connect_operation_key: input.operationKey',
  "applied_configurations: ['recipient']",
  '{ idempotencyKey: input.operationKey }',
  'stripe.v2.core.accountLinks.create',
  'stripe.accounts.createLoginLink',
  "type: 'account_onboarding'",
  "configurations: ['recipient']",
  'configuration:',
  'recipient:',
  'stripe_transfers',
  "dashboard: 'express'",
  'stripe.parseEventNotification',
  'v2.core.account_link.returned',
  "event.type !== 'account.updated'",
  'status: await getAccountStatus(account.id)',
  'providerEventId: event.id',
  'providerEventId: notification.id'
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
  'attemptCount',
  'performers_stripe_connected_account_id_unique',
  'stripeConnectStatusCheckedAt'
]) {
  if (!schemaSource.includes(term)) failures.push(`Connect provisioning schema missing durable term: ${term}`);
}

for (const term of [
  'chargesEnabled: status.chargesEnabled',
  'payoutsEnabled: status.payoutsEnabled',
  "'not_started'",
  "'created'",
  "'charges_enabled'",
  "'payouts_enabled'",
  ".for('update')",
  ".limit(2)",
  'stripe_connect_account_binding_conflict',
  'stripeConnectStatusCheckedAt: checkedAt',
  'updatedAt: checkedAt',
  'stripe_connect.readiness_changed',
  'writeAuditEvent(tx',
  "source: 'return' | 'webhook_v1' | 'webhook_v2'"
]) {
  if (!connectStatusSource.includes(term)) failures.push(`Connect status mapper missing term: ${term}`);
}

for (const term of [
  'requireTalentAccess(input.req)',
  "redirect(303, '/talent/account?connect=auth')",
  "redirect(303, '/talent/account?connect=pending')",
  "'/talent/account?connect=return'",
  'loadOwnedPerformer(ownerUserId)',
  'getAccountStatus(performerOwner.stripeAccountId)',
  'result.kind === \'not_found\''
]) {
  if (!connectReturnSource.includes(term)) failures.push(`Connect return handler missing term: ${term}`);
}

for (const term of [
  'input.applyStatus(input.accountEvent)',
  "throw new Error('stripe_connect_account_not_bound')",
  'input.res.status(400).json',
  "result: { type: 'account.updated' }"
]) {
  if (!connectWebhookSource.includes(term)) failures.push(`Connect webhook handler missing term: ${term}`);
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
  'CREATE UNIQUE INDEX "performers_stripe_connected_account_id_unique"',
  'WHERE "performers"."stripe_connected_account_id" is not null'
]) {
  if (!accountUniqueMigrationSource.includes(term)) failures.push(`Connect account uniqueness migration missing term: ${term}`);
}

if (!statusFreshnessMigrationSource.includes('ADD COLUMN "stripe_connect_status_checked_at" timestamp with time zone')) {
  failures.push('Connect status freshness migration missing dedicated timestamp column.');
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

const statusBehavior = spawnSync(process.execPath, [
  '--import',
  'tsx',
  join(root, 'scripts/sway-stripe-connect-status.behavior.test.ts')
], { cwd: root, encoding: 'utf8' });
if (statusBehavior.status !== 0) {
  failures.push(`Stripe Connect status behavior test failed: ${statusBehavior.stderr || statusBehavior.stdout || 'unknown error'}`);
} else if (statusBehavior.stdout) {
  process.stdout.write(statusBehavior.stdout);
}

const returnBehavior = spawnSync(process.execPath, [
  '--import',
  'tsx',
  join(root, 'scripts/sway-stripe-connect-return.behavior.test.ts')
], { cwd: root, encoding: 'utf8' });
if (returnBehavior.status !== 0) {
  failures.push(`Stripe Connect return behavior test failed: ${returnBehavior.stderr || returnBehavior.stdout || 'unknown error'}`);
} else if (returnBehavior.stdout) {
  process.stdout.write(returnBehavior.stdout);
}

const webhookBehavior = spawnSync(process.execPath, [
  '--import',
  'tsx',
  join(root, 'scripts/sway-stripe-connect-webhook.behavior.test.ts')
], { cwd: root, encoding: 'utf8' });
if (webhookBehavior.status !== 0) {
  failures.push(`Stripe Connect webhook behavior test failed: ${webhookBehavior.stderr || webhookBehavior.stdout || 'unknown error'}`);
} else if (webhookBehavior.stdout) {
  process.stdout.write(webhookBehavior.stdout);
}

const statusIntegration = spawnSync(process.execPath, [
  '--import',
  'tsx',
  join(root, 'scripts/sway-stripe-connect-status.integration.test.ts')
], { cwd: root, encoding: 'utf8' });
if (statusIntegration.status !== 0) {
  failures.push(`Stripe Connect status integration test failed: ${statusIntegration.stderr || statusIntegration.stdout || 'unknown error'}`);
} else if (statusIntegration.stdout) {
  process.stdout.write(statusIntegration.stdout);
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

const payoutDestinationBehavior = spawnSync(process.execPath, [
  '--import',
  'tsx',
  join(root, 'scripts/sway-payout-destination.behavior.test.ts')
], { cwd: root, encoding: 'utf8' });
if (payoutDestinationBehavior.status !== 0) {
  failures.push(`Payout destination behavior test failed: ${payoutDestinationBehavior.stderr || payoutDestinationBehavior.stdout || 'unknown error'}`);
} else if (payoutDestinationBehavior.stdout) {
  process.stdout.write(payoutDestinationBehavior.stdout);
}

const payoutSetupBehavior = spawnSync(process.execPath, [
  '--import',
  'tsx',
  join(root, 'scripts/sway-payout-setup.behavior.test.ts')
], { cwd: root, encoding: 'utf8' });
if (payoutSetupBehavior.status !== 0) {
  failures.push(`Payout setup ordering behavior test failed: ${payoutSetupBehavior.stderr || payoutSetupBehavior.stdout || 'unknown error'}`);
} else if (payoutSetupBehavior.stdout) {
  process.stdout.write(payoutSetupBehavior.stdout);
}

const payoutCapabilityBehavior = spawnSync(process.execPath, [
  '--import',
  'tsx',
  join(root, 'scripts/sway-payout-destination-capabilities.behavior.test.ts')
], { cwd: root, encoding: 'utf8' });
if (payoutCapabilityBehavior.status !== 0) {
  failures.push(`Payout destination capability behavior test failed: ${payoutCapabilityBehavior.stderr || payoutCapabilityBehavior.stdout || 'unknown error'}`);
} else if (payoutCapabilityBehavior.stdout) {
  process.stdout.write(payoutCapabilityBehavior.stdout);
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

if (!talentDashboardSource.includes("disabled={previewMode || !payoutDestinationSetupAllowed || stripeConnectStatus === 'submitting'}")) {
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
