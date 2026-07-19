import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
const tempDir = join(root, '.tmp');
mkdirSync(tempDir, { recursive: true });

async function loadModule(entryPoint, outputName) {
  const outfile = join(tempDir, outputName);
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    sourcemap: false
  });
  return createRequire(import.meta.url)(outfile);
}

async function main() {
const projection = await loadModule('src/server/public-room-state.ts', 'public-room-state.contract.bundle.cjs');
const receipts = await loadModule('src/server/patron-status-receipt.ts', 'patron-status-receipt.contract.bundle.cjs');

const session = {
  status: 'active',
  ownerActorUserId: 'owner-user-id',
  lastMutationActorUserId: 'mutation-user-id',
  talentName: 'DJ Privacy',
  talentRole: 'DJ',
  feeType: 'patron',
  minimumTip: 5,
  endGigTimerStartedAt: null,
  isFeatured: true,
  featuredExpiresAt: null,
  featuredCost: 20,
  featuredDurationHours: 2,
  requestsOpen: true,
  requestWindowMode: 'manual',
  requestWindowExpiresAt: null,
  requestWindowDuration: null,
  requestWindowLabel: null,
  requestPresets: [],
  operatingMode: 'manual',
  searchScope: 'library',
  paymentsEnabled: true,
  totals: { totalTips: 100, accumulatedFees: 15, totalCount: 8, topRequest: 'Private' }
};

function makeRequest(id, overrides = {}) {
  return {
    id,
    type: 'request',
    targetType: 'music',
    title: `Song ${id}`,
    subtitle: 'Artist',
    albumArt: 'https://example.com/art.jpg',
    sourceProvider: 'private-provider',
    spotifyUri: 'spotify:track:private',
    spotifyUrl: 'https://open.spotify.com/private',
    senderName: 'Patron',
    message: 'private note',
    amount: 10,
    holdAmount: 10,
    platformFee: 1,
    sponsorCount: 1,
    status: 'approved',
    shadowBanned: false,
    hidden: false,
    removed: false,
    actorUserId: 'actor-user-id',
    lastMutationActorUserId: 'mutation-user-id',
    createdAt: '2026-07-19T12:00:00.000Z',
    clientRequestId: 'client-private',
    idempotencyKey: 'idem-private',
    idempotencyFingerprint: 'fingerprint-private',
    idempotencyExpiresAt: '2026-07-21T12:00:00.000Z',
    patronDeviceIdHash: 'device-private',
    gigId: '11111111-1111-4111-8111-111111111111',
    payloadHash: 'payload-private',
    amountCents: 1000,
    currency: 'USD',
    paymentId: 'payment-private',
    paymentIntentId: 'intent-private',
    paymentStatus: 'authorized',
    patronStatusReceipts: [{
      receiptHash: 'a'.repeat(64),
      issuedAt: '2026-07-19T12:00:00.000Z',
      expiresAt: '2026-07-21T12:00:00.000Z'
    }],
    boosts: [{
      id: `boost-${id}`,
      patronName: 'Booster',
      amount: 5,
      timestamp: '2026-07-19T12:01:00.000Z',
      actorUserId: 'boost-actor',
      clientRequestId: 'boost-client',
      idempotencyKey: 'boost-idem',
      idempotencyFingerprint: 'boost-fingerprint',
      idempotencyExpiresAt: '2026-07-21T12:01:00.000Z',
      paymentId: 'boost-payment',
      paymentIntentId: 'boost-intent',
      paymentStatus: 'captured'
    }],
    ...overrides
  };
}

const state = {
  session,
  activeGigId: '11111111-1111-4111-8111-111111111111',
  performers: [{
    id: 'performer-1',
    name: 'DJ Privacy',
    role: 'DJ',
    venueName: 'Current gig',
    isFeatured: true,
    featuredExpiresAt: null,
    minimumTip: 5,
    avatarUrl: 'https://example.com/dj.jpg'
  }],
  requests: [
    makeRequest('approved'),
    makeRequest('fulfilled', { status: 'fulfilled' }),
    makeRequest('pending', { status: 'hold' }),
    makeRequest('denied', { status: 'denied' }),
    makeRequest('hidden', { hidden: true }),
    makeRequest('removed', { removed: true }),
    makeRequest('shadowed', { shadowBanned: true })
  ]
};

const publicState = projection.projectPublicRoomState(state);
assert.deepEqual(publicState.requests.map((request) => request.id), ['approved', 'fulfilled']);
assert.equal(publicState.activeGigId, null);

const forbiddenKeys = new Set([
  'ownerActorUserId',
  'lastMutationActorUserId',
  'actorUserId',
  'patronDeviceIdHash',
  'clientRequestId',
  'idempotencyKey',
  'idempotencyFingerprint',
  'idempotencyExpiresAt',
  'payloadHash',
  'paymentId',
  'paymentIntentId',
  'paymentStatus',
  'patronStatusReceipts',
  'message',
  'holdAmount',
  'platformFee',
  'shadowBanned',
  'hidden',
  'removed',
  'totals'
]);

function assertRecursiveAllowlist(value, path = 'root') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(forbiddenKeys.has(key), false, `Forbidden key ${key} leaked at ${path}`);
    assertRecursiveAllowlist(nested, `${path}.${key}`);
  }
}

assertRecursiveAllowlist(publicState);

assert.deepEqual(projection.projectPatronRequestStatus(makeRequest('pending', { status: 'hold' })), { requestId: 'pending', status: 'pending' });
assert.deepEqual(projection.projectPatronRequestStatus(makeRequest('shadow-approved', { shadowBanned: true })), { requestId: 'shadow-approved', status: 'pending' });
assert.deepEqual(projection.projectPatronRequestStatus(makeRequest('approved')), { requestId: 'approved', status: 'approved' });
assert.deepEqual(projection.projectPatronRequestStatus(makeRequest('fulfilled', { status: 'fulfilled' })), { requestId: 'fulfilled', status: 'fulfilled' });
assert.deepEqual(projection.projectPatronRequestStatus(makeRequest('denied', { status: 'denied' })), { requestId: 'denied', status: 'not_approved' });
assert.deepEqual(projection.projectPatronRequestStatus(makeRequest('hidden', { hidden: true })), { requestId: 'hidden', status: 'not_approved' });
assert.deepEqual(projection.projectPatronRequestStatus(makeRequest('removed', { removed: true })), { requestId: 'removed', status: 'not_approved' });

const patronResponse = projection.projectPatronActionResponse({
  success: true,
  request: makeRequest('pending', { status: 'hold' }),
  state
});
assert.deepEqual(patronResponse.request, { requestId: 'pending', status: 'pending' });
assertRecursiveAllowlist(patronResponse);

const operatorState = projection.projectOperatorRoomState(state);
assert.equal(operatorState.requests[0].actorUserId, 'actor-user-id');
assert.equal('patronStatusReceipts' in operatorState.requests[0], false);

const now = new Date('2026-07-19T12:00:00.000Z');
const rawReceipt = Buffer.alloc(32, 1).toString('base64url');
const registration = receipts.registerPatronStatusReceipt({ receipt: rawReceipt, now });
assert.ok(registration);
assert.equal(registration.records.length, 1);
assert.equal(JSON.stringify(registration.records).includes(rawReceipt), false, 'Raw receipt must not enter persisted records.');
assert.ok(receipts.findMatchingPatronStatusReceipt(registration.records, rawReceipt, now));
assert.equal(receipts.findMatchingPatronStatusReceipt(registration.records, Buffer.alloc(32, 2).toString('base64url'), now), null);
assert.equal(receipts.findMatchingPatronStatusReceipt(registration.records, 'malformed', now), null);
assert.equal(
  receipts.findMatchingPatronStatusReceipt(registration.records, rawReceipt, new Date('2026-07-22T12:00:00.000Z')),
  null
);

let boundedRecords = [];
for (let index = 1; index <= 6; index += 1) {
  const issued = receipts.registerPatronStatusReceipt({
    receipt: Buffer.alloc(32, index).toString('base64url'),
    existingRecords: boundedRecords,
    now: new Date(now.getTime() + index)
  });
  boundedRecords = issued.records;
}
assert.equal(boundedRecords.length, receipts.MAX_ACTIVE_PATRON_STATUS_RECEIPTS);

const server = readFileSync(join(root, 'server.ts'), 'utf8');
const businessStore = readFileSync(join(root, 'src/server/business-store.ts'), 'utf8');
const patronView = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const patronApp = readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8');
const talentApp = readFileSync(join(root, 'src/shells/TalentApp.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

for (const term of [
  'projectPublicRoomState(state)',
  'projectPublicRoomState(roomSnapshot.state)',
  'requireGigMutationAccess(req, requestedGigId)',
  "app.post('/api/patron/request-status'",
  'findMatchingPatronStatusReceipt',
  'projectStoredPatronActionResponse',
  "key === 'patronStatusReceipts' ? undefined : value"
]) {
  assert.equal(server.includes(term), true, `Server privacy boundary missing: ${term}`);
}

assert.equal(server.includes('res.status(durableReplay.status).json(durableReplay.body)'), false);
assert.equal(server.includes('shadowBannedFeedback'), false);
assert.equal(server.includes('patronStatusReceiptHash: normalizedPatronStatusReceipt'), true);
for (const routeMarker of [
  'app.get("/api/state"',
  'app.get("/api/state/:gigId"',
  "app.post('/api/patron/request-status'",
  'app.post("/api/pending-action/reconcile"',
  'app.post("/api/request/create"',
  'app.post("/api/request/boost"'
]) {
  const routeStart = server.indexOf(routeMarker);
  const nextRoute = server.indexOf('\napp.', routeStart + routeMarker.length);
  const routeSource = routeStart >= 0 ? server.slice(routeStart, nextRoute > routeStart ? nextRoute : undefined) : '';
  assert.equal(routeSource.includes('applyNoStoreHeaders(res)'), true, `${routeMarker} must disable response caching.`);
}
assert.equal(businessStore.includes('normalizePatronStatusReceiptRecords(input.patronStatusReceipts)'), true);
assert.equal(patronView.includes('globalThis.crypto.getRandomValues(bytes)'), true);
assert.equal(patronView.includes('const latestRequest = [...requests]'), false);
assert.equal(patronView.includes('patron_status_receipt: checkoutPayload.patronStatusReceipt'), true);
assert.equal(patronApp.includes("postJson('/api/patron/request-status'"), true);
assert.equal(talentApp.includes('/api/state/${selectedGigId}?audience=talent'), true);
assert.equal(packageJson.scripts['test:contracts'].includes('sway-public-room-privacy.contract.test.mjs'), true);

  console.log('Public room privacy contract passed.');
}

main().catch((error) => {
  console.error('Public room privacy contract failed:');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
