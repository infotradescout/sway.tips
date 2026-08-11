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
      topRequest: 'Stale runtime top request'
    }
  },
  requests: [],
  boosts: []
};

let paymentSequence = 0;
const payment = (
  paymentStatus: string,
  refundStatus: string,
  amountSubtotal: number,
  overrides: Partial<{
    id: string;
    requestId: string | null;
    requestBoostId: string | null;
    actionType: string | null;
    legacyUnlinked: boolean;
    platformFee: number;
    destinationAccountId: string | null;
  }> = {}
) => ({
  id: overrides.id ?? `payment-${++paymentSequence}`,
  requestId: overrides.requestId ?? null,
  requestBoostId: overrides.requestBoostId ?? null,
  actionType: overrides.actionType ?? 'request',
  legacyUnlinked: overrides.legacyUnlinked ?? false,
  paymentStatus,
  refundStatus,
  amountSubtotal,
  platformFee: overrides.platformFee ?? 100,
  destinationAccountId: overrides.destinationAccountId === undefined
    ? SWAY_TEST_PLATFORM_BALANCE_DESTINATION
    : overrides.destinationAccountId
});

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
assert.equal(productionPilotShape.capturedEarnings, 20, 'Old clients must receive the one-release compatibility alias.');
assert.equal(productionPilotShape.platformFees, 4);
assert.equal(productionPilotShape.completedActions, 4);
assert.equal(productionPilotShape.settlementMode, 'platform_test_balance');
assert.equal(productionPilotShape.paymentEnvironment, 'test');
assert.equal(productionPilotShape.topRequest, 'No captured visible requests');

const pendingRefund = projectPerformerRoomRecap({
  ...baseInput,
  payments: [payment('captured', 'pending', 500)]
});
assert.equal(pendingRefund.capturedAmount, 0, 'Refund-pending volume must not be presented as currently captured.');

const legacyConnected = projectPerformerRoomRecap({
  ...baseInput,
  payments: [payment('captured', 'not_refunded', 700, { destinationAccountId: 'acct_connected' })]
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
  payments: [payment('captured', 'not_refunded', 700, { destinationAccountId: 'acct_connected' })]
});
assert.equal(verifiedLive.paymentEnvironment, 'live');

const freeRoom = projectPerformerRoomRecap({
  ...baseInput,
  payments: []
});
assert.equal(freeRoom.settlementMode, 'no_paid_activity');
assert.equal(freeRoom.paymentEnvironment, 'unavailable');
assert.equal(freeRoom.capturedAmount, 0, 'Runtime totals without durable payments must not be called captured volume.');

const canonicalDuplicate = projectPerformerRoomRecap({
  ...baseInput,
  requests: [{
    id: 'request-duplicate', type: 'request', title: 'Canonical request', status: 'fulfilled',
    hidden: false, removed: false, paymentId: 'payment-canonical'
  }],
  payments: [
    payment('captured', 'not_refunded', 900, {
      id: 'payment-stale', requestId: 'request-duplicate', legacyUnlinked: true
    }),
    payment('refunded', 'refunded', 900, {
      id: 'payment-canonical', requestId: 'request-duplicate', legacyUnlinked: true
    })
  ]
});
assert.equal(canonicalDuplicate.capturedAmount, 0, 'The runtime-bound canonical payment must win over a stale legacy duplicate.');

const ambiguousLegacyDuplicate = projectPerformerRoomRecap({
  ...baseInput,
  requests: [{
    id: 'request-ambiguous', type: 'request', title: 'Ambiguous request', status: 'fulfilled',
    hidden: false, removed: false, paymentId: null
  }],
  payments: [
    payment('captured', 'not_refunded', 800, {
      id: 'payment-ambiguous-a', requestId: 'request-ambiguous', legacyUnlinked: true
    }),
    payment('captured', 'not_refunded', 800, {
      id: 'payment-ambiguous-b', requestId: 'request-ambiguous', legacyUnlinked: true
    })
  ]
});
assert.equal(ambiguousLegacyDuplicate.capturedAmount, 0, 'Ambiguous legacy duplicates must be omitted rather than double-counted.');

const recomputedTopRequest = projectPerformerRoomRecap({
  ...baseInput,
  requests: [
    { id: 'request-visible', type: 'request', title: 'Visible captured request', status: 'fulfilled', hidden: false, removed: false, paymentId: 'payment-visible' },
    { id: 'request-refunded', type: 'request', title: 'Former refunded leader', status: 'fulfilled', hidden: false, removed: false, paymentId: 'payment-refunded' },
    { id: 'request-hidden', type: 'request', title: 'Hidden captured leader', status: 'fulfilled', hidden: true, removed: false, paymentId: 'payment-hidden' }
  ],
  boosts: [{ id: 'boost-visible', requestId: 'request-visible', paymentId: 'payment-boost' }],
  payments: [
    payment('captured', 'not_refunded', 500, { id: 'payment-visible', requestId: 'request-visible' }),
    payment('captured', 'not_refunded', 400, { id: 'payment-boost', requestBoostId: 'boost-visible', actionType: 'boost' }),
    payment('refunded', 'refunded', 3000, { id: 'payment-refunded', requestId: 'request-refunded' }),
    payment('captured', 'not_refunded', 5000, { id: 'payment-hidden', requestId: 'request-hidden' })
  ]
});
assert.equal(recomputedTopRequest.topRequest, 'Visible captured request');
assert.equal(recomputedTopRequest.capturedAmount, 59, 'Captured totals may include hidden service volume while the public top request excludes hidden/refunded names.');

console.log('Sway live-room recap behavior test passed.');
