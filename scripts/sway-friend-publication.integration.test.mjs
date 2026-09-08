import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';
import { createSwayDb, closeDisposableSwayDbProof } from '../src/db/client.ts';
import { createPerformerLoginChallengeStore } from '../src/server/performer-login.ts';

const targets = [
  ['b1b0e4d9-d4a8-4526-b49a-f5c4e464cfcd', '87b3512f-a5a6-4b1f-b80b-1a94f9575a98', '34607bf4-37ca-43d5-b61f-3d684a410e32', 'bubbakhain', 'Bubba Khain', 'https://sway.tips/assets/bubba-khain-avatar.jpg'],
  ['ed8116ce-8255-4ff8-bfec-6a57ec9568cf', '7e78b206-060e-4fed-bb77-6d45113a3b4b', '51e64828-fc4d-4e60-a743-afd993674141', 'calliehines', 'Callie Hines', 'https://sway.tips/assets/callie-hines-avatar.jpg'],
  ['da855e85-9f7a-469e-9d9d-8c8e1ce20b96', 'e66685f1-885b-47c0-ac05-a4cf1e623087', '59a1b6cf-854e-47f2-aa8f-d1424abe868c', 'coreymack', 'Corey Mack', 'https://img1.wsimg.com/isteam/ip/507cdd9e-ba65-48f1-ac5c-290e6c33023b/72E6855B-ABEB-492D-8EA4-0DAB48CAA65E.jpeg'],
  ['bc1c60c2-2ec1-4967-ad2f-b099adfcbb7c', 'bb5a762c-4a0f-47c2-bba9-bb83590764e9', 'd834d8c0-3374-4ec9-bea8-93419fd6df0e', 'drewmaze', 'Drew Maze', 'https://sway.tips/assets/drew-maze-avatar.jpg']
];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const migration = readFileSync('drizzle/0051_friend_public_profiles.sql', 'utf8');
const enrollment = readFileSync('drizzle/0050_automatic_affiliates.sql', 'utf8');
const friendGrants = enrollment.slice(enrollment.indexOf('-- Five explicitly')).split('--> statement-breakpoint')[0];
const proof = await startEmbeddedPostgresProof('friend-publication');
const db = createSwayDb(proof.databaseUrl);
const challenges = createPerformerLoginChallengeStore({ databaseUrl: proof.databaseUrl, dbOverride: db });
let child;
let browser;
let output = '';
try {
  for (const [id, owner, preview, handle, name, avatar] of targets) {
    await proof.query('INSERT INTO users(id, email, display_name, role) VALUES ($1, $2, $3, $4)', [owner, `${handle}@sway.test`, name, 'performer']);
    await proof.query('INSERT INTO performers(id, owner_user_id, handle, display_name) VALUES ($1, $2, $3, $4)', [id, owner, handle, name]);
    await proof.query('INSERT INTO performer_profile_previews(id, claimed_performer_id, handle, display_name, avatar_url, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb)', [preview, id, handle, name, avatar, JSON.stringify({ stageName: name })]);
  }
  const accountBefore = (await proof.query('SELECT * FROM users ORDER BY id')).rows;
  const privateBefore = (await proof.query('SELECT id, owner_user_id, onboarding_status, payment_account_status, kyc_status, payouts_enabled, charges_enabled FROM performers ORDER BY id')).rows;
  // Deliberately make the LAST target conflict. A failure must roll back
  // earlier targets in the same publication statement, not publish a subset.
  await proof.query("UPDATE performers SET bio = 'Intervening owner edit' WHERE handle = 'drewmaze'");
  await assert.rejects(proof.query(migration), /draft state changed/);
  assert.equal((await proof.query('SELECT count(*)::int AS n FROM performer_public_profiles')).rows[0].n, 0);
  assert.equal((await proof.query("SELECT count(*)::int AS n FROM performers WHERE visibility_state = 'public'")).rows[0].n, 0);
  await proof.query("UPDATE performers SET bio = NULL WHERE handle = 'drewmaze'");
  await proof.query(migration);
  await proof.query(friendGrants);
  assert.deepEqual((await proof.query('SELECT * FROM users ORDER BY id')).rows, accountBefore, 'publishing must not forge account state');
  assert.deepEqual((await proof.query('SELECT id, owner_user_id, onboarding_status, payment_account_status, kyc_status, payouts_enabled, charges_enabled FROM performers ORDER BY id')).rows, privateBefore, 'onboarding and money capabilities unchanged');
  assert.equal((await proof.query('SELECT count(*)::int AS n FROM performer_partner_terms_acceptances')).rows[0].n, 0);
  assert.equal((await proof.query('SELECT count(*)::int AS n FROM affiliate_accounts')).rows[0].n, 4);
  assert.deepEqual((await proof.query('SELECT sway_affiliate_rate_bps(owner_user_id) AS rate FROM performers')).rows.map((row) => row.rate), [2000, 2000, 2000, 2000]);
  const after = (await proof.query("SELECT jsonb_build_object('performers', (SELECT jsonb_agg(p ORDER BY id) FROM performers p), 'profiles', (SELECT jsonb_agg(p ORDER BY performer_id) FROM performer_public_profiles p), 'links', (SELECT jsonb_agg(l ORDER BY id) FROM performer_profile_links l), 'audits', (SELECT jsonb_agg(a ORDER BY event_id) FROM audit_events a)) AS snapshot")).rows[0].snapshot;
  await proof.query(migration);
  assert.deepEqual((await proof.query("SELECT jsonb_build_object('performers', (SELECT jsonb_agg(p ORDER BY id) FROM performers p), 'profiles', (SELECT jsonb_agg(p ORDER BY performer_id) FROM performer_public_profiles p), 'links', (SELECT jsonb_agg(l ORDER BY id) FROM performer_profile_links l), 'audits', (SELECT jsonb_agg(a ORDER BY event_id) FROM audit_events a)) AS snapshot")).rows[0].snapshot, after, 'replay must be a true no-op');

  const port = 47600 + Math.floor(Math.random() * 300);
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', DATABASE_URL: proof.databaseUrl, SWAY_EMAIL_PROVIDER: 'mock', SWAY_PERFORMER_SIGNUP_RATE_LIMIT_MAX: '100', SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let ready = false;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${base}/robots.txt`)).ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  assert.ok(ready, output);
  for (const [, , , handle, name] of targets) {
    const response = await fetch(`${base}/api/public/performer/${handle}`);
    assert.equal(response.status, 200, handle);
    const data = await response.json();
    assert.equal(data.performer.displayName, name);
    assert.equal(data.performer.partner.active, true);
    assert.equal(data.performer.partner.kind, 'partner');
    assert.ok(data.performer.bio.length > 80);
    assert.ok(data.performer.links.length >= 2);
    assert.ok(!('email' in data.performer) && !('ownerUserId' in data.performer) && !('metadata' in data.performer));
    assert.equal(data.activeRoom, null);
    assert.deepEqual(data.events, []);
    const html = await (await fetch(`${base}/p/${handle}`)).text();
    assert.ok(html.includes(`https://app.sway.tips/p/${handle}`));
    assert.ok(html.includes(name));
  }
  assert.match((await (await fetch(`${base}/api/public/performer/drewmaze`)).json()).performer.bio, /owner of Lo-Ram Studios, a new record label/);
  const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
  const directory = (await (await fetch(`${base}/api/public/feed`)).json()).performerDirectory;
  for (const [, , , handle] of targets) {
    assert.ok(sitemap.includes(`https://app.sway.tips/p/${handle}`));
    assert.ok(directory.performers.some((performer) => performer.handle === handle), `directory includes ${handle}`);
  }
  assert.equal((await fetch(`${base}/api/account/affiliate`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/sway-membership`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ performerId: targets[0][0], isFriend: true, isPartner: true, isExclusive: true, reason: 'untrusted upgrade' }) })).status, 401);
  mkdirSync('tmp/friend-profile-proof', { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const [, , , handle, name] of targets) {
    await page.goto(`${base}/p/${handle}`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Sway Partner', { exact: true }).waitFor({ state: 'visible' });
    assert.ok((await page.locator('body').innerText()).includes(name));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${handle} mobile overflow`);
    await page.screenshot({ path: `tmp/friend-profile-proof/${handle}-mobile.png`, fullPage: true });
  }
  // Exercise the real account and claim endpoints after publication, without
  // sending mail or touching an external account. All identities are local fixtures.
  const referrerId = targets[2][1];
  const refCode = (await proof.query('SELECT code FROM affiliate_accounts WHERE user_id = $1', [referrerId])).rows[0].code;
  const refCookie = `sway_affiliate_ref=${refCode}`;
  const password = 'Sway-Referral-Proof-123!';
  const post = (path, body, cookie = refCookie) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ password, confirmPassword: password, termsAccepted: true, ...body }) });
  const attribution = async (owner) => (await proof.query('SELECT a.user_id FROM affiliate_referrals r JOIN affiliate_accounts a ON a.id = r.affiliate_account_id WHERE r.referred_user_id = $1', [owner])).rows;
  const signup = await post('/api/account/signup', { displayName: 'Referred fixture', email: 'referred-signup@sway.test' });
  assert.equal(signup.status, 202, await signup.text());
  const newUser = (await proof.query("SELECT id FROM users WHERE email = 'referred-signup@sway.test'")).rows[0].id;
  assert.deepEqual(await attribution(newUser), [{ user_id: referrerId }]);
  const issue = async (target, type = 'claim_code') => challenges.issueChallenge({ actorUserId: target[1], targetEmail: `${target[3]}@sway.test`, challengeType: type, requesterIpHash: 'disposable-referral-proof', challengeMetadata: { performerId: target[0], activateAfterSetup: true, onboardingStatus: 'gig_ready' } });
  const bubbaClaim = await issue(targets[0]);
  const bubba = await post('/api/account/signup', { claimCode: bubbaClaim.token, displayName: targets[0][4], email: 'bubba-claimed@sway.test' });
  assert.equal(bubba.status, 200, await bubba.text());
  assert.deepEqual(await attribution(targets[0][1]), [{ user_id: referrerId }]);
  const repeat = await post('/api/account/signup', { claimCode: bubbaClaim.token, displayName: targets[0][4], email: 'bubba-claimed@sway.test' });
  assert.ok(repeat.status >= 400, 'used claim code cannot bind again');
  assert.deepEqual(await attribution(targets[0][1]), [{ user_id: referrerId }]);
  const callieClaim = await issue(targets[1]);
  await proof.query("UPDATE performers SET stripe_connected_account_id = 'acct_disposable_claim_block' WHERE id = $1", [targets[1][0]]);
  const denied = await post('/api/talent/claim/accept', { token: callieClaim.token, email: 'callie-claimed@sway.test' });
  assert.ok(denied.status >= 400, 'claim with payout identity is rejected');
  assert.deepEqual(await attribution(targets[1][1]), [], 'rejected claim rolls back referral');
  assert.equal((await proof.query('SELECT password_hash FROM users WHERE id = $1', [targets[1][1]])).rows[0].password_hash, null);
  await proof.query('UPDATE performers SET stripe_connected_account_id = NULL WHERE id = $1', [targets[1][0]]);
  const callie = await post('/api/talent/claim/accept', { token: callieClaim.token, email: 'callie-claimed@sway.test' });
  assert.equal(callie.status, 200, await callie.text());
  assert.deepEqual(await attribution(targets[1][1]), [{ user_id: referrerId }]);
  const drewInvite = await issue(targets[3], 'account_invite');
  const drew = await post('/api/talent/invite/accept', { token: drewInvite.token });
  assert.equal(drew.status, 200, await drew.text());
  assert.deepEqual(await attribution(targets[3][1]), [{ user_id: referrerId }]);
  await proof.query("UPDATE users SET password_hash = 'existing-fixture-credential', email_verified_at = now(), terms_accepted_at = now() WHERE id = $1", [referrerId]);
  const coreyClaim = await issue(targets[2]);
  const otherCode = (await proof.query('SELECT code FROM affiliate_accounts WHERE user_id = $1', [targets[0][1]])).rows[0].code;
  const existing = await post('/api/talent/claim/accept', { token: coreyClaim.token, email: 'corey-handoff@sway.test' }, `sway_affiliate_ref=${otherCode}`);
  assert.equal(existing.status, 200, await existing.text());
  assert.deepEqual(await attribution(referrerId), [], 'established handoff is not a newly attributed account');
  const accountCookies = bubba.headers.getSetCookie().map((value) => { const pair = value.split(';')[0]; const equals = pair.indexOf('='); return { name: pair.slice(0, equals), value: pair.slice(equals + 1), url: base }; });
  await page.context().addCookies(accountCookies);
  await page.goto(`${base}/account`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Copy invite link', exact: true }).waitFor({ state: 'visible' });
  assert.ok((await page.locator('body').innerText()).includes('20% of eligible Sway platform fees'));
  assert.ok((await page.locator('body').innerText()).includes('Affiliate cash-out is not available yet.'));
  // An owner can subsequently unpublish; replay must never undo the choice.
  await proof.query("UPDATE performers SET visibility_state = 'unlisted' WHERE handle = 'bubbakhain'");
  await proof.query(migration);
  assert.equal((await proof.query("SELECT visibility_state FROM performers WHERE handle = 'bubbakhain'")).rows[0].visibility_state, 'unlisted');
  console.log('Friend publication: migration guards, account preservation, replay, four public pages, sitemap, directory, mobile browser, ordinary signup, all first-claim paths, rejected claim rollback, established handoff, affiliate UI, and later owner unpublish PASS.');
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), delay(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  await closeDisposableSwayDbProof(proof.databaseUrl);
  await proof.close();
}
