import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { closeDisposableSwayDbProof } from '../src/db/client.ts';
import { createModerationService } from '../src/server/moderation-service.ts';
import { createPerformerSessionStore } from '../src/server/performer-session-store.ts';
import { assertDisposableDatabaseTarget } from './lib/disposable-database-guard.mjs';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const PORT = 39000 + (process.pid % 1000);
const BASE = `http://127.0.0.1:${PORT}`;

function getConfiguredDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) return null;
  return assertDisposableDatabaseTarget({
    databaseUrl: value,
    label: 'Moderation active-blocks integration test'
  });
}

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

async function applyMigrations(client, options = {}) {
  const migrationDir = join(process.cwd(), 'drizzle');
  const migrationFiles = readdirSync(migrationDir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .filter((name) => !options.after || name > options.after)
    .filter((name) => !options.through || name <= options.through)
    .sort();

  if (migrationFiles.length === 0) {
    throw new Error('No drizzle SQL migrations found.');
  }

  for (const filename of migrationFiles) {
    const sql = readFileSync(join(migrationDir, filename), 'utf8');
    const statements = splitStatements(sql);
    for (const statement of statements) {
      await client.query(statement);
    }
  }
}

async function proveUpgradeFromLegacyDuplicateRows(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await resetDatabase(client);
    await applyMigrations(client, { through: '0034_boring_sebastian_shaw.sql' });
    await client.query(`
      INSERT INTO active_blocks (scope, normalized_value, reason, status, revoked_at)
      VALUES
        ('sender_name', 'legacy duplicate', 'Legacy active row', 'active', NULL),
        ('sender_name', 'legacy duplicate', 'Legacy revoked row', 'revoked', NOW())
    `);
    await applyMigrations(client, {
      after: '0034_boring_sebastian_shaw.sql',
      through: '0035_active-block-lifecycle.sql'
    });
    const upgraded = await client.query(`
      SELECT status, count(*)::int AS count
      FROM active_blocks
      WHERE scope = 'sender_name' AND normalized_value = 'legacy duplicate'
      GROUP BY status
      ORDER BY status
    `);
    assert.deepEqual(
      upgraded.rows,
      [{ status: 'active', count: 1 }, { status: 'revoked', count: 1 }],
      'Rolling upgrade must preserve legacy active and revoked rows without a uniqueness failure.'
    );
    await client.query(`
      INSERT INTO active_blocks (scope, normalized_value, reason, status, revoked_at)
      VALUES ('sender_name', 'legacy compatibility write', 'Old writer compatibility', 'active', NULL)
      ON CONFLICT (scope, normalized_value, status)
      DO UPDATE SET reason = EXCLUDED.reason, updated_at = NOW()
    `);
  } finally {
    await client.end();
  }
}

function spawnServer(databaseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: String(PORT),
        APP_URL: BASE,
        SWAY_APP_BASE_URL: BASE,
        NODE_ENV: 'test',
        DISABLE_HMR: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Moderation proof server exited before readiness (code ${code}):\n${output}`));
    });

    const startedAt = Date.now();
    const readinessPoll = setInterval(async () => {
      try {
        const response = await fetch(`${BASE}/api/build-marker`);
        if (response.ok && !settled) {
          clearInterval(readinessPoll);
          settled = true;
          resolve(child);
          return;
        }
      } catch {
        // Server is still starting.
      }

      if (Date.now() - startedAt > 60_000 && !settled) {
        clearInterval(readinessPoll);
        settled = true;
        child.kill();
        reject(new Error(`Moderation proof server did not become ready:\n${output}`));
      }
    }, 250);
  });
}

async function stopServer(child) {
  if (!child) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 3_000);
  });
}

async function main() {
  const configuredDatabaseUrl = getConfiguredDatabaseUrl();
  const embeddedProof = configuredDatabaseUrl
    ? null
    : await startEmbeddedPostgresProof('moderation_active_blocks');
  const databaseUrl = configuredDatabaseUrl || embeddedProof?.databaseUrl;
  if (!databaseUrl) throw new Error('A disposable moderation database is required.');

  let server = null;

  try {
    await proveUpgradeFromLegacyDuplicateRows(databaseUrl);
    if (!embeddedProof) {
      const adminClient = new Client({ connectionString: databaseUrl });
      await adminClient.connect();
      try {
        await resetDatabase(adminClient);
        await applyMigrations(adminClient);
      } finally {
        await adminClient.end();
      }
    }

    const firstService = createModerationService(databaseUrl);
    await firstService.addBlockRule({
      scope: 'patron_device_id_hash',
      value: 'device-live-999',
      reason: 'Integration durability proof'
    });

    const secondService = createModerationService(databaseUrl);
    const outcome = await secondService.evaluateSubmission({
      senderName: 'Any Sender',
      text: 'safe message',
      patronDeviceIdHash: 'device-live-999'
    });

    assert.equal(
      outcome.decision,
      'block_submission',
      'Expected block_submission after service reinitialization when active block exists in Postgres.'
    );

    const revocationClient = new Client({ connectionString: databaseUrl });
    await revocationClient.connect();
    try {
      const revocation = await revocationClient.query(
        `UPDATE active_blocks
         SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
         WHERE scope = $1
           AND normalized_value = $2
           AND status = 'active'
         RETURNING id`,
        ['patron_device_id_hash', 'device-live-999']
      );
      assert.equal(revocation.rowCount, 1, 'Expected the active block to be durably revoked once.');

      const repeatedRevocation = await revocationClient.query(
        `UPDATE active_blocks
         SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
         WHERE scope = $1
           AND normalized_value = $2
           AND status = 'active'
         RETURNING id`,
        ['patron_device_id_hash', 'device-live-999']
      );
      assert.equal(repeatedRevocation.rowCount, 0, 'Expected repeated revocation to be an idempotent no-op.');
    } finally {
      await revocationClient.end();
    }

    const postRevocationService = createModerationService(databaseUrl);
    const allowedAfterRevocation = await postRevocationService.evaluateSubmission({
      senderName: 'Any Sender',
      text: 'safe message',
      patronDeviceIdHash: 'device-live-999'
    });
    assert.equal(
      allowedAfterRevocation.decision,
      'allow_with_local_filter',
      'Expected the same identity to be allowed after durable block revocation.'
    );

    await postRevocationService.addBlockRule({
      scope: 'patron_device_id_hash',
      value: 'device-live-999',
      reason: 'Integration reactivation proof'
    });
    const reactivatedService = createModerationService(databaseUrl);
    const blockedAfterReactivation = await reactivatedService.evaluateSubmission({
      senderName: 'Any Sender',
      text: 'safe message',
      patronDeviceIdHash: 'device-live-999'
    });
    assert.equal(
      blockedAfterReactivation.decision,
      'block_submission',
      'Expected a revoked block row to be safely reusable for a later active block.'
    );

    const identityClient = new Client({ connectionString: databaseUrl });
    await identityClient.connect();
    let adminUserId;
    let patronUserId;
    let supportUserId;
    try {
      const adminInsert = await identityClient.query(
        `INSERT INTO users (email, display_name, role, email_verified_at, terms_accepted_at)
         VALUES ('moderation-admin@example.test', 'Moderation Admin', 'admin', NOW(), NOW())
         RETURNING id`
      );
      const patronInsert = await identityClient.query(
        `INSERT INTO users (email, display_name, role, email_verified_at, terms_accepted_at)
         VALUES ('moderation-patron@example.test', 'Moderation Patron', 'patron', NOW(), NOW())
         RETURNING id`
      );
      const supportInsert = await identityClient.query(
        `INSERT INTO users (email, display_name, role, email_verified_at, terms_accepted_at)
         VALUES ('moderation-support@example.test', 'Moderation Support', 'support', NOW(), NOW())
         RETURNING id`
      );
      adminUserId = adminInsert.rows[0].id;
      patronUserId = patronInsert.rows[0].id;
      supportUserId = supportInsert.rows[0].id;
    } finally {
      await identityClient.end();
    }

    const sessionStore = createPerformerSessionStore({ databaseUrl });
    const adminSession = await sessionStore.issueSession({ actorUserId: adminUserId, issuedBy: adminUserId });
    const patronSession = await sessionStore.issueSession({ actorUserId: patronUserId, issuedBy: patronUserId });
    const supportSession = await sessionStore.issueSession({ actorUserId: supportUserId, issuedBy: supportUserId });
    const adminCookie = `${sessionStore.cookieName}=${encodeURIComponent(adminSession.token)}`;
    const patronCookie = `${sessionStore.cookieName}=${encodeURIComponent(patronSession.token)}`;
    const supportCookie = `${sessionStore.cookieName}=${encodeURIComponent(supportSession.token)}`;
    const blockBody = {
      scope: 'patron_user_id',
      value: patronUserId,
      reason: 'Disposable HTTP enforcement proof',
      idempotency_key: 'moderation-block-http-proof-v1'
    };

    server = await spawnServer(databaseUrl);

    const queryProofDatabase = async (sql, values = []) => {
      if (embeddedProof) return embeddedProof.query(sql, values);
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        return await client.query(sql, values);
      } finally {
        await client.end();
      }
    };
    const evidenceBeforeDeniedCalls = await queryProofDatabase(
      `SELECT
         (SELECT count(*)::int FROM active_blocks) AS blocks,
         (SELECT count(*)::int FROM moderation_events) AS moderation_events,
         (SELECT count(*)::int FROM audit_events WHERE entity_type = 'moderation_block') AS audit_events`
    );

    const anonymousBlock = await fetch(`${BASE}/api/moderation/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(blockBody)
    });
    assert.equal(anonymousBlock.status, 401, 'Anonymous callers must not activate moderation blocks.');

    const forgedHeadersBlock = await fetch(`${BASE}/api/moderation/block`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sway-actor-hydrated': '1',
        'x-sway-resolved-actor-id': adminUserId,
        'x-sway-resolved-session-id': adminSession.sessionId
      },
      body: JSON.stringify(blockBody)
    });
    assert.equal(forgedHeadersBlock.status, 401, 'Forged resolved-actor headers must not authorize moderation mutations.');

    const patronBlock = await fetch(`${BASE}/api/moderation/block`, {
      method: 'POST',
      headers: { cookie: patronCookie, 'content-type': 'application/json' },
      body: JSON.stringify(blockBody)
    });
    assert.equal(patronBlock.status, 403, 'Patron accounts must not activate moderation blocks.');

    const supportBlock = await fetch(`${BASE}/api/moderation/block`, {
      method: 'POST',
      headers: { cookie: supportCookie, 'content-type': 'application/json' },
      body: JSON.stringify(blockBody)
    });
    assert.equal(supportBlock.status, 403, 'Support accounts must not bypass the admin-only block policy.');

    const malformedInputs = [
      { ...blockBody, value: 'not-a-uuid', idempotency_key: 'invalid-target' },
      { ...blockBody, value: { patron: patronUserId }, idempotency_key: 'object-target' },
      { ...blockBody, reason: '   ', idempotency_key: 'blank-reason' },
      { ...blockBody, reason: 'x'.repeat(501), idempotency_key: 'long-reason' },
      { ...blockBody, idempotency_key: '' }
    ];
    for (const invalidBody of malformedInputs) {
      const invalidResponse = await fetch(`${BASE}/api/moderation/block`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify(invalidBody)
      });
      assert.equal(invalidResponse.status, 400, 'Malformed moderation targets and reasons must fail without mutation.');
    }

    const evidenceAfterDeniedCalls = await queryProofDatabase(
      `SELECT
         (SELECT count(*)::int FROM active_blocks) AS blocks,
         (SELECT count(*)::int FROM moderation_events) AS moderation_events,
         (SELECT count(*)::int FROM audit_events WHERE entity_type = 'moderation_block') AS audit_events`
    );
    assert.deepEqual(
      evidenceAfterDeniedCalls.rows[0],
      evidenceBeforeDeniedCalls.rows[0],
      'Denied and malformed moderation calls must create zero durable evidence.'
    );

    const adminBlock = await fetch(`${BASE}/api/moderation/block`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify(blockBody)
    });
    const adminBlockBody = await adminBlock.json();
    assert.equal(adminBlock.status, 200, `Admin block failed: ${JSON.stringify(adminBlockBody)}`);
    assert.deepEqual(adminBlockBody, { success: true, moderation_action: 'block_added', changed: true });

    await stopServer(server);
    server = await spawnServer(databaseUrl);

    const adminBlockReplay = await fetch(`${BASE}/api/moderation/block`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify(blockBody)
    });
    assert.equal(adminBlockReplay.status, 200);
    assert.deepEqual(await adminBlockReplay.json(), adminBlockBody);

    const blockMisuse = await fetch(`${BASE}/api/moderation/block`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...blockBody, reason: 'Changed intent with reused key' })
    });
    assert.equal(blockMisuse.status, 409, 'Changed moderation intent with a reused key must fail closed.');

    const blockedViaHttpService = await createModerationService(databaseUrl).evaluateSubmission({
      senderName: 'Safe Patron',
      text: 'benign request',
      patronUserId
    });
    assert.equal(blockedViaHttpService.decision, 'block_submission', 'HTTP activation must enforce from durable state.');

    const anonymousRevoke = await fetch(`${BASE}/api/moderation/block/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...blockBody, reason: 'Anonymous rollback attempt' })
    });
    assert.equal(anonymousRevoke.status, 401, 'Anonymous callers must not revoke moderation blocks.');

    const patronRevoke = await fetch(`${BASE}/api/moderation/block/revoke`, {
      method: 'POST',
      headers: { cookie: patronCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...blockBody, reason: 'Patron rollback attempt' })
    });
    assert.equal(patronRevoke.status, 403, 'Patron accounts must not revoke moderation blocks.');

    const adminRevoke = await fetch(`${BASE}/api/moderation/block/revoke`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...blockBody, reason: 'Disposable HTTP cleanup', idempotency_key: 'moderation-revoke-http-proof-v1' })
    });
    const adminRevokeBody = await adminRevoke.json();
    assert.equal(adminRevoke.status, 200);
    assert.deepEqual(adminRevokeBody, { success: true, moderation_action: 'block_revoked', changed: true });

    const adminRevokeReplay = await fetch(`${BASE}/api/moderation/block/revoke`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...blockBody, reason: 'Disposable HTTP cleanup', idempotency_key: 'moderation-revoke-http-proof-v1' })
    });
    assert.equal(adminRevokeReplay.status, 200);
    assert.deepEqual(await adminRevokeReplay.json(), adminRevokeBody);

    const repeatedRevoke = await fetch(`${BASE}/api/moderation/block/revoke`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...blockBody, reason: 'Disposable repeated cleanup', idempotency_key: 'moderation-revoke-http-proof-v2' })
    });
    const repeatedRevokeBody = await repeatedRevoke.json();
    assert.equal(repeatedRevoke.status, 200);
    assert.deepEqual(repeatedRevokeBody, { success: true, moderation_action: 'block_already_inactive', changed: false });

    const allowedViaHttpService = await createModerationService(databaseUrl).evaluateSubmission({
      senderName: 'Safe Patron',
      text: 'benign request',
      patronUserId
    });
    assert.equal(allowedViaHttpService.decision, 'allow_with_local_filter', 'HTTP revocation must stop durable enforcement.');

    const adminReactivate = await fetch(`${BASE}/api/moderation/block`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...blockBody, reason: 'Disposable HTTP reactivation', idempotency_key: 'moderation-block-http-proof-v2' })
    });
    const adminReactivateBody = await adminReactivate.json();
    assert.equal(adminReactivate.status, 200);
    assert.deepEqual(adminReactivateBody, { success: true, moderation_action: 'block_reactivated', changed: true });

    const blockedAfterHttpReactivation = await createModerationService(databaseUrl).evaluateSubmission({
      senderName: 'Safe Patron',
      text: 'benign request',
      patronUserId
    });
    assert.equal(blockedAfterHttpReactivation.decision, 'block_submission', 'HTTP reactivation must restore durable enforcement.');

    const finalCleanup = await fetch(`${BASE}/api/moderation/block/revoke`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...blockBody, reason: 'Disposable final cleanup', idempotency_key: 'moderation-revoke-http-proof-v3' })
    });
    assert.equal(finalCleanup.status, 200);
    assert.deepEqual(await finalCleanup.json(), { success: true, moderation_action: 'block_revoked', changed: true });

    const evidenceClient = new Client({ connectionString: databaseUrl });
    await evidenceClient.connect();
    try {
      const activeRows = await evidenceClient.query(
        `SELECT count(*)::int AS count
         FROM active_blocks
         WHERE scope = 'patron_user_id' AND normalized_value = $1 AND status = 'active' AND revoked_at IS NULL`,
        [patronUserId.toLowerCase()]
      );
      assert.equal(activeRows.rows[0].count, 0, 'Cleanup must leave zero enforceable proof blocks.');

      const lifecycleEvents = await evidenceClient.query(
        `SELECT status, metadata->>'source' AS source
         FROM moderation_events
         WHERE actor_user_id = $1 AND entity_type = 'block_rule'
         ORDER BY created_at`,
        [adminUserId]
      );
      assert.ok(lifecycleEvents.rows.some((row) => row.status === 'blocked' && row.source === 'moderation.block'));
      assert.ok(lifecycleEvents.rows.some((row) => row.status === 'blocked' && row.source === 'moderation.block.reactivate'));
      assert.ok(lifecycleEvents.rows.some((row) => row.status === 'allowed' && row.source === 'moderation.block.revoke'));
      assert.equal(
        lifecycleEvents.rows.filter((row) => row.status === 'blocked' && row.source === 'moderation.block').length,
        1,
        'Idempotent block replay must not duplicate moderation evidence.'
      );
      assert.equal(
        lifecycleEvents.rows.filter((row) => row.status === 'blocked' && row.source === 'moderation.block.reactivate').length,
        1,
        'Reactivation must emit one distinct moderation event.'
      );
      assert.equal(
        lifecycleEvents.rows.filter((row) => row.status === 'allowed' && row.source === 'moderation.block.revoke').length,
        2,
        'Each real revoke must emit once while idempotent and inactive replays stay silent.'
      );

      const auditEvents = await evidenceClient.query(
        `SELECT event_type, previous_status, next_status
         FROM audit_events
         WHERE actor_id = $1 AND entity_type = 'moderation_block'
         ORDER BY created_at`,
        [adminUserId]
      );
      assert.ok(auditEvents.rows.some((row) => row.event_type === 'moderation.block' && row.next_status === 'blocked'));
      assert.ok(auditEvents.rows.some((row) => row.event_type === 'moderation.block.reactivate' && row.previous_status === 'revoked' && row.next_status === 'blocked'));
      assert.ok(auditEvents.rows.some((row) => row.event_type === 'moderation.block.revoke' && row.previous_status === 'blocked' && row.next_status === 'revoked'));
      assert.equal(auditEvents.rows.filter((row) => row.event_type === 'moderation.block').length, 1);
      assert.equal(auditEvents.rows.filter((row) => row.event_type === 'moderation.block.reactivate').length, 1);
      assert.equal(auditEvents.rows.filter((row) => row.event_type === 'moderation.block.revoke').length, 2);
    } finally {
      await evidenceClient.end();
    }

    console.log(`Moderation active_blocks block/revoke/reactivate PostgreSQL integration test passed (${embeddedProof?.kind ?? 'configured-disposable-postgres'}).`);
  } finally {
    await stopServer(server);
    if (embeddedProof) {
      await embeddedProof.close();
    } else {
      await closeDisposableSwayDbProof(databaseUrl);
    }
  }
}

main().catch((error) => {
  console.error('Moderation active_blocks Postgres integration test failed:');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
