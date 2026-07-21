import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';

process.on('uncaughtException', (error) => {
  console.error('Sway public room state behavioral test failed:');
  console.error(error);
  process.exit(1);
});

const {
  projectPublicRoomState,
  sanitizePatronMutationResponseBody
} = await tsImport('../src/server/public-room-state.ts', import.meta.url);
const {
  issuePatronStatusReceipt,
  matchesPatronStatusReceipt,
  projectPatronRequestStatus
} = await tsImport('../src/server/patron-status-receipt.ts', import.meta.url);

const root = process.cwd();
const gigId = '11111111-1111-4111-8111-111111111111';
const submittedAt = '2026-07-17T20:00:00.000Z';

function requestFixture(overrides = {}) {
  return {
    id: 'req-base',
    type: 'request',
    targetType: 'music',
    title: 'Public title',
    subtitle: 'Public artist',
    albumArt: 'https://example.test/art.jpg',
    sourceProvider: 'internal-provider',
    spotifyUri: 'spotify:track:internal',
    spotifyUrl: 'https://open.spotify.test/internal',
    senderName: 'Public Patron',
    message: 'private patron note',
    amount: 10,
    holdAmount: 10,
    platformFee: 1,
    sponsorCount: 1,
    status: 'approved',
    shadowBanned: false,
    hidden: false,
    removed: false,
    actorUserId: 'internal-actor-secret',
    lastMutationActorUserId: 'internal-mutator-secret',
    createdAt: submittedAt,
    clientRequestId: 'internal-client-request-secret',
    idempotencyKey: 'internal-idempotency-secret',
    idempotencyFingerprint: 'internal-fingerprint-secret',
    idempotencyExpiresAt: '2026-07-19T20:00:00.000Z',
    patronDeviceIdHash: 'internal-device-secret',
    gigId,
    payloadHash: 'internal-payload-secret',
    amountCents: 1000,
    currency: 'USD',
    paymentId: 'internal-payment-secret',
    paymentIntentId: 'internal-payment-intent-secret',
    paymentStatus: 'authorized',
    patronStatusReceiptHash: 'internal-receipt-hash-secret',
    boosts: [],
    ...overrides
  };
}

const pendingRequest = requestFixture({ id: 'req-pending', status: 'hold' });
const approvedRequest = requestFixture({
  id: 'req-approved',
  boosts: [{
    id: 'boost-public',
    patronName: 'Boost Patron',
    amount: 5,
    timestamp: submittedAt,
    actorUserId: 'internal-boost-actor-secret',
    clientRequestId: 'internal-boost-client-secret',
    idempotencyKey: 'internal-boost-idempotency-secret',
    paymentIntentId: 'internal-boost-payment-secret'
  }]
});
const hiddenRequest = requestFixture({ id: 'req-hidden', status: 'fulfilled', hidden: true });
const shadowRequest = requestFixture({ id: 'req-shadow', status: 'hold', shadowBanned: true });
const deniedRequest = requestFixture({ id: 'req-denied', status: 'denied' });
const fulfilledTip = requestFixture({
  id: 'req-tip',
  type: 'tip',
  targetType: 'straight_tip',
  title: 'Straight Tip',
  subtitle: 'Supported the performer',
  albumArt: undefined,
  status: 'fulfilled'
});

const internalState = {
  session: {
    status: 'active',
    ownerActorUserId: 'internal-room-owner-secret',
    lastMutationActorUserId: 'internal-room-mutator-secret',
    talentName: 'DJ Public',
    talentRole: 'DJ',
    feeType: 'patron',
    minimumTip: 5,
    endGigTimerStartedAt: null,
    isFeatured: false,
    featuredExpiresAt: null,
    featuredCost: 0,
    featuredDurationHours: 0,
    requestsOpen: true,
    requestWindowMode: 'manual',
    requestWindowExpiresAt: null,
    requestWindowDuration: null,
    requestWindowLabel: null,
    requestPresets: [],
    operatingMode: 'manual',
    searchScope: 'catalog',
    paymentsEnabled: true,
    totals: {
      totalTips: 25,
      accumulatedFees: 3,
      totalCount: 6,
      topRequest: 'Public title'
    }
  },
  requests: [pendingRequest, approvedRequest, hiddenRequest, shadowRequest, deniedRequest, fulfilledTip],
  performers: [{
    id: 'p-active',
    name: 'DJ Public',
    role: 'DJ',
    venueName: 'Current gig',
    isFeatured: false,
    featuredExpiresAt: null,
    minimumTip: 5,
    avatarUrl: ''
  }],
  activeGigId: gigId
};

const publicState = projectPublicRoomState(internalState, gigId);
assert.deepEqual(
  publicState.requests.map((request) => request.id),
  ['req-approved', 'req-tip'],
  'Only visible approved/fulfilled requests may enter PublicRoomState.'
);
assert.deepEqual(
  Object.keys(publicState.requests[0]).sort(),
  ['albumArt', 'amount', 'boosts', 'createdAt', 'id', 'senderName', 'sponsorCount', 'status', 'subtitle', 'targetType', 'title', 'type'].sort(),
  'Public requests must be an explicit allowlist rather than a spread of internal state.'
);
assert.deepEqual(
  Object.keys(publicState.requests[0].boosts[0]).sort(),
  ['amount', 'id', 'patronName', 'timestamp'].sort(),
  'Public boosts must exclude actor, payment, client, and idempotency fields.'
);

const serializedPublicState = JSON.stringify(publicState);
for (const secret of [
  'private patron note',
  'internal-actor-secret',
  'internal-device-secret',
  'internal-idempotency-secret',
  'internal-payment-intent-secret',
  'internal-boost-payment-secret',
  'internal-room-owner-secret',
  'internal-receipt-hash-secret'
]) {
  assert.equal(serializedPublicState.includes(secret), false, `PublicRoomState leaked ${secret}.`);
}

const issuedReceipt = issuePatronStatusReceipt();
const secondReceipt = issuePatronStatusReceipt();
assert.match(issuedReceipt.receipt, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(issuedReceipt.receipt, secondReceipt.receipt, 'Each patron receipt must be independently random.');
assert.equal(matchesPatronStatusReceipt(issuedReceipt.receipt, issuedReceipt.receiptHash), true);
assert.equal(matchesPatronStatusReceipt(secondReceipt.receipt, issuedReceipt.receiptHash), false);
assert.equal(matchesPatronStatusReceipt('not-a-valid-receipt', issuedReceipt.receiptHash), false);

const pendingStatus = projectPatronRequestStatus(pendingRequest);
assert.deepEqual(pendingStatus, {
  actionType: 'request',
  status: 'hold',
  title: 'Public title',
  submittedAt
});
assert.equal(projectPatronRequestStatus(hiddenRequest).status, 'unavailable');

const sanitizedReplay = sanitizePatronMutationResponseBody({
  success: true,
  reconciled: true,
  state: internalState,
  request: approvedRequest,
  boost: approvedRequest.boosts[0],
  moderation: { shadowBanned: true, outage_behavior: 'hold_for_review' },
  patron_status: pendingStatus,
  patron_status_receipt: issuedReceipt.receipt
});
assert.equal('request' in sanitizedReplay, false);
assert.equal('boost' in sanitizedReplay, false);
assert.equal('moderation' in sanitizedReplay, false);
assert.deepEqual(sanitizedReplay.patron_status, pendingStatus);
assert.equal(sanitizedReplay.patron_status_receipt, issuedReceipt.receipt);
assert.equal(JSON.stringify(sanitizedReplay).includes('internal-device-secret'), false);

const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
const patronViewSource = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const patronAppSource = readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8');
const controlBridgeSource = readFileSync(join(root, 'scripts/sway-control-bridge.mjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

for (const term of [
  '...projectPublicRoomState(state, null)',
  '...projectPublicRoomState(roomSnapshot.state, requestedGigId)',
  'app.post("/api/patron/request-status"',
  'matchesPatronStatusReceipt(receipt, candidate.patronStatusReceiptHash)',
  'sanitizePatronMutationResponseBody(durableReplay.body)'
]) {
  assert.equal(serverSource.includes(term), true, `Server public-state wiring is missing: ${term}`);
}
assert.equal(patronViewSource.includes('const latestRequest = [...requests]'), false, 'Patron status must not use the newest global request.');
assert.equal(patronViewSource.includes('patronRequestStatus.status'), true, 'PatronView must render receipt-scoped status.');
assert.equal(patronAppSource.includes("postJson('/api/patron/request-status'"), true, 'PatronApp must poll the opaque receipt endpoint.');
assert.equal(controlBridgeSource.includes('...authHeaders'), true, 'Control bridge state reads must carry performer authorization.');
assert.equal(
  packageJson.scripts?.['test:contracts']?.includes('node scripts/sway-public-room-state.behavior.test.mjs'),
  true,
  'test:contracts must run the PublicRoomState behavioral regression.'
);

console.log('Sway public room state behavioral test passed.');
