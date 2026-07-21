import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';

const root = process.cwd();
const databaseUrl = process.env.DATABASE_URL;
const disposableProofEnabled = process.env.SWAY_DISPOSABLE_MIGRATION_PROOF === '1';

if (!disposableProofEnabled) {
  throw new Error('Set SWAY_DISPOSABLE_MIGRATION_PROOF=1 to acknowledge this disposable projection proof.');
}
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the disposable projection proof.');
}

const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, '');
if (!['127.0.0.1', 'localhost'].includes(parsedDatabaseUrl.hostname)) {
  throw new Error('Disposable projection proof refuses non-local database hosts.');
}
if (!/^sway_public_state_projection_proof_[a-z0-9_]+$/i.test(databaseName)) {
  throw new Error('Disposable projection proof requires a database named sway_public_state_projection_proof_* .');
}

const PORT = 3921;
const BASE = `http://127.0.0.1:${PORT}`;

function splitStatements(sql) {
  return sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
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

const FORBIDDEN_INTERNAL_FIELDS = [
  'idempotencyKey', 'idempotencyFingerprint', 'idempotencyExpiresAt',
  'patronDeviceIdHash', 'actorUserId', 'lastMutationActorUserId',
  'payloadHash', 'paymentId', 'paymentIntentId', 'paymentStatus',
  'patronStatusReceiptHash', 'clientRequestId'
];

async function main() {
  const setupClient = new Client({ connectionString: databaseUrl });
  await setupClient.connect();
  const existingTables = await setupClient.query(`SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'`);
  assert.equal(existingTables.rows[0].count, 0, 'Proof database must be fresh; no schema reset is permitted.');
  await applyAllMigrations(setupClient);

  const server = await spawnServer({
    DATABASE_URL: databaseUrl,
    PORT: String(PORT),
    APP_URL: BASE,
    SWAY_APP_BASE_URL: BASE,
    SWAY_EMAIL_PROVIDER: '',
    SWAY_PERFORMER_SIGNUP_RATE_LIMIT_MAX: '100',
    SWAY_PERFORMER_LOGIN_RATE_LIMIT_MAX: '100',
    NODE_ENV: 'test'
  });

  try {
    // ---------- Setup: real performer + room ----------
    const talentContext = { cookie: null };
    const stamp = Date.now();
    const email = `projection-proof-${stamp}@example.test`;
    const handle = `projectionproof${stamp}`;
    const password = 'Sway-Verify-Pass1!';

    const signupRes = await fetch(`${BASE}/api/talent/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, handle, displayName: 'Projection Proof DJ', password, confirmPassword: password, termsAccepted: true })
    });
    const signupBody = await signupRes.json();
    assert.equal(signupRes.status, 202, `signup failed: ${JSON.stringify(signupBody)}`);
    await fetch(signupBody.verificationLink);

    const loginRes = await fetch(`${BASE}/api/talent/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    assert.ok(loginRes.ok);
    talentContext.cookie = loginRes.headers.get('set-cookie')?.split(';')[0];
    assert.ok(talentContext.cookie, 'Talent login must set a session cookie.');

    const startRes = await fetch(`${BASE}/api/session/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: talentContext.cookie },
      body: JSON.stringify({ talentName: 'Projection Proof DJ', talentRole: 'DJ', feeType: 'patron', minimumTip: 5, paymentsEnabled: true })
    });
    const startBody = await startRes.json();
    assert.ok(startBody.success, `room creation failed: ${JSON.stringify(startBody)}`);
    const gigId = startBody.state.activeGigId;

    // ---------- Two GENUINELY DISTINCT patrons: no shared cookie jar, no
    // shared identity, entirely independent HTTP clients hitting the same
    // public room. ----------
    const patronACreate = await fetch(`${BASE}/api/request/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'request', targetType: 'straight_tip', title: 'ignored for straight tips', subtitle: '', senderName: 'Distinct Patron A',
        amount: 5, gig_id: gigId, client_request_id: `patron-a-${stamp}`, idempotency_key: `patron-a-key-${stamp}`, currency: 'USD'
      })
    });
    const patronABody = await patronACreate.json();
    assert.equal(patronACreate.status, 200, `Patron A create failed: ${JSON.stringify(patronABody)}`);
    const receiptA = patronABody.patron_status_receipt;
    assert.match(receiptA, /^[A-Za-z0-9_-]{43}$/, 'Patron A must receive a well-formed receipt.');

    const patronBCreate = await fetch(`${BASE}/api/request/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'request', targetType: 'straight_tip', title: 'ignored for straight tips', subtitle: '', senderName: 'Distinct Patron B',
        amount: 10, gig_id: gigId, client_request_id: `patron-b-${stamp}`, idempotency_key: `patron-b-key-${stamp}`, currency: 'USD'
      })
    });
    const patronBBody = await patronBCreate.json();
    const receiptB = patronBBody.patron_status_receipt;
    assert.notEqual(receiptA, receiptB, 'Two distinct patrons must never receive the same receipt.');

    // REQUIREMENT: mutation responses themselves must never carry internal fields.
    for (const body of [patronABody, patronBBody]) {
      const text = JSON.stringify(body);
      for (const field of FORBIDDEN_INTERNAL_FIELDS) {
        assert.equal(text.includes(field), false, `Mutation response leaked internal field: ${field}`);
      }
    }

    // REQUIREMENT: public GET /api/state/:gigId excludes all internal fields,
    // for an entirely unauthenticated caller.
    const publicStateRes = await fetch(`${BASE}/api/state/${gigId}`);
    const publicStateBody = await publicStateRes.json();
    const publicStateText = JSON.stringify(publicStateBody);
    for (const field of FORBIDDEN_INTERNAL_FIELDS) {
      assert.equal(publicStateText.includes(field), false, `Public /api/state/:gigId leaked internal field: ${field}`);
    }

    // REQUIREMENT: public GET /api/state (global) is likewise sanitized.
    const publicGlobalStateRes = await fetch(`${BASE}/api/state`);
    const publicGlobalStateBody = await publicGlobalStateRes.json();
    const publicGlobalStateText = JSON.stringify(publicGlobalStateBody);
    for (const field of FORBIDDEN_INTERNAL_FIELDS) {
      assert.equal(publicGlobalStateText.includes(field), false, `Public /api/state leaked internal field: ${field}`);
    }

    // REQUIREMENT: the performer (authorized, gig-mutation access) still gets
    // the full internal operational state needed to run the room.
    const performerStateRes = await fetch(`${BASE}/api/state/${gigId}`, { headers: { cookie: talentContext.cookie } });
    const performerStateBody = await performerStateRes.json();
    assert.equal(performerStateBody.requests.length, 2, 'Performer must see both pending requests to run the queue.');
    assert.ok(JSON.stringify(performerStateBody).includes('idempotencyKey'), 'Performer view must retain internal operational fields.');
    const requestARecord = performerStateBody.requests.find((r) => r.senderName === 'Distinct Patron A');
    const requestBRecord = performerStateBody.requests.find((r) => r.senderName === 'Distinct Patron B');
    assert.ok(requestARecord && requestBRecord, 'Performer must be able to identify each patron by senderName to run the room.');

    // REQUIREMENT: Patron A's receipt resolves to Patron A's own submission,
    // never Patron B's, and vice versa.
    const statusA1 = await (await fetch(`${BASE}/api/patron/request-status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gig_id: gigId, patron_status_receipt: receiptA })
    })).json();
    assert.equal(statusA1.patron_status.submittedAt, requestARecord.createdAt, "Patron A's status must match Patron A's own request.");
    assert.notEqual(statusA1.patron_status.submittedAt, requestBRecord.createdAt, "Patron A's status must never match Patron B's request.");

    const statusB1 = await (await fetch(`${BASE}/api/patron/request-status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gig_id: gigId, patron_status_receipt: receiptB })
    })).json();
    assert.equal(statusB1.patron_status.submittedAt, requestBRecord.createdAt, "Patron B's status must match Patron B's own request.");
    assert.notEqual(statusB1.patron_status.submittedAt, requestARecord.createdAt, "Patron B's status must never match Patron A's request.");

    // REQUIREMENT: Patron B taking a further action (boosting an approved
    // item) must not alter what Patron A's own receipt resolves to.
    await fetch(`${BASE}/api/request/triage`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: talentContext.cookie },
      body: JSON.stringify({ requestId: requestBRecord.id, action: 'approve', gig_id: gigId })
    });
    await fetch(`${BASE}/api/request/fulfill`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: talentContext.cookie },
      body: JSON.stringify({ requestId: requestBRecord.id, gig_id: gigId })
    });

    const statusA2 = await (await fetch(`${BASE}/api/patron/request-status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gig_id: gigId, patron_status_receipt: receiptA })
    })).json();
    assert.deepEqual(statusA2.patron_status, statusA1.patron_status, "Patron B's own action must not change Patron A's displayed status.");

    // REQUIREMENT: an invalid/foreign receipt fails closed (404), never
    // returning another patron's data.
    const invalidReceiptRes = await fetch(`${BASE}/api/patron/request-status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gig_id: gigId, patron_status_receipt: 'not-a-real-receipt-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    });
    assert.equal(invalidReceiptRes.status, 404);

    console.log(JSON.stringify({
      database: databaseName,
      gigId,
      receiptsDistinct: receiptA !== receiptB,
      mutationResponsesSanitized: true,
      publicStateSanitized: true,
      publicGlobalStateSanitized: true,
      performerRetainsFullState: true,
      patronAResolvesOwnStatusOnly: true,
      patronBResolvesOwnStatusOnly: true,
      patronBActionDidNotAlterPatronAStatus: true,
      invalidReceiptFailsClosed: true
    }, null, 2));
  } finally {
    await stopServer(server);
    await setupClient.end();
  }
}

main().catch((error) => {
  console.error('Public room state projection integration proof failed:');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
