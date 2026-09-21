import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const server = read('server.ts');
const destinations = read('src/payout-destination.ts');
const capabilities = read('src/server/payout-destination-capabilities.ts');
const destinationStore = read('src/server/payout-destination-store.ts');
const recipientCrypto = read('src/server/payout-recipient-crypto.ts');
const paypal = read('src/server/paypal-payouts.ts');
const withdrawals = read('src/server/performer-withdrawal-service.ts');
const readiness = read('src/server/paypal-payout-readiness.ts');
const kycReview = read('src/server/performer-kyc-review.ts');
const recipientPrivacy = read('src/server/payout-recipient-privacy.ts');
const accountClaim = read('src/server/account-claim.ts');
const paymentService = read('src/server/payment-service.ts');
const sellerReadiness = read('src/server/live-room-seller-readiness.ts');
const runtimeConfig = read('src/server/live-room-payment-config.ts');
const dashboard = read('src/components/TalentDashboard.tsx');
const schema = read('src/db/schema.ts');
const envExample = read('.env.example');
const render = read('render.yaml');
const migrationNames = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name));
const migrationName = migrationNames.find((name) => read(join('drizzle', name)).includes('payout_processor_events'));
const migration = migrationNames.map((name) => read(join('drizzle', name))).join('\n');

const failures = [];
function requireTerms(label, source, terms) {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${label} missing: ${term}`);
  }
}
function forbidTerms(label, source, terms) {
  for (const term of terms) {
    if (source.toLowerCase().includes(term.toLowerCase())) failures.push(`${label} still contains retired term: ${term}`);
  }
}

requireTerms('destination catalog', destinations, [
  "id: 'paypal'",
  "id: 'venmo'",
  "recipientType !== 'email'",
  "destinationKind === 'venmo'",
  'normalizeUsMobile',
  'normalizeVenmoHandle',
  'recipientPreview'
]);
forbidTerms('destination catalog', destinations, [
  "id: 'bank_account'",
  "id: 'debit_card'",
  "id: 'cash_app_direct_deposit'",
  'plaid',
  'moov'
]);

requireTerms('provider capability gate', capabilities, [
  'input.providerConfigured',
  'input.destinationStorageConfigured',
  'SWAY_PAYPAL_PAYOUTS_CONFIRMED',
  'SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED',
  'paypal: baseReady',
  'venmo: baseReady &&'
]);
forbidTerms('provider capability gate', capabilities, ['PLAID', 'MOOV', 'DEBIT_CARD', 'CASH_APP']);

requireTerms('recipient encryption', recipientCrypto, [
  'aes-256-gcm',
  'cipher.setAAD(associatedData(input))',
  "createHmac('sha256'",
  'input.paymentMode',
  'SWAY_PAYOUT_RECIPIENT_ENCRYPTION_KEY_BASE64',
  'key.length !== 32'
]);
requireTerms('payout destination store', destinationStore, [
  ".for('update')",
  'cipher.encrypt({',
  'recipientValueEncrypted: encrypted.encryptedValue',
  'recipientValueFingerprint: encrypted.fingerprint',
  "inArray(performerWithdrawals.status, [",
  "return { kind: 'withdrawal_in_progress' }",
  "provider: 'paypal_payouts'",
  'eq(performerPayoutPreferences.paymentMode, paymentMode)',
  "eventType: 'performer_payout_preference.save'",
  'rawRecipientStoredInAudit: false',
  'cipher.decrypt({'
]);

requireTerms('PayPal adapter', paypal, [
  "'https://api-m.paypal.com'",
  "'https://api-m.sandbox.paypal.com'",
  '/v1/oauth2/token',
  '/v1/payments/payouts',
  "item.recipient_wallet = 'Venmo'",
  "recipient_type: recipientTypeForPayPal",
  "headers: { 'PayPal-Request-Id': requestId }",
  'sender_batch_id: requestId',
  "providerErrorText.includes('DUPLICATE_BATCH_ID')",
  'retryable: duplicateSubmission',
  "providerName: 'SANDBOX_PHONE_UNSUPPORTED'",
  '/v1/notifications/verify-webhook-signature',
  "verification_status) !== 'SUCCESS'",
  'SWAY_PAYPAL_PAYOUTS_FEE_CENTS'
]);

requireTerms('accumulated withdrawal ledger', withdrawals, [
  'MINIMUM_WITHDRAWAL_CENTS = 1_000',
  'recipientConfirmation: NormalizedPayoutRecipient',
  'destinationStore.fingerprintRecipient({',
  "eq(payments.paymentMode, request.paymentMode)",
  'eq(performerWithdrawals.paymentMode, provider.mode)',
  "${payments.paymentStatus} = 'captured'",
  '${payments.amountSubtotal}',
  'normalizeIdempotencyKey',
  ".for('update')",
  'providerSenderItemId: payPalSenderItemId(withdrawalId)',
  'provider.createPayout({',
  'recipientFingerprint !== claim.claimed.recipientFingerprint',
  'destination.recipientFingerprint !== confirmedRecipientFingerprint',
  'withdrawalRestriction(owner, {',
  "return 'email_verification_required' as const",
  "return 'account_restricted' as const",
  "return 'identity_verification_required' as const",
  "return { kind: 'live_canary_not_allowed' }",
  "return { kind: 'live_canary_amount_required' }",
  "return { kind: 'live_canary_already_used' }",
  "normalized === 'CANCELED'",
  'PAYPAL_PAYOUT_WEBHOOK_EVENT_TYPES',
  "'PAYMENT.PAYOUTS-ITEM.SUCCEEDED'",
  '!PAYPAL_PAYOUT_WEBHOOK_EVENT_TYPES.has',
  'payoutProcessorEvents',
  'paypal_payout_webhook_replay_mismatch',
  'MAX_WITHDRAWAL_SUBMISSION_ATTEMPTS',
  "status: 'held'",
  'least(',
  'swayPayoutMarkupCents: 0',
  'rawRecipientStoredInAudit: false'
]);
forbidTerms('withdrawal provider layer', withdrawals, ['plaid', 'moov', 'stripe connect']);

requireTerms('incoming-only Stripe settlement', sellerReadiness, [
  "SWAY_PLATFORM_BALANCE_DESTINATION = 'sway_platform_balance'",
  "settlementMode: 'platform_balance'",
  'input.allowPlatformBalance && seller?.currentPayoutKycApproved === true'
]);
requireTerms('incoming payment adapter', paymentService, [
  'isSwayPlatformBalanceDestination',
  'enabledPayoutDestinationKinds',
  'enabledPayoutDestinationKinds.has(',
  'const usesPlatformBalance = isSwayPlatformBalanceDestination(operation.destinationAccountId)',
  'destinationAccountId: usesPlatformBalance ? undefined : operation.destinationAccountId',
  'applicationFeeAmountCents: usesPlatformBalance ? undefined : payment.platformFee',
  "usesPlatformBalance ? 'platform_balance' : 'connected_account'"
]);
requireTerms('runtime separation', runtimeConfig, [
  'payoutProviderConfigured',
  "mode === 'test' || input.payoutProviderConfigured",
  'connectEnabled: false'
]);

requireTerms('performer payout API', server, [
  "app.get('/api/talent/payouts/balance'",
  "app.post('/api/talent/payouts/destination'",
  "app.post('/api/talent/payouts/withdrawals'",
  "app.post('/api/payouts/paypal/webhook'",
  "app.post('/api/admin/accounts/:userId/payout-kyc-review'",
  'accessControl.requireAdminAccess(req)',
  'paypalPayoutsProvider.verifyWebhook({ rawBody, headers })',
  'performerWithdrawalService.ingestWebhook({',
  'paypalTestExecutionEnabled',
  'paypalLiveExecutionEnabled',
  'resolvePayPalPayoutReadiness',
  'performerKycReviewStore',
  'hasConfirmedPayoutDestination',
  '&& hasConfirmedPayoutDestination',
  'Object.entries(payoutDestinationCapabilities)',
  'enabledPayoutDestinationKinds:',
  "payoutMarkupCents: 0",
  "app.all('/api/talent/connect/onboard', retiredStripePayoutResponse)",
  "app.all('/talent/connect/refresh', retiredStripePayoutResponse)",
  "app.all('/talent/connect/return', retiredStripePayoutResponse)",
  "code: 'stripe_performer_payouts_retired'"
]);
requireTerms('performer payout API recipient lock', server, [
  "saved.kind === 'withdrawal_in_progress'",
  'PayPal Sandbox does not support Venmo mobile recipients.',
  'Wait until the current cash-out is complete before changing the payout destination.',
  'recipientValue: req.body?.recipientConfirmationValue',
  'recipientConfirmation,',
  "result.kind === 'email_verification_required'",
  "result.kind === 'account_restricted'",
  "result.kind === 'identity_verification_required'",
  "result.kind === 'live_canary_already_used'"
]);
forbidTerms('active server onboarding', server, [
  "app.post('/api/talent/connect/onboard'",
  "app.get('/talent/connect/refresh'",
  "app.get('/talent/connect/return'",
  'provisionStripeConnectRecipient',
  'createStripeConnectOnboardingStore',
  'preparePayoutSetup'
]);

requireTerms('performer Money UI', dashboard, [
  'Choose PayPal or Venmo.',
  'PayPal Sandbox rehearsal',
  'Stripe processes incoming customer payments only.',
  'Cash-out goes directly through PayPal Payouts to PayPal or Venmo.',
  'Sway payout markup: $0.',
  "['user_handle', 'Venmo handle']",
  'Venmo U.S. mobile number',
  'never shows the full recipient again',
  'Cash-out remains locked until PayPal activates Sway Payouts',
  'cashOutIdempotencyKeyRef.current ?? `withdrawal:${crypto.randomUUID()}`',
  '![408, 429].includes(response.status)',
  'window.prompt(',
  'recipientConfirmationValue,',
  "withdrawalRestriction: data?.withdrawalRestriction === 'email_verification_required'",
  "disabled={payoutProviderMode === 'test' && value === 'phone'}"
]);
forbidTerms('performer Money UI', dashboard, [
  'Test bank account (simulated)',
  'Test debit card (simulated)',
  'Cash App direct deposit',
  'Plaid',
  'Moov',
  'Review or change payout details'
]);

requireTerms('database schema', schema, [
  "destinationKind} in ('paypal', 'venmo')",
  'recipientValueEncrypted',
  'recipientValueFingerprint',
  "provider} = 'paypal_payouts'",
  "paymentMode} in ('test', 'live')",
  'performerWithdrawals',
  'payoutProcessorEvents',
  'providerEventIdx',
  'amountEquation',
  'paidShape',
  'returnedShape'
]);
requireTerms('production payout readiness', readiness, [
  'SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_CONFIRMED',
  'SWAY_PAYPAL_PAYOUTS_LIVE_FEE_CONFIRMED',
  'SWAY_PERFORMER_KYC_PROCESS_APPROVAL_VERSION',
  'SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_PERFORMER_ID',
  'SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS',
  'PAYPAL_PAYOUTS_LIVE_CANARY_GROSS_CENTS = 1_000',
  'liveExecutionEnabled: failedGate === null'
]);
requireTerms('current payout identity review', kycReview, [
  "status: 'approved'",
  'processApprovalVersion',
  'evidenceReferenceFingerprint',
  'rawIdentityDataStored: false'
]);
requireTerms('payout recipient privacy', recipientPrivacy, [
  'privacyDeletionRequestedAt',
  'privacy_purge_deferred',
  'privacy_purged',
  'rawRecipientStoredInAudit: false'
]);
requireTerms('account claim payout lock', accountClaim, [
  'performerPayoutPreferences',
  'performerWithdrawals',
  'performerPayoutKycReviews',
  "code: 'payout_identity_configured'"
]);
requireTerms('cutover migration', migration, [
  'payout_processor_events',
  'performer_payout_preference.legacy_selection_removed',
  'performer_withdrawal.legacy_simulation_removed',
  'DELETE FROM "performer_payout_preferences"',
  'DELETE FROM "performer_withdrawals"',
  "destination_kind\" in ('paypal', 'venmo')",
  'recipient_value_encrypted',
  'payment_mode',
  'sway_lock_payout_recipient_during_withdrawal',
  'performer_payout_preferences_unresolved_withdrawal_guard',
  "'requested', 'submitting', 'processing', 'unclaimed', 'held'",
  'performer_payout_kyc_reviews',
  'privacy_deletion_requested_at',
  'Privacy deletion may mark the encrypted recipient for deferred purge'
]);

requireTerms('environment fail-closed defaults', envExample, [
  'SWAY_PAYPAL_PAYOUTS_MODE=',
  'SWAY_PAYPAL_PAYOUTS_CLIENT_ID=',
  'SWAY_PAYPAL_PAYOUTS_CLIENT_SECRET=',
  'SWAY_PAYPAL_PAYOUTS_WEBHOOK_ID=',
  'SWAY_PAYOUT_RECIPIENT_ENCRYPTION_KEY_BASE64=',
  'SWAY_PAYPAL_PAYOUTS_CONFIRMED="false"',
  'SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED="false"',
  'SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED="false"',
  'SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED="false"',
  'SWAY_PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION=',
  'SWAY_PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION=',
  'SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_CONFIRMED="false"',
  'SWAY_PAYPAL_PAYOUTS_LIVE_FEE_CONFIRMED="false"',
  'SWAY_PERFORMER_KYC_PROCESS_APPROVAL_VERSION=',
  'SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_PERFORMER_ID='
]);
forbidTerms('environment payout configuration', envExample, ['SWAY_PLAID', 'SWAY_MOOV', 'SWAY_DEBIT_CARD_PAYOUTS', 'SWAY_CASH_APP']);
requireTerms('Render fail-closed configuration', render, [
  'key: SWAY_PAYPAL_PAYOUTS_CLIENT_ID',
  'key: SWAY_PAYPAL_PAYOUTS_CLIENT_SECRET',
  'key: SWAY_PAYPAL_PAYOUTS_WEBHOOK_ID',
  'key: SWAY_PAYOUT_RECIPIENT_ENCRYPTION_KEY_BASE64',
  'key: SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED',
  'key: SWAY_PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION',
  'key: SWAY_PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION',
  'key: SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_CONFIRMED',
  'key: SWAY_PAYPAL_PAYOUTS_LIVE_FEE_CONFIRMED',
  'key: SWAY_PERFORMER_KYC_PROCESS_APPROVAL_VERSION',
  'key: SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_PERFORMER_ID',
  'value: "false"',
  'sync: false'
]);

if (!migrationName) failures.push('No PayPal/Venmo cutover migration was found.');
if (failures.length) {
  console.error('Incoming-only Stripe and PayPal/Venmo payout contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Incoming-only Stripe and PayPal/Venmo payout contract passed.');
