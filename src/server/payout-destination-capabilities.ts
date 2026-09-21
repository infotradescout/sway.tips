import type { PayoutDestinationCapabilities } from '../payout-destination';

function explicitlyConfirmed(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

export function resolvePayoutDestinationCapabilities(input: {
  env?: NodeJS.ProcessEnv;
  providerConfigured: boolean;
  destinationStorageConfigured: boolean;
}): PayoutDestinationCapabilities {
  const env = input.env ?? process.env;
  const baseReady = input.providerConfigured
    && input.destinationStorageConfigured
    && explicitlyConfirmed(env.SWAY_PAYPAL_PAYOUTS_CONFIRMED);

  return {
    paypal: baseReady,
    venmo: baseReady && explicitlyConfirmed(env.SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED)
  };
}
