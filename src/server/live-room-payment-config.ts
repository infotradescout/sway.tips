export type LiveRoomPaymentRuntimeMode = 'test' | 'live' | 'unavailable';

export type LiveRoomPaymentRuntimeConfig = {
  mode: LiveRoomPaymentRuntimeMode;
  publishableKey: string | null;
  moneyEnabled: boolean;
  connectEnabled: boolean;
  liveAllowedPerformerIds: ReadonlySet<string>;
  liveApprovalVersion: string | null;
  reason:
    | 'ready'
    | 'mode_key_mismatch'
    | 'configuration_incomplete'
    | 'durability_writes_disabled'
    | 'live_activation_not_approved';
};

export const LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION = '2026-08-31-v1';

function resolveLiveAllowedPerformerIds(raw: string | undefined) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const values = (raw ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (
    values.length !== 1
    || new Set(values).size !== 1
    || values.some((value) => !uuidPattern.test(value))
  ) return new Set<string>();
  return new Set(values);
}

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
  const liveAllowedPerformerIds = resolveLiveAllowedPerformerIds(
    env.SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS
  );
  const liveApprovalVersion = env.SWAY_LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION?.trim() || null;
  const liveActivationApproved = env.SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED?.trim().toLowerCase() === 'true'
    && liveApprovalVersion === LIVE_ROOM_LIVE_MONEY_APPROVAL_VERSION
    && liveAllowedPerformerIds.size > 0;

  if (publishableMode === 'unavailable' || secretMode === 'unavailable' || !webhookSecret) {
    return {
      mode: 'unavailable',
      publishableKey: null,
      moneyEnabled: false,
      connectEnabled: false,
      liveAllowedPerformerIds,
      liveApprovalVersion,
      reason: 'configuration_incomplete'
    };
  }

  if (publishableMode !== secretMode) {
    return {
      mode: 'unavailable',
      publishableKey: null,
      moneyEnabled: false,
      connectEnabled: false,
      liveAllowedPerformerIds,
      liveApprovalVersion,
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
      liveAllowedPerformerIds,
      liveApprovalVersion,
      reason: 'configuration_incomplete'
    };
  }

  if (!input.durabilityWritesEnabled) {
    return {
      mode,
      publishableKey,
      moneyEnabled: false,
      connectEnabled: false,
      liveAllowedPerformerIds,
      liveApprovalVersion,
      reason: 'durability_writes_disabled'
    };
  }

  if (mode === 'live' && !liveActivationApproved) {
    return {
      mode,
      publishableKey: null,
      moneyEnabled: false,
      connectEnabled: false,
      liveAllowedPerformerIds,
      liveApprovalVersion,
      reason: 'live_activation_not_approved'
    };
  }

  return {
    mode,
    publishableKey,
    moneyEnabled: true,
    connectEnabled: true,
    liveAllowedPerformerIds,
    liveApprovalVersion,
    reason: 'ready'
  };
}
