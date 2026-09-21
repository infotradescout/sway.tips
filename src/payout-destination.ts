export const PAYOUT_DESTINATIONS = [
  {
    id: 'paypal',
    label: 'PayPal',
    shortDescription: 'Send your combined Sway earnings to your PayPal account.',
    setupHint: 'Use the email address connected to the PayPal account that should receive your cash-out.'
  },
  {
    id: 'venmo',
    label: 'Venmo',
    shortDescription: 'Send your combined Sway earnings directly to your Venmo account.',
    setupHint: 'Use your Venmo handle, account email, or U.S. mobile number.'
  }
] as const;

export type PayoutDestinationKind = typeof PAYOUT_DESTINATIONS[number]['id'];
export type PayoutRecipientType = 'email' | 'phone' | 'user_handle';
export type PayoutDestinationCapabilities = Record<PayoutDestinationKind, boolean>;

export const NO_PAYOUT_DESTINATION_CAPABILITIES: PayoutDestinationCapabilities = {
  paypal: false,
  venmo: false
};

const PAYOUT_DESTINATION_IDS = new Set<PayoutDestinationKind>(
  PAYOUT_DESTINATIONS.map((destination) => destination.id)
);

export function normalizePayoutDestinationKind(value: unknown): PayoutDestinationKind | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return PAYOUT_DESTINATION_IDS.has(normalized as PayoutDestinationKind)
    ? normalized as PayoutDestinationKind
    : null;
}

export function payoutDestinationLabel(value: unknown) {
  const destinationKind = normalizePayoutDestinationKind(value);
  return PAYOUT_DESTINATIONS.find((destination) => destination.id === destinationKind)?.label ?? null;
}

export function normalizePayoutRecipientType(value: unknown): PayoutRecipientType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return normalized === 'email' || normalized === 'phone' || normalized === 'user_handle'
    ? normalized
    : null;
}

function normalizeEmail(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function normalizeUsMobile(value: string) {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function normalizeVenmoHandle(value: string) {
  const normalized = value.trim().replace(/^@+/, '');
  return /^[a-zA-Z0-9._-]{3,30}$/.test(normalized) ? normalized : null;
}

export type NormalizedPayoutRecipient = {
  destinationKind: PayoutDestinationKind;
  recipientType: PayoutRecipientType;
  recipientValue: string;
  recipientPreview: string;
};

export function payoutRecipientPreview(type: PayoutRecipientType, value: string) {
  if (type === 'email') {
    const [local, domain] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (type === 'phone') return `••• ••• ${value.slice(-4)}`;
  return `@${value.slice(0, 2)}${value.length > 3 ? '•••' : ''}${value.length > 5 ? value.slice(-1) : ''}`;
}

export function normalizePayoutRecipient(input: {
  destinationKind: unknown;
  recipientType: unknown;
  recipientValue: unknown;
}): NormalizedPayoutRecipient | null {
  const destinationKind = normalizePayoutDestinationKind(input.destinationKind);
  const recipientType = normalizePayoutRecipientType(input.recipientType);
  if (!destinationKind || !recipientType || typeof input.recipientValue !== 'string') return null;

  if (destinationKind === 'paypal' && recipientType !== 'email') return null;
  const recipientValue = recipientType === 'email'
    ? normalizeEmail(input.recipientValue)
    : recipientType === 'phone'
      ? normalizeUsMobile(input.recipientValue)
      : destinationKind === 'venmo'
        ? normalizeVenmoHandle(input.recipientValue)
        : null;
  if (!recipientValue) return null;

  return {
    destinationKind,
    recipientType,
    recipientValue,
    recipientPreview: payoutRecipientPreview(recipientType, recipientValue)
  };
}

export function canConfigurePayoutDestination(
  value: unknown,
  paymentMode: unknown,
  capabilities: unknown
) {
  const destinationKind = normalizePayoutDestinationKind(value);
  if (!destinationKind || (paymentMode !== 'test' && paymentMode !== 'live')) return false;
  return normalizePayoutDestinationCapabilities(capabilities)[destinationKind];
}

export function normalizePayoutDestinationCapabilities(value: unknown): PayoutDestinationCapabilities {
  if (!value || typeof value !== 'object') return { ...NO_PAYOUT_DESTINATION_CAPABILITIES };
  const raw = value as Record<string, unknown>;
  return {
    paypal: raw.paypal === true,
    venmo: raw.venmo === true
  };
}
