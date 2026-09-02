import assert from 'node:assert/strict';
import {
  PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION,
  PAYPAL_PAYOUTS_LIVE_FUNDING_VERSION,
  resolvePayPalPayoutReadiness
} from '../src/server/paypal-payout-readiness';
import { PERFORMER_KYC_PROCESS_APPROVAL_VERSION } from '../src/server/performer-kyc-review';

const performerId = '21000000-0000-4000-8000-000000000099';
const capabilities = { paypal: true, venmo: true } as const;
const completeEnv: NodeJS.ProcessEnv = {
  SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED: 'true',
  SWAY_PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION: PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION,
  SWAY_PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION: PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION,
  SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_CONFIRMED: 'true',
  SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_VERSION: PAYPAL_PAYOUTS_LIVE_FUNDING_VERSION,
  SWAY_PAYPAL_PAYOUTS_LIVE_FEE_CONFIRMED: 'true',
  SWAY_PAYPAL_PAYOUTS_LIVE_FEE_VERSION: `${PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION}:USD:fee_cents=25`,
  SWAY_PERFORMER_KYC_PROCESS_APPROVAL_VERSION: PERFORMER_KYC_PROCESS_APPROVAL_VERSION,
  SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_PERFORMER_ID: performerId,
  SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_VERSION: `${PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION}:performer=${performerId}:gross_cents=1000`,
  SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS: performerId
};

const closed = resolvePayPalPayoutReadiness({
  env: {},
  providerMode: 'live',
  providerFeeCents: 25,
  capabilities
});
assert.equal(closed.liveExecutionEnabled, false);
assert.equal(closed.failedGate, 'executionEnabled');
assert.equal(closed.liveCanaryPerformerId, null);

const ready = resolvePayPalPayoutReadiness({
  env: completeEnv,
  providerMode: 'live',
  providerFeeCents: 25,
  capabilities
});
assert.equal(ready.liveExecutionEnabled, true);
assert.equal(ready.failedGate, null);
assert.equal(ready.liveCanaryPerformerId, performerId);
assert.equal(ready.kycProcessApprovalVersion, PERFORMER_KYC_PROCESS_APPROVAL_VERSION);

const staleFee = resolvePayPalPayoutReadiness({
  env: completeEnv,
  providerMode: 'live',
  providerFeeCents: 30,
  capabilities
});
assert.equal(staleFee.liveExecutionEnabled, false);
assert.equal(staleFee.failedGate, 'feeApproved');

const widenedCanary = resolvePayPalPayoutReadiness({
  env: {
    ...completeEnv,
    SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS: `${performerId},21000000-0000-4000-8000-000000000098`
  },
  providerMode: 'live',
  providerFeeCents: 25,
  capabilities
});
assert.equal(widenedCanary.liveExecutionEnabled, false);
assert.equal(widenedCanary.failedGate, 'canaryBound');

const missingVenmoApproval = resolvePayPalPayoutReadiness({
  env: completeEnv,
  providerMode: 'live',
  providerFeeCents: 25,
  capabilities: { paypal: true, venmo: false }
});
assert.equal(missingVenmoApproval.liveExecutionEnabled, false);
assert.equal(missingVenmoApproval.failedGate, 'venmoApproved');

const sandbox = resolvePayPalPayoutReadiness({
  env: { SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED: 'true' },
  providerMode: 'test',
  providerFeeCents: 25,
  capabilities
});
assert.equal(sandbox.testExecutionEnabled, true);
assert.equal(sandbox.liveExecutionEnabled, false);

console.log('PayPal/Venmo production readiness behavior test passed.');
