import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';

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
if (!/^sway_profile_migration_proof_[a-z0-9_]+$/i.test(databaseName)) {
  throw new Error('Disposable migration proof requires a database named sway_profile_migration_proof_* .');
}

const OWNER_USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_USER_ID = '22222222-2222-4222-8222-222222222222';
const RESERVED_TEST_USER_ID = '33333333-3333-4333-8333-333333333333';
const DUPLICATE_TEST_USER_ID = '44444444-4444-4444-8444-444444444444';
const PERFORMER_ID = '55555555-5555-4555-8555-555555555555';
const GIG_ID = '66666666-6666-4666-8666-666666666666';
const TERMS_VERSION = 'migration-proof-v1';
const TERMS_HASH = 'a'.repeat(64);
const TERMS_TEXT = 'Disposable proof Brand Partner terms.';
const TERMS_SNAPSHOT = {
  guarantee: 'Proof-only immutable Sway fee guarantee.',
  publicProfileHostingFeeCents: 0,
  performerSubscriptionFeeCents: 0,
  paidInteractionPlatformFeeCents: 100,
  externalChargesExcluded: [
    'payment processor fees',
    'taxes',
    'refunds',
    'disputes and chargebacks'
  ]
};

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
    paymentsEnabled: true,
    totals: {
      totalTips: 0,
      accumulatedFees: 0,
      totalCount: 0,
      topRequest: 'None yet'
    }
  };
}

async function loadPartnerFeeResolver() {
  const tempDir = join(root, '.tmp');
  const outfile = join(tempDir, 'performer-link-profile-entitlement-store.bundle.cjs');
  mkdirSync(tempDir, { recursive: true });
  await build({
    entryPoints: ['src/server/partner-entitlement-store.ts'],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    outfile,
    sourcemap: false
  });
  return createRequire(import.meta.url)(outfile).resolveSwayPlatformFeePolicyForGig;
}

async function expectDatabaseRejection(action, messagePattern, label) {
  await assert.rejects(action, messagePattern, label);
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  let pool;
  try {
    const existingTables = await client.query(
      `SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'`
    );
    assert.equal(existingTables.rows[0].count, 0, 'Proof database must be fresh; no schema reset is permitted.');

    const previousHeadMigrations = readdirSync(join(root, 'drizzle'))
      .filter((name) => /^\d+_.*\.sql$/.test(name) && name < '0016_')
      .sort();
    assert.equal(previousHeadMigrations.at(-1), '0015_performer_music_source_connections.sql');

    for (const filename of previousHeadMigrations) {
      await applyMigrationFile(client, filename);
    }

    const activeSession = {
      ...createInactiveSession(),
      status: 'active',
      ownerActorUserId: OWNER_USER_ID,
      lastMutationActorUserId: OWNER_USER_ID,
      talentName: 'Legacy Artist',
      requestsOpen: true
    };

    await client.query(
      `INSERT INTO users
        (id, email, display_name, password_hash, email_verified_at, terms_accepted_at, role)
       VALUES
        ($1, 'legacy-owner@example.test', 'Legacy Owner', 'existing-password-hash', now(), now(), 'performer'),
        ($2, 'proof-admin@example.test', 'Proof Admin', 'admin-password-hash', now(), now(), 'admin'),
        ($3, 'reserved-test@example.test', 'Reserved Test', null, null, null, 'performer'),
        ($4, 'duplicate-test@example.test', 'Duplicate Test', null, null, null, 'performer')`,
      [OWNER_USER_ID, ADMIN_USER_ID, RESERVED_TEST_USER_ID, DUPLICATE_TEST_USER_ID]
    );
    await client.query(
      `INSERT INTO performers
        (id, owner_user_id, handle, display_name, bio, is_active, onboarding_status)
       VALUES ($1, $2, 'LegacyArtist', 'Legacy Artist', 'Existing biography', true, 'gig_ready')`,
      [PERFORMER_ID, OWNER_USER_ID]
    );
    await client.query(
      `INSERT INTO performer_public_profiles
        (performer_id, headline, city, avatar_url, website_url, metadata)
       VALUES ($1, 'Existing public headline', 'Pensacola', 'https://example.test/avatar.png', 'https://example.test', '{"existing":true}'::jsonb)`,
      [PERFORMER_ID]
    );
    await client.query(
      `INSERT INTO gig_sessions
        (id, performer_id, owner_actor_user_id, last_mutation_actor_user_id, status, title, venue_name,
         runtime_session_state, started_at, last_activity_at, auto_closeout_at)
       VALUES ($1, $2, $3, $3, 'active', 'Existing active room', 'Proof Venue', $4::jsonb,
         now() - interval '20 minutes', now(), now() + interval '4 hours')`,
      [GIG_ID, PERFORMER_ID, OWNER_USER_ID, JSON.stringify(activeSession)]
    );
    await client.query(
      `INSERT INTO active_room_registry
        (gig_id, performer_id, owner_actor_user_id, talent_name, talent_role, route_path,
         registry_status, started_at, last_activity_at)
       VALUES ($1, $2, $3, 'Legacy Artist', 'DJ', $4, 'active', now() - interval '20 minutes', now())`,
      [GIG_ID, PERFORMER_ID, OWNER_USER_ID, `/g/${GIG_ID}`]
    );

    const legacySnapshotSql = `
      SELECT
        u.id AS user_id,
        u.email,
        u.password_hash,
        u.email_verified_at,
        u.terms_accepted_at,
        p.id AS performer_id,
        p.handle,
        p.display_name,
        p.bio,
        p.is_active,
        p.onboarding_status,
        pp.headline,
        pp.city,
        pp.avatar_url,
        pp.website_url,
        pp.metadata,
        g.id AS gig_id,
        g.status AS gig_status,
        g.runtime_session_state,
        r.route_path,
        r.registry_status,
        r.talent_name,
        r.talent_role
      FROM users u
      INNER JOIN performers p ON p.owner_user_id = u.id
      INNER JOIN performer_public_profiles pp ON pp.performer_id = p.id
      INNER JOIN gig_sessions g ON g.performer_id = p.id
      INNER JOIN active_room_registry r ON r.gig_id = g.id
      WHERE u.id = $1
    `;
    const beforeMigration = await client.query(legacySnapshotSql, [OWNER_USER_ID]);
    assert.equal(beforeMigration.rowCount, 1);

    await applyMigrationFile(client, '0016_performer_link_profiles.sql');

    const afterMigration = await client.query(legacySnapshotSql, [OWNER_USER_ID]);
    assert.deepEqual(afterMigration.rows, beforeMigration.rows, '0016 must not rewrite existing account, profile, gig, or active-room rows.');

    await applyMigrationFile(client, '0017_unclaimed_performer_profile_previews.sql');
    const previewTable = await client.query(
      `SELECT to_regclass('public.performer_profile_previews') AS table_name,
              count(*)::int AS row_count
       FROM performer_profile_previews`
    );
    assert.equal(previewTable.rows[0].table_name, 'performer_profile_previews');
    assert.equal(previewTable.rows[0].row_count, 0, 'Preview schema migration must not invent profile data.');

    const addedProfileColumns = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'performer_public_profiles'
         AND column_name IN ('booking_email', 'booking_phone', 'facebook_url', 'specialties')
       ORDER BY column_name`
    );
    assert.deepEqual(
      addedProfileColumns.rows.map((row) => row.column_name),
      ['booking_email', 'booking_phone', 'facebook_url', 'specialties']
    );

    const reservedHandleConstraint = await client.query(
      `SELECT convalidated
       FROM pg_constraint
       WHERE conname = 'performers_handle_not_reserved'`
    );
    assert.equal(reservedHandleConstraint.rowCount, 1);
    assert.equal(
      reservedHandleConstraint.rows[0].convalidated,
      true,
      'Reserved-handle protection must validate all existing performer rows during 0016.'
    );

    const activeRoomBehavior = await client.query(
      `SELECT r.gig_id, r.route_path, r.registry_status, r.talent_name, g.status, g.runtime_session_state
       FROM active_room_registry r
       INNER JOIN gig_sessions g ON g.id = r.gig_id
       WHERE r.performer_id = $1
         AND r.registry_status IN ('active', 'ending')
         AND g.status IN ('active', 'closeout_pending')`,
      [PERFORMER_ID]
    );
    assert.equal(activeRoomBehavior.rowCount, 1, 'Existing room must remain discoverable as active.');
    assert.equal(activeRoomBehavior.rows[0].gig_id, GIG_ID);
    assert.equal(activeRoomBehavior.rows[0].route_path, `/g/${GIG_ID}`);
    assert.equal(activeRoomBehavior.rows[0].runtime_session_state.status, 'active');
    assert.equal(activeRoomBehavior.rows[0].runtime_session_state.talentName, 'Legacy Artist');

    await expectDatabaseRejection(
      client.query(
        `INSERT INTO performers (owner_user_id, handle, display_name) VALUES ($1, 'AdMiN', 'Reserved')`,
        [RESERVED_TEST_USER_ID]
      ),
      /performers_handle_not_reserved/i,
      'New handles must reject reserved names case-insensitively.'
    );
    await expectDatabaseRejection(
      client.query(
        `INSERT INTO performers (owner_user_id, handle, display_name) VALUES ($1, 'legacyartist', 'Duplicate')`,
        [DUPLICATE_TEST_USER_ID]
      ),
      /idx_performers_handle_lower/i,
      'New handles must remain case-insensitively unique.'
    );

    const entitlement = await client.query(
      `INSERT INTO performer_partner_entitlements
        (performer_id, granted_by_user_id, partner_kind, terms_version, terms_hash, terms_text, terms_snapshot, note)
       VALUES ($1, $2, 'brand', $3, $4, $5, $6::jsonb, 'Disposable proof')
       RETURNING id`,
      [PERFORMER_ID, ADMIN_USER_ID, TERMS_VERSION, TERMS_HASH, TERMS_TEXT, JSON.stringify(TERMS_SNAPSHOT)]
    );
    const entitlementId = entitlement.rows[0].id;
    await client.query(
      `INSERT INTO performer_partner_entitlement_status_events
        (entitlement_id, performer_id, status, reason, actor_user_id, created_at)
       VALUES ($1, $2, 'active', 'Initial grant', $3, '2026-07-18T00:00:00Z')`,
      [entitlementId, PERFORMER_ID, ADMIN_USER_ID]
    );

    await expectDatabaseRejection(
      client.query(
        `INSERT INTO performer_partner_terms_acceptances
          (entitlement_id, performer_id, account_user_id, terms_version, terms_hash, terms_text, terms_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [entitlementId, PERFORMER_ID, ADMIN_USER_ID, TERMS_VERSION, TERMS_HASH, TERMS_TEXT, JSON.stringify(TERMS_SNAPSHOT)]
      ),
      /acceptance must be recorded by the performer owner/i,
      'An administrator must not accept terms on behalf of a performer.'
    );
    await expectDatabaseRejection(
      client.query(
        `INSERT INTO performer_partner_terms_acceptances
          (entitlement_id, performer_id, account_user_id, terms_version, terms_hash, terms_text, terms_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [entitlementId, PERFORMER_ID, OWNER_USER_ID, TERMS_VERSION, 'b'.repeat(64), TERMS_TEXT, JSON.stringify(TERMS_SNAPSHOT)]
      ),
      /exact granted terms/i,
      'The owner receipt must match the exact granted terms hash.'
    );

    const acceptance = await client.query(
      `INSERT INTO performer_partner_terms_acceptances
        (entitlement_id, performer_id, account_user_id, terms_version, terms_hash, terms_text, terms_snapshot,
         accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '2026-07-18T00:01:00Z')
       RETURNING id, account_user_id, terms_version, terms_hash, accepted_at`,
      [entitlementId, PERFORMER_ID, OWNER_USER_ID, TERMS_VERSION, TERMS_HASH, TERMS_TEXT, JSON.stringify(TERMS_SNAPSHOT)]
    );
    assert.equal(acceptance.rows[0].account_user_id, OWNER_USER_ID);
    assert.equal(acceptance.rows[0].terms_version, TERMS_VERSION);
    assert.equal(acceptance.rows[0].terms_hash, TERMS_HASH);
    assert.ok(acceptance.rows[0].accepted_at instanceof Date);

    pool = new Pool({ connectionString: databaseUrl });
    const db = drizzle(pool);
    const resolveSwayPlatformFeePolicyForGig = await loadPartnerFeeResolver();
    const feePolicy = await resolveSwayPlatformFeePolicyForGig({
      db,
      gigId: GIG_ID,
      proposedPlatformFeeCents: 275
    });
    assert.equal(feePolicy.platformFeeCents, 100, 'Accepted active Brand Partner fee must cap at $1.');
    assert.equal(feePolicy.platformFeeCapCents, 100);
    assert.equal(feePolicy.partnerTermsVersion, TERMS_VERSION);
    assert.equal(feePolicy.partnerTermsHash, TERMS_HASH);

    await client.query(
      `INSERT INTO performer_partner_entitlement_status_events
        (entitlement_id, performer_id, status, reason, actor_user_id, created_at)
       VALUES ($1, $2, 'suspended', 'Operational proof', $3, '2026-07-18T00:02:00Z')`,
      [entitlementId, PERFORMER_ID, ADMIN_USER_ID]
    );
    const suspendedPolicy = await resolveSwayPlatformFeePolicyForGig({
      db,
      gigId: GIG_ID,
      proposedPlatformFeeCents: 275
    });
    assert.equal(suspendedPolicy.platformFeeCents, 275, 'Suspension disables the benefit without deleting history.');

    await client.query(
      `INSERT INTO performer_partner_entitlement_status_events
        (entitlement_id, performer_id, status, reason, actor_user_id, created_at)
       VALUES ($1, $2, 'active', 'Operational restore proof', $3, '2026-07-18T00:03:00Z')`,
      [entitlementId, PERFORMER_ID, ADMIN_USER_ID]
    );
    const restoredPolicy = await resolveSwayPlatformFeePolicyForGig({
      db,
      gigId: GIG_ID,
      proposedPlatformFeeCents: 275
    });
    assert.equal(restoredPolicy.platformFeeCents, 100, 'Append-only restoration must reactivate the $1 cap.');

    await expectDatabaseRejection(
      client.query(`UPDATE performer_partner_entitlements SET note = 'rewrite' WHERE id = $1`, [entitlementId]),
      /append-only/i,
      'Entitlement grants must be immutable.'
    );
    await expectDatabaseRejection(
      client.query(`UPDATE performer_partner_terms_acceptances SET terms_version = 'rewrite' WHERE id = $1`, [acceptance.rows[0].id]),
      /append-only/i,
      'Acceptance receipts must be immutable.'
    );
    await expectDatabaseRejection(
      client.query(`DELETE FROM performer_partner_entitlement_status_events WHERE entitlement_id = $1`, [entitlementId]),
      /append-only/i,
      'Operational status history must be immutable.'
    );

    const immutableCounts = await client.query(
      `SELECT
        (SELECT count(*)::int FROM performer_partner_entitlements WHERE id = $1) AS grants,
        (SELECT count(*)::int FROM performer_partner_terms_acceptances WHERE entitlement_id = $1) AS receipts,
        (SELECT count(*)::int FROM performer_partner_entitlement_status_events WHERE entitlement_id = $1) AS status_events`,
      [entitlementId]
    );
    assert.deepEqual(immutableCounts.rows[0], { grants: 1, receipts: 1, status_events: 3 });

    console.log(JSON.stringify({
      database: databaseName,
      baselineHead: previousHeadMigrations.at(-1),
      migrationApplied: [
        '0016_performer_link_profiles.sql',
        '0017_unclaimed_performer_profile_previews.sql'
      ],
      existingRowsPreserved: {
        users: 1,
        performers: 1,
        publicProfiles: 1,
        gigSessions: 1,
        activeRoomRegistry: 1
      },
      activeRoomBehavior: {
        gigId: GIG_ID,
        routePath: `/g/${GIG_ID}`,
        status: 'active',
        talentName: 'Legacy Artist'
      },
      brandPartnerProof: {
        ownerAccountId: OWNER_USER_ID,
        termsVersion: TERMS_VERSION,
        termsHash: TERMS_HASH,
        acceptedAt: acceptance.rows[0].accepted_at.toISOString(),
        proposedPlatformFeeCents: 275,
        effectivePlatformFeeCents: restoredPolicy.platformFeeCents,
        platformFeeCapCents: restoredPolicy.platformFeeCapCents,
        externalChargesExcluded: TERMS_SNAPSHOT.externalChargesExcluded,
        statusEvents: 3,
        immutable: true
      },
      handleProtection: {
        caseInsensitiveUnique: true,
        reservedCaseInsensitive: true,
        reservedConstraintValidatedForExistingRows: true
      }
    }, null, 2));
  } finally {
    if (pool) await pool.end();
    await client.end();
  }
}

main().catch((error) => {
  console.error('Performer link profile migration integration proof failed:');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
