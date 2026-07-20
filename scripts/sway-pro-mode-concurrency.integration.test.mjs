import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Client } from 'pg';

const root = process.cwd();
const databaseUrl = process.env.DATABASE_URL;
const disposableProofEnabled = process.env.SWAY_DISPOSABLE_MIGRATION_PROOF === '1';

if (!disposableProofEnabled) {
  throw new Error('Set SWAY_DISPOSABLE_MIGRATION_PROOF=1 to acknowledge this disposable concurrency proof.');
}
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the disposable concurrency proof.');
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, '');
if (!['127.0.0.1', 'localhost'].includes(parsedDatabaseUrl.hostname)) {
  throw new Error('Disposable concurrency proof refuses non-local database hosts.');
}
if (!/^sway_pro_mode_concurrency_proof_[a-z0-9_]+$/i.test(databaseName)) {
  throw new Error('Disposable concurrency proof requires a database named sway_pro_mode_concurrency_proof_* .');
}

function splitStatements(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean);
}

async function applyAllMigrations(client) {
  const migrationDir = join(root, 'drizzle');
  const files = readdirSync(migrationDir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  for (const filename of files) {
    const sql = readFileSync(join(migrationDir, filename), 'utf8');
    for (const statement of splitStatements(sql)) {
      await client.query(statement);
    }
  }
}

async function loadProModeModule() {
  const tempDir = join(root, '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const outfile = join(tempDir, 'pro-mode.concurrency-proof.bundle.cjs');
  await build({
    entryPoints: ['src/server/pro-mode.ts'],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    outfile,
    sourcemap: false
  });
  return createRequire(import.meta.url)(outfile);
}

async function loadDbClientModule() {
  const tempDir = join(root, '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const outfile = join(tempDir, 'db-client.concurrency-proof.bundle.cjs');
  await build({
    entryPoints: ['src/db/client.ts'],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    outfile,
    sourcemap: false
  });
  return createRequire(import.meta.url)(outfile);
}

async function main() {
  const setupClient = new Client({ connectionString: databaseUrl });
  await setupClient.connect();

  const existingTables = await setupClient.query(
    `SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'`
  );
  assert.equal(existingTables.rows[0].count, 0, 'Proof database must be fresh; no schema reset is permitted.');

  await applyAllMigrations(setupClient);

  const { createSwayDb } = await loadDbClientModule();
  const { applyProModeTransition } = await loadProModeModule();

  // Two independent connection pools/database handles -- this is not two
  // logical calls sharing one connection, it is two genuinely separate
  // database sessions racing against the same row, matching how two
  // concurrent HTTP requests would each get their own pool connection in the
  // real Express app.
  const dbA = createSwayDb(databaseUrl);
  const dbB = createSwayDb(databaseUrl);

  try {
    const userRow = await setupClient.query(
      `INSERT INTO users (email, display_name, role) VALUES ('concurrency-probe@example.test', 'Concurrency Probe', 'performer') RETURNING id`
    );
    const userId = userRow.rows[0].id;

    // Do NOT await the first call before starting the second -- both
    // transactions must begin before either commits, so the FOR UPDATE row
    // lock actually gets exercised.
    const [resultA, resultB] = await Promise.all([
      applyProModeTransition(dbA, { userId, action: 'self_activate', actorUserId: userId, reason: 'concurrency_probe_a' }),
      applyProModeTransition(dbB, { userId, action: 'self_activate', actorUserId: userId, reason: 'concurrency_probe_b' })
    ]);

    const changedResults = [resultA, resultB].filter((r) => r.allowed === true && r.changed === true);
    const noopResults = [resultA, resultB].filter((r) => r.allowed === true && r.changed === false);
    assert.equal(changedResults.length, 1, 'Exactly one concurrent activation must report changed:true.');
    assert.equal(noopResults.length, 1, 'Exactly one concurrent activation must report changed:false (idempotent no-op).');
    assert.equal(changedResults[0].nextStatus, 'active');
    assert.equal(noopResults[0].nextStatus, 'active');

    const finalUser = await setupClient.query(
      `SELECT pro_mode_status::text AS pro_mode_status, pro_mode_status_changed_at FROM users WHERE id = $1`,
      [userId]
    );
    assert.equal(finalUser.rows[0].pro_mode_status, 'active', 'Final state must be active after the race.');

    const events = await setupClient.query(
      `SELECT previous_status, next_status, reason, created_at FROM pro_mode_status_events WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    );
    assert.equal(events.rowCount, 1, 'Exactly one transition event must exist -- no duplicate from the race.');
    assert.equal(events.rows[0].previous_status, 'disabled');
    assert.equal(events.rows[0].next_status, 'active');

    // The changed-at timestamp must correspond to the one real transition,
    // not be left stale or double-bumped.
    assert.ok(
      Math.abs(new Date(finalUser.rows[0].pro_mode_status_changed_at).getTime() - new Date(events.rows[0].created_at).getTime()) < 2000,
      'pro_mode_status_changed_at must agree with the real transition event timestamp.'
    );

    // Suspended and revoked must remain blocked even under concurrent calls.
    const suspendedUserRow = await setupClient.query(
      `INSERT INTO users (email, display_name, role, pro_mode_status) VALUES ('concurrency-suspended-probe@example.test', 'Concurrency Suspended Probe', 'performer', 'suspended') RETURNING id`
    );
    const suspendedUserId = suspendedUserRow.rows[0].id;
    const [suspendedResultA, suspendedResultB] = await Promise.all([
      applyProModeTransition(dbA, { userId: suspendedUserId, action: 'self_activate', actorUserId: suspendedUserId, reason: 'concurrency_suspended_a' }),
      applyProModeTransition(dbB, { userId: suspendedUserId, action: 'self_activate', actorUserId: suspendedUserId, reason: 'concurrency_suspended_b' })
    ]);
    assert.equal(suspendedResultA.allowed, false, 'A suspended account must remain blocked from self-activation under concurrency.');
    assert.equal(suspendedResultB.allowed, false, 'A suspended account must remain blocked from self-activation under concurrency.');
    const suspendedEvents = await setupClient.query(`SELECT count(*)::int AS count FROM pro_mode_status_events WHERE user_id = $1`, [suspendedUserId]);
    assert.equal(suspendedEvents.rows[0].count, 0, 'A rejected concurrent activation must never write an event.');

    console.log(JSON.stringify({
      database: databaseName,
      concurrentActivation: {
        changedTrueCount: changedResults.length,
        changedFalseCount: noopResults.length,
        finalStatus: finalUser.rows[0].pro_mode_status,
        eventCount: events.rowCount,
        noUncaughtError: true
      },
      concurrentSuspendedRejection: {
        bothRejected: true,
        eventCount: suspendedEvents.rows[0].count
      }
    }, null, 2));
  } finally {
    await setupClient.end();
  }
}

main().catch((error) => {
  console.error('Pro Mode concurrency integration proof failed:');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
