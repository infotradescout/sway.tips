import assert from 'node:assert/strict';
import { resolvePayoutDestinationCapabilities } from '../src/server/payout-destination-capabilities';

const disabled = {
  bank_account: false,
  debit_card: false,
  cash_app_direct_deposit: false,
  venmo: false,
  paypal: false
};

assert.deepEqual(resolvePayoutDestinationCapabilities({ env: {} }), disabled,
  'all payout rails must fail closed without provider confirmation');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_PLAID_TRANSFER_PAYOUTS_CONFIRMED: 'true',
    SWAY_DEBIT_CARD_PAYOUTS_CONFIRMED: 'true',
    SWAY_PAYPAL_PAYOUTS_CONFIRMED: 'true',
    SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED: 'true'
  }
}), {
  bank_account: true,
  debit_card: true,
  cash_app_direct_deposit: true,
  venmo: true,
  paypal: true
});

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: { SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED: 'true' }
}), disabled, 'Venmo must stay locked until PayPal Payouts itself is confirmed');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: { SWAY_PLAID_TRANSFER_PAYOUTS_CONFIRMED: 'yes' }
}), disabled, 'only an explicit true confirmation may enable a payout provider');

console.log('Payout destination capability behavior test passed.');
