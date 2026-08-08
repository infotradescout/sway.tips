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
const PREVIEW_ONLY_ID = '30000000-0000-4000-8000-000000000001';
const JSON_LD_XSS_PAYLOAD = '</script><script>window.__swayJsonLdXss = true</script>';
const OWNER_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000007'
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
      ('${OWNER_IDS[6]}', 'malformed@sway.test', 'Malformed Artist Owner', 'performer', NOW())
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
      ('${MALFORMED_PERFORMER}', '${OWNER_IDS[6]}', 'bad.handle', 'Malformed Artist', 'Malformed biography', true, 'gig_ready', 'public')
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
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

async function request(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
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
    assert.ok(!publicHtml.body.includes(JSON_LD_XSS_PAYLOAD), 'HTML must not contain an attacker-controlled literal closing script sequence');
    assert.doesNotMatch(publicHtml.body, /<script>window\.__swayJsonLdXss = true<\/script>/, 'attacker JavaScript must not become a separate script element');
    const jsonLdMatch = publicHtml.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    assert.ok(jsonLdMatch, 'public performer HTML must contain one parseable JSON-LD script');
    const jsonLdPayload = JSON.parse(jsonLdMatch[1]);
    assert.equal(jsonLdPayload.description, JSON_LD_XSS_PAYLOAD, 'malicious fixture text must survive only as inert JSON-LD data');

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
