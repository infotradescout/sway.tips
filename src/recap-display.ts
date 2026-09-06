const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

// These values are already dollar totals from the saved recap. Do not recalculate
// fees, infer settlement, or turn an unreadable value into an apparent zero.
export function isRecapMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function formatRecapMoney(value: unknown): string {
  return isRecapMoney(value) ? money.format(value) : 'Unavailable';
}

export function recapMoneyState(environment: unknown, settlement: unknown, amount: unknown) {
  const test = environment === 'test' || settlement === 'platform_test_balance';
  const live = !test && environment === 'live'
    && (settlement === 'platform_balance' || settlement === 'connected_account');
  return {
    test,
    live,
    canShare: live && isRecapMoney(amount),
    label: test ? 'Test payment volume' : live ? 'Captured payment volume' : 'Recorded room volume'
  };
}

export const RECAP_REQUEST_STATUS = {
  hold: 'Pending', approved: 'Approved', denied: 'Declined', fulfilled: 'Fulfilled'
} as const;

export function buildRecapShareText(amount: unknown): string | null {
  if (!isRecapMoney(amount)) return null;
  return `I just wrapped a Sway night with ${formatRecapMoney(amount)} in captured room payments. Final settlement can change after refunds or disputes. www.sway.tips`;
}
