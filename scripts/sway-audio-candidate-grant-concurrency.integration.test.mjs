import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from '../src/db/schema.ts';
import { createAudioFileCollaborationService } from '../src/server/audio-file-collaboration-service.ts';
import { createLocalAudioObjectStore } from '../src/server/audio-object-storage-local.ts';
import { createAudioPublishingService } from '../src/server/audio-publishing-service.ts';
import { assertDisposableDatabaseTarget } from './lib/disposable-database-guard.mjs';

const MIB = 1024 * 1024;
const MAX_CANDIDATE_BYTES = 16 * MIB;
const LOCK_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 15_000;
const WAITER_TIMEOUT_MS = 3_000;
const RACE_TIMEOUT_MS = 10_000;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const databaseUrl = process.env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL?.trim();

if (process.env.DATABASE_URL?.trim()) {
  throw new Error(
    'Candidate grant concurrency proof refuses generic DATABASE_URL; use only SWAY_REAL_POSTGRES_PROOF_DATABASE_URL.'
  );
}
if (!databaseUrl) {
  throw new Error(
    'SWAY_REAL_POSTGRES_PROOF_DATABASE_URL is required for the strict real-PostgreSQL candidate grant concurrency proof.'
  );
}
if (process.env.SWAY_ALLOW_DISPOSABLE_DATABASE_RESET !== 'true') {
  throw new Error(
    'SWAY_ALLOW_DISPOSABLE_DATABASE_RESET=true is required for the strict real-PostgreSQL candidate grant concurrency proof.'
  );
}

assertDisposableDatabaseTarget({
  databaseUrl,
  label: 'Audio candidate grant concurrency proof'
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function candidateGrantKeyHash(grantorUserId, idempotencyKey) {
  return sha256(`candidate-grant:${grantorUserId}:${idempotencyKey}`);
}

function candidateGrantScopeHash(grantorUserId, connectionId, versionId) {
  return sha256(`candidate-grant-scope:${grantorUserId}:${connectionId}:${versionId}`);
}

function migrationStatements(filename) {
  return readFileSync(filename, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function attestResetAndMigrate() {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    const attestation = await admin.query(`
      select version() as version,
             current_database() as database_name,
             pg_backend_pid() as backend_pid,
             inet_server_port() as server_port,
             pg_postmaster_start_time() as postmaster_started_at
    `);
    const identity = attestation.rows[0];
    const expectedDatabaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\/+/, ''));
    if (
      !identity
      || !/^PostgreSQL\b/i.test(identity.version)
      || /pglite|electric|wasm/i.test(identity.version)
      || identity.database_name !== expectedDatabaseName
      || !Number.isInteger(identity.backend_pid)
      || identity.backend_pid <= 0
      || !Number.isInteger(identity.server_port)
      || !identity.postmaster_started_at
    ) {
      throw new Error(
        'Candidate grant concurrency proof requires an attested standalone PostgreSQL server, not PGlite or an embedded protocol facade.'
      );
    }

    const independent = new Client({ connectionString: databaseUrl });
    await independent.connect();
    try {
      const secondIdentity = await independent.query('select pg_backend_pid() as backend_pid');
      assert.notEqual(
        secondIdentity.rows[0]?.backend_pid,
        identity.backend_pid,
        'Standalone PostgreSQL attestation must expose independent backend connections.'
      );
    } finally {
      await independent.end();
    }

    await admin.query(`set lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
    await admin.query('CREATE SCHEMA public');

    const migrationDirectory = join(ROOT, 'drizzle');
    const migrationFiles = readdirSync(migrationDirectory)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    assert.ok(migrationFiles.length > 0, 'At least one Drizzle migration is required.');
    for (const filename of migrationFiles) {
      for (const [index, statement] of migrationStatements(join(migrationDirectory, filename)).entries()) {
        try {
          await admin.query(statement);
        } catch (error) {
          throw new Error(`Failed to apply ${filename}, statement ${index + 1}.`, { cause: error });
        }
      }
    }

    return {
      databaseName: identity.database_name,
      migrationCount: migrationFiles.length,
      serverPort: identity.server_port,
      postmasterStartedAt: new Date(identity.postmaster_started_at).toISOString()
    };
  } finally {
    await admin.end();
  }
}

function createProofPool(applicationName) {
  return new Pool({
    connectionString: databaseUrl,
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: LOCK_TIMEOUT_MS,
    options: [
      `-c lock_timeout=${LOCK_TIMEOUT_MS}ms`,
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}ms`,
      `-c idle_in_transaction_session_timeout=${STATEMENT_TIMEOUT_MS}ms`,
      `-c application_name=${applicationName}`
    ].join(' ')
  });
}

function within(promise, label, timeoutMs = RACE_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${timeoutMs}ms; possible lock-order deadlock.`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitForBothAdvisoryWaiters(coordinator, backendPids, label) {
  const deadline = Date.now() + WAITER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const waiting = await coordinator.query(`
      select count(*)::int as count
      from pg_locks
      where locktype = 'advisory'
        and granted = false
        and pid = any($1::integer[])
    `, [backendPids]);
    if (waiting.rows[0]?.count === backendPids.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} did not place both independent PostgreSQL backends behind the advisory-lock barrier.`);
}

async function waitForBothLockWaiters(coordinator, backendPids, label) {
  const deadline = Date.now() + WAITER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const waiting = await coordinator.query(`
      select count(*)::int as count
      from pg_stat_activity
      where pid = any($1::integer[])
        and wait_event_type = 'Lock'
    `, [backendPids]);
    if (waiting.rows[0]?.count === backendPids.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} did not block both independent PostgreSQL backends on the coordinated lock barrier.`);
}

async function raceBehindIdempotencyBarrier({
  grantorUserId,
  idempotencyKey,
  barrierKeyHash,
  backendPids,
  calls,
  label,
  waiterMode = 'advisory'
}) {
  const coordinator = new Client({
    connectionString: databaseUrl,
    options: [
      `-c lock_timeout=${LOCK_TIMEOUT_MS}ms`,
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}ms`,
      `-c idle_in_transaction_session_timeout=${STATEMENT_TIMEOUT_MS}ms`,
      '-c application_name=sway_candidate_grant_barrier'
    ].join(' ')
  });
  const keyHash = barrierKeyHash || candidateGrantKeyHash(grantorUserId, idempotencyKey);
  let transactionOpen = false;
  let pending = [];
  await coordinator.connect();
  try {
    await coordinator.query('begin');
    transactionOpen = true;
    await coordinator.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [keyHash]
    );

    pending = calls.map(async (call) => {
      try {
        return { status: 'fulfilled', value: await call() };
      } catch (reason) {
        return { status: 'rejected', reason };
      }
    });
    if (waiterMode === 'any-lock') {
      await waitForBothLockWaiters(coordinator, backendPids, label);
    } else {
      await waitForBothAdvisoryWaiters(coordinator, backendPids, label);
    }
    await coordinator.query('commit');
    transactionOpen = false;
    return await within(Promise.all(pending), label);
  } catch (error) {
    if (transactionOpen) {
      await coordinator.query('rollback').catch(() => undefined);
      transactionOpen = false;
    }
    if (pending.length > 0) {
      await within(Promise.all(pending), `${label} cleanup`).catch(() => undefined);
    }
    throw error;
  } finally {
    if (transactionOpen) await coordinator.query('rollback').catch(() => undefined);
    await coordinator.end();
  }
}

function errorProperty(error, property) {
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (typeof current === 'object' && property in current) return current[property];
    current = typeof current === 'object' ? current.cause : null;
  }
  return undefined;
}

function errorChainText(error) {
  const messages = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = typeof current === 'object' ? current.cause : null;
  }
  return messages.join(' <- ');
}

function wavFixture(label) {
  const dataSize = 800;
  const body = Buffer.alloc(44 + dataSize, 0x80);
  body.write('RIFF', 0, 'ascii');
  body.writeUInt32LE(body.byteLength - 8, 4);
  body.write('WAVE', 8, 'ascii');
  body.write('fmt ', 12, 'ascii');
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8_000, 24);
  body.writeUInt32LE(8_000, 28);
  body.writeUInt16LE(1, 32);
  body.writeUInt16LE(8, 34);
  body.write('data', 36, 'ascii');
  body.writeUInt32LE(dataSize, 40);
  Buffer.from(label).copy(body, 44, 0, dataSize);
  return body;
}

async function main() {
  const attestation = await attestResetAndMigrate();
  const objectRoot = mkdtempSync(join(tmpdir(), 'sway-candidate-grant-concurrency-'));
  const poolA = createProofPool('sway_candidate_grant_racer_a');
  const poolB = createProofPool('sway_candidate_grant_racer_b');
  const dbA = drizzle(poolA, { schema });
  const dbB = drizzle(poolB, { schema });

  try {
    const store = createLocalAudioObjectStore({
      SWAY_AUDIO_LOCAL_OBJECT_DIR: objectRoot,
      SWAY_AUDIO_LOCAL_BUCKET: 'candidate-grant-concurrency-proof'
    });
    await store.verifyReady();

    const grantorUserId = randomUUID();
    const collaboratorAUserId = randomUUID();
    const collaboratorBUserId = randomUUID();
    await dbA.insert(schema.users).values([
      {
        id: grantorUserId,
        email: `candidate-grantor-${grantorUserId}@example.test`,
        displayName: 'Candidate Grantor',
        emailVerifiedAt: new Date()
      },
      {
        id: collaboratorAUserId,
        email: `candidate-collaborator-a-${collaboratorAUserId}@example.test`,
        displayName: 'Candidate Collaborator A',
        emailVerifiedAt: new Date()
      },
      {
        id: collaboratorBUserId,
        email: `candidate-collaborator-b-${collaboratorBUserId}@example.test`,
        displayName: 'Candidate Collaborator B',
        emailVerifiedAt: new Date()
      }
    ]);

    const [performerA] = await dbA.insert(schema.performers).values({
      ownerUserId: grantorUserId,
      displayName: 'Candidate Source Performer A'
    }).returning();
    const [performerB] = await dbA.insert(schema.performers).values({
      ownerUserId: grantorUserId,
      displayName: 'Candidate Source Performer B'
    }).returning();

    const publishing = createAudioPublishingService({
      db: dbA,
      store,
      workspaceLimitBytes: 64 * MIB,
      workingObjectLimit: 100
    });

    async function createVerifiedSource(performer, label) {
      const project = await publishing.createProject({
        performerId: performer.id,
        actorUserId: grantorUserId,
        title: `${label} project`
      });
      const sourceBody = wavFixture(label);
      const sourceSha256 = sha256(sourceBody);
      const upload = await publishing.initiateUpload({
        projectId: project.id,
        actorUserId: grantorUserId,
        title: `${label}.wav`,
        assetKind: 'master_audio',
        originalFilename: `${label}.wav`,
        mimeType: 'audio/wav',
        expectedByteSize: sourceBody.byteLength,
        expectedSha256: sourceSha256,
        idempotencyKey: `source:${label}:${sourceSha256}`
      });
      await publishing.writeUploadPart({
        uploadSessionId: upload.id,
        actorUserId: grantorUserId,
        partNumber: 1,
        body: sourceBody
      });
      const version = await publishing.completeAndSealUpload({
        uploadSessionId: upload.id,
        actorUserId: grantorUserId,
        performerId: performer.id
      });
      return { performer, project, version };
    }

    const sourceA = await createVerifiedSource(performerA, 'candidate-source-a');
    const sourceB = await createVerifiedSource(performerB, 'candidate-source-b');
    assert.notEqual(sourceA.project.id, sourceB.project.id);
    assert.notEqual(sourceA.version.id, sourceB.version.id);

    for (const source of [sourceA, sourceB]) {
      const capabilityKey = `candidate-concurrency-capability:${source.performer.id}`;
      await dbA.insert(schema.performerCapabilityGrantEvents).values({
        performerId: source.performer.id,
        capability: 'private_collaboration',
        decision: 'granted',
        actorType: 'system',
        actorUserId: null,
        reason: 'Disposable candidate grant concurrency proof',
        evidence: { environment: 'test', source: 'candidate-grant-concurrency' },
        expiresAt: null,
        idempotencyKeyHash: sha256(capabilityKey)
      });
    }

    async function createConnection(collaboratorUserId) {
      const [memberOneUserId, memberTwoUserId] = [grantorUserId, collaboratorUserId].sort();
      const [connection] = await dbA.insert(schema.audioFileConnections).values({
        memberOneUserId,
        memberTwoUserId,
        createdByUserId: grantorUserId,
        createdFromPurpose: 'request_files'
      }).returning();
      return connection;
    }

    const connectionA = await createConnection(collaboratorAUserId);
    const connectionB = await createConnection(collaboratorBUserId);

    const fixtureEvidence = await poolA.query(`
      select
        (select count(*)::int
           from audio_project_asset_versions
          where id = any($1::uuid[])
            and integrity_status = 'verified'
            and mime_type like 'audio/%') as verified_version_count,
        (select count(*)::int
           from audio_project_access_grants
          where project_id = any($2::uuid[])
            and grantee_user_id = $3
            and can_manage_access = true
            and revoked_at is null
            and (expires_at is null or expires_at > clock_timestamp())) as current_manager_count,
        (select count(*)::int
           from audio_file_connections
          where id = any($4::uuid[])
            and revoked_at is null) as active_connection_count
    `, [
      [sourceA.version.id, sourceB.version.id],
      [sourceA.project.id, sourceB.project.id],
      grantorUserId,
      [connectionA.id, connectionB.id]
    ]);
    assert.deepEqual(fixtureEvidence.rows[0], {
      verified_version_count: 2,
      current_manager_count: 2,
      active_connection_count: 2
    });

    const currentCapabilities = await poolA.query(`
      select count(*)::int as count
      from performer_capability_grant_events current_event
      where current_event.performer_id = any($1::uuid[])
        and current_event.capability = 'private_collaboration'
        and current_event.decision = 'granted'
        and (current_event.expires_at is null or current_event.expires_at > clock_timestamp())
        and current_event.event_sequence = (
          select max(latest.event_sequence)
          from performer_capability_grant_events latest
          where latest.performer_id = current_event.performer_id
            and latest.capability = current_event.capability
        )
    `, [[performerA.id, performerB.id]]);
    assert.equal(currentCapabilities.rows[0]?.count, 2, 'Both source performers need current private_collaboration capability.');

    const collaborationA = createAudioFileCollaborationService({
      db: dbA,
      store,
      collaboratorRevisionUploadsEnabled: true
    });
    const collaborationB = createAudioFileCollaborationService({
      db: dbB,
      store,
      collaboratorRevisionUploadsEnabled: true
    });

    const backendA = await poolA.query('select pg_backend_pid() as backend_pid');
    const backendB = await poolB.query('select pg_backend_pid() as backend_pid');
    const backendPids = [backendA.rows[0]?.backend_pid, backendB.rows[0]?.backend_pid];
    assert.ok(backendPids.every((pid) => Number.isInteger(pid) && pid > 0));
    assert.notEqual(backendPids[0], backendPids[1], 'The two service instances must use independent PostgreSQL backends.');

    const intents = [
      {
        connectionId: connectionA.id,
        versionId: sourceA.version.id,
        grantedByUserId: grantorUserId,
        maxCandidateBytes: MAX_CANDIDATE_BYTES,
        expiresInHours: 24
      },
      {
        connectionId: connectionB.id,
        versionId: sourceB.version.id,
        grantedByUserId: grantorUserId,
        maxCandidateBytes: MAX_CANDIDATE_BYTES,
        expiresInHours: 48
      }
    ];

    const conflictingKey = `candidate-grant-conflict-${randomUUID()}`;
    const conflictResults = await raceBehindIdempotencyBarrier({
      grantorUserId,
      idempotencyKey: conflictingKey,
      backendPids,
      label: 'different-intent candidate grant race',
      calls: [
        () => collaborationA.grantCandidateRevisionUpload({ ...intents[0], idempotencyKey: conflictingKey }),
        () => collaborationB.grantCandidateRevisionUpload({ ...intents[1], idempotencyKey: conflictingKey })
      ]
    });
    const conflictFulfilled = conflictResults.filter((result) => result.status === 'fulfilled');
    const conflictRejected = conflictResults.filter((result) => result.status === 'rejected');
    assert.equal(conflictFulfilled.length, 1, 'Exactly one different-intent request must create the grant.');
    assert.equal(conflictRejected.length, 1, 'Exactly one different-intent request must be rejected.');
    assert.equal(conflictFulfilled[0].value.reused, false, 'The winning different-intent request must create a new grant.');
    assert.equal(errorProperty(conflictRejected[0].reason, 'status'), 409);
    assert.equal(errorProperty(conflictRejected[0].reason, 'code'), 'candidate_grant_intent_conflict');
    assert.notEqual(errorProperty(conflictRejected[0].reason, 'code'), '23505');
    assert.doesNotMatch(errorChainText(conflictRejected[0].reason), /duplicate key|unique constraint/i);

    async function rowsForKey(idempotencyKey) {
      return dbA.select({
        id: schema.audioFileAccessGrants.id,
        connectionId: schema.audioFileAccessGrants.connectionId,
        assetVersionId: schema.audioFileAccessGrants.assetVersionId,
        idempotencyKeyHash: schema.audioFileAccessGrants.idempotencyKeyHash
      })
        .from(schema.audioFileAccessGrants)
        .where(and(
          eq(schema.audioFileAccessGrants.grantedByUserId, grantorUserId),
          eq(schema.audioFileAccessGrants.idempotencyKeyHash, candidateGrantKeyHash(grantorUserId, idempotencyKey))
        ));
    }

    const conflictRows = await rowsForKey(conflictingKey);
    assert.equal(conflictRows.length, 1, 'The conflicting grantor/key hash must persist exactly one row.');
    assert.equal(conflictRows[0].id, conflictFulfilled[0].value.grant.id);

    const winningVersionId = conflictFulfilled[0].value.grant.assetVersionId;
    const untouchedIntent = intents.find((intent) => intent.versionId !== winningVersionId);
    assert.ok(untouchedIntent, 'The losing intent must remain available for the exact-intent convergence race.');

    const exactKey = `candidate-grant-exact-${randomUUID()}`;
    const exactResults = await raceBehindIdempotencyBarrier({
      grantorUserId,
      idempotencyKey: exactKey,
      backendPids,
      label: 'exact-intent candidate grant race',
      calls: [
        () => collaborationA.grantCandidateRevisionUpload({ ...untouchedIntent, idempotencyKey: exactKey }),
        () => collaborationB.grantCandidateRevisionUpload({ ...untouchedIntent, idempotencyKey: exactKey })
      ]
    });
    assert.ok(exactResults.every((result) => result.status === 'fulfilled'), 'Both exact-intent requests must succeed.');
    const exactValues = exactResults.map((result) => result.value);
    assert.deepEqual(
      exactValues.map((result) => result.reused).sort(),
      [false, true],
      'The exact-intent race must produce one created grant and one idempotent reuse.'
    );
    assert.equal(exactValues[0].grant.id, exactValues[1].grant.id, 'Both exact-intent calls must converge on one grant.');

    const exactRows = await rowsForKey(exactKey);
    assert.equal(exactRows.length, 1, 'The exact-intent grantor/key hash must persist exactly one row.');
    assert.equal(exactRows[0].id, exactValues[0].grant.id);

    const allCandidateGrants = await dbA.select({ id: schema.audioFileAccessGrants.id })
      .from(schema.audioFileAccessGrants)
      .where(eq(schema.audioFileAccessGrants.grantPurpose, 'collaborator_revision_upload'));
    assert.equal(allCandidateGrants.length, 2, 'The two races must leave exactly two candidate grants, with no duplicate.');

    await dbA.update(schema.audioFileAccessGrants)
      .set({
        revokedAt: new Date(),
        revokedByUserId: grantorUserId,
        revocationReason: 'Reset active candidate scope for different-key contention proof.'
      })
      .where(and(
        eq(schema.audioFileAccessGrants.grantPurpose, 'collaborator_revision_upload'),
        isNull(schema.audioFileAccessGrants.revokedAt)
      ));

    const differentKeyIntent = intents[0];
    const differentKeyScopeHash = candidateGrantScopeHash(
      grantorUserId,
      differentKeyIntent.connectionId,
      differentKeyIntent.versionId
    );
    const exactDifferentKeys = [
      `candidate-grant-different-key-exact-a-${randomUUID()}`,
      `candidate-grant-different-key-exact-b-${randomUUID()}`
    ];
    const exactDifferentKeyResults = await raceBehindIdempotencyBarrier({
      grantorUserId,
      idempotencyKey: exactDifferentKeys[0],
      barrierKeyHash: differentKeyScopeHash,
      backendPids,
      label: 'different-key exact-intent candidate grant race',
      calls: [
        () => collaborationA.grantCandidateRevisionUpload({ ...differentKeyIntent, idempotencyKey: exactDifferentKeys[0] }),
        () => collaborationB.grantCandidateRevisionUpload({ ...differentKeyIntent, idempotencyKey: exactDifferentKeys[1] })
      ]
    });
    const exactDifferentKeyFulfilled = exactDifferentKeyResults.filter((result) => result.status === 'fulfilled');
    const exactDifferentKeyRejected = exactDifferentKeyResults.filter((result) => result.status === 'rejected');
    assert.equal(exactDifferentKeyFulfilled.length, 1);
    assert.equal(exactDifferentKeyRejected.length, 1);
    assert.equal(exactDifferentKeyFulfilled[0].value.reused, false);
    assert.equal(errorProperty(exactDifferentKeyRejected[0].reason, 'status'), 409);
    assert.equal(
      errorProperty(exactDifferentKeyRejected[0].reason, 'code'),
      'active_candidate_grant_idempotency_conflict'
    );
    assert.doesNotMatch(errorChainText(exactDifferentKeyRejected[0].reason), /duplicate key|unique constraint/i);
    const exactDifferentKeyGrantId = exactDifferentKeyFulfilled[0].value.grant.id;

    await dbA.update(schema.audioFileAccessGrants)
      .set({
        revokedAt: new Date(),
        revokedByUserId: grantorUserId,
        revocationReason: 'Reset exact-intent result for conflicting different-key proof.'
      })
      .where(eq(schema.audioFileAccessGrants.id, exactDifferentKeyGrantId));

    const conflictingDifferentKeys = [
      `candidate-grant-different-key-conflict-a-${randomUUID()}`,
      `candidate-grant-different-key-conflict-b-${randomUUID()}`
    ];
    const differentKeyConflictResults = await raceBehindIdempotencyBarrier({
      grantorUserId,
      idempotencyKey: conflictingDifferentKeys[0],
      barrierKeyHash: differentKeyScopeHash,
      backendPids,
      label: 'different-key conflicting-intent candidate grant race',
      calls: [
        () => collaborationA.grantCandidateRevisionUpload({
          ...differentKeyIntent,
          idempotencyKey: conflictingDifferentKeys[0]
        }),
        () => collaborationB.grantCandidateRevisionUpload({
          ...differentKeyIntent,
          maxCandidateBytes: MAX_CANDIDATE_BYTES / 2,
          idempotencyKey: conflictingDifferentKeys[1]
        })
      ]
    });
    const differentKeyConflictFulfilled = differentKeyConflictResults.filter((result) => result.status === 'fulfilled');
    const differentKeyConflictRejected = differentKeyConflictResults.filter((result) => result.status === 'rejected');
    assert.equal(differentKeyConflictFulfilled.length, 1);
    assert.equal(differentKeyConflictRejected.length, 1);
    assert.equal(errorProperty(differentKeyConflictRejected[0].reason, 'status'), 409);
    assert.equal(
      errorProperty(differentKeyConflictRejected[0].reason, 'code'),
      'active_candidate_grant_idempotency_conflict'
    );
    assert.doesNotMatch(errorChainText(differentKeyConflictRejected[0].reason), /duplicate key|unique constraint/i);
    const activeScopeRows = await dbA.select({ id: schema.audioFileAccessGrants.id })
      .from(schema.audioFileAccessGrants)
      .where(and(
        eq(schema.audioFileAccessGrants.connectionId, differentKeyIntent.connectionId),
        eq(schema.audioFileAccessGrants.assetVersionId, differentKeyIntent.versionId),
        eq(schema.audioFileAccessGrants.grantPurpose, 'collaborator_revision_upload'),
        isNull(schema.audioFileAccessGrants.revokedAt)
    ));
    assert.equal(activeScopeRows.length, 1, 'Different-key contention must leave one active tuple row.');

    let candidateProviderBeginCount = 0;
    const candidateStore = {
      ...store,
      async beginUpload(input) {
        candidateProviderBeginCount += 1;
        return store.beginUpload(input);
      }
    };
    const candidatePublishingA = createAudioPublishingService({
      db: dbA,
      store: candidateStore,
      collaboratorRevisionUploadsEnabled: true,
      workspaceLimitBytes: 64 * MIB,
      workingObjectLimit: 100
    });
    const candidatePublishingB = createAudioPublishingService({
      db: dbB,
      store: candidateStore,
      collaboratorRevisionUploadsEnabled: true,
      workspaceLimitBytes: 64 * MIB,
      workingObjectLimit: 100
    });
    const activeCandidateGrant = differentKeyConflictFulfilled[0].value.grant;
    const candidateBody = wavFixture('candidate initiation concurrency');
    const candidateUploadInput = {
      grantId: activeCandidateGrant.id,
      actorUserId: collaboratorAUserId,
      originalFilename: 'candidate-initiation-concurrency.wav',
      mimeType: 'audio/wav',
      expectedByteSize: candidateBody.byteLength,
      expectedSha256: sha256(candidateBody),
      idempotencyKey: `candidate-initiation-concurrency-${randomUUID()}`
    };
    const candidateInitiationResults = await raceBehindIdempotencyBarrier({
      grantorUserId,
      idempotencyKey: candidateUploadInput.idempotencyKey,
      barrierKeyHash: `audio-storage:${sourceA.performer.id}`,
      backendPids,
      label: 'same-key candidate initiation race',
      waiterMode: 'any-lock',
      calls: [
        () => candidatePublishingA.initiateCollaboratorRevisionUpload(candidateUploadInput),
        () => candidatePublishingB.initiateCollaboratorRevisionUpload(candidateUploadInput)
      ]
    });
    assert.ok(
      candidateInitiationResults.every((result) => result.status === 'fulfilled'),
      'Both exact candidate initiation retries must succeed.'
    );
    const candidateSessions = candidateInitiationResults.map((result) => result.value);
    assert.equal(candidateSessions[0].id, candidateSessions[1].id);
    assert.equal(candidateProviderBeginCount, 1, 'Exact candidate initiation retries must begin one provider upload.');
    const durableCandidateSessions = await dbA
      .select({ id: schema.audioUploadSessions.id })
      .from(schema.audioUploadSessions)
      .where(eq(schema.audioUploadSessions.collaboratorFileGrantId, activeCandidateGrant.id));
    assert.deepEqual(durableCandidateSessions, [{ id: candidateSessions[0].id }]);

    console.log(JSON.stringify({
      proof: 'attested standalone PostgreSQL candidate-grant concurrency',
      databaseName: attestation.databaseName,
      migrationCount: attestation.migrationCount,
      serverPort: attestation.serverPort,
      postmasterStartedAt: attestation.postmasterStartedAt,
      independentBackendCount: new Set(backendPids).size,
      differentIntentRace: {
        created: 1,
        deterministicConflict: 'candidate_grant_intent_conflict',
        status: 409,
        rowsForGrantorKeyHash: conflictRows.length,
        rawUniqueViolation: false
      },
      exactIntentRace: {
        created: 1,
        reused: 1,
        rowsForGrantorKeyHash: exactRows.length,
        convergedGrantId: exactValues[0].grant.id
      },
      differentKeyExactIntentRace: {
        created: 1,
        controlledConflict: 'active_candidate_grant_idempotency_conflict',
        status: 409,
        activeScopeRows: 1,
        durableGrantId: exactDifferentKeyGrantId
      },
      differentKeyConflictingIntentRace: {
        created: 1,
        deterministicConflict: 'active_candidate_grant_idempotency_conflict',
        status: 409,
        activeScopeRows: activeScopeRows.length,
        rawUniqueViolation: false
      },
      exactCandidateInitiationRace: {
        successfulResponses: 2,
        providerBeginCount: candidateProviderBeginCount,
        durableSessionCount: durableCandidateSessions.length,
        convergedSessionId: candidateSessions[0].id
      },
      providerOrR2Proof: false,
      fixtureStorage: 'local temporary object store used only to seed verified source versions'
    }, null, 2));
  } finally {
    await Promise.allSettled([poolA.end(), poolB.end()]);
    rmSync(objectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Audio candidate grant concurrency integration proof failed:');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
