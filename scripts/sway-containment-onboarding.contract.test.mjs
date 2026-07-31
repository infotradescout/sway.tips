import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';

process.on('uncaughtException', (error) => {
  console.error('Sway containment and canonical onboarding contract failed:');
  console.error(error);
  process.exit(1);
});

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const server = read('server.ts');
const paymentService = read('src/server/payment-service.ts');
const paymentProvider = read('src/server/payment-provider.ts');
const talentApp = read('src/shells/TalentApp.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
const accountAccess = read('src/components/AccountAccess.tsx');
const patronView = read('src/components/PatronView.tsx');

const { validatePerformerPasswordStrength } = await tsImport('../src/server/performer-password-auth.ts', import.meta.url);
const { createConfiguredPaymentProvider } = await tsImport('../src/server/payment-provider.ts', import.meta.url);
const { isTerminalProviderReversalStatus } = await tsImport('../src/server/payment-service.ts', import.meta.url);
const { getPatronDeviceIdHash } = await tsImport('../src/patron-device.ts', import.meta.url);
assert.equal(validatePerformerPasswordStrength('123').ok, false, 'Three-digit passwords must be rejected.');
assert.equal(validatePerformerPasswordStrength('abcdefgh').ok, false, 'Passwords need a number.');
assert.equal(validatePerformerPasswordStrength('abc12345').ok, true, 'A current-policy password should pass.');
assert.equal(createConfiguredPaymentProvider({ STRIPE_SECRET_KEY: 'sk_live_blocked', STRIPE_WEBHOOK_SECRET: 'whsec_live' }), null, 'Live Stripe keys must fail closed for room money.');
assert.ok(createConfiguredPaymentProvider({ STRIPE_SECRET_KEY: 'sk_test_contract', STRIPE_WEBHOOK_SECRET: 'whsec_test' }), 'Test Stripe keys should remain usable for provider proof.');
assert.equal(isTerminalProviderReversalStatus('void', 'canceled'), true, 'A processor-confirmed cancellation is terminal.');
assert.equal(isTerminalProviderReversalStatus('refund', 'succeeded'), true, 'A processor-confirmed refund is terminal.');
assert.equal(isTerminalProviderReversalStatus('refund', 'pending'), false, 'A pending refund must never be labeled complete.');
assert.equal(isTerminalProviderReversalStatus('refund', 'failed'), false, 'A failed refund must never be labeled complete.');

const deviceStorage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => deviceStorage.get(key) ?? null,
    setItem: (key, value) => deviceStorage.set(key, value)
  }
};
const firstDeviceId = getPatronDeviceIdHash();
const secondDeviceId = getPatronDeviceIdHash();
assert.match(firstDeviceId, /^[0-9a-f]{64}$/, 'Browser identity must be an opaque 256-bit value.');
assert.equal(secondDeviceId, firstDeviceId, 'Browser identity must remain stable for one installation.');
delete globalThis.window;

for (const required of [
  'projectPublicRoomState(createEmptyBackendState(), null)',
  "code: 'password_reset_required'",
  'checkDurablePasswordLoginLimit',
  "app.post('/api/account/verification/resend'",
  "app.post('/api/account/password-reset/request'",
  'PATRON_DEVICE_ID_HASH_PATTERN',
  "code: 'seller_payout_not_ready'",
  "eventType: 'session.closeout_reversal_pending'",
  "status: 'reversal_pending'",
  "eq(performerLibrarySources.connectionStatus, 'active')"
]) {
  assert.equal(server.includes(required), true, `Containment runtime missing: ${required}`);
}

const globalStateRoute = server.slice(
  server.indexOf('app.get("/api/state"'),
  server.indexOf("app.get('/api/public/events/:eventId'")
);
assert.equal(globalStateRoute.includes('state.requests'), false, 'Global state must never return a private room request array.');
assert.equal(globalStateRoute.includes('refreshBusinessState'), false, 'Global state must not hydrate a globally selected private room.');

assert.equal(talentApp.includes("!selectedGigId ? null : `/api/state/${selectedGigId}`"), true, 'Performer state must be scoped to an owned selected room.');
assert.equal(talentApp.includes('/account/signup?'), true, 'Legacy performer signup must redirect to the universal account flow.');
assert.equal(talentApp.includes('TalentSignupCard'), false, 'The split performer signup surface must not remain reachable from TalentApp.');

for (const required of [
  "paymentAccountStatus === 'payouts_enabled'",
  'destinationRow.payoutsEnabled',
  "reason: 'seller_payout_not_ready'",
  'destinationAccountId,',
  'applicationFeeAmountCents: feePolicy.platformFeeCents'
]) {
  assert.equal(paymentService.includes(required), true, `Payout gate missing: ${required}`);
}
assert.equal(paymentService.includes('the charge still proceeds without a destination'), false, 'Platform-balance fallback language must be removed.');
assert.equal(paymentService.includes("reason: `refund_not_terminal:${result.status}`"), true, 'Pending provider refunds must remain non-terminal.');
assert.equal(paymentService.includes('Promise<PaymentReversalResult[]>'), true, 'Batch reversals must return every result to callers.');
assert.equal(paymentProvider.includes("!secretKey.startsWith('sk_test_')"), true, 'Live-room provider must remain test-key only.');

for (const required of [
  '/account/recover',
  '/account/resend-verification',
  'Password (8+ characters, letter and number)',
  'pendingRightsReviewCount'
]) {
  assert.equal(accountAccess.includes(required), true, `Canonical account recovery/readiness UI missing: ${required}`);
}
assert.equal(patronApp.includes('Join with a room link or ID'), true, 'The room recovery screen needs a real typed-entry path.');
assert.equal(patronView.includes("onBlockFoundation('patron_device_id_hash', ''"), true, 'Patron block requests must use the private browser header identity.');
assert.equal(patronView.includes('Device block recorded.'), false, 'Block UI must not claim immediate enforcement.');
assert.equal(patronView.includes('session.tipsEnabled'), true, 'Tip UI must honor seller payout readiness.');

console.log('Sway containment and canonical onboarding contract passed.');
