import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';
import { createBusinessStore } from '../src/server/business-store.ts';

// This owns a newly created in-memory database. It never resets an existing
// schema, accepts an external target, or changes the destructive-proof guard.
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
assert.notEqual(process.env.NODE_ENV, 'production');
assert.notEqual(process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF, 'true');
const configuredTargets = Object.keys(process.env).filter(name => /DATABASE_URL$/.test(name) && process.env[name]?.trim());
assert.deepEqual(configuredTargets, [], 'The registry proof must create its own database, never use an inherited one.');
for (const name of [
  'SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED',
  'SWAY_NATIVE_TICKETS_ENABLED',
  'SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED',
  'SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED',
  'SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED'
]) assert.equal(process.env[name], 'false', `${name} must remain disabled.`);
const configuredSecrets = Object.keys(process.env).filter(name => (
  /^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SWAY_EMAIL_API_KEY)$/.test(name)
  || /PAYPAL.*(?:SECRET|TOKEN)$/.test(name)
) && process.env[name]?.trim());
assert.deepEqual(configuredSecrets, [], 'Provider credentials do not belong in the registry proof.');

function createInactiveSession() {
  return {
    status: 'inactive',
    ownerActorUserId: null,
    lastMutationActorUserId: null,
    talentName: '',
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
    searchScope: 'library',
    paymentsEnabled: false,
    totals: { totalTips: 0, accumulatedFees: 0, totalCount: 0, topRequest: 'None yet' }
  };
}

const ownerId = '11111111-1111-4111-8111-111111111111';
const patronId = '33333333-3333-4333-8333-333333333333';
function createRoomState(gigId, talentName) {
  return {
    session: { ...createInactiveSession(), status: 'active', ownerActorUserId: ownerId, lastMutationActorUserId: ownerId, talentName },
    requests: [{
      id: `req-${talentName.toLowerCase().replace(/\s+/g, '-')}`,
      type: 'request', targetType: 'music', title: `${talentName} Anthem`, subtitle: `${talentName} Artist`,
      senderName: `${talentName} Patron`, message: '', amount: 0, holdAmount: 0, platformFee: 0,
      sponsorCount: 1, status: 'approved', shadowBanned: false, hidden: false, removed: false,
      actorUserId: patronId, lastMutationActorUserId: ownerId, createdAt: new Date().toISOString(),
      clientRequestId: `client-${gigId}`, idempotencyKey: `idem-${gigId}`, idempotencyFingerprint: `fp-${gigId}`,
      idempotencyExpiresAt: new Date(Date.now() + 3600_000).toISOString(), patronDeviceIdHash: `device-${gigId}`,
      gigId, payloadHash: `payload-${gigId}`, amountCents: 0, currency: 'USD', boosts: []
    }],
    performers: [], activeGigId: gigId
  };
}
const emptyState = () => ({ session: createInactiveSession(), requests: [], performers: [], activeGigId: null });

const proof = await startEmbeddedPostgresProof('active_room_registry_owned');
try {
  assert.equal(proof.kind, 'embedded-postgres');
  const target = new URL(proof.databaseUrl);
  assert.equal(target.hostname, '127.0.0.1');
  assert.match(target.pathname, /^\/sway_embedded_disposable_test_/);
  assert.equal(target.search, '');
  assert.equal(target.hash, '');
  await proof.query(`
    INSERT INTO users (id, email, display_name, role)
    VALUES ($1, 'registry-owner@example.test', 'Registry Owner', 'performer'),
           ($2, 'registry-patron@example.test', 'Registry Patron', 'patron')
  `, [ownerId, patronId]);
  const store = createBusinessStore(proof.databaseUrl, createInactiveSession);
  const gigIds = [randomUUID(), randomUUID(), randomUUID()];
  const roomStates = gigIds.map((id, index) => createRoomState(id, ['DJ Atlas', 'DJ Nova', 'DJ Sol'][index]));
  for (let index = 0; index < gigIds.length; index += 1) {
    await store.persistState({ state: roomStates[index], activeGigId: gigIds[index] });
  }
  const tracked = await store.listTrackedGigIds();
  assert.deepEqual(new Set(tracked), new Set(gigIds), 'All three active rooms must stay distinct.');
  const savedStates = [];
  for (let index = 0; index < gigIds.length; index += 1) {
    const snapshot = await store.hydrateStateByGigId(gigIds[index], emptyState());
    assert.equal(snapshot.roomStatus, 'active');
    assert.equal(snapshot.activeGigId, gigIds[index]);
    assert.equal(snapshot.state.session.talentName, roomStates[index].session.talentName);
    assert.equal(snapshot.state.requests.length, 1);
    assert.equal(snapshot.state.requests[0].gigId, gigIds[index]);
    assert.equal(snapshot.state.requests[0].title, roomStates[index].requests[0].title);
    savedStates.push(structuredClone(snapshot.state));
  }
  const legacy = await store.hydrateState(createRoomState(gigIds[0], 'Fallback Legacy'));
  assert.equal(legacy.roomStatus, 'legacy_safe_empty');
  assert.equal(legacy.activeGigId, null);
  assert.equal(legacy.state.requests.length, 0, 'An unscoped read must not leak any room queue.');
  const missing = await store.hydrateStateByGigId(randomUUID(), emptyState());
  assert.equal(missing.roomStatus, 'missing');

  const closedState = structuredClone(savedStates[2]);
  closedState.session.status = 'closed';
  closedState.session.requestsOpen = false;
  await store.persistState({ state: closedState, activeGigId: gigIds[2] });
  const closed = await store.hydrateStateByGigId(gigIds[2], emptyState());
  assert.equal(closed.roomStatus, 'ended');
  assert.equal(closed.activeGigId, null, 'The store must not advertise a closed room as active.');
  assert.equal(closed.state.session.status, 'closed');
  assert.equal(closed.state.session.talentName, roomStates[2].session.talentName);
  assert.deepEqual(closed.state.requests, savedStates[2].requests, 'Closing must preserve the original saved request history.');

  // Read again through a newly constructed store instead of relying on the
  // writer's state. The separate real-server lifecycle test also restarts Node.
  const restoredStore = createBusinessStore(proof.databaseUrl, createInactiveSession);
  const restored = await restoredStore.hydrateStateByGigId(gigIds[2], emptyState());
  assert.equal(restored.roomStatus, 'ended');
  assert.equal(restored.activeGigId, null);
  assert.deepEqual(restored.state.requests, closed.state.requests);
  for (const [index, id] of gigIds.slice(0, 2).entries()) {
    const active = await restoredStore.hydrateStateByGigId(id, emptyState());
    assert.equal(active.roomStatus, 'active');
    assert.equal(active.activeGigId, id);
    assert.equal(active.state.session.talentName, roomStates[index].session.talentName);
    assert.deepEqual(active.state.requests, savedStates[index].requests);
  }
  console.log('ACTIVE_ROOM_REGISTRY_OWNED_DATABASE_PASS Three independent rooms, safe unscoped lookup, missing-room rejection and retained closed history verified against a fresh owned database.');
} finally {
  await proof.close();
}
