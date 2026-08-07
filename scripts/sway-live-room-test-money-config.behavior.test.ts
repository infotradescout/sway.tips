import assert from 'node:assert/strict';
import { resolveLiveRoomPaymentRuntimeConfig } from '../src/server/live-room-payment-config';
import { createConfiguredPaymentProvider } from '../src/server/payment-provider';
import { createConfiguredStripeConnectService } from '../src/server/stripe-connect';

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

console.log('Sway live-room test-money configuration behavior test passed.');
