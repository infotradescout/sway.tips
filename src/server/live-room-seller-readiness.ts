export const SWAY_TEST_PLATFORM_BALANCE_DESTINATION = 'sway_test_platform_balance';
export const SWAY_PLATFORM_BALANCE_DESTINATION = 'sway_platform_balance';

type LiveRoomSeller = {
  isActive?: boolean | null;
  onboardingStatus?: string | null;
  paymentAccountStatus?: string | null;
  kycStatus?: string | null;
  chargesEnabled?: boolean | null;
  payoutsEnabled?: boolean | null;
  stripeConnectedAccountId?: string | null;
  payoutHoldReason?: string | null;
  currentPayoutKycApproved?: boolean | null;
};

export type LiveRoomSellerMoneyReadiness =
  | {
      ready: true;
      destinationAccountId: string;
      settlementMode: 'connected_account' | 'platform_test_balance' | 'platform_balance';
    }
  | {
      ready: false;
      destinationAccountId: null;
      settlementMode: 'unavailable';
    };

export function isSwayTestPlatformBalanceDestination(value: string | null | undefined) {
  return value === SWAY_TEST_PLATFORM_BALANCE_DESTINATION;
}

export function isSwayPlatformBalanceDestination(value: string | null | undefined) {
  return value === SWAY_PLATFORM_BALANCE_DESTINATION
    || value === SWAY_TEST_PLATFORM_BALANCE_DESTINATION;
}

export function resolveTestModePlatformBalanceEnabled(input: {
  paymentMode: string | null | undefined;
  configuredValue: string | null | undefined;
}) {
  return input.paymentMode === 'test'
    && input.configuredValue?.trim().toLowerCase() === 'true';
}

export function resolveTestModePlatformBalancePerformerIds(input: {
  paymentMode: string | null | undefined;
  configuredValue: string | null | undefined;
  performerIdsValue: string | null | undefined;
}) {
  if (!resolveTestModePlatformBalanceEnabled(input)) return new Set<string>();

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const performerIds = (input.performerIdsValue ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!performerIds.length || performerIds.some((value) => !uuidPattern.test(value))) {
    return new Set<string>();
  }
  return new Set(performerIds);
}

export function isTestModePlatformBalancePerformerAllowed(
  performerId: string | null | undefined,
  allowedPerformerIds: ReadonlySet<string>
) {
  return Boolean(performerId && allowedPerformerIds.has(performerId.trim().toLowerCase()));
}

/**
 * Resolves the durable destination used by a live-room payment.
 *
 * New live-room charges settle to Sway's Stripe platform balance. Stripe is
 * incoming-only; an independently verified PayPal/Venmo preference is the
 * prerequisite for a live performer. Historical connected-account rows remain
 * readable elsewhere but are never selected for new money here.
 */
export function resolveLiveRoomSellerMoneyReadiness(input: {
  roomStatus?: string | null;
  seller: LiveRoomSeller | null | undefined;
  allowTestPlatformBalance: boolean;
  allowPlatformBalance?: boolean;
}): LiveRoomSellerMoneyReadiness {
  const seller = input.seller;
  const roomAcceptsMoney = input.roomStatus === undefined || input.roomStatus === 'active';
  const baseEligible = Boolean(
    roomAcceptsMoney
    && seller?.isActive
    && seller.onboardingStatus !== 'restricted'
    && seller.onboardingStatus !== 'suspended'
    && !seller.payoutHoldReason
  );
  if (baseEligible && input.allowPlatformBalance && seller?.currentPayoutKycApproved === true) {
    return {
      ready: true,
      destinationAccountId: SWAY_PLATFORM_BALANCE_DESTINATION,
      settlementMode: 'platform_balance'
    };
  }

  if (baseEligible && input.allowTestPlatformBalance) {
    return {
      ready: true,
      destinationAccountId: SWAY_TEST_PLATFORM_BALANCE_DESTINATION,
      settlementMode: 'platform_test_balance'
    };
  }

  return { ready: false, destinationAccountId: null, settlementMode: 'unavailable' };
}
