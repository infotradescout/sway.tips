import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { Client } from 'pg';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';
import { hashPerformerPassword } from '../src/server/performer-password-auth.ts';

// No real account, provider, or database credentials are accepted. The shared
// helper optionally accepts a separately attested, disposable loopback PG URL.
assert.notEqual(process.env.NODE_ENV, 'production');
const forbidden = Object.keys(process.env).filter((name) => (
  (name.endsWith('DATABASE_URL') && name !== 'SWAY_REAL_POSTGRES_PROOF_DATABASE_URL')
  || /^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SWAY_EMAIL_API_KEY)$/.test(name)
  || /PAYPAL.*(?:SECRET|TOKEN)$/.test(name)
) && Boolean(process.env[name]?.trim()));
assert.deepEqual(forbidden, [], 'Real database and provider credentials are forbidden.');
const allSections = ['identity', 'about', 'live', 'events', 'releases', 'media', 'links', 'booking', 'social'];
const musicOrder = ['identity', 'releases', 'links', 'media', 'live', 'events', 'about', 'booking', 'social'];
const stageOrder = ['identity', 'media', 'events', 'booking', 'live', 'about', 'links', 'releases', 'social'];
const customOrder = [...allSections].reverse();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const proof = await startEmbeddedPostgresProof('public_profile_layout');
let server;
let startupOutput = '';
let serverErrors = '';
let ready = false;
const passed = [];
const record = (label) => { passed.push(label); console.log(`SWAY_PROFILE_LAYOUT_PASS ${label}`); };
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await Promise.race([exited, delay(5_000)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL');
    await Promise.race([exited, delay(5_000)]);
  }
}
try {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const password = 'SyntheticLayout-Proof-2026!';
  const passwordHash = await hashPerformerPassword(password);
  const actor = (name) => ({ id: randomUUID(), performerId: randomUUID(), handle: `layout-${name}`, email: `layout-${name}@example.test` });
  const owner = actor('owner');
  const other = actor('other');
  const sibling = { performerId: randomUUID(), handle: 'layout-sibling' };
  for (const item of [owner, other]) {
    await proof.query("INSERT INTO users(id,email,display_name,role,password_hash,email_verified_at,terms_accepted_at) VALUES($1,$2,$3,'performer',$4,now(),now())", [item.id, item.email, item.handle, passwordHash]);
    await proof.query("INSERT INTO performers(id,owner_user_id,handle,display_name,bio,visibility_state,is_active) VALUES($1,$2,$3,$3,'Synthetic local public profile.','public',true)", [item.performerId, item.id, item.handle]);
  }
  await proof.query("INSERT INTO performers(id,owner_user_id,handle,display_name,bio,visibility_state,is_active) VALUES($1,$2,$3,$3,'Separate synthetic local public profile.','public',true)", [sibling.performerId, owner.id, sibling.handle]);
  const metadataBefore = {
    roles: ['musician', 'producer'], primaryRole: 'musician', stageName: 'Synthetic public stage name',
    customSource: { preserved: true, nested: ['private metadata must stay server-side'] }
  };
  await proof.query('INSERT INTO performer_public_profiles(performer_id,metadata,booking_email,city) VALUES($1,$2::jsonb,$3,$4)', [owner.performerId, JSON.stringify(metadataBefore), 'private-booking@example.test', 'Synthetic city']);
  server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: proof.databaseUrl,
      SWAY_APP_BASE_URL: base, APP_URL: base, APP_BASE_URL: base, SWAY_EMAIL_PROVIDER: '', SWAY_EMAIL_API_KEY: '',
      SWAY_EMAIL_FROM: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_PUBLISHABLE_KEY: '',
      VITE_STRIPE_PUBLISHABLE_KEY: '', SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED: 'false', SWAY_NATIVE_TICKETS_ENABLED: 'false',
      SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED: 'false', SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED: 'false',
      SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED: 'false', SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const drain = (chunk) => { if (!ready) startupOutput = (startupOutput + chunk).slice(-8_000); };
  server.stdout.on('data', drain);
  server.stderr.on('data', (chunk) => {
    drain(chunk);
    serverErrors = (serverErrors + chunk).slice(-12_000);
  });
  // A cold tsx/Vite startup can overlap other release checks on the same host.
  // Keep a bounded deadline and continue to fail immediately on process exit.
  const readinessDeadline = Date.now() + 90_000;
  while (Date.now() < readinessDeadline) {
    if (server.exitCode !== null) throw new Error(`Local server exited before readiness: ${startupOutput}`);
    try {
      if ((await fetch(`${base}/api/health/network-probe`, { signal: AbortSignal.timeout(1_000) })).status === 204) { ready = true; break; }
    } catch { /* Wait for the fresh local listener. */ }
    await delay(100);
  }
  assert.ok(ready, `Local server did not become ready: ${startupOutput}`);
  const request = async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      const diagnostics = serverErrors.split(/\r?\n/)
        .filter((line) => /^(?:Error:|\s*severity:|\s*code:)|Unhandled 'error' event|unexpected commandComplete/.test(line))
        .slice(-12).join('\n');
      throw new Error(`Local ${method} ${path} failed; server exit=${server.exitCode}, signal=${server.signalCode}. ${diagnostics}`, { cause: error });
    }
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login = async (item) => {
    const response = await request('/api/account/login', { method: 'POST', body: { email: item.email, password } });
    assert.equal(response.status, 200, 'Synthetic account login succeeds through the actual HTTP route.');
    const cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
    assert.ok(cookie);
    return cookie;
  };
  const ownerCookie = await login(owner);
  const otherCookie = await login(other);
  const getLayout = (handle = owner.handle, cookie = ownerCookie) => request(`/api/talent/profile/layout?handle=${encodeURIComponent(handle)}`, { cookie });
  const saveLayout = (sectionOrder, expectedRevision, { handle = owner.handle, cookie = ownerCookie, extra = {} } = {}) => request('/api/talent/profile/layout', {
    method: 'POST', cookie, body: { handle, sectionOrder, expectedRevision, ...extra }
  });
  const storedProfile = async () => (await proof.query('SELECT * FROM performer_public_profiles WHERE performer_id=$1', [owner.performerId])).rows[0];
  const auditRows = async () => (await proof.query("SELECT actor_id,event_type,metadata FROM audit_events WHERE event_type='performer_public_profile.layout_update' ORDER BY created_at,event_id")).rows;
  const publicLayout = async () => {
    const response = await request(`/api/public/performer/${owner.handle}`);
    assert.equal(response.status, 200);
    return response.data.performer.layout;
  };
  const initial = await getLayout();
  assert.equal(initial.status, 200);
  assert.deepEqual(Object.keys(initial.data).sort(), ['handle', 'layout']);
  assert.deepEqual(initial.data.layout, { sectionOrder: musicOrder, customized: false, revision: 0 });
  assert.deepEqual(await publicLayout(), initial.data.layout);
  assert.deepEqual((await getLayout(sibling.handle)).data.layout, { sectionOrder: allSections, customized: false, revision: 0 });
  assert.equal((await request(`/api/talent/profile/layout?handle=${owner.handle}`)).status, 401);
  assert.equal((await saveLayout(customOrder, 0, { cookie: '' })).status, 401);
  assert.equal((await getLayout(owner.handle, otherCookie)).status, 403);
  assert.equal((await saveLayout(customOrder, 0, { cookie: otherCookie })).status, 403);
  assert.equal((await request(`/api/talent/profile/layout?handle=${owner.handle}`, { headers: { 'x-sway-actor-id': owner.id, 'x-sway-actor-type': 'performer' } })).status, 401);
  record('owner-scope-anonymous-other-actor-forged-header-and-safe-dto');

  const untouched = await storedProfile();
  for (const value of [[], ['identity', 'identity'], ['invented'], 'media', {}, [1], ['identity', null]]) {
    assert.equal((await saveLayout(value, 0)).status, 422);
  }
  for (const revision of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await saveLayout(customOrder, revision)).status, 422);
  }
  assert.equal((await saveLayout(customOrder, 0, { handle: '../owner' })).status, 422);
  assert.equal((await saveLayout(customOrder, 0, { extra: { performerId: other.performerId } })).status, 422);
  assert.equal((await request('/api/talent/profile/layout', { method: 'POST', cookie: ownerCookie, body: { handle: owner.handle, expectedRevision: 0 } })).status, 422);
  assert.deepEqual(await storedProfile(), untouched);
  assert.deepEqual(await auditRows(), []);
  record('invalid-orders-revisions-and-arbitrary-targets-rejected-without-writes');

  const saved = await saveLayout(customOrder, 0);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.layout, { sectionOrder: customOrder, customized: true, revision: 1 });
  assert.deepEqual((await getLayout()).data.layout, saved.data.layout);
  assert.deepEqual(await publicLayout(), saved.data.layout);
  const profileAfter = await storedProfile();
  assert.deepEqual(profileAfter.metadata, { ...metadataBefore, publicProfileLayout: { sectionOrder: customOrder, revision: 1 } });
  for (const field of Object.keys(untouched).filter((key) => !['metadata', 'updated_at'].includes(key))) {
    assert.deepEqual(profileAfter[field], untouched[field], `${field} is not changed by layout save`);
  }
  const afterSaveAudits = await auditRows();
  assert.equal(afterSaveAudits.length, 1);
  assert.equal(afterSaveAudits[0].actor_id, owner.id);
  assert.equal(afterSaveAudits[0].metadata.revision, 1);
  assert.equal((await saveLayout(musicOrder, 0)).status, 409);
  assert.deepEqual((await saveLayout(null, 0)).data.layout, saved.data.layout);
  assert.deepEqual(await storedProfile(), profileAfter);
  assert.equal((await auditRows()).length, 1);
  assert.equal((await getLayout(sibling.handle)).data.layout.revision, 0);
  record('persisted-public-roundtrip-identity-can-move-stale-conflict-and-unrelated-data-preserved');

  const reset = await saveLayout(null, 1);
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data.layout, { sectionOrder: musicOrder, customized: false, revision: 2 });
  const fullProfileBody = { roles: ['comedian', 'musician'], stageName: 'Updated synthetic stage name', headline: 'Updated synthetic headline', bio: 'Updated synthetic biography.' };
  const fullSave = await request('/api/talent/profile/public', { method: 'POST', cookie: ownerCookie, body: fullProfileBody });
  assert.equal(fullSave.status, 202);
  assert.deepEqual((await getLayout()).data.layout, { sectionOrder: stageOrder, customized: false, revision: 2 });
  assert.deepEqual((await storedProfile()).metadata.customSource, metadataBefore.customSource);
  const customizedAgain = await saveLayout(['social', 'identity'], 2);
  assert.equal(customizedAgain.status, 200);
  assert.deepEqual(customizedAgain.data.layout.sectionOrder, ['social', 'identity', 'media', 'events', 'booking', 'live', 'about', 'links', 'releases']);
  assert.equal((await request('/api/talent/profile/public', { method: 'POST', cookie: ownerCookie, body: { ...fullProfileBody, roles: ['dj'] } })).status, 202);
  assert.deepEqual((await getLayout()).data.layout, customizedAgain.data.layout, 'A type change does not discard an explicit owner arrangement.');
  const siblingSave = await saveLayout(['booking', 'identity'], 0, { handle: sibling.handle });
  assert.equal(siblingSave.status, 200, 'Exact handle can arrange a co-owned profile with no previous profile row.');
  assert.equal((await getLayout()).data.layout.revision, 3);
  record('reset-follows-new-type-custom-order-survives-content-edits-and-coowned-handle-is-exact');

  // A failed audit must roll the profile write back as part of the same DB transaction.
  const beforeAuditFailure = await storedProfile();
  const auditsBeforeFailure = await auditRows();
  await proof.query("CREATE FUNCTION layout_proof_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'performer_public_profile.layout_update' THEN RAISE EXCEPTION 'Synthetic layout audit failure'; END IF; RETURN NEW; END $$");
  // The PGlite socket facade emits duplicate ReadyForQuery messages following
  // an extended-protocol statement error, which can corrupt pg's next query.
  // A deferred audit constraint exercises the same atomic rollback at COMMIT
  // (simple protocol), without suppressing app errors or retrying a write.
  // Standalone PostgreSQL retains the immediate audit-insert failure proof.
  await proof.query(proof.kind === 'embedded-postgres'
    ? 'CREATE CONSTRAINT TRIGGER layout_proof_audit_failure AFTER INSERT ON audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION layout_proof_reject_audit()'
    : 'CREATE TRIGGER layout_proof_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION layout_proof_reject_audit()');
  try {
    assert.equal((await saveLayout(customOrder, 3)).status, 503);
    assert.deepEqual(await storedProfile(), beforeAuditFailure);
    assert.deepEqual(await auditRows(), auditsBeforeFailure);
  } finally {
    await proof.query('DROP TRIGGER layout_proof_audit_failure ON audit_events');
    await proof.query('DROP FUNCTION layout_proof_reject_audit()');
  }
  assert.equal((await saveLayout(customOrder, 3)).status, 200, 'An explicit retry succeeds after a rolled-back audit failure.');
  record('audit-failure-atomically-rolls-back-layout-and-retry-succeeds');

  if (proof.kind === 'real-postgres') {
    // Hold the same performer lock used by both HTTP writes. Observe separate
    // backends blocked on that lock before releasing either controlled race.
    const lockClient = new Client({ connectionString: proof.databaseUrl });
    await lockClient.connect();
    try {
      const [{ pid: lockPid }] = (await lockClient.query('SELECT pg_backend_pid() AS pid')).rows;
      const waitForBlockedWrites = async (count) => {
        for (let attempt = 0; attempt < 150; attempt++) {
          // A later row-lock contender can wait behind the first waiter on a
          // tuple lock. Follow that observed chain back to our held root lock.
          const { rows } = await proof.query(`WITH RECURSIVE blocked AS (
            SELECT pid,wait_event_type FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
            UNION
            SELECT activity.pid,activity.wait_event_type FROM pg_stat_activity activity
            JOIN blocked ON blocked.pid=ANY(pg_blocking_pids(activity.pid)) WHERE activity.datname=current_database()
          ) SELECT DISTINCT pid,wait_event_type FROM blocked`, [lockPid]);
          if (rows.length >= count) {
            assert.ok(rows.every((row) => row.wait_event_type === 'Lock'));
            assert.equal(new Set(rows.map((row) => row.pid)).size, rows.length);
            return;
          }
          await delay(20);
        }
        assert.fail(`Did not observe ${count} independent HTTP writes blocked on the performer row.`);
      };
      const race = async (startFirst, startSecond) => {
        await lockClient.query('BEGIN');
        await lockClient.query('SELECT id FROM performers WHERE id=$1 FOR UPDATE', [owner.performerId]);
        let first;
        let second;
        try {
          first = startFirst();
          await waitForBlockedWrites(1);
          second = startSecond();
          await waitForBlockedWrites(2);
          await lockClient.query('COMMIT');
          return await Promise.all([first, second]);
        } catch (error) {
          await lockClient.query('ROLLBACK');
          await Promise.allSettled([first, second].filter(Boolean));
          throw error;
        }
      };
      let revision = (await getLayout()).data.layout.revision;
      const beforeRaceAudits = (await auditRows()).length;
      const duplicates = await race(() => saveLayout(allSections, revision), () => saveLayout(customOrder, revision));
      assert.deepEqual(duplicates.map((result) => result.status).sort(), [200, 409]);
      assert.equal((await getLayout()).data.layout.revision, revision + 1);
      assert.equal((await auditRows()).length, beforeRaceAudits + 1);
      record('native-postgres-two-layout-saves-have-one-winner-and-one-conflict');
      for (const contentFirst of [true, false]) {
        revision = (await getLayout()).data.layout.revision;
        const layoutSave = () => saveLayout(customOrder, revision);
        const contentSave = () => request('/api/talent/profile/public', { method: 'POST', cookie: ownerCookie, body: { ...fullProfileBody, headline: `Concurrent content ${contentFirst}`, roles: ['producer'] } });
        const results = await race(contentFirst ? contentSave : layoutSave, contentFirst ? layoutSave : contentSave);
        assert.deepEqual(results.map((result) => result.status).sort(), [200, 202]);
        const persisted = await storedProfile();
        assert.equal(persisted.headline, `Concurrent content ${contentFirst}`);
        assert.equal(persisted.metadata.primaryRole, 'producer');
        assert.deepEqual(persisted.metadata.customSource, metadataBefore.customSource);
        assert.deepEqual((await getLayout()).data.layout, { sectionOrder: customOrder, customized: true, revision: revision + 1 });
      }
      record('native-postgres-both-content-layout-arrival-orders-preserve-both-writes');
    } finally {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      await lockClient.end();
    }
  } else {
    console.log('SWAY_PROFILE_LAYOUT_LIMIT Native concurrency schedules require the strict standalone PostgreSQL proof.');
  }
  console.log(`SWAY_PROFILE_LAYOUT_SUMMARY ${JSON.stringify({ passed: passed.length, failed: 0, database: proof.kind, http: 'real-loopback-app', providerCalls: 0 })}`);
} finally {
  await stopServer();
  await proof.close();
}
