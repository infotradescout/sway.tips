import assert from 'node:assert/strict';
import { resolvePayoutDestinationCapabilities } from '../src/server/payout-destination-capabilities';

const disabled = { paypal: false, venmo: false };

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {},
  providerConfigured: false,
  destinationStorageConfigured: false
}), disabled, 'all payout destinations must fail closed without provider and encrypted storage');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_PAYPAL_PAYOUTS_CONFIRMED: 'true',
    SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED: 'true'
  },
  providerConfigured: false,
  destinationStorageConfigured: true
}), disabled, 'environment flags alone must never expose a payout destination');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_PAYPAL_PAYOUTS_CONFIRMED: 'true',
    SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED: 'true'
  },
  providerConfigured: true,
  destinationStorageConfigured: false
}), disabled, 'raw recipient storage must never be used as a fallback');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: { SWAY_PAYPAL_PAYOUTS_CONFIRMED: 'true' },
  providerConfigured: true,
  destinationStorageConfigured: true
}), { paypal: true, venmo: false }, 'PayPal can be released without claiming Venmo approval');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_PAYPAL_PAYOUTS_CONFIRMED: 'true',
    SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED: 'true'
  },
  providerConfigured: true,
  destinationStorageConfigured: true
}), { paypal: true, venmo: true });

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_PAYPAL_PAYOUTS_CONFIRMED: 'yes',
    SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED: 'true'
  },
  providerConfigured: true,
  destinationStorageConfigured: true
}), disabled, 'only an explicit true confirmation may enable PayPal Payouts');

console.log('Payout destination capability behavior test passed.');
