import assert from 'node:assert/strict';
import { resolveLiveRoomPaymentRuntimeConfig } from '../src/server/live-room-payment-config';
import { createConfiguredPaymentProvider } from '../src/server/payment-provider';
import { createConfiguredStripeConnectService } from '../src/server/stripe-connect';
import {
  resolveLiveRoomSellerMoneyReadiness,
  resolveTestModePlatformBalanceEnabled,
  resolveTestModePlatformBalancePerformerIds,
  SWAY_TEST_PLATFORM_BALANCE_DESTINATION
} from '../src/server/live-room-seller-readiness';

function resolve(env: NodeJS.ProcessEnv, durabilityWritesEnabled = true) {
  const paymentProvider = createConfiguredPaymentProvider(env);
  const stripeConnect = createConfiguredStripeConnectService(env);
  return {
    paymentProvider,
    stripeConnect,
    runtime: resolveLiveRoomPaymentRuntimeConfig({
      env,
      paymentProviderConfigured: Boolean(paymentProvider),
      stripeConnectConfigured: Boolean(stripeConnect),
      durabilityWritesEnabled
    })
  };
}

const ready = resolve({
  STRIPE_PUBLISHABLE_KEY: 'pk_test_sway_runtime_proof',
  STRIPE_SECRET_KEY: 'sk_test_sway_runtime_proof',
  STRIPE_WEBHOOK_SECRET: 'whsec_sway_runtime_proof'
});
assert.ok(ready.paymentProvider);
assert.ok(ready.stripeConnect);
assert.deepEqual(ready.runtime, {
  mode: 'test',
  publishableKey: 'pk_test_sway_runtime_proof',
  moneyEnabled: true,
  connectEnabled: true,
  reason: 'ready'
});

const liveReady = resolve({
  STRIPE_PUBLISHABLE_KEY: 'pk_live_sway_runtime_proof',
  STRIPE_SECRET_KEY: 'sk_live_sway_runtime_proof',
  STRIPE_WEBHOOK_SECRET: 'whsec_sway_runtime_proof'
});
assert.ok(liveReady.paymentProvider);
assert.ok(liveReady.stripeConnect);
assert.deepEqual(liveReady.runtime, {
  mode: 'live',
  publishableKey: 'pk_live_sway_runtime_proof',
  moneyEnabled: true,
  connectEnabled: true,
  reason: 'ready'
});

for (const [label, env, expectedReason] of [
  ['missing_secret', {
    STRIPE_PUBLISHABLE_KEY: 'pk_test_sway_runtime_proof',
    STRIPE_WEBHOOK_SECRET: 'whsec_sway_runtime_proof'
  }, 'configuration_incomplete'],
  ['missing_webhook', {
    STRIPE_PUBLISHABLE_KEY: 'pk_test_sway_runtime_proof',
    STRIPE_SECRET_KEY: 'sk_test_sway_runtime_proof'
  }, 'configuration_incomplete'],
  ['live_secret_mismatch', {
    STRIPE_PUBLISHABLE_KEY: 'pk_test_sway_runtime_proof',
    STRIPE_SECRET_KEY: 'sk_live_forbidden',
    STRIPE_WEBHOOK_SECRET: 'whsec_sway_runtime_proof'
  }, 'mode_key_mismatch'],
  ['live_publishable_mismatch', {
    STRIPE_PUBLISHABLE_KEY: 'pk_live_forbidden',
    STRIPE_SECRET_KEY: 'sk_test_sway_runtime_proof',
    STRIPE_WEBHOOK_SECRET: 'whsec_sway_runtime_proof'
  }, 'mode_key_mismatch']
] as const) {
  const result = resolve(env);
  assert.equal(result.runtime.moneyEnabled, false, `${label} must disable live-room money.`);
  assert.equal(result.runtime.connectEnabled, false, `${label} must disable Connect onboarding.`);
  assert.equal(result.runtime.reason, expectedReason, `${label} must report ${expectedReason}.`);
}

const paused = resolve({
  STRIPE_PUBLISHABLE_KEY: 'pk_test_sway_runtime_proof',
  STRIPE_SECRET_KEY: 'sk_test_sway_runtime_proof',
  STRIPE_WEBHOOK_SECRET: 'whsec_sway_runtime_proof'
}, false);
assert.equal(paused.runtime.mode, 'test');
assert.equal(paused.runtime.moneyEnabled, false);
assert.equal(paused.runtime.connectEnabled, false);
assert.equal(paused.runtime.reason, 'durability_writes_disabled');

assert.equal(resolveTestModePlatformBalanceEnabled({ paymentMode: 'test', configuredValue: 'true' }), true);
assert.equal(resolveTestModePlatformBalanceEnabled({ paymentMode: 'test', configuredValue: ' TRUE ' }), true);
assert.equal(resolveTestModePlatformBalanceEnabled({ paymentMode: 'test', configuredValue: 'false' }), false);
assert.equal(resolveTestModePlatformBalanceEnabled({ paymentMode: 'live', configuredValue: 'true' }), false,
  'A live Stripe runtime must never enable the platform-balance rehearsal lane.');
assert.equal(resolveTestModePlatformBalanceEnabled({ paymentMode: 'unavailable', configuredValue: 'true' }), false);

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
}).size, 0, 'One invalid entry must reject the entire payment allowlist.');
assert.equal(resolveTestModePlatformBalancePerformerIds({
  paymentMode: 'live',
  configuredValue: 'true',
  performerIdsValue: '10000000-0000-4000-8000-000000000002'
}).size, 0, 'Live mode must discard the pilot performer allowlist.');
assert.equal(resolveTestModePlatformBalancePerformerIds({
  paymentMode: 'test',
  configuredValue: 'true',
  performerIdsValue: ''
}).size, 0, 'An empty allowlist must keep the pilot lane closed.');

const activeUnconnectedSeller = {
  isActive: true,
  onboardingStatus: 'gig_ready',
  paymentAccountStatus: 'not_started',
  kycStatus: 'not_required',
  chargesEnabled: false,
  payoutsEnabled: false,
  stripeConnectedAccountId: null,
  payoutHoldReason: null
};
assert.deepEqual(
  resolveLiveRoomSellerMoneyReadiness({
    roomStatus: 'active',
    seller: activeUnconnectedSeller,
    allowTestPlatformBalance: true
  }),
  {
    ready: true,
    destinationAccountId: SWAY_TEST_PLATFORM_BALANCE_DESTINATION,
    settlementMode: 'platform_test_balance'
  },
  'An active performer may use the explicit platform test balance for a no-real-money rehearsal.'
);
assert.equal(
  resolveLiveRoomSellerMoneyReadiness({
    roomStatus: 'active',
    seller: activeUnconnectedSeller,
    allowTestPlatformBalance: false
  }).ready,
  false,
  'Without the test-only switch, an unconnected seller must remain blocked.'
);
assert.equal(
  resolveLiveRoomSellerMoneyReadiness({
    roomStatus: 'active',
    seller: { ...activeUnconnectedSeller, onboardingStatus: 'suspended' },
    allowTestPlatformBalance: true
  }).ready,
  false,
  'A suspended performer must remain blocked even in test mode.'
);
assert.equal(
  resolveLiveRoomSellerMoneyReadiness({
    roomStatus: 'active',
    seller: { ...activeUnconnectedSeller, payoutHoldReason: 'risk_hold' },
    allowTestPlatformBalance: true
  }).ready,
  false,
  'A payout/risk hold must remain fail-closed in test mode.'
);
const connectedReadiness = resolveLiveRoomSellerMoneyReadiness({
  roomStatus: 'active',
  seller: {
    ...activeUnconnectedSeller,
    paymentAccountStatus: 'payouts_enabled',
    kycStatus: 'verified',
    chargesEnabled: true,
    payoutsEnabled: true,
    stripeConnectedAccountId: 'acct_connected_contract'
  },
  allowTestPlatformBalance: false
});
assert.equal(connectedReadiness.ready, true);
assert.equal(connectedReadiness.destinationAccountId, 'acct_connected_contract');
assert.equal(connectedReadiness.settlementMode, 'connected_account');

console.log('Sway live-room test-money configuration behavior test passed.');
