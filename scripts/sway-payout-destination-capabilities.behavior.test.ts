import assert from 'node:assert/strict';
import { resolvePayoutDestinationCapabilities } from '../src/server/payout-destination-capabilities';

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {},
  connectEnabled: true
}), {
  bank_account: false,
  debit_card: false,
  cash_app_direct_deposit: false,
  venmo_direct_deposit: false
}, 'provider collection must fail closed without explicit deployment confirmation');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED: 'yes',
    SWAY_STRIPE_CONNECT_DEBIT_CARD_COLLECTION_CONFIRMED: '1',
    SWAY_CASH_APP_DIRECT_DEPOSIT_CONFIRMED: 'enabled',
    SWAY_VENMO_DIRECT_DEPOSIT_CONFIRMED: 'on'
  },
  connectEnabled: true
}), {
  bank_account: false,
  debit_card: false,
  cash_app_direct_deposit: false,
  venmo_direct_deposit: false
}, 'only an explicit true attestation may enable a payout option');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_STRIPE_CONNECT_COUNTRY: 'US',
    SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED: 'true'
  },
  connectEnabled: true
}), {
  bank_account: true,
  debit_card: false,
  cash_app_direct_deposit: false,
  venmo_direct_deposit: false
}, 'generic external-account confirmation enables bank only');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_STRIPE_CONNECT_COUNTRY: 'US',
    SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED: 'TRUE',
    SWAY_STRIPE_CONNECT_DEBIT_CARD_COLLECTION_CONFIRMED: 'true'
  },
  connectEnabled: true
}), {
  bank_account: true,
  debit_card: true,
  cash_app_direct_deposit: false,
  venmo_direct_deposit: false
}, 'debit-card confirmation must not silently enable wallet preferences');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_STRIPE_CONNECT_COUNTRY: 'US',
    SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED: 'true',
    SWAY_CASH_APP_DIRECT_DEPOSIT_CONFIRMED: 'true'
  },
  connectEnabled: true
}), {
  bank_account: true,
  debit_card: false,
  cash_app_direct_deposit: true,
  venmo_direct_deposit: false
}, 'Cash App requires its own independent attestation');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_STRIPE_CONNECT_COUNTRY: 'US',
    SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED: 'true',
    SWAY_VENMO_DIRECT_DEPOSIT_CONFIRMED: 'true'
  },
  connectEnabled: true
}), {
  bank_account: true,
  debit_card: false,
  cash_app_direct_deposit: false,
  venmo_direct_deposit: true
}, 'Venmo requires its own independent attestation');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_STRIPE_CONNECT_COUNTRY: 'US',
    SWAY_CASH_APP_DIRECT_DEPOSIT_CONFIRMED: 'true',
    SWAY_VENMO_DIRECT_DEPOSIT_CONFIRMED: 'true'
  },
  connectEnabled: true
}), {
  bank_account: false,
  debit_card: false,
  cash_app_direct_deposit: false,
  venmo_direct_deposit: false
}, 'wallet attestations must fail closed without generic external-account collection');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_STRIPE_CONNECT_COUNTRY: 'US',
    SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED: 'true',
    SWAY_STRIPE_CONNECT_DEBIT_CARD_COLLECTION_CONFIRMED: 'true',
    SWAY_CASH_APP_DIRECT_DEPOSIT_CONFIRMED: 'true',
    SWAY_VENMO_DIRECT_DEPOSIT_CONFIRMED: 'true'
  },
  connectEnabled: true
}), {
  bank_account: true,
  debit_card: true,
  cash_app_direct_deposit: true,
  venmo_direct_deposit: true
});

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_STRIPE_CONNECT_COUNTRY: 'CA',
    SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED: 'true',
    SWAY_STRIPE_CONNECT_DEBIT_CARD_COLLECTION_CONFIRMED: 'true',
    SWAY_CASH_APP_DIRECT_DEPOSIT_CONFIRMED: 'true',
    SWAY_VENMO_DIRECT_DEPOSIT_CONFIRMED: 'true'
  },
  connectEnabled: true
}), {
  bank_account: true,
  debit_card: false,
  cash_app_direct_deposit: false,
  venmo_direct_deposit: false
}, 'US-only debit and wallet rails must remain disabled for non-US accounts');

assert.deepEqual(resolvePayoutDestinationCapabilities({
  env: {
    SWAY_STRIPE_CONNECT_COUNTRY: 'US',
    SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED: 'true',
    SWAY_STRIPE_CONNECT_DEBIT_CARD_COLLECTION_CONFIRMED: 'true',
    SWAY_CASH_APP_DIRECT_DEPOSIT_CONFIRMED: 'true',
    SWAY_VENMO_DIRECT_DEPOSIT_CONFIRMED: 'true'
  },
  connectEnabled: false
}), {
  bank_account: false,
  debit_card: false,
  cash_app_direct_deposit: false,
  venmo_direct_deposit: false
}, 'destination rails must stay disabled when Connect itself is unavailable');

console.log('Payout destination capability behavior test passed.');
