import assert from 'node:assert/strict';
import {
  LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION,
  resolveLiveRoomPaymentRuntimeConfig
} from '../src/server/live-room-payment-config';
import { createConfiguredPaymentProvider } from '../src/server/payment-provider';
import {
  resolveLiveRoomSellerMoneyReadiness,
  resolveTestModePlatformBalanceEnabled,
  resolveTestModePlatformBalancePerformerIds,
  SWAY_PLATFORM_BALANCE_DESTINATION,
  SWAY_TEST_PLATFORM_BALANCE_DESTINATION
} from '../src/server/live-room-seller-readiness';

function resolve(
  env: NodeJS.ProcessEnv,
  durabilityWritesEnabled = true,
  payoutProviderConfigured = false,
  processingPricingConfigured = true
) {
  const paymentProvider = createConfiguredPaymentProvider(env);
  return {
    paymentProvider,
    runtime: resolveLiveRoomPaymentRuntimeConfig({
      env,
      paymentProviderConfigured: Boolean(paymentProvider),
      payoutProviderConfigured,
      processingPricingConfigured,
      durabilityWritesEnabled
    })
  };
}

const LIVE_CANARY_ID = '10000000-0000-4000-8000-000000000099';
const TEST_KEYS = {
  STRIPE_PUBLISHABLE_KEY: 'pk_test_sway_runtime_proof',
  STRIPE_SECRET_KEY: 'sk_test_sway_runtime_proof',
  STRIPE_WEBHOOK_SECRET: 'whsec_sway_runtime_proof'
};
const LIVE_KEYS = {
  STRIPE_PUBLISHABLE_KEY: 'pk_live_sway_runtime_proof',
  STRIPE_SECRET_KEY: 'sk_live_sway_runtime_proof',
  STRIPE_WEBHOOK_SECRET: 'whsec_sway_runtime_proof'
};
const LIVE_APPROVAL = {
  SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED: 'true',
  SWAY_LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION: LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION,
  SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS: LIVE_CANARY_ID
};

const testReady = resolve(TEST_KEYS);
assert.ok(testReady.paymentProvider);
assert.deepEqual(testReady.runtime, {
  mode: 'test',
  publishableKey: TEST_KEYS.STRIPE_PUBLISHABLE_KEY,
  moneyEnabled: true,
  connectEnabled: false,
  liveAllowedPerformerIds: new Set(),
  liveApprovalVersion: null,
  reason: 'ready'
}, 'incoming Stripe test rehearsals do not require a real payout provider');

const liveWithoutPayouts = resolve({ ...LIVE_KEYS, ...LIVE_APPROVAL }, true, false);
assert.deepEqual(liveWithoutPayouts.runtime, {
  mode: 'unavailable',
  publishableKey: null,
  moneyEnabled: false,
  connectEnabled: false,
  liveAllowedPerformerIds: new Set([LIVE_CANARY_ID]),
  liveApprovalVersion: LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION,
  reason: 'configuration_incomplete'
}, 'live incoming money must not outrun the independently configured payout provider');

const liveKeysOnly = resolve(LIVE_KEYS, true, true);
assert.deepEqual(liveKeysOnly.runtime, {
  mode: 'live',
  publishableKey: null,
  moneyEnabled: false,
  connectEnabled: false,
  liveAllowedPerformerIds: new Set(),
  liveApprovalVersion: null,
  reason: 'live_activation_not_approved'
});

const liveReady = resolve({ ...LIVE_KEYS, ...LIVE_APPROVAL }, true, true);
assert.deepEqual(liveReady.runtime, {
  mode: 'live',
  publishableKey: LIVE_KEYS.STRIPE_PUBLISHABLE_KEY,
  moneyEnabled: true,
  connectEnabled: false,
  liveAllowedPerformerIds: new Set([LIVE_CANARY_ID]),
  liveApprovalVersion: LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION,
  reason: 'ready'
}, 'Stripe may collect live money only while performer-facing Connect remains retired');

const liveWithoutConfirmedProcessingPrice = resolve(
  { ...LIVE_KEYS, ...LIVE_APPROVAL },
  true,
  true,
  false
);
assert.equal(liveWithoutConfirmedProcessingPrice.runtime.mode, 'live');
assert.equal(liveWithoutConfirmedProcessingPrice.runtime.moneyEnabled, false);
assert.equal(liveWithoutConfirmedProcessingPrice.runtime.reason, 'processing_fee_configuration_unapproved');

for (const performerIdsValue of [
  '',
  'not-a-performer-uuid',
  `${LIVE_CANARY_ID},${LIVE_CANARY_ID}`,
  `${LIVE_CANARY_ID},20000000-0000-4000-8000-000000000099`
]) {
  const result = resolve({
    ...LIVE_KEYS,
    ...LIVE_APPROVAL,
    SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS: performerIdsValue
  }, true, true);
  assert.equal(result.runtime.mode, 'live');
  assert.equal(result.runtime.publishableKey, null);
  assert.equal(result.runtime.moneyEnabled, false);
  assert.equal(result.runtime.connectEnabled, false);
  assert.equal(result.runtime.liveAllowedPerformerIds.size, 0);
  assert.equal(result.runtime.reason, 'live_activation_not_approved');
}

const mismatched = resolve({
  STRIPE_PUBLISHABLE_KEY: 'pk_test_sway_runtime_proof',
  STRIPE_SECRET_KEY: 'sk_live_forbidden',
  STRIPE_WEBHOOK_SECRET: 'whsec_sway_runtime_proof'
}, true, true);
assert.equal(mismatched.runtime.reason, 'mode_key_mismatch');
assert.equal(mismatched.runtime.moneyEnabled, false);

const paused = resolve(TEST_KEYS, false, false);
assert.equal(paused.runtime.mode, 'test');
assert.equal(paused.runtime.moneyEnabled, false);
assert.equal(paused.runtime.connectEnabled, false);
assert.equal(paused.runtime.reason, 'durability_writes_disabled');

assert.equal(resolveTestModePlatformBalanceEnabled({ paymentMode: 'test', configuredValue: ' TRUE ' }), true);
assert.equal(resolveTestModePlatformBalanceEnabled({ paymentMode: 'live', configuredValue: 'true' }), false);
const allowedPilotIds = resolveTestModePlatformBalancePerformerIds({
  paymentMode: 'test',
  configuredValue: 'true',
  performerIdsValue: '10000000-0000-4000-8000-000000000002,20000000-0000-4000-8000-000000000003'
});
assert.deepEqual([...allowedPilotIds], [
  '10000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003'
]);
assert.equal(resolveTestModePlatformBalancePerformerIds({
  paymentMode: 'test',
  configuredValue: 'true',
  performerIdsValue: '10000000-0000-4000-8000-000000000002,invalid'
}).size, 0, 'one invalid entry must reject the entire rehearsal allowlist');

const activeSeller = {
  isActive: true,
  onboardingStatus: 'gig_ready',
  paymentAccountStatus: 'not_started',
  kycStatus: 'not_required',
  chargesEnabled: false,
  payoutsEnabled: false,
  stripeConnectedAccountId: null,
  payoutHoldReason: null
};
assert.deepEqual(resolveLiveRoomSellerMoneyReadiness({
  roomStatus: 'active',
  seller: activeSeller,
  allowTestPlatformBalance: true
}), {
  ready: true,
  destinationAccountId: SWAY_TEST_PLATFORM_BALANCE_DESTINATION,
  settlementMode: 'platform_test_balance'
});
assert.deepEqual(resolveLiveRoomSellerMoneyReadiness({
  roomStatus: 'active',
  seller: { ...activeSeller, currentPayoutKycApproved: true },
  allowTestPlatformBalance: false,
  allowPlatformBalance: true
}), {
  ready: true,
  destinationAccountId: SWAY_PLATFORM_BALANCE_DESTINATION,
  settlementMode: 'platform_balance'
}, 'approved live charges settle to Sway for later PayPal/Venmo withdrawal');
assert.equal(resolveLiveRoomSellerMoneyReadiness({
  roomStatus: 'active',
  seller: { ...activeSeller, currentPayoutKycApproved: false },
  allowTestPlatformBalance: false,
  allowPlatformBalance: true
}).ready, false, 'legacy or missing KYC state must never authorize a real platform-balance charge');

const historicalConnectedSeller = {
  ...activeSeller,
  paymentAccountStatus: 'payouts_enabled',
  kycStatus: 'verified',
  chargesEnabled: true,
  payoutsEnabled: true,
  stripeConnectedAccountId: 'acct_historical_only'
};
assert.equal(resolveLiveRoomSellerMoneyReadiness({
  roomStatus: 'active',
  seller: historicalConnectedSeller,
  allowTestPlatformBalance: false
}).ready, false, 'historical Stripe Connect readiness must never route a new charge');

for (const seller of [
  { ...activeSeller, onboardingStatus: 'suspended' },
  { ...activeSeller, onboardingStatus: 'restricted' },
  { ...activeSeller, payoutHoldReason: 'risk_hold' },
  { ...activeSeller, isActive: false }
]) {
  assert.equal(resolveLiveRoomSellerMoneyReadiness({
    roomStatus: 'active',
    seller,
    allowTestPlatformBalance: true,
    allowPlatformBalance: true
  }).ready, false, 'account safety controls must override every platform-balance rail');
}
assert.equal(resolveLiveRoomSellerMoneyReadiness({
  roomStatus: 'closed',
  seller: activeSeller,
  allowTestPlatformBalance: true,
  allowPlatformBalance: true
}).ready, false, 'closed rooms cannot accept money');

console.log('Sway incoming-only Stripe and PayPal/Venmo readiness behavior test passed.');
