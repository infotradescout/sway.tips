import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const failures = [];

const schemaSource = readFileSync(join(root, 'src/db/schema.ts'), 'utf8');
const storeSource = readFileSync(join(root, 'src/server/business-store.ts'), 'utf8');
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
const overlaySource = readFileSync(join(root, 'src/shells/OverlayApp.tsx'), 'utf8');
const patronSource = readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(message);
}

requireIncludes(schemaSource, 'export const activeRoomRegistry', 'Schema must define an isolated active room registry table.');
requireIncludes(schemaSource, "registryStatus: text('registry_status')", 'Schema must persist room registry status.');
requireIncludes(schemaSource, "routePath: text('route_path')", 'Schema must persist the room route path.');

for (const term of [
  'hydrateStateByGigId',
  'listTrackedGigIds',
  'restoreSnapshotForGig',
  'activeRoomRegistry',
  'legacy_safe_empty'
]) {
  requireIncludes(storeSource, term, `Business store missing active room registry term: ${term}`);
}

for (const term of [
  'await businessStore.hydrateStateByGigId(gigId, createEmptyBackendState())',
  'const roomSnapshot = await loadRoomState(requestedGigId);',
  'const roomContext = await findRoomStateByRequestId(requestId);'
]) {
  requireIncludes(serverSource, term, `Server missing room-registry isolation term: ${term}`);
}

for (const forbidden of [
  'QRCode',
  'qr-code',
  'qrcode',
  'client_secret',
  'payment_method',
  'stripe-signature'
]) {
  if (schemaSource.includes(forbidden)) {
    failures.push(`Room registry schema must not expand into forbidden scope: ${forbidden}`);
  }
}

requireIncludes(overlaySource, "statePath: routeGigId ? `/api/state/${routeGigId}` : null", 'Overlay compatibility must stay gig-scoped.');
requireIncludes(patronSource, 'const statePath = routeGigId ? `/api/state/${routeGigId}` : null;', 'Patron room truth must stay gig-scoped.');

requireIncludes(
  packageJson.scripts?.['test:contracts'] ?? '',
  'node scripts/sway-active-room-registry.contract.test.mjs',
  'test:contracts must include the active room registry contract.'
);

function splitStatements(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean);
}

async function runDatabaseProof() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log('Active room registry contract database proof skipped: DATABASE_URL not set.');
    return;
  }

  const { Client } = await import('pg');
  const { build } = await import('esbuild');

  async function resetDatabase(client) {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
    await client.query('CREATE SCHEMA public;');
  }

  async function applyMigrations(client) {
    const migrationDir = join(root, 'drizzle');
    const migrationFiles = readdirSync(migrationDir)
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort();

    for (const filename of migrationFiles) {
      const sql = readFileSync(join(migrationDir, filename), 'utf8');
      for (const statement of splitStatements(sql)) {
        await client.query(statement);
      }
    }
  }

  async function loadBusinessStoreFactory() {
    const tempDir = join(root, '.tmp');
    const outfile = join(tempDir, 'active-room-registry.contract.bundle.cjs');
    mkdirSync(tempDir, { recursive: true });

    await build({
      entryPoints: ['src/server/business-store.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      sourcemap: false
    });

    const require = createRequire(import.meta.url);
    return require(outfile).createBusinessStore;
  }

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
      totals: {
        totalTips: 0,
        accumulatedFees: 0,
        totalCount: 0,
        topRequest: 'None yet'
      }
    };
  }

  function createRoomState(gigId, talentName) {
    return {
      session: {
        ...createInactiveSession(),
        status: 'active',
        ownerActorUserId: '11111111-1111-4111-8111-111111111111',
        lastMutationActorUserId: '11111111-1111-4111-8111-111111111111',
        talentName,
        minimumTip: 7
      },
      requests: [
        {
          id: `req-${talentName.toLowerCase().replace(/\s+/g, '-')}`,
          type: 'request',
          targetType: 'music',
          title: `${talentName} Anthem`,
          subtitle: `${talentName} Artist`,
          senderName: `${talentName} Patron`,
          message: '',
          amount: 10,
          holdAmount: 10,
          platformFee: 1,
          sponsorCount: 1,
          status: 'approved',
          shadowBanned: false,
          hidden: false,
          removed: false,
          actorUserId: '33333333-3333-4333-8333-333333333333',
          lastMutationActorUserId: '11111111-1111-4111-8111-111111111111',
          createdAt: new Date().toISOString(),
          clientRequestId: `client-${gigId}`,
          idempotencyKey: `idem-${gigId}`,
          idempotencyFingerprint: `fp-${gigId}`,
          idempotencyExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          patronDeviceIdHash: `device-${gigId}`,
          gigId,
          payloadHash: `payload-${gigId}`,
          amountCents: 1000,
          currency: 'USD',
          boosts: []
        }
      ],
      performers: [],
      activeGigId: gigId
    };
  }

  const adminClient = new Client({ connectionString: databaseUrl });
  await adminClient.connect();
  try {
    await resetDatabase(adminClient);
    await applyMigrations(adminClient);

    await adminClient.query(`
      INSERT INTO users (id, email, display_name, role)
      VALUES
        ('11111111-1111-4111-8111-111111111111', 'performer@sway.local', 'Performer', 'performer'),
        ('33333333-3333-4333-8333-333333333333', 'patron@sway.local', 'Patron', 'patron')
    `);
  } finally {
    await adminClient.end();
  }

  const createBusinessStore = await loadBusinessStoreFactory();
  const store = createBusinessStore(databaseUrl, createInactiveSession);

  const gigIds = [randomUUID(), randomUUID(), randomUUID()];
  const roomStates = [
    createRoomState(gigIds[0], 'DJ Atlas'),
    createRoomState(gigIds[1], 'DJ Nova'),
    createRoomState(gigIds[2], 'DJ Sol')
  ];

  for (let index = 0; index < roomStates.length; index += 1) {
    await store.persistState({ state: roomStates[index], activeGigId: gigIds[index] });
  }

  const trackedGigIds = await store.listTrackedGigIds();
  assert.equal(new Set(trackedGigIds).size, 3, 'Three concurrent active rooms must remain distinct in the registry.');

  for (let index = 0; index < gigIds.length; index += 1) {
    const snapshot = await store.hydrateStateByGigId(gigIds[index], createRoomState(gigIds[index], `Fallback ${index}`));
    assert.equal(snapshot.roomStatus, 'active', 'Each active room must hydrate as active.');
    assert.equal(snapshot.activeGigId, gigIds[index], 'Each hydrated room must retain its own gigId.');
    assert.equal(snapshot.state.session.talentName, roomStates[index].session.talentName, 'Each room must retain its own session state.');
    assert.equal(snapshot.state.requests[0].gigId, gigIds[index], 'Each room must retain its own request state.');
    assert.notEqual(snapshot.state.session.talentName, roomStates[(index + 1) % roomStates.length].session.talentName, 'A room lookup must never return another room state.');
  }

  const safeLegacy = await store.hydrateState(createRoomState(gigIds[0], 'Fallback Legacy'));
  assert.equal(safeLegacy.roomStatus, 'legacy_safe_empty', 'Legacy unparameterized fallback must fail safe when multiple active rooms exist.');
  assert.equal(safeLegacy.activeGigId, null, 'Legacy unparameterized fallback must not expose another active room.');
  assert.equal(safeLegacy.state.requests.length, 0, 'Legacy unparameterized fallback must not leak another room queue.');

  const missingRoom = await store.hydrateStateByGigId(randomUUID(), {
    session: createInactiveSession(),
    requests: [],
    performers: [],
    activeGigId: null
  });
  assert.equal(missingRoom.roomStatus, 'missing', 'Invalid room IDs must fail closed.');

  const endedRoomState = createRoomState(gigIds[2], 'DJ Sol');
  endedRoomState.session.status = 'closed';
  endedRoomState.session.requestsOpen = false;
  await store.persistState({ state: endedRoomState, activeGigId: gigIds[2] });

  const endedSnapshot = await store.hydrateStateByGigId(gigIds[2], {
    session: createInactiveSession(),
    requests: [],
    performers: [],
    activeGigId: null
  });
  assert.equal(endedSnapshot.roomStatus, 'ended', 'Ended room behavior must remain preserved.');
  assert.equal(endedSnapshot.activeGigId, null, 'Ended rooms must not remain active in route context.');
}

if (failures.length) {
  console.error('Active room registry contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

runDatabaseProof()
  .then(() => {
    console.log('Active room registry contract passed.');
  })
  .catch((error) => {
    console.error('Active room registry contract failed:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
