import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

function failHard(error) {
  console.error(error);
  process.exit(1);
}

process.once('uncaughtException', failHard);
process.once('unhandledRejection', failHard);

const root = process.cwd();
const migration = readFileSync(join(root, 'drizzle/0043_bored_sleeper.sql'), 'utf8');
const cutoverMigration = readFileSync(join(root, 'drizzle/0044_edgewize_identity_cutover.sql'), 'utf8');
const snapshot = readFileSync(join(root, 'drizzle/meta/0043_snapshot.json'), 'utf8');
const schema = readFileSync(join(root, 'src/db/schema.ts'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');

const EDGEWIZE_PERFORMER_ID = 'b705a2fb-9491-4fa8-b9e9-b14b7e1c1289';
const EDGEWIZE_OWNER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_PERFORMER_ID = '20000000-0000-4000-8000-000000000002';
const OTHER_OWNER_ID = '10000000-0000-4000-8000-000000000002';
const CLEANUP_PERFORMER_ID = '30000000-0000-4000-8000-000000000003';
const LEGACY_SHORT_PERFORMER_ID = '40000000-0000-4000-8000-000000000004';

assert.match(schema, /export const performerHandleClaims = pgTable\('performer_handle_claims'/);
assert.match(schema, /name: 'idx_performers_handle_lower'/);
assert.match(schema, /claimKind: text\('claim_kind'\)\.notNull\(\)/);
assert.match(schema, /legacyException: boolean\('legacy_exception'\)\.notNull\(\)\.default\(false\)/);
assert.match(schema, /onDelete: 'cascade'/);
assert.match(schema, /\^\[a-z0-9_-\]\{4,30\}\$/);
assert.match(schema, /legacyException[\s\S]*\^\[a-z0-9_-\]\{1,64\}\$/);
assert.doesNotMatch(schema, /performerHandleAliases|performer_handle_aliases/);

assert.match(migration, /SET LOCAL lock_timeout = '5s'/i);
assert.match(migration, /LOCK TABLE "performers" IN SHARE ROW EXCLUSIVE MODE/i);
assert.match(migration, /SELECT\s+lower\(p\."handle"\),\s+p\."id",\s+'canonical'/i);
assert.match(migration, /DROP INDEX "idx_performers_handle_lower"/i);
assert.match(migration, /ADD CONSTRAINT "idx_performers_handle_lower" PRIMARY KEY \("normalized_handle"\)/i);
assert.match(migration, /ON DELETE cascade/i);
assert.match(migration, /BEFORE INSERT OR UPDATE OR DELETE ON "performer_handle_claims"/i);
assert.match(migration, /AFTER INSERT OR UPDATE OF "handle" ON "performers"/i);
assert.match(migration, /performer_handle_claim_identity_is_immutable/);
assert.match(migration, /performer_handle_claim_kind_transition_is_invalid/);
assert.match(migration, /performer_handle_claim_cannot_be_deleted/);
assert.match(migration, /performer_handle_claim_legacy_exception_is_backfill_only/);
assert.match(migration, /lower\(p\."handle"\) !~ '\^\[a-z0-9_-\]\{4,30\}\$'/);
assert.match(migration, /OLD\."claim_kind" = 'canonical' AND NEW\."claim_kind" = 'redirect'/);
assert.match(migration, /OLD\."claim_kind" = 'reservation' AND NEW\."claim_kind" = 'canonical'/);
assert.doesNotMatch(migration, /OLD\."claim_kind" = 'redirect' AND NEW\."claim_kind" = 'canonical'/);
assert.match(migration, /b705a2fb-9491-4fa8-b9e9-b14b7e1c1289/);
assert.match(migration, /'edgewize',\s*target_performer_id,\s*'reservation'/);
assert.doesNotMatch(migration, /'edgewyze',\s*target_performer_id,\s*'redirect'/);
assert.match(migration, /performer_handle_claim\.reserve/);
assert.doesNotMatch(migration, /performer_handle_aliases/);
assert.doesNotMatch(
  migration,
  /update\s+(payments|payouts|performer_stripe_connect_bindings|stripe_connect_onboarding_operations)/i,
  'The handle namespace migration must not mutate money state.'
);
assert.match(cutoverMigration, /b705a2fb-9491-4fa8-b9e9-b14b7e1c1289/);
assert.match(cutoverMigration, /current_handle IS DISTINCT FROM 'edgewyze'/);
assert.match(cutoverMigration, /"normalized_handle" = 'edgewize'[\s\S]*"claim_kind" = 'reservation'/);
assert.match(cutoverMigration, /"handle" = 'edgewize'/);
assert.match(cutoverMigration, /"display_name" = 'EdgeWize'/);
assert.match(cutoverMigration, /'historicalRedirect', 'edgewyze'/);
assert.doesNotMatch(
  cutoverMigration,
  /update\s+(payments|payouts|performer_stripe_connect_bindings|stripe_connect_onboarding_operations)/i,
  'The exact identity cutover must not mutate money state.'
);

assert.match(snapshot, /"public\.performer_handle_claims"/);
assert.match(snapshot, /"idx_performers_handle_lower"/);
assert.match(snapshot, /"onDelete": "cascade"/);
assert.match(snapshot, /"legacy_exception"/);
assert.doesNotMatch(snapshot, /performer_handle_aliases/);

for (const requiredRuntime of [
  'performerHandleClaims.normalizedHandle',
  "eq(performerHandleClaims.claimKind, 'redirect')",
  'resolvedViaAlias: requestedHandle !== storedHandle?.toLowerCase()',
  'res.redirect(308, canonicalPerformerRedirectPath(req, resolution.profile.handle!))',
  'res.redirect(308, canonicalPerformerRedirectPath(req, profile.handle))',
  "'Content-Location'",
  'excludePerformerId: existingAccount.performerId',
  "claim.claimKind === 'reservation'",
  "'idx_performers_handle_lower'"
]) {
  assert.ok(server.includes(requiredRuntime), `Handle-claim runtime is missing: ${requiredRuntime}`);
}

const availabilityStart = server.indexOf('async function performerHandleExists(');
const availabilityEnd = server.indexOf('\nasync function loadPerformerOwnerVerificationState', availabilityStart);
const availabilityQuery = server.slice(availabilityStart, availabilityEnd);
assert.match(availabilityQuery, /from\(performers\)/, 'The short canonical lookup must remain first.');
assert.match(availabilityQuery, /from\(performerHandleClaims\)/, 'Every durable claim must reserve its handle.');
assert.match(availabilityQuery, /claimKind: performerHandleClaims\.claimKind/);
assert.match(
  availabilityQuery,
  /claim\.claimKind === 'reservation'/,
  'Only the same performer\'s private reservation may pass an admin rename preflight.'
);

const adminAccountUpdateStart = server.indexOf("app.patch('/api/admin/accounts/:userId'");
const adminAccountUpdateEnd = server.indexOf("\napp.post('/api/admin/accounts/:userId/reset-password'", adminAccountUpdateStart);
const adminAccountUpdateRoute = server.slice(adminAccountUpdateStart, adminAccountUpdateEnd);
const legacyLookupIndex = adminAccountUpdateRoute.indexOf('const requestedHandle = normalizePerformerHandleLookup(req.body.handle);');
const unchangedComparisonIndex = adminAccountUpdateRoute.indexOf('requestedHandle.toLowerCase() !== existingHandle?.toLowerCase()');
const strictRenameIndex = adminAccountUpdateRoute.indexOf('const normalizedHandle = normalizePerformerHandle(req.body.handle);', unchangedComparisonIndex);
assert.ok(
  legacyLookupIndex >= 0 && unchangedComparisonIndex > legacyLookupIndex && strictRenameIndex > unchangedComparisonIndex,
  'Admin updates must accept an unchanged legacy handle before applying the strict 4–30 rule to a real rename.'
);
assert.match(
  adminAccountUpdateRoute,
  /catch \(error\) \{[\s\S]*isPerformerHandleConflict\(error\)[\s\S]*status\(409\)[\s\S]*This handle is already taken\./,
  'A handle-claim race in the admin account update route must return a clear 409 conflict.'
);

function statementsFor(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function expectPgError(promise, expected) {
  try {
    await promise;
    assert.fail(`Expected PostgreSQL error ${expected.code ?? ''} ${expected.constraint ?? ''}`);
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error;
    if (expected.code) assert.equal(error?.code, expected.code, error?.message);
    if (expected.constraint) assert.equal(error?.constraint, expected.constraint, error?.message);
    if (expected.pattern) assert.match(error?.message ?? String(error), expected.pattern);
  }
}

const database = new PGlite();

try {
  await database.exec(`
    create table users (
      id uuid primary key,
      display_name text,
      updated_at timestamptz not null default now()
    );
    create table performers (
      id uuid primary key,
      owner_user_id uuid not null references users(id),
      handle text,
      display_name text not null,
      bio text,
      payment_account_status text not null default 'not_started',
      kyc_status text not null default 'not_required',
      payouts_enabled boolean not null default false,
      charges_enabled boolean not null default false,
      stripe_connected_account_id text,
      lifetime_gross_volume integer not null default 0,
      payout_hold_reason text,
      verification_required_at_amount integer not null default 10000
      ,updated_at timestamptz not null default now()
    );
    create unique index idx_performers_handle on performers(handle) where handle is not null;
    create unique index idx_performers_handle_lower on performers(lower(handle)) where handle is not null;
    create table audit_events (
      id uuid primary key default gen_random_uuid(),
      actor_type text not null,
      actor_id uuid,
      entity_type text not null,
      entity_id uuid not null,
      event_type text not null,
      previous_status text,
      next_status text,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    insert into users (id, display_name) values
      ('${EDGEWIZE_OWNER_ID}', 'EdgeWize Owner'),
      ('${OTHER_OWNER_ID}', 'Other Owner');
    insert into performers (
      id, owner_user_id, handle, display_name, payment_account_status,
      kyc_status, payouts_enabled, charges_enabled,
      stripe_connected_account_id, lifetime_gross_volume,
      payout_hold_reason, verification_required_at_amount
    ) values (
      '${EDGEWIZE_PERFORMER_ID}',
      '${EDGEWIZE_OWNER_ID}',
      'edgewyze',
      'EdgeWyze',
      'created',
      'required',
      false,
      true,
      'acct_preserve_me',
      1234,
      'preserve this hold',
      23456
    ), (
      '${OTHER_PERFORMER_ID}',
      '${OTHER_OWNER_ID}',
      'other-performer',
      'Other Performer',
      'not_started',
      'not_required',
      false,
      false,
      null,
      0,
      null,
      10000
    ), (
      '${LEGACY_SHORT_PERFORMER_ID}',
      '${OTHER_OWNER_ID}',
      '3X',
      'Legacy Short Performer',
      'not_started',
      'not_required',
      false,
      false,
      null,
      0,
      null,
      10000
    );
  `);

  const moneyBefore = await database.query(`
    select payment_account_status, kyc_status, payouts_enabled, charges_enabled,
           stripe_connected_account_id, lifetime_gross_volume,
           payout_hold_reason, verification_required_at_amount
      from performers
     where id = '${EDGEWIZE_PERFORMER_ID}'
  `);

  await database.exec('BEGIN');
  try {
    for (const statement of statementsFor(migration)) await database.exec(statement);
    await database.exec('COMMIT');
  } catch (error) {
    await database.exec('ROLLBACK');
    throw error;
  }

  const claims = await database.query(`
    select normalized_handle, performer_id::text, claim_kind, legacy_exception
      from performer_handle_claims
     order by normalized_handle
  `);
  assert.deepEqual(claims.rows, [
    {
      normalized_handle: '3x',
      performer_id: LEGACY_SHORT_PERFORMER_ID,
      claim_kind: 'canonical',
      legacy_exception: true
    },
    {
      normalized_handle: 'edgewize',
      performer_id: EDGEWIZE_PERFORMER_ID,
      claim_kind: 'reservation',
      legacy_exception: false
    },
    {
      normalized_handle: 'edgewyze',
      performer_id: EDGEWIZE_PERFORMER_ID,
      claim_kind: 'canonical',
      legacy_exception: false
    },
    {
      normalized_handle: 'other-performer',
      performer_id: OTHER_PERFORMER_ID,
      claim_kind: 'canonical',
      legacy_exception: false
    }
  ], 'All canonical handles, grandfathered legacy claims, and only the exact EdgeWize reservation must be claimed.');

  const constraintOwner = await database.query(`
    select conrelid::regclass::text as table_name, contype
      from pg_constraint
     where conname = 'idx_performers_handle_lower'
  `);
  assert.deepEqual(constraintOwner.rows, [{ table_name: 'performer_handle_claims', contype: 'p' }]);

  const performerIndexes = await database.query(`
    select indexname
      from pg_indexes
     where tablename = 'performers'
     order by indexname
  `);
  assert.ok(performerIndexes.rows.some((row) => row.indexname === 'idx_performers_handle'));
  assert.ok(performerIndexes.rows.some((row) => row.indexname === 'idx_performers_handle_lower_lookup'));

  const moneyAfter = await database.query(`
    select payment_account_status, kyc_status, payouts_enabled, charges_enabled,
           stripe_connected_account_id, lifetime_gross_volume,
           payout_hold_reason, verification_required_at_amount
      from performers
     where id = '${EDGEWIZE_PERFORMER_ID}'
  `);
  assert.deepEqual(moneyAfter.rows, moneyBefore.rows, 'Handle claims must preserve every money field.');

  const audit = await database.query(`
    select actor_type, actor_id::text, entity_type, entity_id::text,
           event_type, previous_status, next_status, metadata
      from audit_events
     where event_type = 'performer_handle_claim.reserve'
  `);
  assert.deepEqual(audit.rows, [{
    actor_type: 'account_owner_authorized_system',
    actor_id: EDGEWIZE_OWNER_ID,
    entity_type: 'performer',
    entity_id: EDGEWIZE_PERFORMER_ID,
    event_type: 'performer_handle_claim.reserve',
    previous_status: 'edgewyze',
    next_status: 'edgewize',
    metadata: {
      operation: 'reserve_performer_handle_claim',
      normalizedHandle: 'edgewize',
      canonicalHandle: 'edgewyze',
      claimKind: 'reservation',
      moneyFieldsChanged: false,
      accessFieldsChanged: false
    }
  }]);

  await expectPgError(
    database.exec(`update performer_handle_claims set claim_kind = 'canonical' where normalized_handle = 'edgewize'`),
    { code: '23514', constraint: 'performer_handle_claims_canonical_matches_performer' }
  );
  await expectPgError(
    database.exec(`update performer_handle_claims set claim_kind = 'redirect' where normalized_handle = 'edgewize'`),
    { pattern: /performer_handle_claim_kind_transition_is_invalid/i }
  );

  await database.exec('BEGIN');
  try {
    for (const statement of statementsFor(cutoverMigration)) await database.exec(statement);
    await database.exec('COMMIT');
  } catch (error) {
    await database.exec('ROLLBACK');
    throw error;
  }
  const renamedClaims = await database.query(`
    select normalized_handle, claim_kind
      from performer_handle_claims
     where performer_id = '${EDGEWIZE_PERFORMER_ID}'
     order by normalized_handle
  `);
  assert.deepEqual(renamedClaims.rows, [
    { normalized_handle: 'edgewize', claim_kind: 'canonical' },
    { normalized_handle: 'edgewyze', claim_kind: 'redirect' }
  ]);
  assert.deepEqual(
    (await database.query(`select handle, display_name from performers where id = '${EDGEWIZE_PERFORMER_ID}'`)).rows,
    [{ handle: 'edgewize', display_name: 'EdgeWize' }]
  );
  assert.deepEqual(
    (await database.query(`select display_name from users where id = '${EDGEWIZE_OWNER_ID}'`)).rows,
    [{ display_name: 'EdgeWize' }]
  );
  assert.deepEqual(
    (await database.query(`select previous_status, next_status, metadata from audit_events where event_type = 'performer_identity.correct'`)).rows,
    [{
      previous_status: 'edgewyze',
      next_status: 'edgewize',
      metadata: {
        operation: 'edgewize_identity_cutover',
        previousDisplayName: 'EdgeWyze',
        accountDisplayName: 'EdgeWize',
        performerDisplayName: 'EdgeWize',
        historicalRedirect: 'edgewyze',
        moneyFieldsChanged: false,
        accessFieldsChanged: false
      }
    }]
  );

  const moneyAfterCutover = await database.query(`
    select payment_account_status, kyc_status, payouts_enabled, charges_enabled,
           stripe_connected_account_id, lifetime_gross_volume,
           payout_hold_reason, verification_required_at_amount
      from performers
     where id = '${EDGEWIZE_PERFORMER_ID}'
  `);
  assert.deepEqual(moneyAfterCutover.rows, moneyBefore.rows, 'EdgeWize identity cutover must preserve every money field.');

  await expectPgError(
    database.exec(`update performers set handle = 'edgewyze' where id = '${EDGEWIZE_PERFORMER_ID}'`),
    { code: '23505', constraint: 'idx_performers_handle_lower' }
  );
  assert.deepEqual(
    (await database.query(`select handle from performers where id = '${EDGEWIZE_PERFORMER_ID}'`)).rows,
    [{ handle: 'edgewize' }],
    'A performer must never reclaim its own permanent historical redirect.'
  );

  await expectPgError(
    database.exec(`update performers set handle = 'EDGEWYZE' where id = '${OTHER_PERFORMER_ID}'`),
    { code: '23505', constraint: 'idx_performers_handle_lower' }
  );
  await expectPgError(
    database.exec(`update performers set handle = 'EDGEWIZE' where id = '${OTHER_PERFORMER_ID}'`),
    { code: '23505', constraint: 'idx_performers_handle_lower' }
  );
  await expectPgError(
    database.exec(`update performer_handle_claims set claim_kind = 'reservation' where normalized_handle = 'edgewyze'`),
    { pattern: /performer_handle_claim_kind_transition_is_invalid/i }
  );
  await expectPgError(
    database.exec(`update performer_handle_claims set normalized_handle = 'changed' where normalized_handle = 'edgewyze'`),
    { pattern: /performer_handle_claim_identity_is_immutable/i }
  );
  await expectPgError(
    database.exec(`update performer_handle_claims set performer_id = '${OTHER_PERFORMER_ID}' where normalized_handle = 'edgewyze'`),
    { pattern: /performer_handle_claim_identity_is_immutable/i }
  );
  await expectPgError(
    database.exec(`delete from performer_handle_claims where normalized_handle = 'edgewyze'`),
    { pattern: /performer_handle_claim_cannot_be_deleted/i }
  );
  await expectPgError(
    database.query(
      `insert into performer_handle_claims (normalized_handle, performer_id, claim_kind) values ($1, $2, 'reservation')`,
      ['x'.repeat(31), EDGEWIZE_PERFORMER_ID]
    ),
    { code: '23514', constraint: 'performer_handle_claims_valid_handle' }
  );
  await expectPgError(
    database.query(
      `insert into performer_handle_claims (normalized_handle, performer_id, claim_kind, legacy_exception) values ($1, $2, 'redirect', true)`,
      ['old', EDGEWIZE_PERFORMER_ID]
    ),
    { pattern: /performer_handle_claim_legacy_exception_is_backfill_only/i }
  );
  await expectPgError(
    database.query(
      `insert into performer_handle_claims (normalized_handle, performer_id, claim_kind) values ($1, $2, 'reservation')`,
      ['abc', EDGEWIZE_PERFORMER_ID]
    ),
    { code: '23514', constraint: 'performer_handle_claims_valid_handle' }
  );

  await database.exec(`
    insert into performers (id, owner_user_id, handle, display_name)
    values ('${CLEANUP_PERFORMER_ID}', '${OTHER_OWNER_ID}', null, 'Signup Cleanup')
  `);
  assert.equal(
    (await database.query(`select count(*)::int as count from performer_handle_claims where performer_id = '${CLEANUP_PERFORMER_ID}'`)).rows[0].count,
    0
  );
  await expectPgError(
    database.exec(`update performers set handle = 'abc' where id = '${CLEANUP_PERFORMER_ID}'`),
    { code: '23514', constraint: 'performer_handle_claims_valid_handle' }
  );
  await database.exec(`update performers set handle = 'four' where id = '${CLEANUP_PERFORMER_ID}'`);
  assert.deepEqual(
    (await database.query(`select normalized_handle, claim_kind from performer_handle_claims where performer_id = '${CLEANUP_PERFORMER_ID}'`)).rows,
    [{ normalized_handle: 'four', claim_kind: 'canonical' }],
    'The claim namespace must accept handles at the four-character minimum.'
  );
  await database.exec(`update performers set handle = null where id = '${CLEANUP_PERFORMER_ID}'`);
  assert.deepEqual(
    (await database.query(`select normalized_handle, claim_kind from performer_handle_claims where performer_id = '${CLEANUP_PERFORMER_ID}'`)).rows,
    [{ normalized_handle: 'four', claim_kind: 'redirect' }]
  );

  // This is the signup email-delivery rollback shape: deleting the parent must
  // cascade its newly-created canonical claim even though direct claim deletes
  // remain forbidden while a parent performer exists.
  await database.exec(`update performers set handle = 'signup-retry' where id = '${CLEANUP_PERFORMER_ID}'`);
  await database.exec(`delete from performers where id = '${CLEANUP_PERFORMER_ID}'`);
  assert.equal(
    (await database.query(`select count(*)::int as count from performer_handle_claims where performer_id = '${CLEANUP_PERFORMER_ID}'`)).rows[0].count,
    0,
    'A performer rollback must cascade every canonical and historical claim.'
  );

  await database.exec(`update performers set handle = 'OTHER-PERFORMER' where id = '${OTHER_PERFORMER_ID}'`);
  assert.deepEqual(
    (await database.query(`select normalized_handle, claim_kind from performer_handle_claims where performer_id = '${OTHER_PERFORMER_ID}'`)).rows,
    [{ normalized_handle: 'other-performer', claim_kind: 'canonical' }],
    'Case-only canonical changes must preserve one normalized claim.'
  );

  console.log('PASS performer handle claims provide one atomic durable namespace');
} finally {
  await database.close();
}
