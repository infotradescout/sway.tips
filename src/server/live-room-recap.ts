import type { GigSession, PerformerRoomRecap } from '../types';
import { SWAY_TEST_PLATFORM_BALANCE_DESTINATION } from './live-room-seller-readiness';

export type LiveRoomRecapPayment = {
  paymentStatus: string;
  refundStatus: string;
  amountSubtotal: number;
  platformFee: number;
  destinationAccountId: string | null;
};

export function projectPerformerRoomRecap(input: {
  gigId: string;
  performerName: string;
  startedAt: string | null;
  closedAt: string | null;
  runtimeSessionState: Partial<GigSession>;
  payments: LiveRoomRecapPayment[];
}): PerformerRoomRecap {
  const currentlyCaptured = input.payments.filter((payment) =>
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
  const hasDurablePaymentRows = input.payments.length > 0;

  return {
    gigId: input.gigId,
    performerName: input.runtimeSessionState.talentName || input.performerName,
    startedAt: input.runtimeSessionState.startedAt || input.startedAt,
    closedAt: input.runtimeSessionState.closedAt || input.closedAt,
    capturedAmount: hasDurablePaymentRows
      ? currentlyCaptured.reduce((total, payment) => total + payment.amountSubtotal, 0) / 100
      : Number(input.runtimeSessionState.totals?.totalTips || 0),
    platformFees: hasDurablePaymentRows
      ? currentlyCaptured.reduce((total, payment) => total + payment.platformFee, 0) / 100
      : Number(input.runtimeSessionState.totals?.accumulatedFees || 0),
    completedActions: hasDurablePaymentRows
      ? currentlyCaptured.length
      : Number(input.runtimeSessionState.totals?.totalCount || 0),
    topRequest: input.runtimeSessionState.totals?.topRequest || 'No fulfilled requests',
    settlementMode,
    paymentEnvironment
  };
}
