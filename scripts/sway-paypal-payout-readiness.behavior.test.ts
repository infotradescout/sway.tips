import assert from 'node:assert/strict';
import {
  PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION,
  PAYPAL_PAYOUTS_LIVE_FUNDING_VERSION,
  resolvePayPalPayoutReadiness
} from '../src/server/paypal-payout-readiness';
import { PERFORMER_KYC_PROCESS_APPROVAL_VERSION } from '../src/server/performer-kyc-review';
import { resolvePayoutDestinationCapabilities } from '../src/server/payout-destination-capabilities';

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

// An enabled Venmo destination still requires its own versioned approval.
const missingVenmoApproval = resolvePayPalPayoutReadiness({
  env: { ...completeEnv, SWAY_PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION: undefined },
  providerMode: 'live',
  providerFeeCents: 25,
  capabilities
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


// Exercise the same capability-to-readiness composition used by server.ts.
// These are pure configuration tests: no credentials, provider calls, or money.
const paypalOnlyEnv: NodeJS.ProcessEnv = {
  ...completeEnv,
  SWAY_PAYPAL_PAYOUTS_CONFIRMED: 'true',
  SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED: 'false',
  SWAY_PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION: undefined
};
const resolve = (
  env: NodeJS.ProcessEnv,
  options: {
    providerConfigured?: boolean;
    destinationStorageConfigured?: boolean;
    providerMode?: 'test' | 'live' | null;
    providerFeeCents?: number | null;
  } = {}
) => {
  const resolvedCapabilities = resolvePayoutDestinationCapabilities({
    env,
    providerConfigured: options.providerConfigured ?? true,
    destinationStorageConfigured: options.destinationStorageConfigured ?? true
  });
  const readiness = resolvePayPalPayoutReadiness({
    env,
    providerMode: options.providerMode === undefined ? 'live' : options.providerMode,
    providerFeeCents: options.providerFeeCents === undefined ? 25 : options.providerFeeCents,
    capabilities: resolvedCapabilities
  });
  return { readiness, resolvedCapabilities };
};

let regressionCases = 0;
for (const venmoFlag of [undefined, 'false', '', 'not-approved']) {
  const result = resolve({ ...paypalOnlyEnv, SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED: venmoFlag });
  assert.deepEqual(result.resolvedCapabilities, { paypal: true, venmo: false });
  assert.equal(result.readiness.liveExecutionEnabled, true, 'Approved PayPal-only cash-out must work');
  assert.equal(result.readiness.failedGate, null);
  assert.equal(result.readiness.liveCanaryPerformerId, performerId);
  regressionCases++;
}

for (const approval of [undefined, '', 'stale-version']) {
  const result = resolve({
    ...paypalOnlyEnv,
    SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED: 'true',
    SWAY_PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION: approval
  });
  assert.equal(result.resolvedCapabilities.venmo, true);
  assert.equal(result.readiness.liveExecutionEnabled, false);
  assert.equal(result.readiness.failedGate, 'venmoApproved');
  assert.equal(result.readiness.liveCanaryPerformerId, null);
  regressionCases++;
}

const bothApproved = resolve({
  ...paypalOnlyEnv,
  SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED: 'true',
  SWAY_PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION: PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION
});
assert.deepEqual(bothApproved.resolvedCapabilities, { paypal: true, venmo: true });
assert.equal(bothApproved.readiness.liveExecutionEnabled, true);
regressionCases++;

const requiredGates = [
  ['SWAY_PAYPAL_PAYOUTS_CONFIRMED', 'paypalApproved'],
  ['SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED', 'executionEnabled'],
  ['SWAY_PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION', 'paypalApproved'],
  ['SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_CONFIRMED', 'fundingApproved'],
  ['SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_VERSION', 'fundingApproved'],
  ['SWAY_PAYPAL_PAYOUTS_LIVE_FEE_CONFIRMED', 'feeApproved'],
  ['SWAY_PAYPAL_PAYOUTS_LIVE_FEE_VERSION', 'feeApproved'],
  ['SWAY_PERFORMER_KYC_PROCESS_APPROVAL_VERSION', 'kycProcessApproved'],
  ['SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_PERFORMER_ID', 'canaryBound'],
  ['SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_VERSION', 'canaryBound'],
  ['SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS', 'canaryBound']
] as const;
for (const [key, failedGate] of requiredGates) {
  const { readiness } = resolve({ ...paypalOnlyEnv, [key]: undefined });
  assert.equal(readiness.liveExecutionEnabled, false, `${key} remains mandatory`);
  assert.equal(readiness.failedGate, failedGate);
  assert.equal(readiness.liveCanaryPerformerId, null);
  regressionCases++;
}

for (const options of [
  { providerConfigured: false },
  { destinationStorageConfigured: false },
  { providerMode: 'test' as const },
  { providerMode: null },
  { providerFeeCents: 30 },
  { providerFeeCents: null }
]) {
  const { readiness } = resolve(paypalOnlyEnv, options);
  assert.equal(readiness.liveExecutionEnabled, false);
  assert.equal(readiness.liveCanaryPerformerId, null);
  regressionCases++;
}
const widenedPaypalOnly = resolve({
  ...paypalOnlyEnv,
  SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS: `${performerId},21000000-0000-4000-8000-000000000098`
});
assert.equal(widenedPaypalOnly.readiness.liveExecutionEnabled, false);
assert.equal(widenedPaypalOnly.readiness.failedGate, 'canaryBound');
regressionCases++;

console.log(`PayPal-only readiness regression matrix passed: ${regressionCases} cases.`);

console.log('PayPal/Venmo production readiness behavior test passed.');
