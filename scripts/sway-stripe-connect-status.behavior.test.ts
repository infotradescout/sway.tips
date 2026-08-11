import assert from 'node:assert/strict';
import { buildStripeConnectPerformerStatusUpdate } from '../src/server/stripe-connect-status';

const cases = [
  {
    provider: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false },
    expected: { chargesEnabled: false, payoutsEnabled: false, paymentAccountStatus: 'not_started' }
  },
  {
    provider: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: true },
    expected: { chargesEnabled: false, payoutsEnabled: false, paymentAccountStatus: 'created' }
  },
  {
    provider: { chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true },
    expected: { chargesEnabled: true, payoutsEnabled: false, paymentAccountStatus: 'charges_enabled' }
  },
  {
    provider: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
    expected: { chargesEnabled: true, payoutsEnabled: true, paymentAccountStatus: 'payouts_enabled' }
  },
  {
    provider: { chargesEnabled: false, payoutsEnabled: true, detailsSubmitted: true },
    expected: { chargesEnabled: false, payoutsEnabled: true, paymentAccountStatus: 'payouts_enabled' }
  }
] as const;

for (const testCase of cases) {
  assert.deepEqual(buildStripeConnectPerformerStatusUpdate(testCase.provider), testCase.expected);
}

console.log('Stripe Connect status behavior test passed.');
