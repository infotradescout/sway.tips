import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const root = process.cwd();
const PUBLIC_PERFORMER = '20000000-0000-4000-8000-000000000001';
const UNLISTED_PERFORMER = '20000000-0000-4000-8000-000000000002';
const DRAFT_PERFORMER = '20000000-0000-4000-8000-000000000003';
const SUSPENDED_PERFORMER = '20000000-0000-4000-8000-000000000004';
const RESTRICTED_PERFORMER = '20000000-0000-4000-8000-000000000005';
const INACTIVE_PERFORMER = '20000000-0000-4000-8000-000000000006';
const MALFORMED_PERFORMER = '20000000-0000-4000-8000-000000000007';
const DEFAULT_DRAFT_PERFORMER = '20000000-0000-4000-8000-000000000008';
const COMEDIAN_PERFORMER = '20000000-0000-4000-8000-000000000009';
const BARTENDER_PERFORMER = '20000000-0000-4000-8000-000000000010';
const RESERVED_TEST_PERFORMER = '20000000-0000-4000-8000-000000000011';
const UNVERIFIED_PERFORMER = '20000000-0000-4000-8000-000000000012';
const STAFF_PERFORMER = '20000000-0000-4000-8000-000000000013';
const PRO_INACTIVE_PERFORMER = '20000000-0000-4000-8000-000000000014';
const MISSING_PROFILE_PERFORMER = '20000000-0000-4000-8000-000000000015';
const MISSING_BIO_PERFORMER = '20000000-0000-4000-8000-000000000016';
const MISSING_IDENTITY_PERFORMER = '20000000-0000-4000-8000-000000000017';
const BLANK_NAME_PERFORMER = '20000000-0000-4000-8000-000000000018';
const DUPLICATE_OWNER_PERFORMER = '20000000-0000-4000-8000-000000000019';
const PREVIEW_ONLY_ID = '30000000-0000-4000-8000-000000000001';
const JSON_LD_XSS_PAYLOAD = '</script><script>window.__swayJsonLdXss = true</script>';
const OWNER_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007',
  '10000000-0000-4000-8000-000000000008',
  '10000000-0000-4000-8000-000000000009',
  '10000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000011',
  '10000000-0000-4000-8000-000000000012',
  '10000000-0000-4000-8000-000000000013',
  '10000000-0000-4000-8000-000000000014',
  '10000000-0000-4000-8000-000000000015',
  '10000000-0000-4000-8000-000000000016',
  '10000000-0000-4000-8000-000000000017'
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function seedDatabase(query) {
  await query(`
    INSERT INTO users (id, email, display_name, role, email_verified_at, pro_mode_status)
    VALUES
      ('${OWNER_IDS[0]}', 'public@example.com', 'Public Artist Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[1]}', 'unlisted@sway.test', 'Unlisted Artist Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[2]}', 'draft@sway.test', 'Draft Artist Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[3]}', 'suspended@sway.test', 'Suspended Artist Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[4]}', 'restricted@sway.test', 'Restricted Artist Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[5]}', 'inactive@sway.test', 'Inactive Artist Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[6]}', 'malformed@sway.test', 'Malformed Artist Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[7]}', 'comedian@example.com', 'Comedian Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[8]}', 'bartender@example.com', 'Bartender Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[9]}', 'reserved@sway.test', 'Reserved Test Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[10]}', 'unverified@example.com', 'Unverified Owner', 'performer', NULL, 'active'),
      ('${OWNER_IDS[11]}', 'staff@example.com', 'Staff Owner', 'admin', NOW(), 'active'),
      ('${OWNER_IDS[12]}', 'pro-inactive@example.com', 'Inactive Pro Owner', 'performer', NOW(), 'onboarding'),
      ('${OWNER_IDS[13]}', 'missing-profile@example.com', 'Missing Profile Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[14]}', 'missing-bio@example.com', 'Missing Bio Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[15]}', 'missing-identity@example.com', 'Missing Identity Owner', 'performer', NOW(), 'active'),
      ('${OWNER_IDS[16]}', 'blank-name@example.com', 'Blank Name Owner', 'performer', NOW(), 'active')
  `);

  await query(`
    INSERT INTO performers
      (id, owner_user_id, handle, display_name, bio, is_active, onboarding_status, visibility_state)
    VALUES
      ('${PUBLIC_PERFORMER}', '${OWNER_IDS[0]}', 'PublicArtist', 'Public Artist', '${JSON_LD_XSS_PAYLOAD}', true, 'gig_ready', 'public'),
      ('${UNLISTED_PERFORMER}', '${OWNER_IDS[1]}', 'UnlistedArtist', 'Unlisted Artist', 'Direct-link biography', true, 'gig_ready', 'unlisted'),
      ('${DRAFT_PERFORMER}', '${OWNER_IDS[2]}', 'DraftArtist', 'Draft Artist', 'Draft biography', true, 'profile_started', 'draft'),
      ('${SUSPENDED_PERFORMER}', '${OWNER_IDS[3]}', 'SuspendedArtist', 'Suspended Artist', 'Suspended biography', true, 'suspended', 'public'),
      ('${RESTRICTED_PERFORMER}', '${OWNER_IDS[4]}', 'RestrictedArtist', 'Restricted Artist', 'Restricted biography', true, 'restricted', 'public'),
      ('${INACTIVE_PERFORMER}', '${OWNER_IDS[5]}', 'InactiveArtist', 'Inactive Artist', 'Inactive biography', false, 'gig_ready', 'public'),
      ('${MALFORMED_PERFORMER}', '${OWNER_IDS[6]}', 'bad.handle', 'Malformed Artist', 'Malformed biography', true, 'gig_ready', 'public'),
      ('${COMEDIAN_PERFORMER}', '${OWNER_IDS[7]}', 'ComedyNorth', 'Comedy North', 'Stand-up comedian with public audio and live dates.', true, 'gig_ready', 'public'),
      ('${BARTENDER_PERFORMER}', '${OWNER_IDS[8]}', 'PourByAlex', 'Pour by Alex', 'Bartender available for private events and service inquiries.', true, 'gig_ready', 'public'),
      ('${RESERVED_TEST_PERFORMER}', '${OWNER_IDS[9]}', 'ReservedTestPro', 'Reserved Test Pro', 'Complete fixture that must never enter aggregate discovery.', true, 'gig_ready', 'public'),
      ('${UNVERIFIED_PERFORMER}', '${OWNER_IDS[10]}', 'UnverifiedPro', 'Unverified Pro', 'Otherwise complete unverified profile.', true, 'gig_ready', 'public'),
      ('${STAFF_PERFORMER}', '${OWNER_IDS[11]}', 'StaffPro', 'Staff Pro', 'Otherwise complete staff-owned profile.', true, 'gig_ready', 'public'),
      ('${PRO_INACTIVE_PERFORMER}', '${OWNER_IDS[12]}', 'InactiveProMode', 'Inactive Pro Mode', 'Otherwise complete inactive Pro Mode profile.', true, 'gig_ready', 'public'),
      ('${MISSING_PROFILE_PERFORMER}', '${OWNER_IDS[13]}', 'MissingProfile', 'Missing Profile', 'Profile row is deliberately absent.', true, 'gig_ready', 'public'),
      ('${MISSING_BIO_PERFORMER}', '${OWNER_IDS[14]}', 'MissingBio', 'Missing Bio', NULL, true, 'gig_ready', 'public'),
      ('${MISSING_IDENTITY_PERFORMER}', '${OWNER_IDS[15]}', 'MissingIdentity', 'Missing Identity', 'Identity ledger row is deliberately absent.', true, 'gig_ready', 'public'),
      ('${BLANK_NAME_PERFORMER}', '${OWNER_IDS[16]}', 'BlankName', '   ', 'Display name is deliberately blank.', true, 'gig_ready', 'public')
  `);

  await query(`
    INSERT INTO performers
      (id, owner_user_id, handle, display_name, is_active, onboarding_status)
    VALUES ('${DEFAULT_DRAFT_PERFORMER}', '${OWNER_IDS[2]}', 'DefaultDraft', 'Default Draft', true, 'profile_started')
  `);

  await query(`
    INSERT INTO performer_public_profiles
      (performer_id, headline, specialties, city, avatar_url, metadata)
    VALUES
      ('${PUBLIC_PERFORMER}', 'Canonical headline', '["songwriter","live"]'::jsonb, 'Pensacola', 'https://images.example.com/public.png', '{"canonicalMarker":"yes","primaryRole":"songwriter"}'::jsonb),
      ('${UNLISTED_PERFORMER}', 'Unlisted headline', '["producer"]'::jsonb, 'Mobile', 'https://images.example.com/unlisted.png', '{"canonicalMarker":"unlisted","primaryRole":"producer"}'::jsonb),
      ('${COMEDIAN_PERFORMER}', 'Stand-up, stories, and independent audio', '["stand-up","comedy audio"]'::jsonb, 'Chicago', 'https://images.example.com/comedy.png', '{"primaryRole":"comedian"}'::jsonb),
      ('${BARTENDER_PERFORMER}', 'Cocktails and event service', '["cocktails","private events"]'::jsonb, 'Austin', 'https://images.example.com/bartender.png', '{"primaryRole":"bartender"}'::jsonb),
      ('${RESERVED_TEST_PERFORMER}', 'Reserved test headline', '["fixture"]'::jsonb, 'Test City', 'https://images.example.com/test.png', '{"primaryRole":"creator"}'::jsonb),
      ('${UNVERIFIED_PERFORMER}', 'Unverified headline', '["fixture"]'::jsonb, 'Test City', NULL, '{"primaryRole":"creator"}'::jsonb),
      ('${STAFF_PERFORMER}', 'Staff headline', '["fixture"]'::jsonb, 'Test City', NULL, '{"primaryRole":"creator"}'::jsonb),
      ('${PRO_INACTIVE_PERFORMER}', 'Inactive Pro headline', '["fixture"]'::jsonb, 'Test City', NULL, '{"primaryRole":"creator"}'::jsonb),
      ('${MISSING_BIO_PERFORMER}', 'Missing bio headline', '["fixture"]'::jsonb, 'Test City', NULL, '{"primaryRole":"creator"}'::jsonb),
      ('${MISSING_IDENTITY_PERFORMER}', 'Missing identity headline', '["fixture"]'::jsonb, 'Test City', NULL, '{"primaryRole":"creator"}'::jsonb),
      ('${BLANK_NAME_PERFORMER}', 'Blank name headline', '["fixture"]'::jsonb, 'Test City', NULL, '{"primaryRole":"creator"}'::jsonb)
  `);

  await query(`
    INSERT INTO performer_identity_events
      (performer_id, identity_role, identity_kind, custom_label, event_type, actor_user_id, idempotency_key_hash)
    VALUES
      ('${PUBLIC_PERFORMER}', 'primary', 'other', 'Mobile sound engineer', 'selected', '${OWNER_IDS[0]}', repeat('a', 64)),
      ('${COMEDIAN_PERFORMER}', 'primary', 'comedian', NULL, 'selected', '${OWNER_IDS[7]}', repeat('b', 64)),
      ('${BARTENDER_PERFORMER}', 'primary', 'bartender', NULL, 'selected', '${OWNER_IDS[8]}', repeat('c', 64)),
      ('${RESERVED_TEST_PERFORMER}', 'primary', 'creator', NULL, 'selected', '${OWNER_IDS[9]}', repeat('d', 64)),
      ('${UNVERIFIED_PERFORMER}', 'primary', 'creator', NULL, 'selected', '${OWNER_IDS[10]}', repeat('f', 64)),
      ('${STAFF_PERFORMER}', 'primary', 'creator', NULL, 'selected', '${OWNER_IDS[11]}', repeat('1', 64)),
      ('${PRO_INACTIVE_PERFORMER}', 'primary', 'creator', NULL, 'selected', '${OWNER_IDS[12]}', repeat('2', 64)),
      ('${MISSING_PROFILE_PERFORMER}', 'primary', 'creator', NULL, 'selected', '${OWNER_IDS[13]}', repeat('3', 64)),
      ('${MISSING_BIO_PERFORMER}', 'primary', 'creator', NULL, 'selected', '${OWNER_IDS[14]}', repeat('4', 64)),
      ('${BLANK_NAME_PERFORMER}', 'primary', 'creator', NULL, 'selected', '${OWNER_IDS[16]}', repeat('5', 64))
  `);

  await query(`
    INSERT INTO performer_capability_grant_events
      (performer_id, capability, decision, actor_type, reason, evidence, idempotency_key_hash)
    VALUES
      ('${COMEDIAN_PERFORMER}', 'profile_publication', 'granted', 'system', 'Qualified discovery fixture grant', '{"reference":"discovery-comedian-grant"}'::jsonb, repeat('6', 64)),
      ('${BARTENDER_PERFORMER}', 'profile_publication', 'granted', 'system', 'Qualified discovery fixture grant', '{"reference":"discovery-bartender-grant"}'::jsonb, repeat('7', 64))
  `);

  await query(`
    INSERT INTO performer_profile_previews
      (id, handle, display_name, bio, headline, metadata, is_active)
    VALUES
      ('${PREVIEW_ONLY_ID}', 'previewonly', 'Preview Only', 'PREVIEW_ONLY_MARKER', 'Preview headline', '{"previewMarker":"PREVIEW_ONLY_MARKER"}'::jsonb, true)
  `);
}

function startServer(port, databaseUrl) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    HOST: '127.0.0.1',
    SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION: 'true'
  };
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  else env.DATABASE_URL = '';

  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
  return { child, getOutput: () => output };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, 'exit'), sleep(3000)]);
}

async function waitForServer(port, child, getOutput) {
  let lastError = 'server did not become ready';
  // The clean isolated worktree may need more than 20 seconds to initialize
  // Vite, the bundled server, and the disposable database on a cold run.
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (getOutput().includes('EADDRINUSE')) throw new Error(getOutput());
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}\n${getOutput()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/robots.txt`);
      if (response.status === 200) return;
      lastError = `robots status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`${lastError}\n${getOutput()}`);
}

async function request(port, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function main() {
  const proof = await startEmbeddedPostgresProof('performer-discovery');
  let databaseServer;
  let unavailableServer;
  try {
    await seedDatabase(proof.query);

    const defaultDraft = await proof.query(
      `SELECT visibility_state FROM performers WHERE handle = 'DefaultDraft'`
    );
    assert.equal(defaultDraft.rows[0]?.visibility_state, 'draft', 'new performers must default to draft');

    const port = 48100 + Math.floor(Math.random() * 400);
    databaseServer = startServer(port, proof.databaseUrl);
    await waitForServer(port, databaseServer.child, databaseServer.getOutput);

    const publicApi = await request(port, '/api/public/performer/publicartist');
    assert.equal(publicApi.status, 200);
    assert.match(publicApi.body, /Public Artist/);
    assert.doesNotMatch(publicApi.body, /PREVIEW_ONLY_MARKER/);
    const publicApiBody = JSON.parse(publicApi.body);
    assert.equal(publicApiBody.performer.primaryRole, 'other');
    assert.equal(publicApiBody.performer.primaryRoleLabel, 'Mobile sound engineer');

    const unlistedApi = await request(port, '/api/public/performer/unlistedartist');
    assert.equal(unlistedApi.status, 200);

    const missingApi = await request(port, '/api/public/performer/nonexistentartist');
    assert.equal(missingApi.status, 404);
    for (const blockedHandle of [
      'draftartist',
      'suspendedartist',
      'restrictedartist',
      'inactiveartist',
      'previewonly',
      'bad.handle',
      'admin'
    ]) {
      const blocked = await request(port, `/api/public/performer/${blockedHandle}`);
      assert.equal(blocked.status, 404, blockedHandle);
      assert.equal(blocked.body, missingApi.body, `${blockedHandle} must be indistinguishable from missing`);
    }

    const publicHtml = await request(port, '/p/PublicArtist');
    assert.equal(publicHtml.status, 200);
    assert.match(publicHtml.body, /application\/ld\+json/);
    assert.match(publicHtml.body, /Public Artist/);
    assert.match(publicHtml.body, /Mobile sound engineer/);
    assert.ok(!publicHtml.body.includes(JSON_LD_XSS_PAYLOAD), 'HTML must not contain an attacker-controlled literal closing script sequence');
    assert.doesNotMatch(publicHtml.body, /<script>window\.__swayJsonLdXss = true<\/script>/, 'attacker JavaScript must not become a separate script element');
    const jsonLdMatch = publicHtml.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    assert.ok(jsonLdMatch, 'public performer HTML must contain one parseable JSON-LD script');
    const jsonLdPayload = JSON.parse(jsonLdMatch[1]);
    assert.equal(jsonLdPayload.description, JSON_LD_XSS_PAYLOAD, 'malicious fixture text must survive only as inert JSON-LD data');

    const trackedPublicHtml = await request(port, '/p/PublicArtist?utm_source=organic');
    assert.equal(trackedPublicHtml.status, 200);
    assert.match(
      trackedPublicHtml.body,
      /<link rel="canonical" href="https:\/\/app\.sway\.tips\/p\/publicartist" \/>/,
      'public performer canonical must omit query tokens'
    );
    assert.doesNotMatch(trackedPublicHtml.body, /utm_source=organic/);

    const missingGrantFeed = await request(port, '/api/public/feed');
    assert.equal(missingGrantFeed.status, 200);
    assert.equal(JSON.parse(missingGrantFeed.body).professionals.length, 2);
    assert.doesNotMatch(missingGrantFeed.body, /publicartist/i, 'public profile facts alone must not bypass the server publication grant');
    const missingGrantDiscover = await request(port, '/discover');
    assert.match(missingGrantDiscover.headers.get('x-robots-tag') ?? '', /noindex, follow/i);
    assert.doesNotMatch(missingGrantDiscover.body, /Public Artist/);
    const missingGrantSitemap = await request(port, '/sitemap.xml');
    assert.doesNotMatch(missingGrantSitemap.body, /\/p\/publicartist/);
    assert.doesNotMatch(missingGrantSitemap.body, /<loc>https:\/\/app\.sway\.tips\/discover<\/loc>/);

    await proof.query(`
      INSERT INTO performer_capability_grant_events
        (performer_id, capability, decision, actor_type, reason, evidence, idempotency_key_hash)
      VALUES
        ('${PUBLIC_PERFORMER}', 'profile_publication', 'granted', 'system', 'Qualified discovery fixture grant', '{"reference":"discovery-public-artist-grant"}'::jsonb, repeat('8', 64))
    `);

    const trackedDiscoverHtml = await request(port, '/discover?utm_source=organic');
    assert.equal(trackedDiscoverHtml.status, 200);
    assert.match(
      trackedDiscoverHtml.body,
      /<link rel="canonical" href="https:\/\/app\.sway\.tips\/discover" \/>/,
      'default discovery canonical must omit query tokens'
    );
    assert.doesNotMatch(trackedDiscoverHtml.body, /utm_source=organic/);
    assert.equal(
      trackedDiscoverHtml.headers.get('x-robots-tag'),
      null,
      'three qualified durable profiles must release the aggregate discovery index hold'
    );
    for (const [variant, expectedLocation] of [
      ['/discover/', '/discover'],
      ['/DISCOVER?utm_source=organic', '/discover?utm_source=organic'],
      ['/discover/?utm_source=organic', '/discover?utm_source=organic']
    ]) {
      const redirected = await request(port, variant, { redirect: 'manual' });
      assert.equal(redirected.status, 308, `${variant} must redirect permanently to the canonical discovery path`);
      assert.equal(redirected.headers.get('location'), expectedLocation);
    }
    assert.match(trackedDiscoverHtml.body, /id="sway-professional-directory"/);
    assert.match(trackedDiscoverHtml.body, /Comedy North/);
    assert.match(trackedDiscoverHtml.body, /Pour by Alex/);
    assert.match(trackedDiscoverHtml.body, /Public Artist/);
    assert.match(trackedDiscoverHtml.body, /Comedian|Bartender|Songwriter/);
    assert.match(trackedDiscoverHtml.body, /Mobile sound engineer/);
    assert.match(trackedDiscoverHtml.body, /https:\/\/app\.sway\.tips\/p\/comedynorth/);
    assert.match(trackedDiscoverHtml.body, /"@type":"CollectionPage"/);
    assert.match(trackedDiscoverHtml.body, /"@type":"ItemList"/);

    const publicFeed = await request(port, '/api/public/feed');
    assert.equal(publicFeed.status, 200);
    const publicFeedBody = JSON.parse(publicFeed.body);
    assert.equal(publicFeedBody.professionals.length, 3);
    assert.equal('qualifiedProfileCount' in publicFeedBody, false, 'internal index-threshold counts must not leak through the public feed');
    assert.equal('discoverIndexEligible' in publicFeedBody, false, 'internal indexing decisions must not leak through the public feed');
    assert.deepEqual(
      publicFeedBody.professionals.map((professional) => professional.handle).sort(),
      ['comedynorth', 'pourbyalex', 'publicartist'],
      'aggregate discovery must return only directory-qualified public professionals'
    );
    const customProfessional = publicFeedBody.professionals.find((professional) => professional.handle === 'publicartist');
    assert.equal(customProfessional.primaryRole, 'other');
    assert.equal(customProfessional.primaryRoleLabel, 'Mobile sound engineer');
    assert.doesNotMatch(
      JSON.stringify(publicFeedBody.professionals),
      /unlistedartist|draftartist|suspendedartist|restrictedartist|inactiveartist|reservedtestpro|unverifiedpro|staffpro|inactivepromode|missingprofile|missingbio|missingidentity|blankname|previewonly/i,
      'aggregate discovery must not leak unlisted, draft, restricted, inactive, test, unverified, staff, incomplete, identity-less, or preview records'
    );
    assert.doesNotMatch(
      trackedDiscoverHtml.body,
      /Reserved Test Pro|Unverified Pro|Staff Pro|Inactive Pro Mode|Missing Profile|Missing Bio|Missing Identity|Blank Name/i,
      'server-rendered first-response HTML must use the same strict professional qualification policy'
    );
    const visualVerificationHoldMs = Math.max(
      0,
      Math.min(120_000, Number(process.env.SWAY_VISUAL_VERIFICATION_HOLD_MS) || 0)
    );
    if (visualVerificationHoldMs > 0) {
      console.log(`[SWAY_VISUAL_VERIFICATION_READY] http://127.0.0.1:${port}/discover`);
      await sleep(visualVerificationHoldMs);
    }

    const unlistedHtml = await request(port, '/p/unlistedartist');
    assert.equal(unlistedHtml.status, 200);
    assert.match(unlistedHtml.headers.get('x-robots-tag') ?? '', /noindex, nofollow/i);
    assert.doesNotMatch(unlistedHtml.body, /application\/ld\+json/);

    const missingHtml = await request(port, '/p/nonexistentartist');
    assert.equal(missingHtml.status, 404);
    for (const blockedHandle of ['draftartist', 'suspendedartist', 'restrictedartist', 'inactiveartist', 'previewonly', 'admin']) {
      const blocked = await request(port, `/p/${blockedHandle}`);
      assert.equal(blocked.status, 404, blockedHandle);
      assert.equal(blocked.body, missingHtml.body, `${blockedHandle} HTML must be indistinguishable from missing`);
    }

    const sitemap = await request(port, '/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.body, /\/p\/publicartist/);
    assert.match(sitemap.body, /\/p\/comedynorth/);
    assert.match(sitemap.body, /\/p\/pourbyalex/);
    assert.match(sitemap.body, /<loc>https:\/\/app\.sway\.tips\/discover<\/loc>/);
    assert.doesNotMatch(
      sitemap.body,
      /unlistedartist|draftartist|suspendedartist|reservedtestpro|unverifiedpro|staffpro|inactivepromode|missingprofile|missingbio|missingidentity|blankname|previewonly/i
    );

    await proof.query(`
      INSERT INTO performers
        (id, owner_user_id, handle, display_name, bio, is_active, onboarding_status, visibility_state)
      VALUES
        ('${DUPLICATE_OWNER_PERFORMER}', '${OWNER_IDS[7]}', 'ComedySideProfile', 'Comedy Side Profile', 'Duplicate owner subject fixture.', true, 'profile_started', 'draft')
    `);
    const conflictedOwnerFeed = await request(port, '/api/public/feed');
    assert.equal(conflictedOwnerFeed.status, 200);
    assert.equal(JSON.parse(conflictedOwnerFeed.body).professionals.length, 2);
    assert.doesNotMatch(conflictedOwnerFeed.body, /comedynorth/i, 'an owner with multiple performer subjects must fail closed in aggregate discovery');
    const conflictedOwnerDiscover = await request(port, '/discover');
    assert.match(conflictedOwnerDiscover.headers.get('x-robots-tag') ?? '', /noindex, follow/i);
    await proof.query(`DELETE FROM performers WHERE id = '${DUPLICATE_OWNER_PERFORMER}'`);
    const restoredOwnerFeed = await request(port, '/api/public/feed');
    assert.equal(JSON.parse(restoredOwnerFeed.body).professionals.length, 3);

    await proof.query(`
      INSERT INTO performer_capability_grant_events
        (performer_id, capability, decision, actor_type, reason, evidence, idempotency_key_hash)
      VALUES
        ('${BARTENDER_PERFORMER}', 'profile_publication', 'revoked', 'system', 'Exercise revocation fail-closed behavior', '{"reference":"discovery-bartender-revoked"}'::jsonb, repeat('9', 64))
    `);
    const revokedGrantFeed = await request(port, '/api/public/feed');
    assert.equal(JSON.parse(revokedGrantFeed.body).professionals.length, 2);
    assert.doesNotMatch(revokedGrantFeed.body, /pourbyalex/i);
    assert.match((await request(port, '/discover')).headers.get('x-robots-tag') ?? '', /noindex, follow/i);

    await proof.query(`
      INSERT INTO performer_capability_grant_events
        (performer_id, capability, decision, actor_type, reason, evidence, idempotency_key_hash)
      VALUES
        ('${BARTENDER_PERFORMER}', 'profile_publication', 'denied', 'system', 'Exercise latest denial behavior', '{"reference":"discovery-bartender-denied"}'::jsonb, repeat('a', 64))
    `);
    const deniedGrantFeed = await request(port, '/api/public/feed');
    assert.equal(JSON.parse(deniedGrantFeed.body).professionals.length, 2);
    assert.doesNotMatch(deniedGrantFeed.body, /pourbyalex/i);

    await proof.query(`
      INSERT INTO performer_capability_grant_events
        (performer_id, capability, decision, actor_type, reason, evidence, idempotency_key_hash)
      VALUES
        ('${BARTENDER_PERFORMER}', 'profile_publication', 'granted', 'system', 'Restore qualified discovery fixture', '{"reference":"discovery-bartender-restored"}'::jsonb, repeat('b', 64))
    `);
    assert.equal(JSON.parse((await request(port, '/api/public/feed')).body).professionals.length, 3);

    await proof.query(`
      INSERT INTO performer_capability_grant_events
        (performer_id, capability, decision, actor_type, reason, evidence, idempotency_key_hash)
      VALUES
        ('${BARTENDER_PERFORMER}', 'profile_publication', 'revoked', 'system', 'Prepare time-bound grant proof', '{"reference":"discovery-bartender-timebound-revoke"}'::jsonb, repeat('c', 64))
    `);
    await proof.query(`
      INSERT INTO performer_capability_grant_events
        (performer_id, capability, decision, actor_type, reason, evidence, expires_at, idempotency_key_hash, created_at)
      VALUES
        ('${BARTENDER_PERFORMER}', 'profile_publication', 'granted', 'system', 'Expired time-bound discovery grant', '{"reference":"discovery-bartender-timebound"}'::jsonb, NOW() - INTERVAL '1 minute', repeat('d', 64), NOW() - INTERVAL '2 minutes')
    `);
    const naturallyExpiredGrantFeed = await request(port, '/api/public/feed');
    assert.equal(JSON.parse(naturallyExpiredGrantFeed.body).professionals.length, 2);
    assert.doesNotMatch(naturallyExpiredGrantFeed.body, /pourbyalex/i, 'an elapsed grant expiry must fail closed even before an explicit expiry event');

    await proof.query(`
      INSERT INTO performer_capability_grant_events
        (performer_id, capability, decision, actor_type, reason, evidence, idempotency_key_hash)
      VALUES
        ('${BARTENDER_PERFORMER}', 'profile_publication', 'expired', 'system', 'Record elapsed discovery grant', '{"reference":"discovery-bartender-expired"}'::jsonb, repeat('e', 64))
    `);
    assert.equal(JSON.parse((await request(port, '/api/public/feed')).body).professionals.length, 2);
    await proof.query(`
      INSERT INTO performer_capability_grant_events
        (performer_id, capability, decision, actor_type, reason, evidence, idempotency_key_hash)
      VALUES
        ('${BARTENDER_PERFORMER}', 'profile_publication', 'granted', 'system', 'Restore qualified discovery after expiry proof', '{"reference":"discovery-bartender-final-grant"}'::jsonb, repeat('f', 64))
    `);
    assert.equal(JSON.parse((await request(port, '/api/public/feed')).body).professionals.length, 3);

    await proof.query(`UPDATE users SET pro_mode_status = 'onboarding' WHERE id = '${OWNER_IDS[8]}'`);
    const heldFeed = await request(port, '/api/public/feed');
    assert.equal(heldFeed.status, 200);
    const heldFeedBody = JSON.parse(heldFeed.body);
    assert.equal(heldFeedBody.professionals.length, 2);
    assert.doesNotMatch(JSON.stringify(heldFeedBody.professionals), /pourbyalex/i);

    const heldDiscover = await request(port, '/discover');
    assert.equal(heldDiscover.status, 200);
    assert.match(heldDiscover.headers.get('x-robots-tag') ?? '', /noindex, follow/i);
    const heldSitemap = await request(port, '/sitemap.xml');
    assert.equal(heldSitemap.status, 200);
    assert.doesNotMatch(heldSitemap.body, /<loc>https:\/\/app\.sway\.tips\/discover<\/loc>/);
    assert.doesNotMatch(heldSitemap.body, /\/p\/pourbyalex/);

    await proof.query(`UPDATE users SET pro_mode_status = 'active' WHERE id = '${OWNER_IDS[8]}'`);
    await proof.query(`
      INSERT INTO performer_identity_events
        (performer_id, identity_role, identity_kind, custom_label, event_type, actor_user_id, idempotency_key_hash)
      VALUES
        ('${BARTENDER_PERFORMER}', 'primary', 'bartender', NULL, 'withdrawn', '${OWNER_IDS[8]}', repeat('e', 64))
    `);
    const withdrawnIdentityFeed = await request(port, '/api/public/feed');
    assert.equal(withdrawnIdentityFeed.status, 200);
    assert.equal(JSON.parse(withdrawnIdentityFeed.body).professionals.length, 2);
    assert.doesNotMatch(withdrawnIdentityFeed.body, /pourbyalex/i, 'stale public-profile metadata must not override a withdrawn ledger identity');
    const withdrawnIdentityProfile = await request(port, '/api/public/performer/pourbyalex');
    assert.equal(withdrawnIdentityProfile.status, 200);
    const withdrawnIdentityProfileBody = JSON.parse(withdrawnIdentityProfile.body);
    assert.equal(withdrawnIdentityProfileBody.performer.primaryRole, null);
    assert.equal(withdrawnIdentityProfileBody.performer.primaryRoleLabel, null);
    const withdrawnIdentityDiscover = await request(port, '/discover');
    assert.match(withdrawnIdentityDiscover.headers.get('x-robots-tag') ?? '', /noindex, follow/i);

    await proof.query(`
      UPDATE users
      SET pro_mode_status = 'onboarding'
      WHERE id IN ('${OWNER_IDS[0]}', '${OWNER_IDS[7]}')
    `);
    const emptyQualifiedFeed = await request(port, '/api/public/feed');
    assert.equal(emptyQualifiedFeed.status, 200);
    assert.deepEqual(JSON.parse(emptyQualifiedFeed.body).professionals, []);
    const emptyQualifiedDiscover = await request(port, '/discover');
    assert.equal(emptyQualifiedDiscover.status, 200);
    assert.match(emptyQualifiedDiscover.headers.get('x-robots-tag') ?? '', /noindex, follow/i);
    assert.match(emptyQualifiedDiscover.body, /No qualified public professional profiles are listed right now/);
    assert.doesNotMatch(emptyQualifiedDiscover.body, /Comedy North|Pour by Alex|Public Artist/);
    const emptyQualifiedSitemap = await request(port, '/sitemap.xml');
    assert.equal(emptyQualifiedSitemap.status, 200);
    assert.doesNotMatch(emptyQualifiedSitemap.body, /<loc>https:\/\/app\.sway\.tips\/discover<\/loc>/);
    assert.doesNotMatch(emptyQualifiedSitemap.body, /\/p\/(?:publicartist|comedynorth|pourbyalex)/);

    const robots = await request(port, '/robots.txt');
    const llms = await request(port, '/llms.txt');
    assert.equal(robots.status, 200);
    assert.equal(llms.status, 200);
    assert.doesNotMatch(llms.body, /publicartist|unlistedartist|previewonly/i);

    await stopServer(databaseServer.child);
    databaseServer = undefined;

    const unavailablePort = 48500 + Math.floor(Math.random() * 400);
    unavailableServer = startServer(unavailablePort);
    await waitForServer(unavailablePort, unavailableServer.child, unavailableServer.getOutput);
    for (const path of ['/api/public/performer/publicartist', '/p/publicartist', '/sitemap.xml']) {
      const unavailable = await request(unavailablePort, path);
      assert.equal(unavailable.status, 503, path);
    }
    const unavailableDiscover = await request(unavailablePort, '/discover');
    assert.equal(unavailableDiscover.status, 503);
    assert.match(unavailableDiscover.headers.get('x-robots-tag') ?? '', /noindex, follow/i);
    assert.equal(unavailableDiscover.headers.get('retry-after'), '300');
    assert.equal((await request(unavailablePort, '/robots.txt')).status, 200);
    assert.equal((await request(unavailablePort, '/llms.txt')).status, 200);

    console.log('PASS sway-organic-performer-discovery integration');
  } finally {
    if (databaseServer) await stopServer(databaseServer.child);
    if (unavailableServer) await stopServer(unavailableServer.child);
    await proof.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
