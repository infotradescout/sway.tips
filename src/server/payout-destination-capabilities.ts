import type { PayoutDestinationCapabilities } from '../payout-destination';

function explicitlyConfirmed(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

export function resolvePayoutDestinationCapabilities(input: {
  env?: NodeJS.ProcessEnv;
  connectEnabled: boolean;
}): PayoutDestinationCapabilities {
  const env = input.env ?? process.env;
  const country = (env.SWAY_STRIPE_CONNECT_COUNTRY || 'US').trim().toUpperCase();
  const externalAccountCollectionConfirmed = input.connectEnabled
    && explicitlyConfirmed(env.SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED);
  const debitCardCollectionConfirmed = externalAccountCollectionConfirmed
    && explicitlyConfirmed(env.SWAY_STRIPE_CONNECT_DEBIT_CARD_COLLECTION_CONFIRMED);
  const isUnitedStates = country === 'US';

  return {
    bank_account: externalAccountCollectionConfirmed,
    debit_card: debitCardCollectionConfirmed && isUnitedStates,
    cash_app_direct_deposit: externalAccountCollectionConfirmed && isUnitedStates,
    venmo_direct_deposit: externalAccountCollectionConfirmed && isUnitedStates
  };
}
