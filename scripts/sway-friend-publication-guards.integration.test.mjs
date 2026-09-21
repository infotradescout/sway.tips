import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

// This proof owns only a fresh embedded database. Never reset an inherited target.
if (process.env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL?.trim()) {
  throw new Error('Friend publication guard proof requires embedded PostgreSQL; a configured real database is not accepted.');
}

const migrationPath = 'drizzle/0051_friend_public_profiles.sql';
const migration = readFileSync(migrationPath, 'utf8');
const migrationId = '0051_friend_public_profiles_v1';
const publicationType = 'performer_public_profile.operator_publish';
const rollbackType = `${publicationType}_rollback`;
const targets = [
  ['b1b0e4d9-d4a8-4526-b49a-f5c4e464cfcd', '87b3512f-a5a6-4b1f-b80b-1a94f9575a98', '34607bf4-37ca-43d5-b61f-3d684a410e32', 'bubbakhain', 'Bubba Khain', 'https://sway.tips/assets/bubba-khain-avatar.jpg'],
  ['ed8116ce-8255-4ff8-bfec-6a57ec9568cf', '7e78b206-060e-4fed-bb77-6d45113a3b4b', '51e64828-fc4d-4e60-a743-afd993674141', 'calliehines', 'Callie Hines', 'https://sway.tips/assets/callie-hines-avatar.jpg'],
  ['da855e85-9f7a-469e-9d9d-8c8e1ce20b96', 'e66685f1-885b-47c0-ac05-a4cf1e623087', '59a1b6cf-854e-47f2-aa8f-d1424abe868c', 'coreymack', 'Corey Mack', 'https://img1.wsimg.com/isteam/ip/507cdd9e-ba65-48f1-ac5c-290e6c33023b/72E6855B-ABEB-492D-8EA4-0DAB48CAA65E.jpeg'],
  ['bc1c60c2-2ec1-4967-ad2f-b099adfcbb7c', 'bb5a762c-4a0f-47c2-bba9-bb83590764e9', 'd834d8c0-3374-4ec9-bea8-93419fd6df0e', 'drewmaze', 'Drew Maze', 'https://sway.tips/assets/drew-maze-avatar.jpg']
];
// The last target is also last in the rollback's handle order. Every rejection
// must preserve all earlier targets as well as the intervening edit itself.
const [lastPerformer, lastOwner, lastPreview] = targets.at(-1);
const otherOwner = randomUUID();
const otherPerformer = randomUUID();
const passed = [];
const startedAt = new Date().toISOString();
const proof = await startEmbeddedPostgresProof('friend-publication-guards');
const client = new Client({ connectionString: proof.databaseUrl });

// This temporary function is an executable example of the documented rollback,
// not an installed production rollback or authorization to run one. The caller
// supplies exact publication event IDs inside its own transaction.
const rollbackFunction = `
CREATE FUNCTION pg_temp.rollback_friend_publications(selected_ids uuid[], operator_reason text)
RETURNS void LANGUAGE plpgsql AS $rollback$
DECLARE
  publication audit_events%ROWTYPE;
  current_performer performers%ROWTYPE;
  current_snapshot jsonb;
  restored_fields jsonb;
  affected integer;
BEGIN
  IF selected_ids IS NULL OR cardinality(selected_ids) = 0
    OR cardinality(selected_ids) <> (SELECT count(DISTINCT id) FROM unnest(selected_ids) id)
    OR nullif(trim(operator_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Rollback requires unique event IDs and an operator reason';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('0051_friend_public_profiles_v1', 0));
  IF (SELECT count(*) FROM audit_events a
      WHERE a.event_id = ANY(selected_ids) AND a.actor_type = 'operator'
        AND a.actor_id IS NULL AND a.entity_type = 'performer'
        AND a.event_type = 'performer_public_profile.operator_publish'
        AND a.metadata->>'migrationId' = '0051_friend_public_profiles_v1') <> cardinality(selected_ids) THEN
    RAISE EXCEPTION 'Rollback publication selection mismatch';
  END IF;

  -- Validate and lock EVERY selected event before the first data mutation.
  FOR publication IN SELECT * FROM audit_events WHERE event_id = ANY(selected_ids)
    ORDER BY metadata->'identity'->>'handle' FOR SHARE
  LOOP
    IF EXISTS (SELECT 1 FROM audit_events a
      WHERE a.event_type = 'performer_public_profile.operator_publish_rollback'
        AND a.metadata->>'publicationEventId' = publication.event_id::text) THEN
      RAISE EXCEPTION 'Publication already rolled back';
    END IF;
    SELECT * INTO current_performer FROM performers
      WHERE id = publication.entity_id FOR UPDATE;
    IF NOT FOUND
      OR current_performer.id::text IS DISTINCT FROM publication.metadata->'identity'->>'performerId'
      OR current_performer.owner_user_id::text IS DISTINCT FROM publication.metadata->'identity'->>'ownerUserId'
      OR lower(current_performer.handle) IS DISTINCT FROM publication.metadata->'identity'->>'handle' THEN
      RAISE EXCEPTION 'Rollback identity changed';
    END IF;
    PERFORM 1 FROM performer_public_profiles WHERE performer_id = publication.entity_id FOR UPDATE;
    PERFORM 1 FROM performer_profile_links WHERE performer_id = publication.entity_id
      ORDER BY sort_order, id FOR UPDATE;
    SELECT jsonb_build_object(
      'performer', jsonb_build_object('bio', current_performer.bio,
        'is_active', current_performer.is_active, 'visibility_state', current_performer.visibility_state,
        'updated_at', current_performer.updated_at),
      'publicProfile', (SELECT to_jsonb(p) FROM performer_public_profiles p WHERE p.performer_id = publication.entity_id),
      'links', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.sort_order, l.id), '[]'::jsonb)
        FROM performer_profile_links l WHERE l.performer_id = publication.entity_id)
    ) INTO current_snapshot;
    IF current_snapshot IS DISTINCT FROM publication.metadata->'after' THEN
      RAISE EXCEPTION 'Rollback after-state changed';
    END IF;
    IF publication.metadata->'before'->'publicProfile' IS DISTINCT FROM 'null'::jsonb
      OR publication.metadata->'before'->'links' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'Rollback before-state is not an absent profile';
    END IF;
  END LOOP;

  FOR publication IN SELECT * FROM audit_events WHERE event_id = ANY(selected_ids)
    ORDER BY metadata->'identity'->>'handle'
  LOOP
    DELETE FROM performer_profile_links l WHERE l.performer_id = publication.entity_id
      AND l.id IN (SELECT (item->>'id')::uuid FROM jsonb_array_elements(publication.metadata->'after'->'links') item);
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> jsonb_array_length(publication.metadata->'after'->'links') THEN
      RAISE EXCEPTION 'Rollback link deletion mismatch';
    END IF;
    DELETE FROM performer_public_profiles p WHERE p.performer_id = publication.entity_id
      AND to_jsonb(p) IS NOT DISTINCT FROM publication.metadata->'after'->'publicProfile';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN RAISE EXCEPTION 'Rollback profile deletion mismatch'; END IF;
    UPDATE performers p SET
      bio = publication.metadata->'before'->'performer'->>'bio',
      is_active = (publication.metadata->'before'->'performer'->>'is_active')::boolean,
      visibility_state = (publication.metadata->'before'->'performer'->>'visibility_state')::performer_visibility_state,
      updated_at = clock_timestamp()
    WHERE p.id = publication.entity_id
    RETURNING jsonb_build_object('bio', p.bio, 'is_active', p.is_active,
      'visibility_state', p.visibility_state, 'updated_at', p.updated_at) INTO restored_fields;
    INSERT INTO audit_events (actor_type, actor_id, entity_type, entity_id, event_type,
      previous_status, next_status, metadata)
    VALUES ('operator', NULL, 'performer', publication.entity_id,
      'performer_public_profile.operator_publish_rollback',
      publication.metadata->'after'->'performer'->>'visibility_state', restored_fields->>'visibility_state',
      jsonb_build_object('publicationEventId', publication.event_id,
        'migrationId', '0051_friend_public_profiles_v1', 'before', publication.metadata->'after',
        'restoredFields', restored_fields, 'reason', operator_reason));
  END LOOP;
END;
$rollback$;
`;

try {
  await client.connect();
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows;
  // Whole-database row snapshots catch accidental writes beyond the four-table
  // publication allowlist, including preserved users, previews and money state.
  const snapshotSql = `SELECT jsonb_object_agg(table_name, rows) AS snapshot FROM (${tables.map(({ tablename }) => {
    assert.match(tablename, /^[a-z0-9_]+$/);
    return `SELECT '${tablename}' AS table_name, coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM "${tablename}" t`;
  }).join(' UNION ALL ')}) snapshots`;
  const snapshot = async () => (await client.query(snapshotSql)).rows[0].snapshot;
  const sameDatabase = async (before, label) => assert.deepEqual(await snapshot(), before, label);
  const unchangedExcept = (before, after, allowed, label) => {
    for (const table of Object.keys(before)) {
      if (!allowed.includes(table)) assert.deepEqual(after[table], before[table], `${label}: ${table}`);
    }
  };
  const isolated = async (label, work) => {
    await client.query('BEGIN');
    try {
      await work();
      passed.push(label);
    } finally {
      await client.query('ROLLBACK');
    }
  };
  const rejectsWithoutWrites = async (action, expectedError, label) => {
    const before = await snapshot();
    await client.query('SAVEPOINT rejected_action');
    await assert.rejects(action(), expectedError, label);
    await client.query('ROLLBACK TO SAVEPOINT rejected_action');
    await sameDatabase(before, `${label}: rejection preserves the entire database`);
    await client.query('RELEASE SAVEPOINT rejected_action');
  };
  const guard = (label, mutate, expectedError) => isolated(label, async () => {
    await mutate();
    await rejectsWithoutWrites(() => client.query(migration), expectedError, label);
  });
  const seedTarget = async ([id, owner, preview, handle, name, avatar]) => {
    await client.query('INSERT INTO users(id, email, display_name, role) VALUES ($1, $2, $3, $4)', [owner, `${handle}@sway.test`, name, 'performer']);
    await client.query('INSERT INTO performers(id, owner_user_id, handle, display_name) VALUES ($1, $2, $3, $4)', [id, owner, handle, name]);
    await client.query('INSERT INTO performer_profile_previews(id, claimed_performer_id, handle, display_name, avatar_url, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [preview, id, handle, name, avatar, JSON.stringify({ stageName: name })]);
  };

  const empty = await snapshot();
  assert.equal(empty.performers.length, 0);
  assert.equal(empty.users.length, 0);
  await client.query(migration);
  await sameDatabase(empty, 'Empty database replay creates no people or records');
  passed.push('empty database no-op');

  await client.query('INSERT INTO users(id, email, display_name) VALUES ($1, $2, $3)', [otherOwner, 'unrelated-guard-fixture@sway.test', 'Unrelated fixture']);
  await client.query('INSERT INTO performers(id, owner_user_id, handle, display_name, bio) VALUES ($1, $2, $3, $4, $5)', [otherPerformer, otherOwner, 'unrelated-guard-fixture', 'Unrelated fixture', 'Preserve this unrelated record.']);
  await client.query('INSERT INTO performer_public_profiles(performer_id, headline, metadata) VALUES ($1, $2, $3::jsonb)', [otherPerformer, 'Existing unrelated page', JSON.stringify({ ownerData: 'retain exactly' })]);
  await client.query('INSERT INTO performer_profile_links(performer_id, label, url, kind) VALUES ($1, $2, $3, $4)', [otherPerformer, 'Unrelated website', 'https://example.test/unrelated', 'other']);
  const unrelatedOnly = await snapshot();
  await client.query(migration);
  await sameDatabase(unrelatedOnly, 'Missing targets preserve unrelated existing records');
  passed.push('missing targets preserve unrelated content');
  for (const target of targets) await seedTarget(target);
  const baseline = await snapshot();

  const draftError = /identity or draft state changed for drewmaze/;
  const previewError = /curated preview identity or image changed for drewmaze/;
  await guard('wrong performer UUID aborts all publication', async () => {
    await client.query('DELETE FROM performer_profile_previews WHERE id = $1', [lastPreview]);
    await client.query('DELETE FROM performers WHERE id = $1', [lastPerformer]);
    const replacement = randomUUID();
    await client.query('INSERT INTO performers(id, owner_user_id, handle, display_name) VALUES ($1, $2, $3, $4)', [replacement, lastOwner, 'drewmaze', 'Drew Maze']);
    await client.query('INSERT INTO performer_profile_previews(id, claimed_performer_id, handle, display_name) VALUES ($1, $2, $3, $4)', [lastPreview, replacement, 'drewmaze', 'Drew Maze']);
  }, draftError);
  await guard('wrong owner UUID aborts all publication', () => client.query('UPDATE performers SET owner_user_id = $1 WHERE id = $2', [otherOwner, lastPerformer]), draftError);
  await guard('changed canonical handle aborts all publication', () => client.query("UPDATE performers SET handle = 'drewmaze-renamed' WHERE id = $1", [lastPerformer]), draftError);
  for (const [column, value] of [['display_name', 'Intervening name'], ['bio', 'Intervening owner bio'], ['is_active', true], ['visibility_state', 'unlisted'], ['onboarding_status', 'suspended']]) {
    await guard(`changed performer ${column} aborts all publication`, () => client.query(`UPDATE performers SET ${column} = $1 WHERE id = $2`, [value, lastPerformer]), draftError);
  }
  for (const [column, value] of [['id', randomUUID()], ['claimed_performer_id', otherPerformer], ['handle', 'drewmaze-preview-edit'], ['display_name', 'Intervening preview name'], ['is_active', false], ['avatar_url', 'https://example.test/edited.jpg'], ['metadata', JSON.stringify({ stageName: 'Drew Maze', ownerEdit: true })]]) {
    await guard(`changed preview ${column} aborts all publication`, () => client.query(`UPDATE performer_profile_previews SET ${column} = $1 WHERE id = $2`, [value, lastPreview]), previewError);
  }
  // Do not disable schema guards to manufacture an impossible canonical claim.
  await isolated('schema rejects canonical claim reassignment', () => rejectsWithoutWrites(
    () => client.query("UPDATE performer_handle_claims SET performer_id = $1 WHERE normalized_handle = 'drewmaze'", [otherPerformer]),
    /performer_handle_claim_identity_is_immutable/, 'canonical claim reassignment'));
  await isolated('schema rejects canonical claim deletion', () => rejectsWithoutWrites(
    () => client.query("DELETE FROM performer_handle_claims WHERE normalized_handle = 'drewmaze'"),
    /performer_handle_claim_cannot_be_deleted/, 'canonical claim deletion'));
  await guard('existing public profile aborts all publication', () => client.query('INSERT INTO performer_public_profiles(performer_id) VALUES ($1)', [lastPerformer]), /public profile already exists for drewmaze/);
  await guard('existing profile link aborts all publication', () => client.query('INSERT INTO performer_profile_links(performer_id, label, url, kind) VALUES ($1, $2, $3, $4)', [lastPerformer, 'Owner link', 'https://example.test/owner', 'other']), /prior profile or visibility edit for drewmaze/);
  for (const eventType of ['performer_public_profile.update', 'performer_visibility.update']) {
    await guard(`prior ${eventType} audit aborts all publication`, () => client.query('INSERT INTO audit_events(actor_type, actor_id, entity_type, entity_id, event_type) VALUES ($1, $2, $3, $4, $5)', ['user', lastOwner, 'performer', lastPerformer, eventType]), /prior profile or visibility edit for drewmaze/);
  }
  for (const status of ['suspended', 'revoked']) {
    await guard(`${status} owner aborts all publication`, () => client.query('UPDATE users SET pro_mode_status = $1 WHERE id = $2', [status, lastOwner]), /missing or restricted owner for drewmaze/);
  }
  await guard('active owner block aborts all publication', () => client.query('INSERT INTO active_blocks(scope, normalized_value, reason) VALUES ($1, $2, $3)', ['patron_user_id', lastOwner, 'Disposable guard fixture']), /moderation review required for drewmaze/);
  for (const [type, id] of [['user', lastOwner], ['performer', lastPerformer], ['performer_profile_preview', lastPreview]]) {
    for (const status of ['held_for_review', 'blocked']) {
      await guard(`latest ${type} ${status} aborts all publication`, async () => {
        await client.query("INSERT INTO moderation_events(entity_type, entity_id, status, created_at) VALUES ($1, $2, 'allowed', '2026-01-01'), ($1, $2, $3, '2026-01-02')", [type, id, status]);
      }, /moderation review required for drewmaze/);
    }
  }
  await isolated('latest allowed moderation and revoked block permit publication without altering history', async () => {
    await client.query("INSERT INTO moderation_events(entity_type, entity_id, status, created_at) VALUES ('performer', $1, 'blocked', '2026-01-01'), ('performer', $1, 'allowed', '2026-01-02')", [lastPerformer]);
    await client.query("INSERT INTO active_blocks(scope, normalized_value, reason, status, revoked_at) VALUES ('patron_user_id', $1, 'Previously revoked fixture', 'revoked', now())", [lastOwner]);
    const before = await snapshot();
    await client.query(migration);
    const after = await snapshot();
    assert.equal(after.audit_events.filter((event) => event.event_type === publicationType).length, 4);
    unchangedExcept(before, after, ['performers', 'performer_public_profiles', 'performer_profile_links', 'audit_events'], 'allowed publication');
  });

  await sameDatabase(baseline, 'All guard fixtures are transaction-isolated');
  await client.query(migration);
  const published = await snapshot();
  const publications = published.audit_events.filter((event) => event.event_type === publicationType);
  const eventIds = publications.map((event) => event.event_id);
  assert.equal(publications.length, 4);
  unchangedExcept(baseline, published, ['performers', 'performer_public_profiles', 'performer_profile_links', 'audit_events'], 'successful publication');
  for (const event of publications) {
    assert.equal(event.actor_type, 'operator');
    assert.equal(event.actor_id, null);
    assert.equal(event.metadata.accountClaimPerformed, false);
    assert.equal(event.metadata.messageSent, false);
    assert.equal(event.metadata.migrationId, migrationId);
    const original = baseline.performers.find((row) => row.id === event.entity_id);
    const current = published.performers.find((row) => row.id === event.entity_id);
    assert.deepEqual(event.metadata.before.performer, Object.fromEntries(['bio', 'is_active', 'visibility_state', 'updated_at'].map((key) => [key, original[key]])));
    assert.deepEqual(event.metadata.after.performer, Object.fromEntries(['bio', 'is_active', 'visibility_state', 'updated_at'].map((key) => [key, current[key]])));
    assert.deepEqual(event.metadata.after.publicProfile, published.performer_public_profiles.find((row) => row.performer_id === event.entity_id));
    assert.deepEqual(event.metadata.after.links.map((row) => row.id).sort(), published.performer_profile_links.filter((row) => row.performer_id === event.entity_id).map((row) => row.id).sort());
    for (const [key, value] of Object.entries(original)) {
      if (!['bio', 'is_active', 'visibility_state', 'updated_at'].includes(key)) assert.deepEqual(current[key], value, `publication preserves performer ${key}`);
    }
  }
  passed.push('four exact targets publish with audited before/after and preserved account/private/unrelated state');
  await client.query(migration);
  await sameDatabase(published, 'Publication replay is a complete no-op');
  passed.push('publication replay no-op');

  await client.query(rollbackFunction);
  const rollback = (ids = eventIds) => client.query('SELECT pg_temp.rollback_friend_publications($1::uuid[], $2)', [ids, 'Disposable rollback proof']);
  for (const [label, mutate, expectedError] of [
    ['profile edit', () => client.query("UPDATE performer_public_profiles SET headline = 'Later owner headline' WHERE performer_id = $1", [lastPerformer]), /Rollback after-state changed/],
    ['profile timestamp edit', () => client.query("UPDATE performer_public_profiles SET updated_at = updated_at + interval '1 second' WHERE performer_id = $1", [lastPerformer]), /Rollback after-state changed/],
    ['link edit', () => client.query("UPDATE performer_profile_links SET url = 'https://example.test/later-owner-link' WHERE performer_id = $1 AND sort_order = 0", [lastPerformer]), /Rollback after-state changed/],
    ['added link', () => client.query('INSERT INTO performer_profile_links(performer_id, label, url, kind, sort_order) VALUES ($1, $2, $3, $4, $5)', [lastPerformer, 'Later addition', 'https://example.test/new', 'other', 10]), /Rollback after-state changed/],
    ['deleted link', () => client.query('DELETE FROM performer_profile_links WHERE performer_id = $1 AND sort_order = 0', [lastPerformer]), /Rollback after-state changed/],
    ['performer bio edit', () => client.query("UPDATE performers SET bio = 'Later owner bio' WHERE id = $1", [lastPerformer]), /Rollback after-state changed/],
    ['performer visibility edit', () => client.query("UPDATE performers SET visibility_state = 'unlisted' WHERE id = $1", [lastPerformer]), /Rollback after-state changed/],
    ['identity owner edit', () => client.query('UPDATE performers SET owner_user_id = $1 WHERE id = $2', [otherOwner, lastPerformer]), /Rollback identity changed/],
    ['identity handle edit', () => client.query("UPDATE performers SET handle = 'drewmaze-later-handle' WHERE id = $1", [lastPerformer]), /Rollback identity changed/]
  ]) {
    await isolated(`rollback rejects later ${label} atomically and migration replay preserves it`, async () => {
      await mutate();
      await rejectsWithoutWrites(() => rollback(), expectedError, label);
      const edited = await snapshot();
      await client.query(migration);
      await sameDatabase(edited, `${label}: replay preserves all later edits`);
    });
  }
  await isolated('rollback rejects unknown event IDs without partial mutation', () => rejectsWithoutWrites(() => rollback([...eventIds, randomUUID()]), /Rollback publication selection mismatch/, 'unknown event ID'));
  await isolated('rollback rejects duplicate event IDs without partial mutation', () => rejectsWithoutWrites(() => rollback([...eventIds, eventIds[0]]), /Rollback requires unique event IDs/, 'duplicate event ID'));

  // Inject a test-only failure on the last reversal audit. This proves the
  // transaction rolls back earlier deletions/restorations, not just validation.
  await isolated('rollback audit-write failure rolls back every earlier reversal', async () => {
    await client.query(`CREATE FUNCTION pg_temp.reject_last_rollback_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type = 'performer_public_profile.operator_publish_rollback'
        AND NEW.entity_id = '${lastPerformer}'::uuid THEN RAISE EXCEPTION 'Injected rollback audit failure'; END IF;
        RETURN NEW; END; $$;
      CREATE TRIGGER friend_rollback_audit_failure BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_last_rollback_audit();`);
    await rejectsWithoutWrites(() => rollback(), /Injected rollback audit failure/, 'audit failure');
  });

  await client.query('BEGIN');
  try {
    await rollback();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  const restored = await snapshot();
  unchangedExcept(baseline, restored, ['performers', 'audit_events'], 'successful rollback');
  for (const original of baseline.performers) {
    const current = restored.performers.find((row) => row.id === original.id);
    if (original.id === otherPerformer) {
      assert.deepEqual(current, original, 'unrelated performer remains byte-for-byte unchanged');
    } else {
      assert.deepEqual({ ...current, updated_at: original.updated_at }, original, 'rollback restores only published performer fields');
      assert.ok(new Date(current.updated_at) >= new Date(published.performers.find((row) => row.id === original.id).updated_at), 'rollback records a new mutation timestamp');
    }
  }
  assert.deepEqual(restored.audit_events.filter((event) => event.event_type === publicationType), publications, 'original publication audits remain immutable');
  const reversals = restored.audit_events.filter((event) => event.event_type === rollbackType);
  assert.equal(reversals.length, 4);
  for (const reversal of reversals) {
    const publication = publications.find((event) => event.event_id === reversal.metadata.publicationEventId);
    assert.ok(publication);
    assert.equal(reversal.actor_type, 'operator');
    assert.equal(reversal.actor_id, null);
    assert.equal(reversal.entity_id, publication.entity_id);
    assert.equal(reversal.metadata.migrationId, migrationId);
    assert.equal(reversal.metadata.reason, 'Disposable rollback proof');
    assert.deepEqual(reversal.metadata.before, publication.metadata.after);
    const current = restored.performers.find((row) => row.id === reversal.entity_id);
    assert.deepEqual(reversal.metadata.restoredFields, Object.fromEntries(['bio', 'is_active', 'visibility_state', 'updated_at'].map((key) => [key, current[key]])));
  }
  passed.push('unchanged after-state rolls back all four atomically with retained original audits and four reversal audits');
  await isolated('already rolled back publication is rejected', () => rejectsWithoutWrites(() => rollback(), /Publication already rolled back/, 'repeat rollback'));
  await client.query(migration);
  await sameDatabase(restored, 'Migration replay after rollback must never republish');
  passed.push('migration replay after rollback no-op');

  mkdirSync('artifacts/friend-publication-guards', { recursive: true });
  writeFileSync('artifacts/friend-publication-guards/result.json', `${JSON.stringify({
    startedAt, completedAt: new Date().toISOString(), engine: proof.kind,
    migrationPath, migrationSha256: createHash('sha256').update(migration).digest('hex'),
    passed, limitations: [
      'Embedded PostgreSQL proves deterministic constraints and transactional rollback, not independent-backend concurrency.',
      'Rollback function exists only in pg_temp for this proof; no production rollback is installed or executed.',
      'Canonical claim reassignment/deletion are rejected by intact schema guards; the proof does not disable triggers to construct corrupted claims.'
    ]
  }, null, 2)}\n`);
  console.log(`Friend publication guards: ${passed.length} cases PASS (embedded PostgreSQL; no provider calls).`);
  console.log('Evidence: artifacts/friend-publication-guards/result.json');
} finally {
  await client.end();
  await proof.close();
}
