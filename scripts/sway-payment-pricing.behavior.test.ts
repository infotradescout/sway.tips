import assert from 'node:assert/strict';
import {
  calculateCustomerPaidProcessingRecovery,
  estimateCardProcessingFeeCents
} from '../src/payment-pricing';
import {
  resolveStripeProcessingFeeConfig,
  STRIPE_PROCESSING_FEE_APPROVAL_VERSION
} from '../src/server/payment-processing-config';

const pricing = { basisPoints: 290, fixedCents: 30 };
for (const amountSubtotalCents of [1, 50, 100, 499, 500, 1_000, 10_000, 999_999]) {
  for (const platformFeeCents of [100, 275]) {
    const result = calculateCustomerPaidProcessingRecovery({
      amountSubtotalCents,
      platformFeeCents,
      pricing
    });
    const protectedNetCents = amountSubtotalCents + platformFeeCents;
    assert.equal(
      result.processorFeeRecoveryCents,
      result.amountTotalCents - protectedNetCents
    );
    assert.ok(
      result.amountTotalCents - estimateCardProcessingFeeCents(result.amountTotalCents, pricing)
        >= protectedNetCents,
      'customer gross-up must protect both performer earnings and the Sway fee'
    );
    assert.ok(
      result.amountTotalCents - 1
        - estimateCardProcessingFeeCents(result.amountTotalCents - 1, pricing)
        < protectedNetCents,
      'gross-up must not charge one cent more than the configured protection requires'
    );
  }
}

assert.deepEqual(
  calculateCustomerPaidProcessingRecovery({
    amountSubtotalCents: 1_000,
    platformFeeCents: 100,
    pricing
  }),
  {
    amountSubtotalCents: 1_000,
    platformFeeCents: 100,
    processorFeeRecoveryCents: 64,
    estimatedProcessorFeeCents: 64,
    amountTotalCents: 1_164
  }
);

assert.equal(resolveStripeProcessingFeeConfig({}).livePricingApproved, false);
assert.equal(resolveStripeProcessingFeeConfig({
  SWAY_STRIPE_PROCESSING_FEE_BPS: '290',
  SWAY_STRIPE_PROCESSING_FIXED_CENTS: '30',
  SWAY_STRIPE_PROCESSING_FEE_CONFIRMED: 'true',
  SWAY_STRIPE_PROCESSING_FEE_APPROVAL_VERSION: 'stale'
}).livePricingApproved, false);
assert.deepEqual(resolveStripeProcessingFeeConfig({
  SWAY_STRIPE_PROCESSING_FEE_BPS: '290',
  SWAY_STRIPE_PROCESSING_FIXED_CENTS: '30',
  SWAY_STRIPE_PROCESSING_FEE_CONFIRMED: 'true',
  SWAY_STRIPE_PROCESSING_FEE_APPROVAL_VERSION: STRIPE_PROCESSING_FEE_APPROVAL_VERSION
}), {
  basisPoints: 290,
  fixedCents: 30,
  livePricingApproved: true
});

console.log('Customer-paid incoming processing pricing behavior test passed.');
