import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const root = process.cwd();
const databaseUrl = process.env.DATABASE_URL;
const disposableProofEnabled = process.env.SWAY_DISPOSABLE_MIGRATION_PROOF === '1';

if (!disposableProofEnabled) {
  throw new Error('Set SWAY_DISPOSABLE_MIGRATION_PROOF=1 to acknowledge this disposable migration proof.');
}
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the disposable migration proof.');
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, '');
if (!['127.0.0.1', 'localhost'].includes(parsedDatabaseUrl.hostname)) {
  throw new Error('Disposable migration proof refuses non-local database hosts.');
}
if (!/^sway_pro_mode_migration_proof_[a-z0-9_]+$/i.test(databaseName)) {
  throw new Error('Disposable migration proof requires a database named sway_pro_mode_migration_proof_* .');
}

const ACTIVE_PERFORMER_USER_ID = '11111111-1111-4111-8111-111111111111';
const ONBOARDING_PERFORMER_USER_ID = '22222222-2222-4222-8222-222222222222';
const SUSPENDED_PERFORMER_USER_ID = '33333333-3333-4333-8333-333333333333';
const EXISTING_PATRON_USER_ID = '44444444-4444-4444-8444-444444444444';

function splitStatements(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean);
}

async function applyMigrationFile(client, filename) {
  const sql = readFileSync(join(root, 'drizzle', filename), 'utf8');
  for (const statement of splitStatements(sql)) {
    await client.query(statement);
  }
}

async function expectDatabaseRejection(action, messagePattern, label) {
  await assert.rejects(action, messagePattern, label);
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const existingTables = await client.query(
      `SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'`
    );
    assert.equal(existingTables.rows[0].count, 0, 'Proof database must be fresh; no schema reset is permitted.');

    const previousHeadMigrations = readdirSync(join(root, 'drizzle'))
      .filter((name) => /^\d+_.*\.sql$/.test(name) && name < '0021_')
      .sort();
    assert.equal(previousHeadMigrations.at(-1), '0020_many_silvermane.sql');

    for (const filename of previousHeadMigrations) {
      await applyMigrationFile(client, filename);
    }

    // Pre-existing accounts from before this migration: three performers at
    // different onboarding stages, plus one patron account with no
    // performers row (representing the pre-Phase-2 status quo, where
    // patrons never got a users row created at all -- but if one ever did,
    // it must not be touched by the performer backfill).
    await client.query(
      `INSERT INTO users (id, email, display_name, role) VALUES
        ($1, 'active-performer@example.test', 'Active Performer', 'performer'),
        ($2, 'onboarding-performer@example.test', 'Onboarding Performer', 'performer'),
        ($3, 'suspended-performer@example.test', 'Suspended Performer', 'performer'),
        ($4, 'existing-patron@example.test', 'Existing Patron', 'patron')`,
      [ACTIVE_PERFORMER_USER_ID, ONBOARDING_PERFORMER_USER_ID, SUSPENDED_PERFORMER_USER_ID, EXISTING_PATRON_USER_ID]
    );
    await client.query(
      `INSERT INTO performers (owner_user_id, handle, display_name, is_active, onboarding_status) VALUES
        ($1, 'activeperformer', 'Active Performer', true, 'gig_ready'),
        ($2, 'onboardingperformer', 'Onboarding Performer', false, 'profile_started'),
        ($3, 'suspendedperformer', 'Suspended Performer', false, 'suspended')`,
      [ACTIVE_PERFORMER_USER_ID, ONBOARDING_PERFORMER_USER_ID, SUSPENDED_PERFORMER_USER_ID]
    );

    const beforeMigration = await client.query(
      `SELECT id, role FROM users WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[ACTIVE_PERFORMER_USER_ID, ONBOARDING_PERFORMER_USER_ID, SUSPENDED_PERFORMER_USER_ID, EXISTING_PATRON_USER_ID]]
    );
    assert.equal(beforeMigration.rowCount, 4);

    await applyMigrationFile(client, '0021_pro_mode_universal_account.sql');

    // Every pre-existing performer must be backfilled onto pro_mode_status
    // reflecting their real onboarding state, not silently left at the
    // universal 'disabled' default the new column otherwise applies.
    const backfilled = await client.query(
      `SELECT id, pro_mode_status::text AS pro_mode_status FROM users WHERE id = ANY($1::uuid[])`,
      [[ACTIVE_PERFORMER_USER_ID, ONBOARDING_PERFORMER_USER_ID, SUSPENDED_PERFORMER_USER_ID, EXISTING_PATRON_USER_ID]]
    );
    const byId = Object.fromEntries(backfilled.rows.map((row) => [row.id, row.pro_mode_status]));
    assert.equal(byId[ACTIVE_PERFORMER_USER_ID], 'active', 'gig_ready performer must backfill to active.');
    assert.equal(byId[ONBOARDING_PERFORMER_USER_ID], 'onboarding', 'profile_started performer must backfill to onboarding.');
    assert.equal(byId[SUSPENDED_PERFORMER_USER_ID], 'suspended', 'suspended performer must backfill to suspended.');
    assert.equal(byId[EXISTING_PATRON_USER_ID], 'disabled', 'A patron with no performers row must stay at the universal default.');

    // Every backfilled performer must have a causal audit event -- no silent
    // status changes.
    const backfillEvents = await client.query(
      `SELECT user_id, previous_status, next_status, reason FROM pro_mode_status_events WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`,
      [[ACTIVE_PERFORMER_USER_ID, ONBOARDING_PERFORMER_USER_ID, SUSPENDED_PERFORMER_USER_ID]]
    );
    assert.equal(backfillEvents.rowCount, 3, 'Every backfilled performer account must get exactly one causal audit event.');
    for (const row of backfillEvents.rows) {
      assert.equal(row.previous_status, 'disabled');
      assert.match(row.reason, /backfilled/i);
    }
    const patronEvents = await client.query(
      `SELECT count(*)::int AS count FROM pro_mode_status_events WHERE user_id = $1`,
      [EXISTING_PATRON_USER_ID]
    );
    assert.equal(patronEvents.rows[0].count, 0, 'An untouched patron account must not get a fabricated status event.');

    // A brand-new account created after the migration must default to
    // 'disabled' -- the universal patron starting point.
    const newPatron = await client.query(
      `INSERT INTO users (email, display_name, role) VALUES ('brand-new-patron@example.test', 'Brand New Patron', 'patron')
       RETURNING pro_mode_status::text AS pro_mode_status`
    );
    assert.equal(newPatron.rows[0].pro_mode_status, 'disabled');

    // The append-only trigger must reject UPDATE and DELETE on status events.
    const oneEvent = await client.query(
      `SELECT id FROM pro_mode_status_events WHERE user_id = $1 LIMIT 1`,
      [ACTIVE_PERFORMER_USER_ID]
    );
    await expectDatabaseRejection(
      client.query(`UPDATE pro_mode_status_events SET reason = 'tampered' WHERE id = $1`, [oneEvent.rows[0].id]),
      /append-only/i,
      'Pro Mode status events must be immutable.'
    );
    await expectDatabaseRejection(
      client.query(`DELETE FROM pro_mode_status_events WHERE id = $1`, [oneEvent.rows[0].id]),
      /append-only/i,
      'Pro Mode status events must not be deletable.'
    );

    // The check constraint must reject an invalid status value.
    await expectDatabaseRejection(
      client.query(
        `INSERT INTO pro_mode_status_events (user_id, previous_status, next_status, reason, actor_user_id)
         VALUES ($1, 'onboarding', 'not_a_real_status', 'bad value test', $1)`,
        [ACTIVE_PERFORMER_USER_ID]
      ),
      /pro_mode_status_events_next_status_allowed/i,
      'Invalid pro_mode_status values must be rejected by the check constraint.'
    );

    console.log(JSON.stringify({
      database: databaseName,
      baselineHead: previousHeadMigrations.at(-1),
      migrationApplied: '0021_pro_mode_universal_account.sql',
      backfillResults: byId,
      backfillEventCount: backfillEvents.rowCount,
      newAccountDefault: newPatron.rows[0].pro_mode_status,
      immutable: true,
      checkConstraintEnforced: true
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Pro Mode migration integration proof failed:');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
