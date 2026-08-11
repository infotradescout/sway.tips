import assert from 'node:assert/strict';
import { projectPerformerRoomRecap } from '../src/server/live-room-recap';
import { SWAY_TEST_PLATFORM_BALANCE_DESTINATION } from '../src/server/live-room-seller-readiness';

const baseInput = {
  gigId: '825b02fc-e8a9-4ece-9957-efa4bca8ed91',
  performerName: 'Pilot Performer',
  startedAt: '2026-08-09T18:57:22.101Z',
  closedAt: '2026-08-09T19:24:21.427Z',
  runtimeSessionState: {
    talentName: 'Pilot Performer',
    totals: {
      totalTips: 60,
      accumulatedFees: 10,
      totalCount: 10,
      topRequest: 'QA Song Boost Target'
    }
  }
};

const payment = (
  paymentStatus: string,
  refundStatus: string,
  amountSubtotal: number,
  platformFee = 100,
  destinationAccountId: string | null = SWAY_TEST_PLATFORM_BALANCE_DESTINATION
) => ({ paymentStatus, refundStatus, amountSubtotal, platformFee, destinationAccountId });

const productionPilotShape = projectPerformerRoomRecap({
  ...baseInput,
  payments: [
    ...Array.from({ length: 4 }, () => payment('captured', 'not_refunded', 500)),
    ...Array.from({ length: 2 }, () => payment('refunded', 'refunded', 500)),
    ...Array.from({ length: 3 }, () => payment('voided', 'not_refunded', 500)),
    payment('failed', 'not_refunded', 500)
  ]
});
assert.equal(productionPilotShape.capturedAmount, 20);
assert.equal(productionPilotShape.platformFees, 4);
assert.equal(productionPilotShape.completedActions, 4);
assert.equal(productionPilotShape.settlementMode, 'platform_test_balance');
assert.equal(productionPilotShape.paymentEnvironment, 'test');

const pendingRefund = projectPerformerRoomRecap({
  ...baseInput,
  payments: [payment('captured', 'pending', 500)]
});
assert.equal(pendingRefund.capturedAmount, 0, 'Refund-pending volume must not be presented as currently captured.');

const legacyConnected = projectPerformerRoomRecap({
  ...baseInput,
  payments: [payment('captured', 'not_refunded', 700, 100, 'acct_connected')]
});
assert.equal(legacyConnected.settlementMode, 'connected_account');
assert.equal(legacyConnected.paymentEnvironment, 'unavailable', 'A historical connected destination without a persisted key mode must not be guessed live.');

const verifiedLive = projectPerformerRoomRecap({
  ...baseInput,
  runtimeSessionState: {
    ...baseInput.runtimeSessionState,
    settlementMode: 'connected_account' as const,
    paymentEnvironment: 'live' as const
  },
  payments: [payment('captured', 'not_refunded', 700, 100, 'acct_connected')]
});
assert.equal(verifiedLive.paymentEnvironment, 'live');

const freeRoom = projectPerformerRoomRecap({
  ...baseInput,
  runtimeSessionState: {
    ...baseInput.runtimeSessionState,
    totals: { ...baseInput.runtimeSessionState.totals, totalTips: 0, accumulatedFees: 0 }
  },
  payments: []
});
assert.equal(freeRoom.settlementMode, 'no_paid_activity');
assert.equal(freeRoom.paymentEnvironment, 'unavailable');
assert.equal(freeRoom.capturedAmount, 0);

console.log('Sway live-room recap behavior test passed.');
