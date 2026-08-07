export type LiveRoomPaymentRuntimeMode = 'test' | 'live' | 'unavailable';

export type LiveRoomPaymentRuntimeConfig = {
  mode: LiveRoomPaymentRuntimeMode;
  publishableKey: string | null;
  moneyEnabled: boolean;
  connectEnabled: boolean;
  reason:
    | 'ready'
    | 'mode_key_mismatch'
    | 'configuration_incomplete'
    | 'durability_writes_disabled';
};

function keyMode(value: string, prefixes: { test: string; live: string }) {
  if (value.startsWith(prefixes.test)) return 'test' as const;
  if (value.startsWith(prefixes.live)) return 'live' as const;
  return 'unavailable' as const;
}

export function resolveLiveRoomPaymentRuntimeConfig(input: {
  env?: NodeJS.ProcessEnv;
  paymentProviderConfigured: boolean;
  stripeConnectConfigured: boolean;
  durabilityWritesEnabled: boolean;
}): LiveRoomPaymentRuntimeConfig {
  const env = input.env ?? process.env;
  const publishableKey = (env.STRIPE_PUBLISHABLE_KEY || env.VITE_STRIPE_PUBLISHABLE_KEY || '').trim();
  const secretKey = (env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = (env.STRIPE_WEBHOOK_SECRET || '').trim();
  const publishableMode = keyMode(publishableKey, { test: 'pk_test_', live: 'pk_live_' });
  const secretMode = keyMode(secretKey, { test: 'sk_test_', live: 'sk_live_' });

  if (publishableMode === 'unavailable' || secretMode === 'unavailable' || !webhookSecret) {
    return {
      mode: 'unavailable',
      publishableKey: null,
      moneyEnabled: false,
      connectEnabled: false,
      reason: 'configuration_incomplete'
    };
  }

  if (publishableMode !== secretMode) {
    return {
      mode: 'unavailable',
      publishableKey: null,
      moneyEnabled: false,
      connectEnabled: false,
      reason: 'mode_key_mismatch'
    };
  }

  const mode = publishableMode;
  const configurationComplete = input.paymentProviderConfigured && input.stripeConnectConfigured;
  if (!configurationComplete) {
    return {
      mode: 'unavailable',
      publishableKey: null,
      moneyEnabled: false,
      connectEnabled: false,
      reason: 'configuration_incomplete'
    };
  }

  if (!input.durabilityWritesEnabled) {
    return {
      mode,
      publishableKey,
      moneyEnabled: false,
      connectEnabled: false,
      reason: 'durability_writes_disabled'
    };
  }

  return {
    mode,
    publishableKey,
    moneyEnabled: true,
    connectEnabled: true,
    reason: 'ready'
  };
}
