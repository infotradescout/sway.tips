export const PAYOUT_DESTINATIONS = [
  {
    id: 'bank_account',
    label: 'Bank account',
    shortDescription: 'Deposit earnings to a checking or savings account.',
    setupHint: 'Enter your bank routing and account numbers during secure setup.',
    helpUrl: null
  },
  {
    id: 'debit_card',
    label: 'Debit card',
    shortDescription: 'Use an eligible debit card when card payouts are available.',
    setupHint: 'Eligibility, timing, and any fee are shown before you finish secure setup.',
    helpUrl: null
  },
  {
    id: 'cash_app_direct_deposit',
    label: 'Cash App direct deposit',
    shortDescription: 'Use Cash App routing and account details only when Direct Deposit is available on your account.',
    setupHint: 'Eligibility and limits apply. Secure setup confirms whether the routing and account details can be used.',
    helpUrl: 'https://cash.app/help/3111-direct-deposit-account-details'
  },
  {
    id: 'venmo_direct_deposit',
    label: 'Venmo direct deposit',
    shortDescription: 'Use Venmo routing and account details only when Direct Deposit is available on your account.',
    setupHint: 'Eligibility and limits apply. Secure setup confirms whether the routing and account details can be used.',
    helpUrl: 'https://help.venmo.com/cs/articles/direct-deposit-faq-vhel332'
  }
] as const;

export type PayoutDestinationKind = typeof PAYOUT_DESTINATIONS[number]['id'];
export type PayoutSetupReturnStatus = 'return' | 'pending' | 'auth';
export type PayoutDestinationCapabilities = Record<PayoutDestinationKind, boolean>;

export const NO_PAYOUT_DESTINATION_CAPABILITIES: PayoutDestinationCapabilities = {
  bank_account: false,
  debit_card: false,
  cash_app_direct_deposit: false,
  venmo_direct_deposit: false
};

const PAYOUT_DESTINATION_IDS = new Set<PayoutDestinationKind>(
  PAYOUT_DESTINATIONS.map((destination) => destination.id)
);

export function normalizePayoutDestinationKind(value: unknown): PayoutDestinationKind | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases: Record<string, PayoutDestinationKind> = {
    bank: 'bank_account',
    bank_account: 'bank_account',
    debit: 'debit_card',
    debit_card: 'debit_card',
    cash_app: 'cash_app_direct_deposit',
    cashapp: 'cash_app_direct_deposit',
    cash_app_direct_deposit: 'cash_app_direct_deposit',
    venmo: 'venmo_direct_deposit',
    venmo_direct_deposit: 'venmo_direct_deposit'
  };
  return aliases[normalized]
    ?? (PAYOUT_DESTINATION_IDS.has(normalized as PayoutDestinationKind)
      ? normalized as PayoutDestinationKind
      : null);
}

export function payoutDestinationLabel(value: unknown) {
  const destinationKind = normalizePayoutDestinationKind(value);
  return PAYOUT_DESTINATIONS.find((destination) => destination.id === destinationKind)?.label ?? null;
}

export function canConfigurePayoutDestination(
  value: unknown,
  paymentMode: unknown,
  capabilities: unknown
) {
  const destinationKind = normalizePayoutDestinationKind(value);
  if (!destinationKind || (paymentMode !== 'test' && paymentMode !== 'live')) return false;
  if (!normalizePayoutDestinationCapabilities(capabilities)[destinationKind]) return false;
  if (paymentMode === 'live') return true;
  return destinationKind === 'bank_account' || destinationKind === 'debit_card';
}

export type PayoutDestinationSetupRequest =
  | { ok: true; destinationKind: PayoutDestinationKind }
  | { ok: false; status: 422 | 503; error: string };

export function resolvePayoutDestinationSetupRequest(input: {
  destinationKind: unknown;
  paymentMode: unknown;
  capabilities: unknown;
  runtimeAvailable: boolean;
}): PayoutDestinationSetupRequest {
  const destinationKind = normalizePayoutDestinationKind(input.destinationKind);
  if (!destinationKind) {
    return { ok: false, status: 422, error: 'Choose a supported payout destination.' };
  }
  if (!input.runtimeAvailable) {
    return { ok: false, status: 503, error: 'Secure payout setup is temporarily unavailable. Try again later.' };
  }

  const capabilities = normalizePayoutDestinationCapabilities(input.capabilities);
  if (!canConfigurePayoutDestination(destinationKind, input.paymentMode, capabilities)) {
    return {
      ok: false,
      status: 422,
      error: !capabilities[destinationKind]
        ? 'That payout destination is not available yet. Choose an enabled option.'
        : input.paymentMode === 'test'
          ? 'Cash App and Venmo setup is available only for live payouts. Choose an enabled simulated option.'
          : 'That payout destination is unavailable in the current payment mode.'
    };
  }

  return { ok: true, destinationKind };
}

export function normalizePayoutDestinationCapabilities(value: unknown): PayoutDestinationCapabilities {
  if (!value || typeof value !== 'object') return { ...NO_PAYOUT_DESTINATION_CAPABILITIES };
  const raw = value as Record<string, unknown>;
  return {
    bank_account: raw.bank_account === true,
    debit_card: raw.debit_card === true,
    cash_app_direct_deposit: raw.cash_app_direct_deposit === true,
    venmo_direct_deposit: raw.venmo_direct_deposit === true
  };
}

export function resolvePayoutSetupReturnStatus(search: string): PayoutSetupReturnStatus | null {
  const values = new URLSearchParams(search).getAll('connect');
  if (values.length !== 1) return null;
  return values[0] === 'return' || values[0] === 'pending' || values[0] === 'auth'
    ? values[0]
    : null;
}
