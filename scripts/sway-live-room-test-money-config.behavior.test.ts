import assert from 'node:assert/strict';
import {
  LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION,
  resolveLiveRoomPaymentRuntimeConfig
} from '../src/server/live-room-payment-config';
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

const LIVE_CANARY_ID = '10000000-0000-4000-8000-000000000099';
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
  liveAllowedPerformerIds: new Set(),
  liveApprovalVersion: null,
  reason: 'ready'
});

const liveKeysOnly = resolve(LIVE_KEYS);
assert.ok(liveKeysOnly.paymentProvider, 'Live secret credentials may configure the provider adapter.');
assert.ok(liveKeysOnly.stripeConnect, 'Live secret credentials may configure the Connect adapter.');
assert.deepEqual(liveKeysOnly.runtime, {
  mode: 'live',
  publishableKey: null,
  moneyEnabled: false,
  connectEnabled: false,
  liveAllowedPerformerIds: new Set(),
  liveApprovalVersion: null,
  reason: 'live_activation_not_approved'
}, 'Live Stripe keys alone must never activate new money or Connect onboarding.');

const liveReady = resolve({ ...LIVE_KEYS, ...LIVE_APPROVAL });
assert.ok(liveReady.paymentProvider);
assert.ok(liveReady.stripeConnect);
assert.deepEqual(liveReady.runtime, {
  mode: 'live',
  publishableKey: 'pk_live_sway_runtime_proof',
  moneyEnabled: true,
  connectEnabled: true,
  liveAllowedPerformerIds: new Set([LIVE_CANARY_ID]),
  liveApprovalVersion: LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION,
  reason: 'ready'
});

for (const [label, performerIdsValue] of [
  ['empty', ''],
  ['malformed', 'not-a-performer-uuid'],
  ['duplicate', `${LIVE_CANARY_ID},${LIVE_CANARY_ID}`],
  ['multiple', `${LIVE_CANARY_ID},20000000-0000-4000-8000-000000000099`]
] as const) {
  const result = resolve({
    ...LIVE_KEYS,
    ...LIVE_APPROVAL,
    SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS: performerIdsValue
  });
  assert.equal(result.runtime.mode, 'live', `${label}: provider mode remains observable.`);
  assert.equal(result.runtime.publishableKey, null, `${label}: browser money config must stay hidden.`);
  assert.equal(result.runtime.moneyEnabled, false, `${label}: new live money must stay disabled.`);
  assert.equal(result.runtime.connectEnabled, false, `${label}: live Connect onboarding must stay disabled.`);
  assert.equal(result.runtime.liveAllowedPerformerIds.size, 0, `${label}: invalid canary input must fail closed.`);
  assert.equal(result.runtime.reason, 'live_activation_not_approved', `${label}: activation must be rejected.`);
}

for (const [label, approvalOverride] of [
  ['flag_disabled', { SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED: 'false' }],
  ['approval_missing', { SWAY_LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION: '' }],
  ['approval_wrong_version', { SWAY_LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION: 'stale-approval' }]
] as const) {
  const result = resolve({ ...LIVE_KEYS, ...LIVE_APPROVAL, ...approvalOverride });
  assert.equal(result.runtime.moneyEnabled, false, `${label}: new live money must stay disabled.`);
  assert.equal(result.runtime.connectEnabled, false, `${label}: live Connect onboarding must stay disabled.`);
  assert.equal(result.runtime.publishableKey, null, `${label}: browser money config must stay hidden.`);
  assert.equal(result.runtime.reason, 'live_activation_not_approved', `${label}: activation must be rejected.`);
}

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
    seller: { ...activeUnconnectedSeller, onboardingStatus: 'restricted' },
    allowTestPlatformBalance: true
  }).ready,
  false,
  'A restricted performer must remain blocked from money actions even in test mode.'
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

assert.equal(
  resolveLiveRoomSellerMoneyReadiness({
    roomStatus: 'active',
    seller: {
      ...activeUnconnectedSeller,
      onboardingStatus: 'restricted',
      paymentAccountStatus: 'payouts_enabled',
      kycStatus: 'verified',
      chargesEnabled: true,
      payoutsEnabled: true,
      stripeConnectedAccountId: 'acct_restricted_contract'
    },
    allowTestPlatformBalance: false
  }).ready,
  false,
  'A restricted performer must not regain money eligibility through a connected account.'
);

console.log('Sway live-room test-money configuration behavior test passed.');
