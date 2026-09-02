import type { PayoutDestinationCapabilities } from '../payout-destination';
import { PERFORMER_KYC_PROCESS_APPROVAL_VERSION } from './performer-kyc-review';

export const PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION = '2026-09-02-v1';
export const PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION = '2026-09-02-v1';
export const PAYPAL_PAYOUTS_LIVE_FUNDING_VERSION = '2026-09-02-v1';
export const PAYPAL_PAYOUTS_LIVE_CANARY_GROSS_CENTS = 1_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

function oneUuid(value: string | undefined) {
  const values = (value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return values.length === 1 && UUID_PATTERN.test(values[0]) ? values[0] : null;
}

export type PayPalPayoutReadiness = ReturnType<typeof resolvePayPalPayoutReadiness>;

export function resolvePayPalPayoutReadiness(input: {
  env?: NodeJS.ProcessEnv;
  providerMode: 'test' | 'live' | null;
  providerFeeCents: number | null;
  capabilities: PayoutDestinationCapabilities;
}) {
  const env = input.env ?? process.env;
  const testExecutionEnabled = input.providerMode === 'test'
    && enabled(env.SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED);
  const canaryPerformerId = oneUuid(env.SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_PERFORMER_ID);
  const incomingCanaryPerformerId = oneUuid(env.SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS);
  const expectedFeeVersion = Number.isSafeInteger(input.providerFeeCents)
    ? `${PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION}:USD:fee_cents=${input.providerFeeCents}`
    : null;
  const expectedCanaryVersion = canaryPerformerId
    ? `${PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION}:performer=${canaryPerformerId}:gross_cents=${PAYPAL_PAYOUTS_LIVE_CANARY_GROSS_CENTS}`
    : null;

  const gates = {
    liveProvider: input.providerMode === 'live',
    executionEnabled: enabled(env.SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED),
    paypalApproved: input.capabilities.paypal
      && env.SWAY_PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION?.trim() === PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION,
    venmoApproved: input.capabilities.venmo
      && env.SWAY_PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION?.trim() === PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION,
    fundingApproved: enabled(env.SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_CONFIRMED)
      && env.SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_VERSION?.trim() === PAYPAL_PAYOUTS_LIVE_FUNDING_VERSION,
    feeApproved: enabled(env.SWAY_PAYPAL_PAYOUTS_LIVE_FEE_CONFIRMED)
      && Boolean(expectedFeeVersion)
      && env.SWAY_PAYPAL_PAYOUTS_LIVE_FEE_VERSION?.trim() === expectedFeeVersion,
    kycProcessApproved: env.SWAY_PERFORMER_KYC_PROCESS_APPROVAL_VERSION?.trim()
      === PERFORMER_KYC_PROCESS_APPROVAL_VERSION,
    canaryBound: Boolean(
      canaryPerformerId
      && incomingCanaryPerformerId === canaryPerformerId
      && expectedCanaryVersion
      && env.SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_VERSION?.trim() === expectedCanaryVersion
    )
  };
  const failedGate = Object.entries(gates).find(([, passed]) => !passed)?.[0] ?? null;
  return {
    testExecutionEnabled,
    liveExecutionEnabled: failedGate === null,
    liveCanaryPerformerId: failedGate === null ? canaryPerformerId : null,
    kycProcessApprovalVersion: gates.kycProcessApproved ? PERFORMER_KYC_PROCESS_APPROVAL_VERSION : null,
    expectedFeeVersion,
    expectedCanaryVersion,
    failedGate,
    gates
  };
}
