export const DEFAULT_STRIPE_PROCESSING_FEE_BPS = 290;
export const DEFAULT_STRIPE_PROCESSING_FIXED_CENTS = 30;

export type CardProcessingPricing = {
  basisPoints: number;
  fixedCents: number;
};

function requireNonNegativeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field}_must_be_a_non_negative_safe_integer`);
  }
}

export function estimateCardProcessingFeeCents(
  amountTotalCents: number,
  pricing: CardProcessingPricing
) {
  requireNonNegativeInteger(amountTotalCents, 'amount_total_cents');
  requireNonNegativeInteger(pricing.basisPoints, 'processing_fee_basis_points');
  requireNonNegativeInteger(pricing.fixedCents, 'processing_fee_fixed_cents');
  if (pricing.basisPoints >= 10_000) {
    throw new Error('processing_fee_basis_points_must_be_below_10000');
  }
  if (amountTotalCents === 0) return 0;
  return Math.ceil((amountTotalCents * pricing.basisPoints) / 10_000) + pricing.fixedCents;
}

/**
 * Grosses up a customer charge so the configured processor cost does not
 * reduce either the performer's stated amount or Sway's platform fee.
 */
export function calculateCustomerPaidProcessingRecovery(input: {
  amountSubtotalCents: number;
  platformFeeCents: number;
  pricing?: CardProcessingPricing;
}) {
  requireNonNegativeInteger(input.amountSubtotalCents, 'amount_subtotal_cents');
  requireNonNegativeInteger(input.platformFeeCents, 'platform_fee_cents');
  const pricing = input.pricing ?? {
    basisPoints: DEFAULT_STRIPE_PROCESSING_FEE_BPS,
    fixedCents: DEFAULT_STRIPE_PROCESSING_FIXED_CENTS
  };
  requireNonNegativeInteger(pricing.basisPoints, 'processing_fee_basis_points');
  requireNonNegativeInteger(pricing.fixedCents, 'processing_fee_fixed_cents');
  if (pricing.basisPoints >= 10_000) {
    throw new Error('processing_fee_basis_points_must_be_below_10000');
  }

  const protectedNetCents = input.amountSubtotalCents + input.platformFeeCents;
  if (protectedNetCents === 0) {
    return {
      amountSubtotalCents: input.amountSubtotalCents,
      platformFeeCents: input.platformFeeCents,
      processorFeeRecoveryCents: 0,
      estimatedProcessorFeeCents: 0,
      amountTotalCents: 0
    };
  }

  let amountTotalCents = Math.ceil(
    ((protectedNetCents + pricing.fixedCents) * 10_000)
      / (10_000 - pricing.basisPoints)
  );
  let estimatedProcessorFeeCents = estimateCardProcessingFeeCents(amountTotalCents, pricing);
  while (amountTotalCents - estimatedProcessorFeeCents < protectedNetCents) {
    amountTotalCents += 1;
    estimatedProcessorFeeCents = estimateCardProcessingFeeCents(amountTotalCents, pricing);
  }
  while (
    amountTotalCents > 0
    && amountTotalCents - 1
      - estimateCardProcessingFeeCents(amountTotalCents - 1, pricing) >= protectedNetCents
  ) {
    amountTotalCents -= 1;
    estimatedProcessorFeeCents = estimateCardProcessingFeeCents(amountTotalCents, pricing);
  }

  return {
    amountSubtotalCents: input.amountSubtotalCents,
    platformFeeCents: input.platformFeeCents,
    processorFeeRecoveryCents: amountTotalCents - protectedNetCents,
    estimatedProcessorFeeCents,
    amountTotalCents
  };
}
