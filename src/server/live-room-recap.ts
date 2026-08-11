import type { GigSession, PerformerRoomRecap } from '../types';
import { SWAY_TEST_PLATFORM_BALANCE_DESTINATION } from './live-room-seller-readiness';

export type LiveRoomRecapPayment = {
  id: string;
  requestId: string | null;
  requestBoostId: string | null;
  actionType: string | null;
  legacyUnlinked: boolean;
  paymentStatus: string;
  refundStatus: string;
  amountSubtotal: number;
  platformFee: number;
  destinationAccountId: string | null;
};

export type LiveRoomRecapRequest = {
  id: string;
  type: string;
  title: string;
  status: string;
  hidden: boolean;
  removed: boolean;
  paymentId: string | null;
};

export type LiveRoomRecapBoost = {
  id: string;
  requestId: string;
  paymentId: string | null;
};

function selectCanonicalPayments(input: {
  payments: LiveRoomRecapPayment[];
  requests: LiveRoomRecapRequest[];
  boosts: LiveRoomRecapBoost[];
}) {
  const requestPaymentId = new Map(input.requests.map((request) => [request.id, request.paymentId]));
  const boostPaymentId = new Map(input.boosts.map((boost) => [boost.id, boost.paymentId]));
  const groups = new Map<string, LiveRoomRecapPayment[]>();
  for (const payment of input.payments) {
    const key = payment.requestId
      ? `request:${payment.requestId}`
      : payment.requestBoostId
        ? `boost:${payment.requestBoostId}`
        : `payment:${payment.id}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(payment);
    groups.set(key, bucket);
  }

  return [...groups.entries()].flatMap(([key, candidates]) => {
    if (key.startsWith('payment:')) return candidates.slice(0, 1);
    const actionId = key.slice(key.indexOf(':') + 1);
    const runtimePaymentId = key.startsWith('request:')
      ? requestPaymentId.get(actionId)
      : boostPaymentId.get(actionId);
    if (runtimePaymentId) {
      const exact = candidates.find((candidate) => candidate.id === runtimePaymentId);
      return exact ? [exact] : [];
    }
    if (candidates.length === 1) return candidates;
    const durableBound = candidates.filter((candidate) => candidate.legacyUnlinked === false);
    return durableBound.length === 1 ? durableBound : [];
  });
}

export function projectPerformerRoomRecap(input: {
  gigId: string;
  performerName: string;
  startedAt: string | null;
  closedAt: string | null;
  runtimeSessionState: Partial<GigSession>;
  payments: LiveRoomRecapPayment[];
  requests: LiveRoomRecapRequest[];
  boosts: LiveRoomRecapBoost[];
}): PerformerRoomRecap {
  const canonicalPayments = selectCanonicalPayments(input);
  const currentlyCaptured = canonicalPayments.filter((payment) =>
    (payment.paymentStatus === 'captured' || payment.paymentStatus === 'paid_out')
    && payment.refundStatus !== 'pending'
    && payment.refundStatus !== 'refunded'
  );
  const hasTestPlatformBalance = input.payments.some((payment) =>
    payment.destinationAccountId === SWAY_TEST_PLATFORM_BALANCE_DESTINATION
  );
  const hasConnectedAccount = input.payments.some((payment) =>
    Boolean(payment.destinationAccountId)
    && payment.destinationAccountId !== SWAY_TEST_PLATFORM_BALANCE_DESTINATION
  );
  const settlementMode = hasTestPlatformBalance && hasConnectedAccount
    ? 'mixed' as const
    : hasTestPlatformBalance
      ? 'platform_test_balance' as const
      : hasConnectedAccount
        ? 'connected_account' as const
        : input.runtimeSessionState.settlementMode === 'platform_test_balance'
            || input.runtimeSessionState.settlementMode === 'connected_account'
          ? input.runtimeSessionState.settlementMode
          : 'no_paid_activity' as const;
  const paymentEnvironment = input.runtimeSessionState.paymentEnvironment === 'test'
      || input.runtimeSessionState.paymentEnvironment === 'live'
    ? input.runtimeSessionState.paymentEnvironment
    : hasTestPlatformBalance
      ? 'test' as const
      : 'unavailable' as const;

  const requestById = new Map(input.requests.map((request) => [request.id, request]));
  const boostParentById = new Map(input.boosts.map((boost) => [boost.id, boost.requestId]));
  const capturedVolumeByRequest = new Map<string, number>();
  for (const payment of currentlyCaptured) {
    const requestId = payment.requestId
      ?? (payment.requestBoostId ? boostParentById.get(payment.requestBoostId) ?? null : null);
    if (!requestId) continue;
    const request = requestById.get(requestId);
    if (
      !request
      || request.type !== 'request'
      || !['fulfilled', 'captured', 'paid_out'].includes(request.status)
      || request.hidden
      || request.removed
    ) continue;
    capturedVolumeByRequest.set(
      requestId,
      (capturedVolumeByRequest.get(requestId) ?? 0) + payment.amountSubtotal
    );
  }
  const topRequestEntry = [...capturedVolumeByRequest.entries()]
    .map(([requestId, capturedCents]) => ({
      requestId,
      capturedCents,
      title: requestById.get(requestId)?.title || 'Untitled request'
    }))
    .sort((left, right) =>
      right.capturedCents - left.capturedCents
      || left.title.localeCompare(right.title)
      || left.requestId.localeCompare(right.requestId)
    )[0];
  const capturedAmount = currentlyCaptured.reduce((total, payment) => total + payment.amountSubtotal, 0) / 100;

  return {
    gigId: input.gigId,
    performerName: input.runtimeSessionState.talentName || input.performerName,
    startedAt: input.runtimeSessionState.startedAt || input.startedAt,
    closedAt: input.runtimeSessionState.closedAt || input.closedAt,
    capturedAmount,
    // One-release compatibility alias for cached clients and safe rollback.
    capturedEarnings: capturedAmount,
    platformFees: currentlyCaptured.reduce((total, payment) => total + payment.platformFee, 0) / 100,
    completedActions: currentlyCaptured.length,
    topRequest: topRequestEntry?.title || 'No captured visible requests',
    settlementMode,
    paymentEnvironment
  };
}
