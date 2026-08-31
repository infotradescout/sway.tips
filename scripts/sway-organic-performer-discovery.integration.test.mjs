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
const DEFAULT_DRAFT_PERFORMER = '20000000-0000-4000-8000-000000000008';
const LEGACY_SHORT_PERFORMER = '20000000-0000-4000-8000-000000000009';
const LEGACY_LONG_PERFORMER = '20000000-0000-4000-8000-000000000010';
const LEGACY_LONG_HANDLE = `legacy-${'x'.repeat(24)}`;
const LEGACY_SHORT_CANONICAL = 'legacy-short-artist';
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
  '10000000-0000-4000-8000-000000000009'
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function seedDatabase(query) {
  await query(`
    INSERT INTO users (id, email, display_name, role, email_verified_at)
    VALUES
      ('${OWNER_IDS[0]}', 'public@sway.test', 'Public Artist Owner', 'performer', NOW()),
      ('${OWNER_IDS[1]}', 'unlisted@sway.test', 'Unlisted Artist Owner', 'performer', NOW()),
      ('${OWNER_IDS[2]}', 'draft@sway.test', 'Draft Artist Owner', 'performer', NOW()),
      ('${OWNER_IDS[3]}', 'suspended@sway.test', 'Suspended Artist Owner', 'performer', NOW()),
      ('${OWNER_IDS[4]}', 'restricted@sway.test', 'Restricted Artist Owner', 'performer', NOW()),
      ('${OWNER_IDS[5]}', 'inactive@sway.test', 'Inactive Artist Owner', 'performer', NOW()),
      ('${OWNER_IDS[6]}', 'malformed@sway.test', 'Malformed Artist Owner', 'performer', NOW()),
      ('${OWNER_IDS[7]}', 'legacy-short@sway.test', 'Legacy Short Owner', 'performer', NOW()),
      ('${OWNER_IDS[8]}', 'legacy-long@sway.test', 'Legacy Long Owner', 'performer', NOW())
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
      ('${INACTIVE_PERFORMER}', '${OWNER_IDS[5]}', 'InactiveArtist', 'Inactive Artist', 'Inactive biography', false, 'gig_ready', 'public')
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
      ('${PUBLIC_PERFORMER}', 'Canonical headline', '["songwriter","live"]'::jsonb, 'Pensacola', 'https://cdn.test/public.png', '{"canonicalMarker":"yes"}'::jsonb),
      ('${UNLISTED_PERFORMER}', 'Unlisted headline', '["producer"]'::jsonb, 'Mobile', 'https://cdn.test/unlisted.png', '{"canonicalMarker":"unlisted"}'::jsonb)
  `);

  await query(`
    INSERT INTO performer_handle_claims (normalized_handle, performer_id, claim_kind)
    VALUES
      ('publicartist-old', '${PUBLIC_PERFORMER}', 'redirect'),
      ('publicartist-future', '${PUBLIC_PERFORMER}', 'reservation')
  `);

  // Recreate the post-migration shape for pre-policy accounts. New writes may
  // not set legacy_exception, so the disposable fixture bypasses the guards
  // only while inserting the exact state that 0043's locked backfill creates.
  await query(`
    ALTER TABLE performers DISABLE TRIGGER performers_handle_claim_sync;
    ALTER TABLE performer_handle_claims DISABLE TRIGGER performer_handle_claims_identity_guard;

    INSERT INTO performers
      (id, owner_user_id, handle, display_name, bio, is_active, onboarding_status, visibility_state)
    VALUES
      ('${LEGACY_SHORT_PERFORMER}', '${OWNER_IDS[7]}', '3X', 'Legacy Short Artist', 'Legacy short biography', true, 'gig_ready', 'public'),
      ('${LEGACY_LONG_PERFORMER}', '${OWNER_IDS[8]}', '${LEGACY_LONG_HANDLE}', 'Legacy Long Artist', 'Legacy long biography', true, 'gig_ready', 'public');

    INSERT INTO performer_handle_claims
      (normalized_handle, performer_id, claim_kind, legacy_exception)
    VALUES
      ('3x', '${LEGACY_SHORT_PERFORMER}', 'canonical', true),
      ('${LEGACY_LONG_HANDLE}', '${LEGACY_LONG_PERFORMER}', 'canonical', true);

    ALTER TABLE performer_handle_claims ENABLE TRIGGER performer_handle_claims_identity_guard;
    ALTER TABLE performers ENABLE TRIGGER performers_handle_claim_sync;

    UPDATE performers
       SET handle = '${LEGACY_SHORT_CANONICAL}'
     WHERE id = '${LEGACY_SHORT_PERFORMER}';
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

async function request(port, path, redirect = 'follow') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect });
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

    const legacyShortApi = await request(port, '/api/public/performer/3x');
    assert.equal(legacyShortApi.status, 200, 'a grandfathered short redirect must remain reachable');
    assert.equal(legacyShortApi.headers.get('content-location'), `/api/public/performer/${LEGACY_SHORT_CANONICAL}`);
    assert.equal(JSON.parse(legacyShortApi.body).performer.handle, LEGACY_SHORT_CANONICAL);

    const legacyLongApi = await request(port, `/api/public/performer/${LEGACY_LONG_HANDLE}`);
    assert.equal(legacyLongApi.status, 200, 'a grandfathered 31-character canonical handle must remain reachable');
    assert.equal(JSON.parse(legacyLongApi.body).performer.handle, LEGACY_LONG_HANDLE);

    const aliasApi = await request(port, '/api/public/performer/publicartist-old');
    assert.equal(aliasApi.status, 200, 'historical API links must continue resolving');
    assert.equal(aliasApi.headers.get('content-location'), '/api/public/performer/publicartist');
    assert.equal(JSON.parse(aliasApi.body).performer.handle, 'publicartist');

    const aliasShareCard = await request(port, '/api/public/performer/publicartist-old/share-card.png');
    assert.equal(aliasShareCard.status, 200, 'historical share-card links must continue rendering');
    assert.match(aliasShareCard.headers.get('content-type') ?? '', /^image\/png/i);
    assert.equal(
      aliasShareCard.headers.get('content-location'),
      '/api/public/performer/publicartist/share-card.png'
    );

    const reservedShareCard = await request(port, '/api/public/performer/publicartist-future/share-card.png');
    assert.equal(reservedShareCard.status, 404);
    assert.match(
      reservedShareCard.headers.get('cache-control') ?? '',
      /no-store/i,
      'a future share-card reservation must not be negatively cached before promotion'
    );

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
      'publicartist-future',
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

    const aliasHtml = await request(
      port,
      '/p/publicartist-old?utm_source=historical-link',
      'manual'
    );
    assert.equal(aliasHtml.status, 308, 'historical profile links must permanently redirect');
    assert.equal(
      aliasHtml.headers.get('location'),
      '/p/publicartist?utm_source=historical-link',
      'canonical redirects must preserve attribution query parameters'
    );

    const legacyShortHtml = await request(port, '/p/3X?utm_source=grandfathered', 'manual');
    assert.equal(legacyShortHtml.status, 308, 'a grandfathered short redirect must remain permanent');
    assert.equal(
      legacyShortHtml.headers.get('location'),
      `/p/${LEGACY_SHORT_CANONICAL}?utm_source=grandfathered`
    );

    const legacyLongHtml = await request(port, `/p/${LEGACY_LONG_HANDLE}`);
    assert.equal(legacyLongHtml.status, 200, 'a grandfathered long canonical page must remain reachable');
    assert.match(legacyLongHtml.body, /Legacy Long Artist/);

    const legacyAliasHtml = await request(
      port,
      '/publicartist-old?utm_source=legacy-short-link',
      'manual'
    );
    assert.equal(legacyAliasHtml.status, 308, 'legacy short profile links must permanently redirect');
    assert.equal(
      legacyAliasHtml.headers.get('location'),
      '/p/publicartist?utm_source=legacy-short-link',
      'legacy short redirects must preserve attribution query parameters'
    );

    const reservedShortHtml = await request(port, '/publicartist-future', 'manual');
    assert.notEqual(
      reservedShortHtml.status,
      308,
      'a future canonical reservation must not publish a backward permanent redirect'
    );
    assert.equal(reservedShortHtml.headers.get('location'), null);

    const reservedProfileHtml = await request(port, '/p/publicartist-future');
    assert.equal(reservedProfileHtml.status, 404);
    assert.match(
      reservedProfileHtml.headers.get('cache-control') ?? '',
      /no-store/i,
      'a future profile reservation must not be negatively cached before promotion'
    );

    const trackedDiscoverHtml = await request(port, '/discover?utm_source=organic');
    assert.equal(trackedDiscoverHtml.status, 200);
    assert.match(
      trackedDiscoverHtml.body,
      /<link rel="canonical" href="https:\/\/app\.sway\.tips\/discover" \/>/,
      'default discovery canonical must omit query tokens'
    );
    assert.doesNotMatch(trackedDiscoverHtml.body, /utm_source=organic/);

    const unlistedHtml = await request(port, '/p/unlistedartist');
    assert.equal(unlistedHtml.status, 200);
    assert.match(unlistedHtml.headers.get('x-robots-tag') ?? '', /noindex, nofollow/i);
    assert.doesNotMatch(unlistedHtml.body, /application\/ld\+json/);

    const missingHtml = await request(port, '/p/nonexistentartist');
    assert.equal(missingHtml.status, 404);
    for (const blockedHandle of ['draftartist', 'suspendedartist', 'restrictedartist', 'inactiveartist', 'previewonly', 'publicartist-future', 'admin']) {
      const blocked = await request(port, `/p/${blockedHandle}`);
      assert.equal(blocked.status, 404, blockedHandle);
      assert.equal(blocked.body, missingHtml.body, `${blockedHandle} HTML must be indistinguishable from missing`);
    }

    const sitemap = await request(port, '/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.body, /\/p\/publicartist/);
    assert.match(sitemap.body, new RegExp(`/p/${LEGACY_SHORT_CANONICAL}`));
    assert.match(sitemap.body, new RegExp(`/p/${LEGACY_LONG_HANDLE}`));
    assert.doesNotMatch(sitemap.body, /\/p\/3x(?:<|\/)/, 'historical short redirects must not be canonical sitemap entries');
    assert.doesNotMatch(sitemap.body, /unlistedartist|draftartist|suspendedartist|previewonly/);

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
