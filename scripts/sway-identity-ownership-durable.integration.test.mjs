import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { Client } from 'pg';

function splitStatements(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean);
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

async function loadFactories() {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const accessOut = join(tempDir, 'access-control.slice8.bundle.cjs');
  const storeOut = join(tempDir, 'business-store.slice8.bundle.cjs');
  const auditOut = join(tempDir, 'audit-log.slice8.bundle.cjs');
  const clientOut = join(tempDir, 'db-client.slice8.bundle.cjs');

  await build({
    entryPoints: ['src/server/access-control.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: accessOut,
    sourcemap: false
  });

  await build({
    entryPoints: ['src/server/business-store.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: storeOut,
    sourcemap: false
  });

  await build({
    entryPoints: ['src/server/audit-log.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: auditOut,
    sourcemap: false
  });

  await build({
    entryPoints: ['src/db/client.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: clientOut,
    sourcemap: false
  });

  const require = createRequire(import.meta.url);
  const accessModule = require(accessOut);
  const storeModule = require(storeOut);
  const auditModule = require(auditOut);
  const clientModule = require(clientOut);

  return {
    createAccessControl: accessModule.createAccessControl,
    createBusinessStore: storeModule.createBusinessStore,
    writeAuditEvent: auditModule.writeAuditEvent,
    createSwayDb: clientModule.createSwayDb
  };
}

function makeReq(actorId) {
  const headers = {
    'x-sway-session-id': 'sess-test',
    'x-sway-device-id-hash': 'device-test'
  };
  if (actorId) {
    headers['x-sway-actor-id'] = actorId;
  }
  return { headers };
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
    totals: {
      totalTips: 0,
      accumulatedFees: 0,
      totalCount: 0,
      topRequest: 'None yet'
    }
  };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for identity/ownership durability integration test.');
  }

  const adminClient = new Client({ connectionString: databaseUrl });
  await adminClient.connect();
  try {
    await resetDatabase(adminClient);
    await applyMigrations(adminClient);

    await adminClient.query(`
      INSERT INTO users (id, email, display_name, role)
      VALUES
        ('11111111-1111-4111-8111-111111111111', 'performer-a@sway.local', 'Performer A', 'performer'),
        ('22222222-2222-4222-8222-222222222222', 'performer-b@sway.local', 'Performer B', 'performer'),
        ('33333333-3333-4333-8333-333333333333', 'patron@sway.local', 'Patron', 'patron'),
        ('44444444-4444-4444-8444-444444444444', 'support@sway.local', 'Support', 'support')
    `);

    await adminClient.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name, bio)
       VALUES ('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', 'performer-a', 'Performer A', NULL)`
    );
  } finally {
    await adminClient.end();
  }

  const { createAccessControl, createBusinessStore, writeAuditEvent, createSwayDb } = await loadFactories();

  const store = createBusinessStore(databaseUrl, createInactiveSession);
  const gigId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const initialState = {
    session: {
      ...createInactiveSession(),
      status: 'active',
      ownerActorUserId: '11111111-1111-4111-8111-111111111111',
      lastMutationActorUserId: '11111111-1111-4111-8111-111111111111',
      talentName: 'Performer A'
    },
    requests: [
      {
        id: 'req-identity-1',
        type: 'request',
        targetType: 'music',
        title: 'Authorization Song',
        subtitle: 'Artist',
        senderName: 'Patron',
        message: 'hello',
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
        clientRequestId: 'client-identity-1',
        idempotencyKey: 'idem-identity-1',
        idempotencyFingerprint: 'fp-identity-1',
        idempotencyExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        patronDeviceIdHash: 'device-identity-1',
        gigId,
        payloadHash: 'payload',
        amountCents: 1000,
        currency: 'USD',
        boosts: [
          {
            id: 'boost-identity-1',
            patronName: 'Patron',
            amount: 3,
            actorUserId: '33333333-3333-4333-8333-333333333333',
            timestamp: new Date().toISOString()
          }
        ]
      }
    ],
    performers: []
  };

  await store.persistState({ state: initialState, activeGigId: gigId });

  const accessA = createAccessControl({ databaseUrl, isProduction: true });

  const missingActorResult = await accessA.requireTalentAccess(makeReq(null));
  assert.equal(missingActorResult.allowed, false, 'Missing actor must be rejected for protected talent routes.');

  const patronTalentResult = await accessA.requireTalentAccess(makeReq('33333333-3333-4333-8333-333333333333'));
  assert.equal(patronTalentResult.allowed, false, 'Patron actors must be rejected for protected talent routes.');

  const ownerBootstrapResult = await accessA.requireTalentAccess(makeReq('11111111-1111-4111-8111-111111111111'));
  assert.equal(ownerBootstrapResult.allowed, true, 'Performer owner must be allowed to bootstrap session start without membership/grant rows.');

  const performerAResult = await accessA.requireGigMutationAccess(makeReq('11111111-1111-4111-8111-111111111111'), gigId);
  assert.equal(performerAResult.allowed, true, 'Performer A should be authorized for own gig mutations.');

  const performerBResult = await accessA.requireGigMutationAccess(makeReq('22222222-2222-4222-8222-222222222222'), gigId);
  assert.equal(performerBResult.allowed, false, 'Performer B must be rejected for Performer A gig mutations.');

  const patronResult = await accessA.requireGigMutationAccess(makeReq('33333333-3333-4333-8333-333333333333'), gigId);
  assert.equal(patronResult.allowed, false, 'Patron actors must not escalate into gig mutation authority.');

  const supportResult = await accessA.requireGigMutationAccess(makeReq('44444444-4444-4444-8444-444444444444'), gigId);
  assert.equal(supportResult.allowed, true, 'Support role should have privileged moderation/mutation access.');

  // Fresh instance durability proof for authorization and ownership.
  const accessB = createAccessControl({ databaseUrl, isProduction: true });
  const performerAReinit = await accessB.requireGigMutationAccess(makeReq('11111111-1111-4111-8111-111111111111'), gigId);
  const performerBReinit = await accessB.requireGigMutationAccess(makeReq('22222222-2222-4222-8222-222222222222'), gigId);
  assert.equal(performerAReinit.allowed, true, 'Performer A must remain authorized after fresh service instance.');
  assert.equal(performerBReinit.allowed, false, 'Performer B must remain rejected after fresh service instance.');

  const verifyClient = new Client({ connectionString: databaseUrl });
  await verifyClient.connect();
  try {
    const db = createSwayDb(databaseUrl);

    const previousStatus = 'approved';
    const nextStatus = 'fulfilled';
    await db.transaction(async (tx) => {
      await store.persistState({
        state: {
          ...initialState,
          session: {
            ...initialState.session,
            lastMutationActorUserId: '11111111-1111-4111-8111-111111111111'
          },
          requests: initialState.requests.map((request) => ({
            ...request,
            status: request.id === 'req-identity-1' ? 'fulfilled' : request.status,
            lastMutationActorUserId: '11111111-1111-4111-8111-111111111111'
          }))
        },
        activeGigId: gigId
      }, { executor: tx });

      await writeAuditEvent(tx, {
        actorId: '11111111-1111-4111-8111-111111111111',
        actorType: 'performer',
        entityType: 'request',
        entityId: 'req-identity-1',
        eventType: 'request.fulfill',
        previousStatus,
        nextStatus,
        metadata: {
          requestId: 'req-identity-1',
          gigId
        }
      });
    });

    const gigRow = await verifyClient.query(
      'SELECT owner_actor_user_id, last_mutation_actor_user_id FROM gig_sessions WHERE id = $1',
      [gigId]
    );
    assert.equal(gigRow.rows.length, 1, 'Expected persisted gig session row.');
    assert.equal(gigRow.rows[0].owner_actor_user_id, '11111111-1111-4111-8111-111111111111');

    const requestRows = await verifyClient.query(
      'SELECT patron_user_id, last_mutation_actor_user_id FROM requests WHERE gig_id = $1',
      [gigId]
    );
    assert.equal(requestRows.rows.length, 1, 'Expected persisted request row.');
    assert.equal(requestRows.rows[0].patron_user_id, '33333333-3333-4333-8333-333333333333');
    assert.equal(requestRows.rows[0].last_mutation_actor_user_id, '11111111-1111-4111-8111-111111111111');

    const boostRows = await verifyClient.query(
      'SELECT patron_user_id, actor_user_id FROM request_boosts WHERE gig_id = $1',
      [gigId]
    );
    assert.equal(boostRows.rows.length, 1, 'Expected persisted boost row.');
    assert.equal(boostRows.rows[0].patron_user_id, '33333333-3333-4333-8333-333333333333');
    assert.equal(boostRows.rows[0].actor_user_id, '33333333-3333-4333-8333-333333333333');

    const auditRows = await verifyClient.query(
      'SELECT actor_id, actor_type, entity_type, event_type, previous_status, next_status FROM audit_events WHERE event_type = $1 ORDER BY created_at DESC LIMIT 1',
      ['request.fulfill']
    );
    assert.equal(auditRows.rows.length, 1, 'Expected durable audit_events row for protected mutation.');
    assert.equal(auditRows.rows[0].actor_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(auditRows.rows[0].actor_type, 'performer');
    assert.equal(auditRows.rows[0].entity_type, 'request');
    assert.equal(auditRows.rows[0].event_type, 'request.fulfill');
    assert.equal(auditRows.rows[0].previous_status, 'approved');
    assert.equal(auditRows.rows[0].next_status, 'fulfilled');
  } finally {
    await verifyClient.end();
  }

  console.log('Identity ownership durable authorization integration test passed.');
}

main().catch((error) => {
  console.error('Identity ownership durable authorization integration test failed:');
  console.error(error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
