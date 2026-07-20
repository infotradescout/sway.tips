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

// All nine performers.onboarding_status values, used to prove the
// deployment-race trigger (0022) maps every one of them explicitly.
const ALL_ONBOARDING_STATUSES = [
  ['created', 'onboarding'],
  ['profile_started', 'onboarding'],
  ['gig_ready', 'active'],
  ['payments_limited', 'active'],
  ['verification_required', 'active'],
  ['verified', 'active'],
  ['payouts_enabled', 'active'],
  ['restricted', 'active'],
  ['suspended', 'suspended']
];

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

    // Pre-existing accounts from before migration 0021: three performers at
    // different onboarding stages, plus one patron account with no
    // performers row.
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
    // reflecting their real onboarding state.
    const backfilled = await client.query(
      `SELECT id, pro_mode_status::text AS pro_mode_status FROM users WHERE id = ANY($1::uuid[])`,
      [[ACTIVE_PERFORMER_USER_ID, ONBOARDING_PERFORMER_USER_ID, SUSPENDED_PERFORMER_USER_ID, EXISTING_PATRON_USER_ID]]
    );
    const byId = Object.fromEntries(backfilled.rows.map((row) => [row.id, row.pro_mode_status]));
    assert.equal(byId[ACTIVE_PERFORMER_USER_ID], 'active', 'gig_ready performer must backfill to active.');
    assert.equal(byId[ONBOARDING_PERFORMER_USER_ID], 'onboarding', 'profile_started performer must backfill to onboarding.');
    assert.equal(byId[SUSPENDED_PERFORMER_USER_ID], 'suspended', 'suspended performer must backfill to suspended.');
    assert.equal(byId[EXISTING_PATRON_USER_ID], 'disabled', 'A patron with no performers row must stay at the universal default.');

    // Onboarding-boundary isolation: the backfill must never touch
    // performers.onboarding_status itself -- only users.pro_mode_status.
    const onboardingStatusesUnchanged = await client.query(
      `SELECT owner_user_id, onboarding_status FROM performers WHERE owner_user_id = ANY($1::uuid[]) ORDER BY owner_user_id`,
      [[ACTIVE_PERFORMER_USER_ID, ONBOARDING_PERFORMER_USER_ID, SUSPENDED_PERFORMER_USER_ID]]
    );
    const onboardingById = Object.fromEntries(onboardingStatusesUnchanged.rows.map((row) => [row.owner_user_id, row.onboarding_status]));
    assert.equal(onboardingById[ACTIVE_PERFORMER_USER_ID], 'gig_ready', 'Backfill must not alter performers.onboarding_status.');
    assert.equal(onboardingById[ONBOARDING_PERFORMER_USER_ID], 'profile_started', 'Backfill must not alter performers.onboarding_status.');
    assert.equal(onboardingById[SUSPENDED_PERFORMER_USER_ID], 'suspended', 'Backfill must not alter performers.onboarding_status.');

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

    // A brand-new account created after 0021 must default to 'disabled'.
    const newPatron = await client.query(
      `INSERT INTO users (email, display_name, role) VALUES ('brand-new-patron@example.test', 'Brand New Patron', 'patron')
       RETURNING pro_mode_status::text AS pro_mode_status`
    );
    assert.equal(newPatron.rows[0].pro_mode_status, 'disabled');

    // ---------- Migration 0022: deletion decoupling + deployment-race trigger ----------
    await applyMigrationFile(client, '0022_pro_mode_deletion_and_deployment_race_hardening.sql');

    // Remediation 1 proof: the FK constraints must be gone, so a real hard
    // DELETE of a users row referenced by a pro_mode_status_events row must
    // succeed instead of raising a foreign-key violation. This is the exact
    // scenario server.ts's signup-rollback path hits when verification-email
    // delivery fails after the account (and its Pro Mode init event) were
    // already created in the same transaction.
    const fkCheck = await client.query(
      `SELECT count(*)::int AS count
       FROM information_schema.table_constraints
       WHERE table_name = 'pro_mode_status_events' AND constraint_type = 'FOREIGN KEY'`
    );
    assert.equal(fkCheck.rows[0].count, 0, 'pro_mode_status_events must have zero foreign keys after 0022.');

    const hardDeleteProbeUser = await client.query(
      `INSERT INTO users (email, display_name, role, pro_mode_status) VALUES ('hard-delete-probe@example.test', 'Hard Delete Probe', 'performer', 'onboarding') RETURNING id`
    );
    const hardDeleteProbeId = hardDeleteProbeUser.rows[0].id;
    await client.query(
      `INSERT INTO pro_mode_status_events (user_id, previous_status, next_status, reason, actor_user_id) VALUES ($1, 'disabled', 'onboarding', 'performer_signup', $1)`,
      [hardDeleteProbeId]
    );
    await client.query(`DELETE FROM users WHERE id = $1`, [hardDeleteProbeId]);
    const survivingEvent = await client.query(
      `SELECT user_id, next_status FROM pro_mode_status_events WHERE user_id = $1`,
      [hardDeleteProbeId]
    );
    assert.equal(survivingEvent.rowCount, 1, 'The Pro Mode event must survive a hard delete of the users row it references.');
    assert.equal(survivingEvent.rows[0].next_status, 'onboarding');

    // Remediation 4 proof: legacy-style performer creation (a pre-cutover app
    // instance that never calls the new Pro Mode application helper) must be
    // protected by the database-level compatibility trigger, for every valid
    // onboarding_status value.
    for (const [onboardingStatus, expectedProModeStatus] of ALL_ONBOARDING_STATUSES) {
      const legacyUser = await client.query(
        `INSERT INTO users (email, display_name, role) VALUES ($1, 'Legacy', 'performer') RETURNING id`,
        [`legacy-${onboardingStatus}@example.test`]
      );
      const legacyUserId = legacyUser.rows[0].id;
      await client.query(
        `INSERT INTO performers (owner_user_id, handle, display_name, onboarding_status) VALUES ($1, $2, 'Legacy Performer', $3)`,
        [legacyUserId, `legacy${onboardingStatus}`, onboardingStatus]
      );
      const legacyResult = await client.query(`SELECT pro_mode_status::text AS pro_mode_status FROM users WHERE id = $1`, [legacyUserId]);
      assert.equal(legacyResult.rows[0].pro_mode_status, expectedProModeStatus, `Legacy performer creation with onboarding_status=${onboardingStatus} must map to pro_mode_status=${expectedProModeStatus}.`);
      const legacyEventCount = await client.query(`SELECT count(*)::int AS count FROM pro_mode_status_events WHERE user_id = $1`, [legacyUserId]);
      assert.equal(legacyEventCount.rows[0].count, 1, `Legacy performer creation with onboarding_status=${onboardingStatus} must write exactly one causal event.`);
    }

    // Remediation 4 proof: the CURRENT application signup path (users row
    // already updated to 'onboarding', with its own event already inserted,
    // before the performers row is inserted in the same transaction) must
    // not be double-initialized by the trigger.
    const currentAppUser = await client.query(
      `INSERT INTO users (email, display_name, role, pro_mode_status) VALUES ('current-app-signup@example.test', 'Current App', 'performer', 'onboarding') RETURNING id`
    );
    const currentAppUserId = currentAppUser.rows[0].id;
    await client.query(
      `INSERT INTO pro_mode_status_events (user_id, previous_status, next_status, reason, actor_user_id) VALUES ($1, 'disabled', 'onboarding', 'performer_signup', $1)`,
      [currentAppUserId]
    );
    await client.query(
      `INSERT INTO performers (owner_user_id, handle, display_name, onboarding_status) VALUES ($1, 'currentappsignup', 'Current App Performer', 'created')`,
      [currentAppUserId]
    );
    const currentAppStatus = await client.query(`SELECT pro_mode_status::text AS pro_mode_status FROM users WHERE id = $1`, [currentAppUserId]);
    assert.equal(currentAppStatus.rows[0].pro_mode_status, 'onboarding', 'The current application signup path must not be overwritten by the legacy-compatibility trigger.');
    const currentAppEventCount = await client.query(`SELECT count(*)::int AS count FROM pro_mode_status_events WHERE user_id = $1`, [currentAppUserId]);
    assert.equal(currentAppEventCount.rows[0].count, 1, 'The current application signup path must not produce a duplicate event when the trigger also fires.');

    // Remediation 4 proof: an already-active/suspended account must not be
    // downgraded by a later performer-record creation.
    const alreadyActiveUser = await client.query(
      `INSERT INTO users (email, display_name, role, pro_mode_status) VALUES ('already-active@example.test', 'Already Active', 'performer', 'active') RETURNING id`
    );
    await client.query(
      `INSERT INTO performers (owner_user_id, handle, display_name, onboarding_status) VALUES ($1, 'alreadyactive', 'Already Active Performer', 'profile_started')`,
      [alreadyActiveUser.rows[0].id]
    );
    const alreadyActiveResult = await client.query(`SELECT pro_mode_status::text AS pro_mode_status FROM users WHERE id = $1`, [alreadyActiveUser.rows[0].id]);
    assert.equal(alreadyActiveResult.rows[0].pro_mode_status, 'active', 'An already-active account must not be downgraded by a new performer record.');

    const alreadySuspendedUser = await client.query(
      `INSERT INTO users (email, display_name, role, pro_mode_status) VALUES ('already-suspended@example.test', 'Already Suspended', 'performer', 'suspended') RETURNING id`
    );
    await client.query(
      `INSERT INTO performers (owner_user_id, handle, display_name, onboarding_status) VALUES ($1, 'alreadysuspended', 'Already Suspended Performer', 'gig_ready')`,
      [alreadySuspendedUser.rows[0].id]
    );
    const alreadySuspendedResult = await client.query(`SELECT pro_mode_status::text AS pro_mode_status FROM users WHERE id = $1`, [alreadySuspendedUser.rows[0].id]);
    assert.equal(alreadySuspendedResult.rows[0].pro_mode_status, 'suspended', 'An already-suspended account must not be reactivated by a new performer record.');

    // Remediation 4 proof: rollback must leave no partial user/performer/event.
    await client.query('BEGIN');
    const rollbackUser = await client.query(
      `INSERT INTO users (email, display_name, role) VALUES ('rollback-probe@example.test', 'Rollback Probe', 'performer') RETURNING id`
    );
    await client.query(
      `INSERT INTO performers (owner_user_id, handle, display_name, onboarding_status) VALUES ($1, 'rollbackprobe', 'Rollback Probe Performer', 'gig_ready')`,
      [rollbackUser.rows[0].id]
    );
    await client.query('ROLLBACK');
    const rollbackUserCheck = await client.query(`SELECT count(*)::int AS count FROM users WHERE email = 'rollback-probe@example.test'`);
    assert.equal(rollbackUserCheck.rows[0].count, 0, 'A rolled-back transaction must leave no partial user row.');
    const rollbackEventCheck = await client.query(`SELECT count(*)::int AS count FROM pro_mode_status_events WHERE user_id = $1`, [rollbackUser.rows[0].id]);
    assert.equal(rollbackEventCheck.rows[0].count, 0, 'A rolled-back transaction must leave no partial Pro Mode event.');

    // Immutability and check constraint remain enforced after 0022.
    const oneEvent = await client.query(`SELECT id FROM pro_mode_status_events WHERE user_id = $1 LIMIT 1`, [ACTIVE_PERFORMER_USER_ID]);
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
      migrationsApplied: ['0021_pro_mode_universal_account.sql', '0022_pro_mode_deletion_and_deployment_race_hardening.sql'],
      backfillResults: byId,
      onboardingStatusUntouchedByBackfill: onboardingById,
      backfillEventCount: backfillEvents.rowCount,
      newAccountDefault: newPatron.rows[0].pro_mode_status,
      foreignKeysAfter0022: fkCheck.rows[0].count,
      hardDeleteEventSurvived: true,
      legacyCreationMappings: Object.fromEntries(ALL_ONBOARDING_STATUSES),
      currentAppSignupNotDoubleInitialized: true,
      noDowngradeOfActiveOrSuspended: true,
      rollbackLeavesNoPartialRows: true,
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
