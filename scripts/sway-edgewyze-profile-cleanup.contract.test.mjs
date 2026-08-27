import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

function failHard(error) {
  console.error(error);
  process.exit(1);
}

process.once('uncaughtException', failHard);
process.once('unhandledRejection', failHard);

const root = process.cwd();
const migrationDirectory = join(root, 'drizzle');
const targetMigration = '0038_edgewyze_profile_cleanup.sql';
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const targetIndex = migrationFiles.indexOf(targetMigration);

assert.notEqual(targetIndex, -1, `${targetMigration} must exist.`);
assert.equal(targetIndex, migrationFiles.length - 1, 'The EdgeWyze cleanup must be the latest migration.');

const migrationSql = readFileSync(join(migrationDirectory, targetMigration), 'utf8');
assert.match(migrationSql, /lower\(handle\) = 'platynum-47'/i);
assert.match(migrationSql, /handle = 'edgewyze'/i);
assert.match(migrationSql, /display_name = 'EdgeWyze'/);
assert.match(migrationSql, /performer_identity\.correct/);
assert.equal(migrationSql.includes('@'), false, 'A private account email must not be committed in the migration.');
assert.doesNotMatch(
  migrationSql,
  /update\s+(payments|payouts|stripe_connect_onboarding_operations|event_ticket_orders)/i,
  'The identity cleanup must not mutate money ledgers or payment state.'
);

function statementsFor(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigration(database, migrationFile) {
  const sql = readFileSync(join(migrationDirectory, migrationFile), 'utf8');
  for (const statement of statementsFor(sql)) {
    await database.exec(statement);
  }
}

const database = new PGlite();

try {
  for (const migrationFile of migrationFiles.slice(0, targetIndex)) {
    await applyMigration(database, migrationFile);
  }

  await database.exec(`
    insert into users (
      id, email, display_name, role, pro_mode_status, email_verified_at
    ) values (
      '10000000-0000-0000-0000-000000000001',
      'edgewyze-owner@example.test',
      'Sway Admin',
      'admin',
      'active',
      now()
    );

    insert into performers (
      id, owner_user_id, handle, display_name, bio, is_active, visibility_state,
      onboarding_status, payment_account_status, kyc_status, payouts_enabled,
      charges_enabled, stripe_connected_account_id, lifetime_gross_volume,
      payout_hold_reason, verification_required_at_amount
    ) values (
      '10000000-0000-0000-0000-000000000010',
      '10000000-0000-0000-0000-000000000001',
      'Platynum-47',
      'Thomas Robertson',
      'I am a passive fan of alot of things',
      true,
      'public',
      'gig_ready',
      'created',
      'required',
      false,
      true,
      'acct_edgewyze_fixture',
      1234,
      'fixture hold',
      23456
    );

    insert into performer_public_profiles (
      performer_id, headline, specialties, city, avatar_url, website_url, metadata
    ) values (
      '10000000-0000-0000-0000-000000000010',
      'I like chicken nuggets',
      '["Stuff and things"]'::jsonb,
      'Keep City',
      'https://example.test/avatar.png',
      'https://example.test',
      '{"primaryRole":"creator","stageName":"EdgeWyze"}'::jsonb
    );

    insert into music_releases (
      id, performer_id, title, primary_artist_name, release_type
    ) values (
      '10000000-0000-0000-0000-000000000020',
      '10000000-0000-0000-0000-000000000010',
      'Preserved draft',
      'EdgeWyze',
      'single'
    );
  `);

  const beforeMoney = await database.query(`
    select payment_account_status, kyc_status, payouts_enabled, charges_enabled,
           stripe_connected_account_id, lifetime_gross_volume, payout_hold_reason,
           verification_required_at_amount
      from performers
     where id = '10000000-0000-0000-0000-000000000010';
  `);

  await applyMigration(database, targetMigration);

  const corrected = await database.query(`
    select u.email, u.display_name as account_display_name, u.role, u.pro_mode_status,
           p.id::text as performer_id, p.handle, p.display_name, p.bio,
           p.visibility_state, p.onboarding_status,
           pp.headline, pp.specialties, pp.city, pp.avatar_url, pp.website_url, pp.metadata
      from users u
      join performers p on p.owner_user_id = u.id
      join performer_public_profiles pp on pp.performer_id = p.id
     where p.id = '10000000-0000-0000-0000-000000000010';
  `);
  assert.equal(corrected.rows.length, 1);
  assert.deepEqual(corrected.rows[0], {
    email: 'edgewyze-owner@example.test',
    account_display_name: 'EdgeWyze',
    role: 'admin',
    pro_mode_status: 'active',
    performer_id: '10000000-0000-0000-0000-000000000010',
    handle: 'edgewyze',
    display_name: 'EdgeWyze',
    bio: 'EdgeWyze pairs human-written lyrics with an original virtual voice and generative music production.',
    visibility_state: 'public',
    onboarding_status: 'gig_ready',
    headline: 'Human-written lyrics. Original virtual artist.',
    specialties: ['Songwriting', 'Original music', 'Virtual performance'],
    city: 'Keep City',
    avatar_url: 'https://example.test/avatar.png',
    website_url: 'https://example.test',
    metadata: { primaryRole: 'creator', stageName: 'EdgeWyze' }
  });

  const afterMoney = await database.query(`
    select payment_account_status, kyc_status, payouts_enabled, charges_enabled,
           stripe_connected_account_id, lifetime_gross_volume, payout_hold_reason,
           verification_required_at_amount
      from performers
     where id = '10000000-0000-0000-0000-000000000010';
  `);
  assert.deepEqual(afterMoney.rows, beforeMoney.rows, 'All performer money fields must remain byte-for-byte equivalent.');

  const preservedRelease = await database.query(`
    select performer_id::text, title, primary_artist_name, status
      from music_releases
     where id = '10000000-0000-0000-0000-000000000020';
  `);
  assert.deepEqual(preservedRelease.rows, [{
    performer_id: '10000000-0000-0000-0000-000000000010',
    title: 'Preserved draft',
    primary_artist_name: 'EdgeWyze',
    status: 'draft'
  }]);

  const audit = await database.query(`
    select actor_type, actor_id::text, entity_type, entity_id::text, event_type,
           previous_status, next_status, metadata
      from audit_events
     where event_type = 'performer_identity.correct';
  `);
  assert.deepEqual(audit.rows, [{
    actor_type: 'account_owner_authorized_system',
    actor_id: '10000000-0000-0000-0000-000000000001',
    entity_type: 'performer',
    entity_id: '10000000-0000-0000-0000-000000000010',
    event_type: 'performer_identity.correct',
    previous_status: 'Platynum-47',
    next_status: 'edgewyze',
    metadata: {
      operation: 'edgewyze_profile_cleanup',
      accountDisplayName: 'EdgeWyze',
      performerDisplayName: 'EdgeWyze',
      moneyFieldsChanged: false,
      accessFieldsChanged: false
    }
  }]);

  await applyMigration(database, targetMigration);
  const auditAfterReplay = await database.query(`
    select count(*)::integer as count
      from audit_events
     where event_type = 'performer_identity.correct';
  `);
  assert.deepEqual(auditAfterReplay.rows, [{ count: 1 }], 'A replay must be a no-op.');

  await database.exec(`
    insert into users (id, email, display_name) values (
      '20000000-0000-0000-0000-000000000001',
      'conflict-owner@example.test',
      'Conflict Owner'
    );
    insert into performers (id, owner_user_id, handle, display_name) values (
      '20000000-0000-0000-0000-000000000010',
      '20000000-0000-0000-0000-000000000001',
      'Platynum-47',
      'Must Stay Unchanged'
    );
  `);

  await assert.rejects(
    applyMigration(database, targetMigration),
    /cannot claim an existing performer handle/i
  );
  const conflictedSource = await database.query(`
    select handle, display_name
      from performers
     where id = '20000000-0000-0000-0000-000000000010';
  `);
  assert.deepEqual(conflictedSource.rows, [{ handle: 'Platynum-47', display_name: 'Must Stay Unchanged' }]);

  console.log('EdgeWyze profile cleanup migration preserves identity ownership, releases, access, and money state.');
} finally {
  await database.close();
}
