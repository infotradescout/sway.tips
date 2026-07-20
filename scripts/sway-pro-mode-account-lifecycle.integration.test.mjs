import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { Client } from 'pg';

const root = process.cwd();
const databaseUrl = process.env.DATABASE_URL;
const disposableProofEnabled = process.env.SWAY_DISPOSABLE_MIGRATION_PROOF === '1';

if (!disposableProofEnabled) {
  throw new Error('Set SWAY_DISPOSABLE_MIGRATION_PROOF=1 to acknowledge this disposable account-lifecycle proof.');
}
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the disposable account-lifecycle proof.');
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, '');
if (!['127.0.0.1', 'localhost'].includes(parsedDatabaseUrl.hostname)) {
  throw new Error('Disposable account-lifecycle proof refuses non-local database hosts.');
}
if (!/^sway_pro_mode_lifecycle_proof_[a-z0-9_]+$/i.test(databaseName)) {
  throw new Error('Disposable account-lifecycle proof requires a database named sway_pro_mode_lifecycle_proof_* .');
}

const PORT = 3911;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_BOOTSTRAP_SECRET = 'lifecycle-proof-secret-1234567890';

function splitStatements(sql) {
  return sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean);
}

async function applyAllMigrations(client) {
  const migrationDir = join(root, 'drizzle');
  const files = readdirSync(migrationDir).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  for (const filename of files) {
    const sql = readFileSync(join(migrationDir, filename), 'utf8');
    for (const statement of splitStatements(sql)) {
      await client.query(statement);
    }
  }
}

async function loadSessionStoreModule() {
  const tempDir = join(root, '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const outfile = join(tempDir, 'performer-session-store.lifecycle-proof.bundle.cjs');
  await build({
    entryPoints: ['src/server/performer-session-store.ts'],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    outfile,
    sourcemap: false
  });
  return createRequire(import.meta.url)(outfile);
}

function spawnServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server process exited early (code ${code}) before becoming ready:\n${output}`));
      }
    });

    const start = Date.now();
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${BASE}/api/build-marker`);
        if (res.ok) {
          clearInterval(interval);
          if (!settled) {
            settled = true;
            resolve(child);
          }
        }
      } catch {
        // Not up yet.
      }
      if (Date.now() - start > 60000 && !settled) {
        clearInterval(interval);
        settled = true;
        child.kill();
        reject(new Error(`Server did not become ready within 60s:\n${output}`));
      }
    }, 300);
  });
}

async function stopServer(child) {
  if (!child) return;
  await new Promise((resolve) => {
    child.on('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  });
}

async function main() {
  const setupClient = new Client({ connectionString: databaseUrl });
  await setupClient.connect();
  const existingTables = await setupClient.query(`SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'`);
  assert.equal(existingTables.rows[0].count, 0, 'Proof database must be fresh; no schema reset is permitted.');
  await applyAllMigrations(setupClient);
  const { createPerformerSessionStore } = await loadSessionStoreModule();

  const commonEnv = {
    DATABASE_URL: databaseUrl,
    PORT: String(PORT),
    APP_URL: BASE,
    SWAY_APP_BASE_URL: BASE,
    SWAY_ADMIN_BOOTSTRAP_SECRET: ADMIN_BOOTSTRAP_SECRET,
    SWAY_PERFORMER_SIGNUP_RATE_LIMIT_MAX: '100',
    SWAY_PERFORMER_LOGIN_RATE_LIMIT_MAX: '100',
    SWAY_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_MAX: '100',
    NODE_ENV: 'test'
  };

  // ================= Session 1: mock email mode =================
  // Covers auth boundaries, activation matrix over HTTP, boundary isolation,
  // and the real admin soft-delete route.
  let server = await spawnServer({ ...commonEnv, SWAY_EMAIL_PROVIDER: '' });
  try {
    // ---- Unauthenticated access ----
    const anonGet = await fetch(`${BASE}/api/account/pro-mode`);
    assert.equal(anonGet.status, 401, 'Unauthenticated GET must return 401.');
    const anonPost = await fetch(`${BASE}/api/account/pro-mode/activate`, { method: 'POST' });
    assert.equal(anonPost.status, 401, 'Unauthenticated POST must return 401.');

    // ---- A patron-role account with no performers row (session minted
    // directly since no patron signup/login route exists yet -- see the
    // Slice 1 handoff's documented gap). This exercises the real
    // requireAuthenticatedAccountAccess/cookie-reading code path; only
    // session *creation* is done programmatically. ----
    const patronRow = await setupClient.query(
      `INSERT INTO users (email, display_name, role) VALUES ('lifecycle-patron@example.test', 'Lifecycle Patron', 'patron') RETURNING id`
    );
    const patronUserId = patronRow.rows[0].id;
    const performerRowsBeforeActivation = await setupClient.query(`SELECT count(*)::int AS count FROM performers WHERE owner_user_id = $1`, [patronUserId]);
    assert.equal(performerRowsBeforeActivation.rows[0].count, 0);

    const sessionStore = createPerformerSessionStore({ databaseUrl });
    const patronSession = await sessionStore.issueSession({ actorUserId: patronUserId, issuedBy: patronUserId });
    const patronCookie = `${sessionStore.cookieName}=${encodeURIComponent(patronSession.token)}`;

    const patronRead = await fetch(`${BASE}/api/account/pro-mode`, { headers: { cookie: patronCookie } });
    const patronReadBody = await patronRead.json();
    assert.equal(patronRead.status, 200);
    assert.equal(patronReadBody.status, 'disabled', 'A brand-new patron account must read as disabled.');

    // ---- Caller cannot select another account by supplying an account ID:
    // a read must reflect the session-derived caller's own (still-disabled)
    // status, never the unrelated account named in the request. ----
    const otherUserRow = await setupClient.query(
      `INSERT INTO users (email, display_name, role, pro_mode_status) VALUES ('lifecycle-other@example.test', 'Lifecycle Other', 'patron', 'active') RETURNING id`
    );
    const spoofAttempt = await fetch(`${BASE}/api/account/pro-mode`, {
      headers: { cookie: patronCookie, 'content-type': 'application/json' }
    });
    const spoofBody = await spoofAttempt.json();
    assert.equal(spoofBody.status, 'disabled', 'The route must ignore any attempt to read another account and must only ever resolve identity from the session.');

    // ---- Activation matrix over HTTP: disabled -> active for the patron ----
    const patronActivate = await fetch(`${BASE}/api/account/pro-mode/activate`, { method: 'POST', headers: { cookie: patronCookie } });
    const patronActivateBody = await patronActivate.json();
    assert.equal(patronActivate.status, 200);
    assert.deepEqual(patronActivateBody, { status: 'active', changed: true });

    // ---- Now prove the activate route itself ignores any account
    // identifier supplied in the body: passing another account's id must
    // still resolve to (and only affect) the session-derived caller, who is
    // already active, so this must be a no-op for the caller and must not
    // touch the unrelated other account at all. ----
    const spoofActivate = await fetch(`${BASE}/api/account/pro-mode/activate`, {
      method: 'POST',
      headers: { cookie: patronCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: otherUserRow.rows[0].id, actorId: otherUserRow.rows[0].id })
    });
    const spoofActivateBody = await spoofActivate.json();
    assert.deepEqual(spoofActivateBody, { status: 'active', changed: false }, 'A spoofed body must not redirect activation onto another account; it must resolve to the already-active session-derived caller as a no-op.');
    const otherAccountUnaffected = await setupClient.query(`SELECT pro_mode_status::text AS pro_mode_status FROM users WHERE id = $1`, [otherUserRow.rows[0].id]);
    assert.equal(otherAccountUnaffected.rows[0].pro_mode_status, 'active', 'The unrelated other account must be completely untouched by the spoofed call (it was already active for unrelated reasons, not changed by this call).');

    // ---- Boundary isolation: activating Pro Mode must not create a
    // performers row, must not grant talent access, must not imply
    // gig-ready eligibility. ----
    const performerRowsAfterActivation = await setupClient.query(`SELECT count(*)::int AS count FROM performers WHERE owner_user_id = $1`, [patronUserId]);
    assert.equal(performerRowsAfterActivation.rows[0].count, 0, 'Pro Mode activation must not create a performers row.');
    const talentGatedResponse = await fetch(`${BASE}/api/talent/active-rooms`, { headers: { cookie: patronCookie } });
    assert.equal(talentGatedResponse.status, 403, 'An active-Pro-Mode account without a performers row must still be denied talent-gated routes.');

    // ---- Idempotent no-op over HTTP ----
    const patronActivateAgain = await fetch(`${BASE}/api/account/pro-mode/activate`, { method: 'POST', headers: { cookie: patronCookie } });
    const patronActivateAgainBody = await patronActivateAgain.json();
    assert.deepEqual(patronActivateAgainBody, { status: 'active', changed: false });

    // ---- Suspended/revoked rejection over HTTP ----
    for (const blockedStatus of ['suspended', 'revoked']) {
      const blockedRow = await setupClient.query(
        `INSERT INTO users (email, display_name, role, pro_mode_status) VALUES ($1, 'Blocked', 'patron', $2) RETURNING id`,
        [`lifecycle-${blockedStatus}@example.test`, blockedStatus]
      );
      const blockedSession = await sessionStore.issueSession({ actorUserId: blockedRow.rows[0].id, issuedBy: blockedRow.rows[0].id });
      const blockedCookie = `${sessionStore.cookieName}=${encodeURIComponent(blockedSession.token)}`;
      const blockedActivate = await fetch(`${BASE}/api/account/pro-mode/activate`, { method: 'POST', headers: { cookie: blockedCookie } });
      assert.equal(blockedActivate.status, 409, `A ${blockedStatus} account must be rejected with 409.`);
    }

    // ---- Admin and support account activation remains allowed ----
    for (const role of ['admin', 'support']) {
      const roleRow = await setupClient.query(
        `INSERT INTO users (email, display_name, role) VALUES ($1, 'Role Account', $2) RETURNING id`,
        [`lifecycle-${role}@example.test`, role]
      );
      const roleSession = await sessionStore.issueSession({ actorUserId: roleRow.rows[0].id, issuedBy: roleRow.rows[0].id });
      const roleCookie = `${sessionStore.cookieName}=${encodeURIComponent(roleSession.token)}`;
      const roleActivate = await fetch(`${BASE}/api/account/pro-mode/activate`, { method: 'POST', headers: { cookie: roleCookie } });
      const roleActivateBody = await roleActivate.json();
      assert.equal(roleActivate.status, 200, `${role} accounts must remain able to use the role-agnostic account endpoint.`);
      assert.equal(roleActivateBody.status, 'active');
    }

    // ---- Real performer signup + real admin soft-delete route ----
    const stamp = Date.now();
    const performerEmail = `lifecycle-performer-${stamp}@example.test`;
    const signupRes = await fetch(`${BASE}/api/talent/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: performerEmail,
        handle: `lifecycleperformer${stamp}`,
        displayName: 'Lifecycle Performer',
        password: 'Sway-Lifecycle-Pass1!',
        confirmPassword: 'Sway-Lifecycle-Pass1!',
        termsAccepted: true
      })
    });
    const signupBody = await signupRes.json();
    assert.equal(signupRes.status, 202);
    const verifyRes = await fetch(signupBody.verificationLink);
    assert.ok(verifyRes.ok);
    const loginRes = await fetch(`${BASE}/api/talent/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: performerEmail, password: 'Sway-Lifecycle-Pass1!' })
    });
    assert.ok(loginRes.ok);

    const performerRow = await setupClient.query(`SELECT id FROM users WHERE email = $1`, [performerEmail]);
    const performerUserId = performerRow.rows[0].id;
    const performerEventsBeforeDeletion = await setupClient.query(`SELECT count(*)::int AS count FROM pro_mode_status_events WHERE user_id = $1`, [performerUserId]);
    assert.equal(performerEventsBeforeDeletion.rows[0].count, 1, 'Performer signup must have written exactly one initialization event.');
    const eventBeforeDeletion = await setupClient.query(`SELECT id, user_id, actor_user_id, previous_status, next_status, reason FROM pro_mode_status_events WHERE user_id = $1`, [performerUserId]);
    for (const key of ['email', 'display_name', 'phone', 'password_hash', 'session_token', 'payment', 'address']) {
      assert.ok(!Object.keys(eventBeforeDeletion.rows[0]).some((column) => column.toLowerCase().includes(key)), `pro_mode_status_events must not have a column resembling "${key}".`);
    }

    const adminEmail = `lifecycle-admin-${stamp}@example.test`;
    const bootstrapRes = await fetch(`${BASE}/api/admin/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: ADMIN_BOOTSTRAP_SECRET,
        email: adminEmail,
        displayName: 'Lifecycle Admin',
        password: 'Sway-Lifecycle-Admin1!',
        confirmPassword: 'Sway-Lifecycle-Admin1!'
      })
    });
    assert.equal(bootstrapRes.status, 201);
    const adminLoginRes = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: 'Sway-Lifecycle-Admin1!' })
    });
    assert.ok(adminLoginRes.ok);
    const adminCookieHeader = adminLoginRes.headers.get('set-cookie');
    assert.ok(adminCookieHeader, 'Admin login must set a session cookie.');
    const adminCookie = adminCookieHeader.split(';')[0];

    const deleteRes = await fetch(`${BASE}/api/admin/accounts/${performerUserId}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie }
    });
    const deleteBody = await deleteRes.json();
    assert.equal(deleteRes.status, 200, `Real admin account-deletion route must succeed: ${JSON.stringify(deleteBody)}`);
    assert.equal(deleteBody.success, true);

    const scrubbedUser = await setupClient.query(`SELECT email, display_name, password_hash FROM users WHERE id = $1`, [performerUserId]);
    assert.equal(scrubbedUser.rows[0].email, null, 'Existing account-deletion contract: email must be scrubbed.');
    assert.equal(scrubbedUser.rows[0].display_name, 'Deleted account', 'Existing account-deletion contract must be unchanged.');
    assert.equal(scrubbedUser.rows[0].password_hash, null);

    const eventAfterDeletion = await setupClient.query(`SELECT id, next_status FROM pro_mode_status_events WHERE user_id = $1`, [performerUserId]);
    assert.equal(eventAfterDeletion.rowCount, 1, 'The Pro Mode initialization event must survive admin account deletion (the users row is scrubbed, not removed).');
    assert.equal(eventAfterDeletion.rows[0].next_status, 'onboarding');
    await assert.rejects(
      setupClient.query(`UPDATE pro_mode_status_events SET reason = 'tampered' WHERE id = $1`, [eventAfterDeletion.rows[0].id]),
      /append-only/i,
      'The retained event must still reject direct UPDATE after account deletion.'
    );
    await assert.rejects(
      setupClient.query(`DELETE FROM pro_mode_status_events WHERE id = $1`, [eventAfterDeletion.rows[0].id]),
      /append-only/i,
      'The retained event must still reject direct DELETE after account deletion.'
    );

    console.log('Session 1 (mock email, admin soft-delete) proofs passed.');
  } finally {
    await stopServer(server);
  }

  // ================= Session 2: broken email provider (deterministic
  // delivery failure, no network call, no real credentials) =================
  // Exercises the real hard-delete path: signup rollback when
  // verification-email delivery fails after the account (and its Pro Mode
  // init event) were already created in the same transaction.
  server = await spawnServer({
    ...commonEnv,
    SWAY_EMAIL_PROVIDER: 'resend',
    SWAY_EMAIL_API_KEY: '',
    SWAY_EMAIL_FROM: 'Sway <performers@sway.tips>'
  });
  try {
    const rollbackEmail = `lifecycle-rollback-${Date.now()}@example.test`;
    const rollbackSignupRes = await fetch(`${BASE}/api/talent/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: rollbackEmail,
        handle: `lifecyclerollback${Date.now()}`,
        displayName: 'Lifecycle Rollback',
        password: 'Sway-Lifecycle-Pass1!',
        confirmPassword: 'Sway-Lifecycle-Pass1!',
        termsAccepted: true
      })
    });
    assert.equal(rollbackSignupRes.status, 503, 'Signup must fail closed when email delivery is unavailable.');

    const rollbackUserCheck = await setupClient.query(`SELECT count(*)::int AS count FROM users WHERE email = $1`, [rollbackEmail]);
    assert.equal(rollbackUserCheck.rows[0].count, 0, 'The real hard-delete signup-rollback path must succeed (no FK violation) and leave no partial user row.');

    console.log('Session 2 (broken email provider, real hard-delete rollback) proof passed.');
  } finally {
    await stopServer(server);
  }

  await setupClient.end();
}

main().catch((error) => {
  console.error('Pro Mode account-lifecycle integration proof failed:');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
