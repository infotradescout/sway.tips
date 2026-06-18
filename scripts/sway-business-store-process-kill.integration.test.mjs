import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

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
    operatingMode: 'manual',
    requestPresets: [
      { id: 'p-sys-15', label: 'Speed Round', duration: 15, isSystem: true },
      { id: 'p-sys-30', label: 'Mid-Gig Rush', duration: 30, isSystem: true },
      { id: 'p-sys-45', label: 'Main Stage Vibe', duration: 45, isSystem: true }
    ],
    totals: {
      totalTips: 0,
      accumulatedFees: 0,
      totalCount: 0,
      topRequest: 'None yet'
    }
  };
}

function splitStatements(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean);
}

function createFallbackState() {
  return {
    session: createInactiveSession(),
    requests: [],
    performers: []
  };
}

async function resetDatabase(client) {
  await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
  await client.query('CREATE SCHEMA public;');
}

async function applyMigrations(client) {
  const migrationDir = join(process.cwd(), 'drizzle');
  const migrationFiles = readdirSync(migrationDir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();

  if (!migrationFiles.length) {
    throw new Error('No drizzle SQL migrations found.');
  }

  for (const filename of migrationFiles) {
    const sql = readFileSync(join(migrationDir, filename), 'utf8');
    for (const statement of splitStatements(sql)) {
      await client.query(statement);
    }
  }
}

async function loadBusinessStoreFactory() {
  const tempDir = join(process.cwd(), '.tmp');
  const outfile = join(tempDir, 'business-store.integration.bundle.cjs');
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
  const loaded = require(outfile);
  return loaded.createBusinessStore;
}

function clone(input) {
  return JSON.parse(JSON.stringify(input));
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for business-store process-kill integration test.');
  }

  const adminClient = new Client({ connectionString: databaseUrl });
  await adminClient.connect();
  try {
    await resetDatabase(adminClient);
    await applyMigrations(adminClient);
  } finally {
    await adminClient.end();
  }

  const createBusinessStore = await loadBusinessStoreFactory();

  const firstStore = createBusinessStore(databaseUrl, createInactiveSession);
  const activeGigId = randomUUID();

  const preCrashState = createFallbackState();
  preCrashState.session = {
    ...createInactiveSession(),
    status: 'active',
    talentName: 'DJ Durable',
    talentRole: 'DJ',
    feeType: 'patron',
    minimumTip: 7,
    isFeatured: true,
    featuredDurationHours: 2,
    featuredCost: 20,
    featuredExpiresAt: '2026-06-06T23:00:00.000Z',
    requestsOpen: true,
    requestWindowMode: 'preset',
    requestWindowDuration: 30,
    requestWindowLabel: 'Mid-Gig Rush',
    requestWindowExpiresAt: '2026-06-06T22:00:00.000Z',
    requestPresets: [
      { id: 'p-sys-15', label: 'Speed Round', duration: 15, isSystem: true },
      { id: 'custom-1', label: 'Late Night', duration: 45, isSystem: false }
    ],
    totals: {
      totalTips: 31,
      accumulatedFees: 5,
      totalCount: 1,
      topRequest: 'Song A'
    }
  };

  preCrashState.requests = [
    {
      id: 'req-a',
      type: 'request',
      targetType: 'music',
      title: 'Song A',
      subtitle: 'Artist A',
      senderName: 'Patron A',
      message: 'Please play this',
      amount: 15,
      holdAmount: 15,
      platformFee: 2,
      sponsorCount: 2,
      status: 'fulfilled',
      shadowBanned: false,
      hidden: false,
      removed: false,
      createdAt: '2026-06-06T20:00:00.000Z',
      clientRequestId: 'client-a',
      idempotencyKey: 'idem-a',
      idempotencyFingerprint: 'fp-a',
      idempotencyExpiresAt: '2026-06-08T20:00:00.000Z',
      patronDeviceIdHash: 'device-a',
      gigId: activeGigId,
      payloadHash: 'payload-a',
      amountCents: 1500,
      currency: 'USD',
      boosts: [
        {
          id: 'boost-a1',
          patronName: 'Booster 1',
          amount: 5,
          timestamp: '2026-06-06T20:05:00.000Z',
          clientRequestId: 'boost-client-a1',
          idempotencyKey: 'boost-idem-a1',
          idempotencyFingerprint: 'boost-fp-a1',
          idempotencyExpiresAt: '2026-06-08T20:05:00.000Z'
        }
      ]
    },
    {
      id: 'req-b',
      type: 'request',
      targetType: 'music',
      title: 'Song B',
      subtitle: 'Artist B',
      senderName: 'Patron B',
      message: 'Try this one',
      amount: 8,
      holdAmount: 8,
      platformFee: 1,
      sponsorCount: 1,
      status: 'approved',
      shadowBanned: false,
      hidden: false,
      removed: false,
      createdAt: '2026-06-06T20:10:00.000Z',
      clientRequestId: 'client-b',
      idempotencyKey: 'idem-b',
      idempotencyFingerprint: 'fp-b',
      idempotencyExpiresAt: '2026-06-08T20:10:00.000Z',
      patronDeviceIdHash: 'device-b',
      gigId: activeGigId,
      payloadHash: 'payload-b',
      amountCents: 800,
      currency: 'USD',
      boosts: []
    },
    {
      id: 'req-c',
      type: 'request',
      targetType: 'music',
      title: 'Song C',
      subtitle: 'Artist C',
      senderName: 'Patron C',
      message: 'Moderated hidden',
      amount: 4,
      holdAmount: 4,
      platformFee: 1,
      sponsorCount: 1,
      status: 'hold',
      shadowBanned: true,
      hidden: true,
      removed: false,
      createdAt: '2026-06-06T20:12:00.000Z',
      clientRequestId: 'client-c',
      idempotencyKey: 'idem-c',
      idempotencyFingerprint: 'fp-c',
      idempotencyExpiresAt: '2026-06-08T20:12:00.000Z',
      patronDeviceIdHash: 'device-c',
      gigId: activeGigId,
      payloadHash: 'payload-c',
      amountCents: 400,
      currency: 'USD',
      boosts: []
    },
    {
      id: 'req-d',
      type: 'request',
      targetType: 'music',
      title: 'Song D',
      subtitle: 'Artist D',
      senderName: 'Patron D',
      message: 'Moderated removed',
      amount: 4,
      holdAmount: 4,
      platformFee: 1,
      sponsorCount: 1,
      status: 'denied',
      shadowBanned: false,
      hidden: false,
      removed: true,
      createdAt: '2026-06-06T20:13:00.000Z',
      clientRequestId: 'client-d',
      idempotencyKey: 'idem-d',
      idempotencyFingerprint: 'fp-d',
      idempotencyExpiresAt: '2026-06-08T20:13:00.000Z',
      patronDeviceIdHash: 'device-d',
      gigId: activeGigId,
      payloadHash: 'payload-d',
      amountCents: 400,
      currency: 'USD',
      boosts: []
    }
  ];

  preCrashState.requests = preCrashState.requests.map((request) => ({
    actorUserId: null,
    lastMutationActorUserId: null,
    paymentId: null,
    paymentIntentId: null,
    paymentStatus: null,
    ...request,
    boosts: request.boosts.map((boost) => ({
      actorUserId: null,
      paymentId: null,
      paymentIntentId: null,
      paymentStatus: null,
      ...boost
    }))
  }));

  // Simulate session closeout lifecycle after triage/fulfill/hide/remove effects already applied.
  preCrashState.session.status = 'ending';
  preCrashState.session.endGigTimerStartedAt = '2026-06-06T21:55:00.000Z';
  preCrashState.session.requestsOpen = false;
  preCrashState.session.requestWindowMode = 'manual';
  preCrashState.session.requestWindowDuration = null;
  preCrashState.session.requestWindowLabel = null;
  preCrashState.session.requestWindowExpiresAt = null;

  await firstStore.persistState({ state: preCrashState, activeGigId });

  // Process-kill simulation: new store instance, same DATABASE_URL.
  const secondStore = createBusinessStore(databaseUrl, createInactiveSession);
  const postCrash = await secondStore.hydrateState(createFallbackState());

  assert.equal(postCrash.activeGigId, activeGigId, 'Active gig ID should survive process restart.');

  const normalizedPre = clone(preCrashState);
  const normalizedPost = clone(postCrash.state);

  normalizedPre.requests.sort((a, b) => a.id.localeCompare(b.id));
  normalizedPost.requests.sort((a, b) => a.id.localeCompare(b.id));

  for (const request of normalizedPre.requests) {
    request.boosts.sort((a, b) => a.id.localeCompare(b.id));
  }

  for (const request of normalizedPost.requests) {
    request.boosts.sort((a, b) => a.id.localeCompare(b.id));
  }

  assert.deepEqual(
    normalizedPost.session,
    normalizedPre.session,
    'Session state should match pre-crash snapshot after store reinitialization.'
  );

  assert.deepEqual(
    normalizedPost.requests,
    normalizedPre.requests,
    'Requests, boosts, statuses, and moderation effects should survive store reinitialization.'
  );

  console.log('Business store process-kill integration test passed.');
}

main().catch((error) => {
  console.error('Business store process-kill integration test failed:');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
