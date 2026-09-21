import {
  DEFAULT_STRIPE_PROCESSING_FEE_BPS,
  DEFAULT_STRIPE_PROCESSING_FIXED_CENTS,
  type CardProcessingPricing
} from '../payment-pricing';

export const STRIPE_PROCESSING_FEE_APPROVAL_VERSION = '2026-09-02-v1';

function parseNonNegativeInteger(rawValue: string | undefined, fallback: number) {
  if (rawValue === undefined || rawValue.trim() === '') return fallback;
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function resolveStripeProcessingFeeConfig(
  env: NodeJS.ProcessEnv = process.env
): CardProcessingPricing & { livePricingApproved: boolean } {
  const basisPoints = parseNonNegativeInteger(
    env.SWAY_STRIPE_PROCESSING_FEE_BPS,
    DEFAULT_STRIPE_PROCESSING_FEE_BPS
  );
  const fixedCents = parseNonNegativeInteger(
    env.SWAY_STRIPE_PROCESSING_FIXED_CENTS,
    DEFAULT_STRIPE_PROCESSING_FIXED_CENTS
  );
  const valuesValid = basisPoints !== null && basisPoints < 10_000 && fixedCents !== null;

  return {
    basisPoints: valuesValid ? basisPoints : DEFAULT_STRIPE_PROCESSING_FEE_BPS,
    fixedCents: valuesValid ? fixedCents : DEFAULT_STRIPE_PROCESSING_FIXED_CENTS,
    livePricingApproved: valuesValid
      && env.SWAY_STRIPE_PROCESSING_FEE_CONFIRMED?.trim().toLowerCase() === 'true'
      && env.SWAY_STRIPE_PROCESSING_FEE_APPROVAL_VERSION?.trim()
        === STRIPE_PROCESSING_FEE_APPROVAL_VERSION
  };
}
