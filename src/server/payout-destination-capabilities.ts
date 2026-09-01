import type { PayoutDestinationCapabilities } from '../payout-destination';

function explicitlyConfirmed(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

export function resolvePayoutDestinationCapabilities(input: {
  env?: NodeJS.ProcessEnv;
  connectEnabled?: boolean;
}): PayoutDestinationCapabilities {
  const env = input.env ?? process.env;
  const plaidEnabled = explicitlyConfirmed(env.SWAY_PLAID_TRANSFER_PAYOUTS_CONFIRMED);
  const paypalEnabled = explicitlyConfirmed(env.SWAY_PAYPAL_PAYOUTS_CONFIRMED);

  return {
    bank_account: plaidEnabled,
    debit_card: explicitlyConfirmed(env.SWAY_DEBIT_CARD_PAYOUTS_CONFIRMED),
    cash_app_direct_deposit: plaidEnabled,
    venmo: paypalEnabled && explicitlyConfirmed(env.SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED),
    paypal: paypalEnabled
  };
}
