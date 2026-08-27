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
const identityMigration = '0038_edgewyze_profile_cleanup.sql';
const linkCleanupMigration = '0039_edgewyze_public_link_cleanup.sql';
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const identityIndex = migrationFiles.indexOf(identityMigration);
const linkCleanupIndex = migrationFiles.indexOf(linkCleanupMigration);

assert.notEqual(identityIndex, -1, `${identityMigration} must exist.`);
assert.notEqual(linkCleanupIndex, -1, `${linkCleanupMigration} must exist.`);
assert.equal(identityIndex + 1, linkCleanupIndex, 'The link cleanup must immediately follow the identity cleanup.');
assert.equal(linkCleanupIndex, migrationFiles.length - 1, 'The EdgeWyze link cleanup must be the latest migration.');

const identitySql = readFileSync(join(migrationDirectory, identityMigration), 'utf8');
assert.match(identitySql, /lower\(handle\) = 'platynum-47'/i);
assert.match(identitySql, /handle = 'edgewyze'/i);
assert.match(identitySql, /display_name = 'EdgeWyze'/);
assert.match(identitySql, /performer_identity\.correct/);
assert.equal(identitySql.includes('@'), false, 'A private account email must not be committed in the migration.');
assert.doesNotMatch(
  identitySql,
  /update\s+(payments|payouts|stripe_connect_onboarding_operations|event_ticket_orders)/i,
  'The identity cleanup must not mutate money ledgers or payment state.'
);

const linkCleanupSql = readFileSync(join(migrationDirectory, linkCleanupMigration), 'utf8');
assert.match(linkCleanupSql, /label = 'Platynum-47'/);
assert.match(linkCleanupSql, /url = 'https:\/\/github\.com\/Platynum-47\/Selective-Intelligence'/);
assert.match(linkCleanupSql, /delete from performer_profile_links/i);
assert.match(linkCleanupSql, /performer_profile_link\.cleanup/);
assert.doesNotMatch(linkCleanupSql, /update\s+(payments|payouts|stripe_connect_onboarding_operations|event_ticket_orders)/i);
assert.doesNotMatch(linkCleanupSql, /update\s+performer_public_profiles/i);
assert.doesNotMatch(linkCleanupSql, /update\s+users/i);
assert.equal(linkCleanupSql.includes('@'), false, 'A private account email must not be committed in the link cleanup.');

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
  for (const migrationFile of migrationFiles.slice(0, identityIndex)) {
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
      performer_id, headline, specialties, city, avatar_url, booking_email,
      booking_phone, website_url, metadata
    ) values (
      '10000000-0000-0000-0000-000000000010',
      'I like chicken nuggets',
      '["Stuff and things"]'::jsonb,
      'Keep City',
      'https://example.test/avatar.png',
      'booking@example.test',
      '+1-555-0100',
      'https://example.test',
      '{"primaryRole":"creator","stageName":"EdgeWyze"}'::jsonb
    );

    insert into performer_profile_links (
      id, performer_id, label, description, url, kind, sort_order, is_active
    ) values
      (
        '10000000-0000-0000-0000-000000000030',
        '10000000-0000-0000-0000-000000000010',
        'Platynum-47',
        'Free access to turn vibe coding into real coding.',
        'https://github.com/Platynum-47/Selective-Intelligence',
        'other',
        0,
        true
      ),
      (
        '10000000-0000-0000-0000-000000000031',
        '10000000-0000-0000-0000-000000000010',
        'EdgeWyze catalog',
        'Keep this link',
        'https://example.test/edgewyze',
        'music',
        1,
        true
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

  await applyMigration(database, identityMigration);

  const corrected = await database.query(`
    select u.email, u.display_name as account_display_name, u.role, u.pro_mode_status,
           p.id::text as performer_id, p.handle, p.display_name, p.bio,
           p.visibility_state, p.onboarding_status,
           pp.headline, pp.specialties, pp.city, pp.avatar_url,
           pp.booking_email, pp.booking_phone, pp.website_url, pp.metadata
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
    booking_email: 'booking@example.test',
    booking_phone: '+1-555-0100',
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

  await applyMigration(database, linkCleanupMigration);

  const linksAfterCleanup = await database.query(`
    select id::text, label, description, url, kind, sort_order, is_active
      from performer_profile_links
     where performer_id = '10000000-0000-0000-0000-000000000010'
     order by sort_order, id;
  `);
  assert.deepEqual(linksAfterCleanup.rows, [{
    id: '10000000-0000-0000-0000-000000000031',
    label: 'EdgeWyze catalog',
    description: 'Keep this link',
    url: 'https://example.test/edgewyze',
    kind: 'music',
    sort_order: 1,
    is_active: true
  }], 'Only the exact legacy public link may be removed.');

  const bookingAfterCleanup = await database.query(`
    select booking_email, booking_phone
      from performer_public_profiles
     where performer_id = '10000000-0000-0000-0000-000000000010';
  `);
  assert.deepEqual(bookingAfterCleanup.rows, [{
    booking_email: 'booking@example.test',
    booking_phone: '+1-555-0100'
  }], 'Booking contact fields must be preserved.');

  const linkAudit = await database.query(`
    select actor_type, actor_id::text, entity_type, entity_id::text, event_type,
           previous_status, next_status, metadata
      from audit_events
     where event_type = 'performer_profile_link.cleanup';
  `);
  assert.equal(linkAudit.rows.length, 1);
  assert.deepEqual(linkAudit.rows[0], {
    actor_type: 'account_owner_authorized_system',
    actor_id: '10000000-0000-0000-0000-000000000001',
    entity_type: 'performer',
    entity_id: '10000000-0000-0000-0000-000000000010',
    event_type: 'performer_profile_link.cleanup',
    previous_status: 'legacy_link_present',
    next_status: 'removed',
    metadata: {
      operation: 'edgewyze_public_link_cleanup',
      removedLinks: [{
        id: '10000000-0000-0000-0000-000000000030',
        label: 'Platynum-47',
        description: 'Free access to turn vibe coding into real coding.',
        url: 'https://github.com/Platynum-47/Selective-Intelligence',
        kind: 'other',
        sortOrder: 0,
        isActive: true
      }],
      moneyFieldsChanged: false,
      accessFieldsChanged: false
    }
  });

  const afterLinkCleanupMoney = await database.query(`
    select payment_account_status, kyc_status, payouts_enabled, charges_enabled,
           stripe_connected_account_id, lifetime_gross_volume, payout_hold_reason,
           verification_required_at_amount
      from performers
     where id = '10000000-0000-0000-0000-000000000010';
  `);
  assert.deepEqual(afterLinkCleanupMoney.rows, beforeMoney.rows, 'The link cleanup must preserve all money fields.');

  await applyMigration(database, identityMigration);
  await applyMigration(database, linkCleanupMigration);
  const auditsAfterReplay = await database.query(`
    select event_type, count(*)::integer as count
      from audit_events
     where event_type in ('performer_identity.correct', 'performer_profile_link.cleanup')
     group by event_type
     order by event_type;
  `);
  assert.deepEqual(auditsAfterReplay.rows, [
    { event_type: 'performer_identity.correct', count: 1 },
    { event_type: 'performer_profile_link.cleanup', count: 1 }
  ], 'A replay must be a no-op.');

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
    applyMigration(database, identityMigration),
    /cannot claim an existing performer handle/i
  );
  const conflictedSource = await database.query(`
    select handle, display_name
      from performers
     where id = '20000000-0000-0000-0000-000000000010';
  `);
  assert.deepEqual(conflictedSource.rows, [{ handle: 'Platynum-47', display_name: 'Must Stay Unchanged' }]);

  console.log('EdgeWyze cleanup migrations preserve identity ownership, booking contact, releases, access, and money state.');
} finally {
  await database.close();
}
