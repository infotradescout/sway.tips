import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Client } from 'pg';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const root = process.cwd();
const proofTempPrefix = join(tmpdir(), 'sway-generalized-live-room-');
const expectedProductGaps = new Set([
  'nonmusic paid request intent is rejected',
  'nonmusic straight tip intent is rejected',
  'nonmusic paid boost intent is rejected',
  'nonmusic supplied payment intent is rejected',
  'host menu moderation rejects abusive content'
]);

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isoFromNow(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function withTimeout(promise, milliseconds, label) {
  return Promise.race([
    promise,
    delay(milliseconds).then(() => {
      throw new Error(`${label} exceeded ${milliseconds}ms.`);
    })
  ]);
}

async function reservePort() {
  const socket = createServer();
  await new Promise((resolvePromise, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') {
    socket.close();
    throw new Error('Unable to reserve a local Wave 4 proof port.');
  }
  const port = address.port;
  await new Promise((resolvePromise, reject) => {
    socket.close((error) => error ? reject(error) : resolvePromise());
  });
  return port;
}

class HttpClient {
  constructor(baseUrl, defaultHeaders = {}) {
    this.baseUrl = baseUrl;
    this.defaultHeaders = defaultHeaders;
    this.cookies = new Map();
  }

  captureCookies(setCookieValues) {
    for (const cookie of setCookieValues) {
      const pair = cookie.split(';', 1)[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (/max-age=0/i.test(cookie) || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(path, init = {}) {
    const headers = new Headers(this.defaultHeaders);
    for (const [name, value] of new Headers(init.headers).entries()) headers.set(name, value);
    if (this.cookies.size > 0) {
      headers.set(
        'cookie',
        [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
      );
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      redirect: init.redirect ?? 'manual'
    });
    const setCookieValues = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    this.captureCookies(setCookieValues);

    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { text };
      }
    }
    return { status: response.status, headers: response.headers, body };
  }

  get(path, init = {}) {
    return this.request(path, { ...init, method: 'GET' });
  }

  post(path, body, init = {}) {
    return this.request(path, {
      ...init,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...Object.fromEntries(new Headers(init.headers).entries())
      },
      body: JSON.stringify(body)
    });
  }
}

function assertStatus(response, expected, label, server) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(
    statuses.includes(response.status),
    `${label}: expected ${statuses.join(' or ')}, received ${response.status}: ${JSON.stringify(response.body)}\n${server.logs()}`
  );
}

async function buildDisposableServerBundle({
  buildImplementation = build,
  onDirectoryCreated = () => undefined
} = {}) {
  const directory = await mkdtemp(proofTempPrefix);
  const entryPath = join(directory, 'server.cjs');
  try {
    onDirectoryCreated(directory);
    await buildImplementation({
      entryPoints: [join(root, 'server.ts')],
      outfile: entryPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      sourcemap: false,
      logLevel: 'silent'
    });
    return { directory, entryPath };
  } catch (error) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Disposable server bundle build and cleanup both failed.',
        { cause: error }
      );
    }
    throw error;
  }
}

async function removeDisposableServerBundle(bundle) {
  if (!bundle) return;
  const resolvedDirectory = resolve(bundle.directory).toLowerCase();
  const resolvedPrefix = resolve(proofTempPrefix).toLowerCase();
  if (!resolvedDirectory.startsWith(resolvedPrefix)) {
    throw new Error(`Refusing to remove unexpected proof directory: ${bundle.directory}`);
  }
  await rm(bundle.directory, { recursive: true, force: true });
}

async function proveDisposableServerBundleFailureCleanup() {
  let createdDirectory = null;
  await assert.rejects(
    buildDisposableServerBundle({
      buildImplementation: async () => {
        throw new Error('Injected disposable server build failure.');
      },
      onDirectoryCreated: (directory) => {
        createdDirectory = directory;
      }
    }),
    /Injected disposable server build failure/
  );
  assert.ok(createdDirectory, 'The build-failure proof must observe its disposable directory.');
  await assert.rejects(access(createdDirectory), { code: 'ENOENT' });
}

async function collectCleanupFailures(steps) {
  const failures = [];
  for (const [label, cleanup] of steps) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(new Error(`${label}: ${errorMessage(error)}`, { cause: error }));
    }
  }
  return failures;
}

async function proveCleanupContinuesAfterFailure() {
  const calls = [];
  const failures = await collectCleanupFailures([
    ['injected first cleanup', async () => {
      calls.push('first');
      throw new Error('Injected cleanup failure.');
    }],
    ['injected second cleanup', async () => {
      calls.push('second');
    }]
  ]);
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Injected cleanup failure/);
}

async function startSwayServer({ databaseUrl, entryPath, port }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [entryPath], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DISABLE_HMR: 'true',
      SWAY_API_ONLY_TEST_MODE: 'true',
      NODE_PATH: [join(root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(delimiter),
      SWAY_STARTUP_DIAGNOSTICS: 'true',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      APP_URL: baseUrl,
      APP_BASE_URL: baseUrl,
      SWAY_APP_BASE_URL: baseUrl,
      VITE_SWAY_DEMO_MODE: 'false',
      SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED: 'false',
      SWAY_EMAIL_PROVIDER: '',
      SWAY_EMAIL_API_KEY: '',
      SWAY_EMAIL_FROM: '',
      SWAY_PERFORMER_SIGNUP_RATE_LIMIT_MAX: '100',
      SWAY_PERFORMER_LOGIN_RATE_LIMIT_MAX: '100',
      SWAY_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_MAX: '100',
      SWAY_ROOM_MENU_REPORT_SUBJECT_LIMIT: '2',
      SWAY_ROOM_MENU_REPORT_IP_LIMIT: '4',
      SWAY_ROOM_MENU_REPORT_WINDOW_MS: String(24 * 60 * 60 * 1000),
      SWAY_ROOM_MENU_REPORT_RETENTION_DAYS: '30',
      STRIPE_SECRET_KEY: '',
      STRIPE_PUBLISHABLE_KEY: '',
      VITE_STRIPE_PUBLISHABLE_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const output = [];
  const recordOutput = (chunk) => {
    output.push(chunk.toString('utf8'));
    if (output.length > 250) output.splice(0, output.length - 250);
  };
  child.stdout.on('data', recordOutput);
  child.stderr.on('data', recordOutput);

  const earlyExit = new Promise((_resolve, reject) => {
    child.once('exit', (code, signal) => reject(new Error(
      `Wave 4 proof server exited before readiness (code=${code}, signal=${signal}).\n${output.join('')}`
    )));
  });
  const readiness = (async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}/api/health/network-probe`);
        if (response.status === 204) return;
      } catch {
        // The disposable server is still starting.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    }
    throw new Error(`Timed out waiting for the Wave 4 proof server.\n${output.join('')}`);
  })();

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
    const forced = new Promise((resolvePromise) => setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolvePromise();
    }, 5_000));
    await Promise.race([exited, forced]);
  };

  try {
    await Promise.race([readiness, earlyExit]);
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    baseUrl,
    logs: () => output.join(''),
    stop
  };
}

async function createPerformerAccount({ server, suffix, displayName, handle }) {
  const client = new HttpClient(server.baseUrl);
  const email = `wave4-${suffix}-${Date.now()}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `Sway!${suffix}-Wave4-2026-Long`;
  const signup = await client.post('/api/account/signup', {
    displayName,
    email,
    password,
    confirmPassword: password,
    termsAccepted: true,
    next: '/account?intent=performer'
  });
  assertStatus(signup, 202, `${suffix} account signup`, server);
  assert.match(String(signup.body.verificationLink ?? ''), /\/api\/account\/verify-email\/consume\?token=/);

  const verificationUrl = new URL(String(signup.body.verificationLink));
  const verification = await client.get(`${verificationUrl.pathname}${verificationUrl.search}`);
  assertStatus(verification, 302, `${suffix} email verification`, server);

  const login = await client.post('/api/account/login', {
    email,
    password,
    next: '/account?intent=performer'
  });
  assertStatus(login, 200, `${suffix} account login`, server);
  assert.match(client.cookies.get('sway_performer_session') ?? '', /\S+/);

  const activation = await client.post('/api/account/pro-mode/activate', { displayName, handle });
  assertStatus(activation, 200, `${suffix} Pro Mode activation`, server);
  assert.equal(activation.body.status, 'active');

  const session = await client.get('/api/account/session');
  assertStatus(session, 200, `${suffix} account session`, server);
  assert.equal(session.body.performer.handle, handle);
  return {
    client,
    email,
    performerId: String(session.body.performer.id),
    userId: String(session.body.account.id)
  };
}

async function recordCapabilityDecision(proof, {
  performerId,
  capability,
  decision,
  label
}) {
  const decisionKey = `wave4:${label}:${performerId}:${capability}:${decision}:${randomUUID()}`;
  await proof.query(
    `insert into performer_capability_grant_events (
       performer_id, capability, decision, actor_type, reason, evidence, idempotency_key_hash
     ) values ($1, $2, $3, 'system', $4, $5::jsonb, $6)`,
    [
      performerId,
      capability,
      decision,
      `Disposable Wave 4 ${capability} ${decision} proof`,
      JSON.stringify({ reference: decisionKey, environment: 'test' }),
      hash(decisionKey)
    ]
  );
}

async function grantCapabilities(proof, performerId, label) {
  for (const capability of ['live_rooms', 'event_publication', 'external_ticket_links']) {
    const latest = await proof.query(
      `select decision, expires_at
         from performer_capability_grant_events
        where performer_id = $1 and capability = $2
        order by event_sequence desc
        limit 1`,
      [performerId, capability]
    );
    const current = latest.rows[0];
    if (
      current?.decision === 'granted'
      && (!current.expires_at || new Date(current.expires_at).getTime() > Date.now())
    ) continue;
    await recordCapabilityDecision(proof, {
      performerId,
      capability,
      decision: 'granted',
      label
    });
  }
}

async function recordEventAuthorityDecision(proof, {
  performerId,
  eventId,
  decision,
  label
}) {
  const authorityKey = `wave4:${label}:${performerId}:${eventId}:${decision}:${randomUUID()}`;
  await proof.query(
    `insert into performer_authority_events (
       performer_id, authority_kind, subject_type, subject_id, decision,
       actor_type, reason, evidence, idempotency_key_hash
     ) values ($1, 'event_organizer', 'event', $2, $3, 'system', $4, $5::jsonb, $6)`,
    [
      performerId,
      eventId,
      decision,
      `Disposable Wave 4 event organizer ${decision} proof`,
      JSON.stringify({ reference: authorityKey, environment: 'test' }),
      hash(authorityKey)
    ]
  );
}

async function grantEventAuthority(proof, performerId, eventId) {
  const latest = await proof.query(
    `select decision, expires_at
       from performer_authority_events
      where performer_id = $1
        and authority_kind = 'event_organizer'
        and subject_type = 'event'
        and subject_id = $2
      order by event_sequence desc
      limit 1`,
    [performerId, eventId]
  );
  const current = latest.rows[0];
  if (
    current?.decision === 'granted'
    && (!current.expires_at || new Date(current.expires_at).getTime() > Date.now())
  ) return;
  await recordEventAuthorityDecision(proof, {
    performerId,
    eventId,
    decision: 'granted',
    label: 'event-authority'
  });
}

async function createEvent({ server, proof, account, title, startsAt, endsAt, publish = true }) {
  const response = await account.client.post('/api/talent/events', {
    clientRequestId: randomUUID(),
    title,
    description: `${title} disposable integration proof`,
    startsAt,
    endsAt,
    timeZone: 'America/Chicago',
    locationName: 'Wave 4 Proof Hall',
    locationAddress: '100 Test Avenue',
    city: 'Chicago',
    locationIsTba: false,
    ticketingMode: 'external',
    attendanceMode: 'external_ticket',
    externalTicketUrl: `https://tickets.example.test/${randomUUID()}`,
    externalTicketLabel: 'Get tickets',
    visibility: 'public'
  });
  assertStatus(response, [200, 201], `${title} creation`, server);
  const event = response.body.event;
  assert.match(String(event?.id ?? ''), /^[0-9a-f-]{36}$/i);
  await grantEventAuthority(proof, account.performerId, event.id);
  if (!publish) return event;

  const published = await account.client.post(`/api/talent/events/${event.id}/publish`, {
    expectedUpdatedAt: event.updatedAt
  });
  assertStatus(published, 200, `${title} publication`, server);
  assert.equal(published.body.event.status, 'published');
  return published.body.event;
}

function roomStartBody({ gigId, roomType, talentName, menu, linkedEventId = null }) {
  return {
    gig_id: gigId,
    talentName,
    talentRole: 'Performer',
    roomType,
    requestMenu: menu,
    linkedEventId,
    feeType: 'patron',
    minimumTip: 5,
    paymentsEnabled: false,
    searchScope: 'library'
  };
}

function actionIdentity(label) {
  const clientRequestId = `${label}-${randomUUID()}`;
  return {
    clientRequestId,
    idempotencyKey: `idempotency-${clientRequestId}`,
    expiresAt: isoFromNow(5 * 60 * 1000)
  };
}

function assertNonMusicMoneyDenial(response, label, persistence) {
  const evidence = JSON.stringify({
    status: response.status,
    code: response.body.code ?? null,
    error: response.body.error ?? null,
    success: response.body.success ?? null,
    pending: response.body.pending ?? null,
    paymentStatus: response.body.payment_status ?? null,
    ...persistence
  });
  assert.ok(
    [409, 422].includes(response.status),
    `${label} must be rejected at the non-music boundary. Evidence: ${evidence}`
  );
  assert.equal(
    response.body.code,
    'non_music_room_money_not_available',
    `${label} must not pass merely because Stripe or payout setup is unavailable. Evidence: ${evidence}`
  );
  assert.notEqual(response.body.success, true, `${label} must never be reported as successful. Evidence: ${evidence}`);
}

async function countByClientRequestId(proof, table, clientRequestId) {
  assert.ok(['requests', 'request_boosts'].includes(table));
  const result = await proof.query(
    `select count(*)::int as count from ${table} where client_request_id = $1`,
    [clientRequestId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function countPaymentsByIdempotencyKey(proof, idempotencyKey) {
  const result = await proof.query(
    'select count(*)::int as count from payments where idempotency_key = $1',
    [idempotencyKey]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function countEventsByClientRequestId(proof, clientRequestId) {
  const result = await proof.query(
    'select count(*)::int as count from performer_events where client_request_id = $1',
    [clientRequestId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function proveHttpCloseoutEventLifecycleRetry({ server, proof, account, menu }) {
  const createLinkedRoom = async (label) => {
    const event = await createEvent({
      server,
      proof,
      account,
      title: `Wave 4 ${label} closeout event`,
      startsAt: isoFromNow(30 * 60 * 1000),
      endsAt: isoFromNow(3 * 60 * 60 * 1000)
    });
    const gigId = randomUUID();
    const started = await account.client.post('/api/session/start', roomStartBody({
      gigId,
      roomType: 'comedy',
      talentName: `Wave 4 ${label} closeout host`,
      menu,
      linkedEventId: event.id
    }));
    assertStatus(started, 200, `${label} closeout room start`, server);
    return { eventId: event.id, gigId };
  };

  const loadCloseoutTruth = async (gigId) => {
    const result = await proof.query(
      `select room.status::text as status,
              room.runtime_session_state ->> 'status' as runtime_status,
              registry.registry_status::text as registry_status,
              (
                select count(*)::integer
                  from audit_events audit
                 where audit.event_type = 'session.end'
                   and audit.metadata ->> 'gigId' = room.id::text
              ) as audit_count,
              (
                select count(*)::integer
                  from live_room_payment_operations operation
                 where operation.gig_id = room.id
              ) as payment_operation_count
         from gig_sessions room
         left join active_room_registry registry on registry.gig_id = room.id
        where room.id = $1`,
      [gigId]
    );
    assert.equal(result.rowCount, 1);
    return result.rows[0];
  };

  const eventual = await createLinkedRoom('eventual-retry');
  const eventualBlocker = new Client({ connectionString: proof.databaseUrl });
  await eventualBlocker.connect();
  let eventualTransactionOpen = false;
  try {
    await eventualBlocker.query('begin');
    eventualTransactionOpen = true;
    await eventualBlocker.query('select sway_event_room_link_lock($1::uuid)', [eventual.eventId]);

    let requestSettled = false;
    const endPromise = account.client.post('/api/session/end', { gig_id: eventual.gigId });
    void endPromise.then(
      () => { requestSettled = true; },
      () => { requestSettled = true; }
    );
    await delay(70);
    assert.equal(requestSettled, false, 'The HTTP request must remain bounded in retry while the event lifecycle lock is busy.');
    await eventualBlocker.query('rollback');
    eventualTransactionOpen = false;

    const ended = await withTimeout(endPromise, 5_000, 'The internally retried room-end HTTP request');
    assertStatus(ended, 200, 'internally retried linked-room end', server);
    const truth = await loadCloseoutTruth(eventual.gigId);
    assert.equal(truth.status, 'closeout_pending');
    assert.equal(truth.runtime_status, 'ending');
    assert.equal(truth.registry_status, 'ending');
    assert.equal(Number(truth.audit_count), 1);
    assert.equal(Number(truth.payment_operation_count), 0);
  } finally {
    if (eventualTransactionOpen) await eventualBlocker.query('rollback').catch(() => undefined);
    await eventualBlocker.end();
  }

  const exhausted = await createLinkedRoom('exhausted-retry');
  const exhaustedBlocker = new Client({ connectionString: proof.databaseUrl });
  await exhaustedBlocker.connect();
  let exhaustedTransactionOpen = false;
  try {
    await exhaustedBlocker.query('begin');
    exhaustedTransactionOpen = true;
    await exhaustedBlocker.query('select sway_event_room_link_lock($1::uuid)', [exhausted.eventId]);

    const conflicted = await withTimeout(
      account.client.post('/api/session/end', { gig_id: exhausted.gigId }),
      5_000,
      'The exhausted room-end HTTP retry response'
    );
    assertStatus(conflicted, 409, 'exhausted linked-room end retry', server);
    assert.equal(conflicted.body.code, 'room_event_lifecycle_retry_required');
    assert.equal(conflicted.headers.get('retry-after'), '1');
    const beforeRetry = await loadCloseoutTruth(exhausted.gigId);
    assert.equal(beforeRetry.status, 'active');
    assert.equal(Number(beforeRetry.audit_count), 0);
    assert.equal(Number(beforeRetry.payment_operation_count), 0);

    const health = await new HttpClient(server.baseUrl).get('/api/health/network-probe');
    assertStatus(health, 204, 'server health after exhausted lifecycle retry', server);
    await exhaustedBlocker.query('rollback');
    exhaustedTransactionOpen = false;

    const retried = await account.client.post('/api/session/end', { gig_id: exhausted.gigId });
    assertStatus(retried, 200, 'client-retried linked-room end', server);
    const afterRetry = await loadCloseoutTruth(exhausted.gigId);
    assert.equal(afterRetry.status, 'closeout_pending');
    assert.equal(afterRetry.runtime_status, 'ending');
    assert.equal(afterRetry.registry_status, 'ending');
    assert.equal(Number(afterRetry.audit_count), 1);
    assert.equal(Number(afterRetry.payment_operation_count), 0);
  } finally {
    if (exhaustedTransactionOpen) await exhaustedBlocker.query('rollback').catch(() => undefined);
    await exhaustedBlocker.end();
  }

  return {
    internallyRetriedStatus: 'closeout_pending',
    exhaustedStatus: 409,
    retryCode: 'room_event_lifecycle_retry_required',
    finalAuditCountPerRoom: 1,
    providerOperationCount: 0
  };
}

async function run() {
  await proveDisposableServerBundleFailureCleanup();
  await proveCleanupContinuesAfterFailure();
  const checks = [];
  const unmet = [];
  const proof = await startEmbeddedPostgresProof('generalized_live_room_http');
  let bundle = null;
  let server = null;
  let proofError = null;

  const verify = async (name, action) => {
    try {
      const evidence = await action();
      checks.push({ name, status: 'pass', evidence: evidence ?? null });
      return evidence;
    } catch (error) {
      const failure = {
        name,
        status: 'fail',
        expectedGap: expectedProductGaps.has(name),
        error: errorMessage(error)
      };
      checks.push(failure);
      unmet.push(failure);
      return null;
    }
  };

  try {
    const port = await reservePort();
    bundle = await buildDisposableServerBundle();
    server = await startSwayServer({ databaseUrl: proof.databaseUrl, entryPath: bundle.entryPath, port });
    const initialServer = server;

    const paymentConfig = await new HttpClient(server.baseUrl).get('/api/payment/config');
    assertStatus(paymentConfig, 503, 'fail-closed payment configuration', server);
    assert.notEqual(paymentConfig.body.mode, 'live');

    const stamp = Date.now().toString(36);
    const hostA = await createPerformerAccount({
      server,
      suffix: 'host-a',
      displayName: 'Wave 4 Comedy Host',
      handle: `wave4hosta${stamp}`.slice(0, 30)
    });
    const hostB = await createPerformerAccount({
      server,
      suffix: 'host-b',
      displayName: 'Wave 4 Service Host',
      handle: `wave4hostb${stamp}`.slice(0, 30)
    });
    await grantCapabilities(proof, hostA.performerId, 'host-a');
    await grantCapabilities(proof, hostB.performerId, 'host-b');

    const authorityMenu = [{
      id: 'authority-proof-topic',
      title: 'Authority proof topic',
      description: 'Suggest a safe topic after authorization succeeds.',
      targetType: 'custom'
    }];
    await verify('revoked live_rooms capability blocks room start', async () => {
      const gigId = randomUUID();
      await recordCapabilityDecision(proof, {
        performerId: hostA.performerId,
        capability: 'live_rooms',
        decision: 'revoked',
        label: 'live-room-negative'
      });
      let response;
      try {
        response = await hostA.client.post('/api/session/start', roomStartBody({
          gigId,
          roomType: 'comedy',
          talentName: 'Revoked Live Room Host',
          menu: authorityMenu
        }));
        const persisted = await proof.query(
          'select count(*)::int as count from gig_sessions where id = $1',
          [gigId]
        );
        assertStatus(response, 403, 'revoked live_rooms room start', server);
        assert.equal(response.body.code, 'capability_not_granted');
        assert.equal(response.body.capability, 'live_rooms');
        assert.equal(Number(persisted.rows[0]?.count ?? 0), 0);
        return { status: response.status, code: response.body.code, persisted: 0 };
      } finally {
        await recordCapabilityDecision(proof, {
          performerId: hostA.performerId,
          capability: 'live_rooms',
          decision: 'granted',
          label: 'live-room-restored'
        });
      }
    });

    const protectedEventPayload = (title, clientRequestId) => ({
      clientRequestId,
      title,
      description: `${title} disposable authority proof`,
      startsAt: isoFromNow(45 * 60 * 1000),
      endsAt: isoFromNow(4 * 60 * 60 * 1000),
      timeZone: 'America/Chicago',
      locationName: 'Wave 4 Authority Hall',
      locationAddress: '200 Test Avenue',
      city: 'Chicago',
      locationIsTba: false,
      ticketingMode: 'external',
      attendanceMode: 'external_ticket',
      externalTicketUrl: `https://tickets.example.test/${randomUUID()}`,
      externalTicketLabel: 'Get tickets',
      visibility: 'public'
    });

    await verify('revoked event_publication capability blocks event create', async () => {
      const clientRequestId = randomUUID();
      await recordCapabilityDecision(proof, {
        performerId: hostA.performerId,
        capability: 'event_publication',
        decision: 'revoked',
        label: 'event-create-negative'
      });
      try {
        const response = await hostA.client.post(
          '/api/talent/events',
          protectedEventPayload('Revoked publication create', clientRequestId)
        );
        const persisted = await countEventsByClientRequestId(proof, clientRequestId);
        assertStatus(response, 403, 'revoked event_publication event create', server);
        assert.equal(response.body.code, 'capability_not_granted');
        assert.equal(response.body.capability, 'event_publication');
        assert.equal(persisted, 0);
        return { status: response.status, code: response.body.code, persisted };
      } finally {
        await recordCapabilityDecision(proof, {
          performerId: hostA.performerId,
          capability: 'event_publication',
          decision: 'granted',
          label: 'event-create-restored'
        });
      }
    });

    await verify('revoked external_ticket_links capability blocks event create', async () => {
      const clientRequestId = randomUUID();
      await recordCapabilityDecision(proof, {
        performerId: hostA.performerId,
        capability: 'external_ticket_links',
        decision: 'revoked',
        label: 'external-link-create-negative'
      });
      try {
        const response = await hostA.client.post(
          '/api/talent/events',
          protectedEventPayload('Revoked external link create', clientRequestId)
        );
        const persisted = await countEventsByClientRequestId(proof, clientRequestId);
        assertStatus(response, 403, 'revoked external_ticket_links event create', server);
        assert.equal(response.body.code, 'capability_not_granted');
        assert.equal(response.body.capability, 'external_ticket_links');
        assert.equal(persisted, 0);
        return { status: response.status, code: response.body.code, persisted };
      } finally {
        await recordCapabilityDecision(proof, {
          performerId: hostA.performerId,
          capability: 'external_ticket_links',
          decision: 'granted',
          label: 'external-link-create-restored'
        });
      }
    });

    const authorityEvent = await createEvent({
      server,
      proof,
      account: hostA,
      title: 'Wave 4 authority transition event',
      startsAt: isoFromNow(45 * 60 * 1000),
      endsAt: isoFromNow(4 * 60 * 60 * 1000),
      publish: false
    });

    await verify('revoked event_publication capability blocks event publish', async () => {
      await recordCapabilityDecision(proof, {
        performerId: hostA.performerId,
        capability: 'event_publication',
        decision: 'revoked',
        label: 'event-publish-negative'
      });
      try {
        const response = await hostA.client.post(`/api/talent/events/${authorityEvent.id}/publish`, {
          expectedUpdatedAt: authorityEvent.updatedAt
        });
        const persisted = await proof.query(
          'select status from performer_events where id = $1',
          [authorityEvent.id]
        );
        assertStatus(response, 403, 'revoked event_publication event publish', server);
        assert.equal(response.body.code, 'capability_not_granted');
        assert.equal(response.body.capability, 'event_publication');
        assert.equal(persisted.rows[0]?.status, 'draft');
        return { status: response.status, code: response.body.code, eventStatus: 'draft' };
      } finally {
        await recordCapabilityDecision(proof, {
          performerId: hostA.performerId,
          capability: 'event_publication',
          decision: 'granted',
          label: 'event-publish-restored'
        });
      }
    });

    await verify('revoked external_ticket_links capability blocks event publish', async () => {
      await recordCapabilityDecision(proof, {
        performerId: hostA.performerId,
        capability: 'external_ticket_links',
        decision: 'revoked',
        label: 'external-link-publish-negative'
      });
      try {
        const response = await hostA.client.post(`/api/talent/events/${authorityEvent.id}/publish`, {
          expectedUpdatedAt: authorityEvent.updatedAt
        });
        const persisted = await proof.query(
          'select status from performer_events where id = $1',
          [authorityEvent.id]
        );
        assertStatus(response, 403, 'revoked external_ticket_links event publish', server);
        assert.equal(response.body.code, 'capability_not_granted');
        assert.equal(response.body.capability, 'external_ticket_links');
        assert.equal(persisted.rows[0]?.status, 'draft');
        return { status: response.status, code: response.body.code, eventStatus: 'draft' };
      } finally {
        await recordCapabilityDecision(proof, {
          performerId: hostA.performerId,
          capability: 'external_ticket_links',
          decision: 'granted',
          label: 'external-link-publish-restored'
        });
      }
    });

    await verify('revoked exact event organizer authority blocks event publish', async () => {
      await recordEventAuthorityDecision(proof, {
        performerId: hostA.performerId,
        eventId: authorityEvent.id,
        decision: 'revoked',
        label: 'event-organizer-negative'
      });
      try {
        const response = await hostA.client.post(`/api/talent/events/${authorityEvent.id}/publish`, {
          expectedUpdatedAt: authorityEvent.updatedAt
        });
        const persisted = await proof.query(
          'select status from performer_events where id = $1',
          [authorityEvent.id]
        );
        assertStatus(response, 403, 'revoked event organizer event publish', server);
        assert.equal(response.body.code, 'subject_authority_not_granted');
        assert.equal(response.body.eventId, authorityEvent.id);
        assert.equal(persisted.rows[0]?.status, 'draft');
        return { status: response.status, code: response.body.code, eventStatus: 'draft' };
      } finally {
        await recordEventAuthorityDecision(proof, {
          performerId: hostA.performerId,
          eventId: authorityEvent.id,
          decision: 'granted',
          label: 'event-organizer-restored'
        });
      }
    });

    const authorityEventPublish = await hostA.client.post(
      `/api/talent/events/${authorityEvent.id}/publish`,
      { expectedUpdatedAt: authorityEvent.updatedAt }
    );
    assertStatus(authorityEventPublish, 200, 'restored event authority publish', server);
    assert.equal(authorityEventPublish.body.event.status, 'published');
    checks.push({
      name: 'restored event grants permit the protected publish',
      status: 'pass',
      evidence: { eventId: authorityEvent.id }
    });

    await verify('public event publication receives a durable safety decision', async () => {
      const reviews = await proof.query(
        `select status, metadata
           from moderation_events
          where entity_type = 'performer_event_publication'
            and metadata ->> 'eventId' = $1
          order by created_at desc`,
        [authorityEvent.id]
      );
      assert.equal(reviews.rowCount, 1);
      assert.equal(reviews.rows[0].status, 'allowed');
      assert.match(String(reviews.rows[0].metadata.contentFingerprint ?? ''), /^[0-9a-f]{64}$/);
      return { reviewCount: reviews.rowCount, decision: reviews.rows[0].status };
    });

    const unsafePublicationEvent = await createEvent({
      server,
      proof,
      account: hostA,
      title: 'Fuck the audience publication fixture',
      startsAt: isoFromNow(20 * 60 * 1000),
      endsAt: isoFromNow(3 * 60 * 60 * 1000),
      publish: false
    });
    await verify('event safety review blocks public transition before publication', async () => {
      const response = await hostA.client.post(`/api/talent/events/${unsafePublicationEvent.id}/publish`, {
        expectedUpdatedAt: unsafePublicationEvent.updatedAt
      });
      const persisted = await proof.query(
        'select status from performer_events where id = $1',
        [unsafePublicationEvent.id]
      );
      const reviews = await proof.query(
        `select status
           from moderation_events
          where entity_type = 'performer_event_publication'
            and metadata ->> 'eventId' = $1
          order by created_at desc`,
        [unsafePublicationEvent.id]
      );
      assertStatus(response, 422, 'unsafe event publication', server);
      assert.equal(response.body.code, 'event_publication_review_required');
      assert.equal(persisted.rows[0]?.status, 'draft');
      assert.equal(reviews.rows[0]?.status, 'held_for_review');
      return { status: response.status, code: response.body.code, eventStatus: persisted.rows[0]?.status };
    });

    const validEvent = await createEvent({
      server,
      proof,
      account: hostA,
      title: 'Wave 4 current external event',
      startsAt: isoFromNow(15 * 60 * 1000),
      endsAt: isoFromNow(3 * 60 * 60 * 1000)
    });
    await verify('published event edits are safety-reviewed before public mutation', async () => {
      const response = await hostA.client.request(`/api/talent/events/${validEvent.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: validEvent.updatedAt,
          description: 'Fuck this unsafe published edit fixture'
        })
      });
      const persisted = await proof.query(
        'select description, updated_at from performer_events where id = $1',
        [validEvent.id]
      );
      assertStatus(response, 422, 'unsafe published event edit', server);
      assert.equal(response.body.code, 'event_publication_review_required');
      assert.equal(persisted.rows[0]?.description, validEvent.description);
      assert.equal(new Date(persisted.rows[0]?.updated_at).toISOString(), validEvent.updatedAt);
      return { status: response.status, code: response.body.code, unchanged: true };
    });
    const wrongOwnerEvent = await createEvent({
      server,
      proof,
      account: hostB,
      title: 'Wave 4 other-owner event',
      startsAt: isoFromNow(20 * 60 * 1000),
      endsAt: isoFromNow(3 * 60 * 60 * 1000)
    });
    const draftEvent = await createEvent({
      server,
      proof,
      account: hostA,
      title: 'Wave 4 draft event',
      startsAt: isoFromNow(20 * 60 * 1000),
      endsAt: isoFromNow(3 * 60 * 60 * 1000),
      publish: false
    });
    const nativeEvent = { id: randomUUID() };
    const nativeEventClientRequestId = randomUUID();
    await proof.query(
      `insert into performer_events (
         id, performer_id, client_request_id, created_by_actor_user_id,
         last_mutation_actor_user_id, title, description, starts_at,
         door_opens_at, ends_at, time_zone, location_name, location_address,
         city, location_is_tba, ticketing_mode, attendance_mode, visibility,
         status, published_at
       ) values (
         $1, $2, $3, $4, $4, 'Wave 4 native-ticket fixture',
         'Disposable native-ticket linkage denial fixture',
         now() + interval '20 minutes', now() + interval '10 minutes',
         now() + interval '3 hours', 'America/Chicago', 'Wave 4 Proof Hall',
         '100 Test Avenue', 'Chicago', false, 'native_ga', 'native_ticket',
         'public', 'published', now()
       )`,
      [nativeEvent.id, hostA.performerId, nativeEventClientRequestId, hostA.userId]
    );
    await grantEventAuthority(proof, hostA.performerId, nativeEvent.id);
    const endedEvent = await createEvent({
      server,
      proof,
      account: hostA,
      title: 'Wave 4 ended event fixture',
      startsAt: isoFromNow(20 * 60 * 1000),
      endsAt: isoFromNow(3 * 60 * 60 * 1000)
    });
    await proof.query(
      `update performer_events
          set starts_at = now() - interval '2 hours',
              ends_at = now() - interval '1 hour',
              updated_at = now()
        where id = $1`,
      [endedEvent.id]
    );
    const outsideWindowEvent = await createEvent({
      server,
      proof,
      account: hostA,
      title: 'Wave 4 far-future event',
      startsAt: isoFromNow(30 * 24 * 60 * 60 * 1000),
      endsAt: isoFromNow((30 * 24 + 3) * 60 * 60 * 1000)
    });
    const concurrentEvent = await createEvent({
      server,
      proof,
      account: hostA,
      title: 'Wave 4 concurrent-link event',
      startsAt: isoFromNow(25 * 60 * 1000),
      endsAt: isoFromNow(3 * 60 * 60 * 1000)
    });
    const concurrentCancelEvent = await createEvent({
      server,
      proof,
      account: hostA,
      title: 'Wave 4 concurrent cancel event',
      startsAt: isoFromNow(30 * 60 * 1000),
      endsAt: isoFromNow(3 * 60 * 60 * 1000)
    });

    const roomAMenu = [
      {
        id: 'audience-topic',
        title: 'Audience topic',
        description: 'Suggest a clean topic for the next bit.',
        targetType: 'custom'
      },
      {
        id: 'callback-choice',
        title: 'Callback choice',
        description: 'Choose a callback for the closing set.',
        targetType: 'custom'
      }
    ];
    const roomBMenu = [
      {
        id: 'service-shoutout',
        title: 'Service shout-out',
        description: 'Share a name for a friendly shout-out.',
        targetType: 'custom'
      }
    ];
    const roomA = randomUUID();
    const roomAStart = await hostA.client.post('/api/session/start', roomStartBody({
      gigId: roomA,
      roomType: 'comedy',
      talentName: 'Wave 4 Comedy Host',
      menu: roomAMenu,
      linkedEventId: validEvent.id
    }));
    assertStatus(roomAStart, 200, 'valid linked comedy room start', server);
    assert.equal(roomAStart.body.state.session.roomType, 'comedy');
    assert.deepEqual(roomAStart.body.state.session.requestMenu, roomAMenu);
    assert.equal(roomAStart.body.state.session.linkedEventId, validEvent.id);

    const persistedRoomA = await proof.query(
      `select room_type, request_menu, linked_event_id, status
         from gig_sessions
        where id = $1`,
      [roomA]
    );
    assert.equal(persistedRoomA.rowCount, 1);
    assert.equal(persistedRoomA.rows[0].room_type, 'comedy');
    assert.deepEqual(persistedRoomA.rows[0].request_menu, roomAMenu);
    assert.equal(persistedRoomA.rows[0].linked_event_id, validEvent.id);

    await verify('database rejects malformed or cross-type request menus without mutation', async () => {
      const malformedMenus = [
        ['non-object item', ['not-an-object']],
        ['missing exact key', [{ id: 'missing-description', title: 'Missing', targetType: 'custom' }]],
        ['unexpected key', [{
          id: 'unexpected-key', title: 'Unexpected', description: 'Unexpected key proof.', targetType: 'custom', price: 1
        }]],
        ['duplicate identifiers', [
          { id: 'duplicate', title: 'First', description: 'First duplicate.', targetType: 'custom' },
          { id: 'duplicate', title: 'Second', description: 'Second duplicate.', targetType: 'custom' }
        ]],
        ['music target in comedy room', [{
          id: 'music-only', title: 'Music target', description: 'Wrong room type.', targetType: 'music'
        }]],
        ['too many items', Array.from({ length: 9 }, (_unused, index) => ({
          id: `item-${index}`,
          title: `Item ${index}`,
          description: `Bounded item ${index}.`,
          targetType: 'custom'
        }))],
        ['oversized title', [{
          id: 'long-title', title: 'T'.repeat(81), description: 'Title bound proof.', targetType: 'custom'
        }]],
        ['oversized description', [{
          id: 'long-description', title: 'Description bound', description: 'D'.repeat(241), targetType: 'custom'
        }]]
      ];
      for (const [label, menu] of malformedMenus) {
        await assert.rejects(
          proof.query(
            'update gig_sessions set request_menu = $2::jsonb where id = $1',
            [roomA, JSON.stringify(menu)]
          ),
          (error) => {
            assert.match(errorMessage(error), /gig_sessions_request_menu_shape/, String(label));
            return true;
          }
        );
      }
      const unchanged = await proof.query('select request_menu from gig_sessions where id = $1', [roomA]);
      assert.deepEqual(unchanged.rows[0]?.request_menu, roomAMenu);
      return { rejectedCases: malformedMenus.length, menuUnchanged: true };
    });

    await initialServer.stop();
    server = await startSwayServer({ databaseUrl: proof.databaseUrl, entryPath: bundle.entryPath, port });
    const restartedSession = await hostA.client.get('/api/account/session');
    assertStatus(restartedSession, 200, 'host cookie after process restart', server);
    assert.equal(restartedSession.body.performer.id, hostA.performerId);
    const restartedRoomA = await hostA.client.get(`/api/state/${roomA}`);
    assertStatus(restartedRoomA, 200, 'room state after process restart', server);
    assert.equal(restartedRoomA.body.session.roomType, 'comedy');
    assert.deepEqual(restartedRoomA.body.session.requestMenu, roomAMenu);
    assert.equal(restartedRoomA.body.session.linkedEventId, validEvent.id);
    checks.push({
      name: 'valid host-menu room start persists across process restart',
      status: 'pass',
      evidence: { roomA, eventId: validEvent.id, menuItemCount: roomAMenu.length }
    });

    await verify('public event projects the active linked room', async () => {
      const response = await new HttpClient(server.baseUrl).get(`/api/public/events/${validEvent.id}`);
      assertStatus(response, 200, 'public linked event projection', server);
      assert.equal(response.body.event.activeRoom.gigId, roomA);
      assert.equal(response.body.event.activeRoom.routePath, `/g/${roomA}`);
      assert.equal(response.body.event.activeRoom.roomType, 'comedy');
      return response.body.event.activeRoom;
    });

    if (proof.kind === 'real-postgres') {
      await verify('HTTP room closeout handles event lifecycle retry without process or payment escape', async () => (
        proveHttpCloseoutEventLifecycleRetry({
          server,
          proof,
          account: hostA,
          menu: roomAMenu
        })
      ));
    }

    await verify('invalid walk-in edit rolls back without detaching the live room', async () => {
      const before = await proof.query(
        `select linked_event_id, state_revision
           from gig_sessions
          where id = $1`,
        [roomA]
      );
      const response = await hostA.client.request(`/api/talent/events/${validEvent.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: validEvent.updatedAt,
          attendanceMode: 'walk_in',
          externalTicketUrl: null,
          externalTicketLabel: null,
          locationIsTba: true
        })
      });
      const after = await proof.query(
        `select room.linked_event_id, room.state_revision,
                event.attendance_mode, event.location_is_tba, event.updated_at
           from gig_sessions room
           join performer_events event on event.id = $2
          where room.id = $1`,
        [roomA, validEvent.id]
      );
      assertStatus(response, 422, 'invalid linked walk-in edit', server);
      assert.equal(response.body.code, 'walk_in_location_required');
      assert.equal(after.rows[0]?.linked_event_id, validEvent.id);
      assert.equal(after.rows[0]?.state_revision, before.rows[0]?.state_revision);
      assert.equal(after.rows[0]?.attendance_mode, 'external_ticket');
      assert.equal(after.rows[0]?.location_is_tba, false);
      assert.equal(new Date(after.rows[0]?.updated_at).toISOString(), validEvent.updatedAt);
      return { status: response.status, code: response.body.code, linkPreserved: true };
    });

    const roomB = randomUUID();
    const roomBStart = await hostA.client.post('/api/session/start', roomStartBody({
      gigId: roomB,
      roomType: 'service',
      talentName: 'Wave 4 Service Room',
      menu: roomBMenu
    }));
    assertStatus(roomBStart, 200, 'second host-defined room start', server);

    const patronHash = hash('wave4-generalized-room-patron');
    const patron = new HttpClient(server.baseUrl, { 'x-sway-device-id-hash': patronHash });
    const canonicalAction = actionIdentity('wave4-canonical-menu');
    const canonicalRequest = await patron.post('/api/request/create', {
      type: 'request',
      targetType: 'custom',
      menu_item_id: 'audience-topic',
      title: 'FORGED CLIENT TITLE',
      subtitle: 'FORGED CLIENT DESCRIPTION',
      senderName: 'Wave 4 Patron',
      message: 'Keep it friendly.',
      amount: 0,
      client_request_id: canonicalAction.clientRequestId,
      idempotency_key: canonicalAction.idempotencyKey,
      patron_device_id_hash: patronHash,
      gig_id: roomA,
      currency: 'USD',
      expires_at: canonicalAction.expiresAt
    });
    assertStatus(canonicalRequest, 200, 'canonical host-menu request', server);
    const privateRoomA = await hostA.client.get(`/api/state/${roomA}`);
    assertStatus(privateRoomA, 200, 'private Room A state', server);
    const canonicalRuntimeRequest = privateRoomA.body.requests.find(
      (request) => request.clientRequestId === canonicalAction.clientRequestId
    );
    assert.ok(canonicalRuntimeRequest, 'Canonical request must be visible to the host.');
    assert.equal(canonicalRuntimeRequest.title, roomAMenu[0].title);
    assert.equal(canonicalRuntimeRequest.subtitle, roomAMenu[0].description);
    assert.equal(canonicalRuntimeRequest.menuItemId, roomAMenu[0].id);
    assert.doesNotMatch(JSON.stringify(canonicalRuntimeRequest), /FORGED CLIENT/);
    checks.push({
      name: 'same-room menu selection is canonicalized by the server',
      status: 'pass',
      evidence: { requestId: canonicalRuntimeRequest.id, menuItemId: canonicalRuntimeRequest.menuItemId }
    });

    await verify('forged unknown menu item is rejected without persistence', async () => {
      const identity = actionIdentity('wave4-forged-menu');
      const response = await patron.post('/api/request/create', {
        type: 'request',
        targetType: 'custom',
        menu_item_id: 'forged-menu-item',
        title: 'Forged menu item',
        subtitle: 'Must not persist',
        senderName: 'Wave 4 Patron',
        amount: 0,
        client_request_id: identity.clientRequestId,
        idempotency_key: identity.idempotencyKey,
        patron_device_id_hash: patronHash,
        gig_id: roomA,
        currency: 'USD',
        expires_at: identity.expiresAt
      });
      const persisted = await countByClientRequestId(proof, 'requests', identity.clientRequestId);
      assertStatus(response, 422, 'forged menu request', server);
      assert.equal(response.body.code, 'room_menu_item_not_available');
      assert.equal(persisted, 0);
      return { status: response.status, code: response.body.code, persisted };
    });

    await verify('cross-room menu item is rejected without persistence', async () => {
      const identity = actionIdentity('wave4-cross-room-menu');
      const response = await patron.post('/api/request/create', {
        type: 'request',
        targetType: 'custom',
        menu_item_id: roomBMenu[0].id,
        title: 'Cross-room forged request',
        subtitle: 'Must not persist',
        senderName: 'Wave 4 Patron',
        amount: 0,
        client_request_id: identity.clientRequestId,
        idempotency_key: identity.idempotencyKey,
        patron_device_id_hash: patronHash,
        gig_id: roomA,
        currency: 'USD',
        expires_at: identity.expiresAt
      });
      const persisted = await countByClientRequestId(proof, 'requests', identity.clientRequestId);
      assertStatus(response, 422, 'cross-room menu request', server);
      assert.equal(response.body.code, 'room_menu_item_not_available');
      assert.equal(persisted, 0);
      return { status: response.status, code: response.body.code, persisted };
    });

    await verify('completed Room A identity cannot replay or leak into Room B', async () => {
      const hostileReplay = await patron.post('/api/request/create', {
        type: 'request',
        targetType: 'custom',
        menu_item_id: roomBMenu[0].id,
        title: 'HOSTILE CROSS ROOM REPLAY',
        subtitle: 'Must not receive Room A state or receipt.',
        senderName: 'Wave 4 Patron',
        message: 'Cross-room replay attempt.',
        amount: 999,
        payment_intent_id: 'pi_forged_cross_room_replay',
        client_request_id: canonicalAction.clientRequestId,
        idempotency_key: canonicalAction.idempotencyKey,
        patron_device_id_hash: patronHash,
        gig_id: roomB,
        currency: 'USD',
        expires_at: canonicalAction.expiresAt
      });
      assertStatus(hostileReplay, 409, 'cross-room completed replay', server);
      assert.equal(hostileReplay.body.code, 'idempotency_identity_mismatch');
      for (const forbiddenField of ['responseBody', 'state', 'patron_status_receipt', 'gigId']) {
        assert.equal(forbiddenField in hostileReplay.body, false, `${forbiddenField} must not leak across rooms.`);
      }
      const writes = await proof.query(
        `select
           (select count(*)::int from requests where gig_id = $1 and idempotency_key = $2) as requests,
           (select count(*)::int from payments where gig_id = $1 and idempotency_key = $2) as payments`,
        [roomB, canonicalAction.idempotencyKey]
      );
      assert.equal(Number(writes.rows[0]?.requests ?? 0), 0);
      assert.equal(Number(writes.rows[0]?.payments ?? 0), 0);
      return {
        status: hostileReplay.status,
        code: hostileReplay.body.code,
        roomBWrites: writes.rows[0]
      };
    });

    await verify('legacy two-field reconciliation requires and honors a trusted room route', async () => {
      const missingRoute = await patron.post('/api/pending-action/reconcile', {
        client_request_id: canonicalAction.clientRequestId,
        idempotency_key: canonicalAction.idempotencyKey
      });
      assertStatus(missingRoute, 400, 'legacy reconciliation without route binding', server);
      assert.equal(missingRoute.body.code, 'legacy_room_scope_required');

      const wrongRoute = await patron.post('/api/pending-action/reconcile', {
        client_request_id: canonicalAction.clientRequestId,
        idempotency_key: canonicalAction.idempotencyKey
      }, {
        headers: { referer: `${server.baseUrl}/g/${roomB}` }
      });
      assertStatus(wrongRoute, 409, 'legacy reconciliation with wrong room binding', server);
      assert.equal(wrongRoute.body.code, 'pending_action_room_mismatch');
      for (const rejected of [missingRoute, wrongRoute]) {
        assert.equal('responseBody' in rejected.body, false);
        assert.equal('gigId' in rejected.body, false);
        assert.equal('patron_status_receipt' in rejected.body, false);
      }

      const legacy = await patron.post('/api/pending-action/reconcile', {
        client_request_id: canonicalAction.clientRequestId,
        idempotency_key: canonicalAction.idempotencyKey
      }, {
        headers: { referer: `${server.baseUrl}/g/${roomA}` }
      });
      assertStatus(legacy, 200, 'legacy pending action reconciliation', server);
      assert.equal(legacy.body.status, 'reconciled');
      assert.equal(legacy.body.room_scope_source, 'trusted_route_legacy');
      assert.equal(legacy.body.recovery, 'resubmit_original_action');
      for (const forbiddenField of ['responseBody', 'gigId', 'actionType', 'patron_status_receipt']) {
        assert.equal(forbiddenField in legacy.body, false, `${forbiddenField} must not be returned by status-only recovery.`);
      }
      return {
        statuses: [missingRoute.status, wrongRoute.status, legacy.status],
        roomScopeSource: legacy.body.room_scope_source
      };
    });

    await verify('Room A pending action cannot reconcile as Room B', async () => {
      const mismatch = await patron.post('/api/pending-action/reconcile', {
        client_request_id: canonicalAction.clientRequestId,
        idempotency_key: canonicalAction.idempotencyKey,
        expected_gig_id: roomB
      });
      assertStatus(mismatch, 409, 'cross-room pending action reconciliation', server);
      assert.equal(mismatch.body.code, 'pending_action_room_mismatch');
      const correctRoom = await patron.post('/api/pending-action/reconcile', {
        client_request_id: canonicalAction.clientRequestId,
        idempotency_key: canonicalAction.idempotencyKey,
        expected_gig_id: roomA
      });
      assertStatus(correctRoom, 200, 'correct-room pending action reconciliation', server);
      assert.equal(correctRoom.body.status, 'reconciled');
      return { mismatchStatus: mismatch.status, correctRoomStatus: correctRoom.body.status };
    });

    const approveCanonical = await hostA.client.post('/api/request/triage', {
      requestId: canonicalRuntimeRequest.id,
      action: 'approve',
      gig_id: roomA
    });
    assertStatus(approveCanonical, 200, 'approve canonical request for boost proof', server);

    await verify('nonmusic free upvote remains durable and nonmonetary', async () => {
      const identity = actionIdentity('wave4-free-upvote');
      const response = await patron.post('/api/request/boost', {
        requestId: canonicalRuntimeRequest.id,
        patronName: 'Wave 4 Patron',
        boostAmount: 1,
        client_request_id: identity.clientRequestId,
        idempotency_key: identity.idempotencyKey,
        patron_device_id_hash: patronHash,
        gig_id: roomA,
        currency: 'USD',
        expires_at: identity.expiresAt
      });
      assertStatus(response, 200, 'non-music free upvote', server);
      assert.equal(response.body.success, true);

      const persisted = await proof.query(`
        select amount_cents, money_required,
               runtime_boost_state ->> 'amount' as runtime_amount,
               runtime_boost_state ->> 'paymentStatus' as payment_status,
               activated_at is not null as active
        from request_boosts
        where client_request_id = $1
      `, [identity.clientRequestId]);
      assert.equal(persisted.rows.length, 1);
      assert.equal(persisted.rows[0].amount_cents, 0);
      assert.equal(persisted.rows[0].money_required, false);
      assert.equal(persisted.rows[0].runtime_amount, '1');
      assert.equal(persisted.rows[0].payment_status, 'not_applicable');
      assert.equal(persisted.rows[0].active, true);
      return {
        status: response.status,
        amountCents: persisted.rows[0].amount_cents,
        moneyRequired: persisted.rows[0].money_required,
        runtimeWeight: Number(persisted.rows[0].runtime_amount)
      };
    });

    await verify('nonmusic paid request intent is rejected', async () => {
      const identity = actionIdentity('wave4-hostile-paid-request');
      const response = await patron.post('/api/request/create', {
        type: 'request',
        targetType: 'custom',
        menu_item_id: roomAMenu[1].id,
        title: 'Hostile paid request',
        subtitle: 'Must not become free silently',
        senderName: 'Wave 4 Patron',
        amount: 25,
        payment_method: 'pm_wave4_nonmusic_request',
        client_request_id: identity.clientRequestId,
        idempotency_key: identity.idempotencyKey,
        patron_device_id_hash: patronHash,
        gig_id: roomA,
        currency: 'USD',
        expires_at: identity.expiresAt
      });
      const requestCount = await countByClientRequestId(proof, 'requests', identity.clientRequestId);
      const paymentCount = await countPaymentsByIdempotencyKey(proof, identity.idempotencyKey);
      assertNonMusicMoneyDenial(response, 'Non-music paid request intent', { requestCount, paymentCount });
      assert.equal(requestCount, 0, 'A rejected paid request must not become a free request.');
      assert.equal(paymentCount, 0, 'A rejected paid request must not create a payment row.');
      return { status: response.status, code: response.body.code, requestCount, paymentCount };
    });

    await verify('nonmusic straight tip intent is rejected', async () => {
      const identity = actionIdentity('wave4-hostile-tip');
      const response = await patron.post('/api/request/create', {
        type: 'tip',
        targetType: 'straight_tip',
        senderName: 'Wave 4 Patron',
        amount: 20,
        payment_method: 'pm_wave4_nonmusic_tip',
        client_request_id: identity.clientRequestId,
        idempotency_key: identity.idempotencyKey,
        patron_device_id_hash: patronHash,
        gig_id: roomA,
        currency: 'USD',
        expires_at: identity.expiresAt
      });
      const requestCount = await countByClientRequestId(proof, 'requests', identity.clientRequestId);
      const paymentCount = await countPaymentsByIdempotencyKey(proof, identity.idempotencyKey);
      assertNonMusicMoneyDenial(response, 'Non-music straight tip intent', { requestCount, paymentCount });
      assert.equal(requestCount, 0);
      assert.equal(paymentCount, 0);
      return { status: response.status, code: response.body.code, requestCount, paymentCount };
    });

    await verify('nonmusic paid boost intent is rejected', async () => {
      const identity = actionIdentity('wave4-hostile-boost');
      const response = await patron.post('/api/request/boost', {
        requestId: canonicalRuntimeRequest.id,
        patronName: 'Wave 4 Patron',
        boostAmount: 25,
        payment_method: 'pm_wave4_nonmusic_boost',
        client_request_id: identity.clientRequestId,
        idempotency_key: identity.idempotencyKey,
        patron_device_id_hash: patronHash,
        gig_id: roomA,
        currency: 'USD',
        expires_at: identity.expiresAt
      });
      const boostCount = await countByClientRequestId(proof, 'request_boosts', identity.clientRequestId);
      const paymentCount = await countPaymentsByIdempotencyKey(proof, identity.idempotencyKey);
      assertNonMusicMoneyDenial(response, 'Non-music paid boost intent', { boostCount, paymentCount });
      assert.equal(boostCount, 0, 'A rejected paid boost must not become a free upvote.');
      assert.equal(paymentCount, 0);
      return { status: response.status, code: response.body.code, boostCount, paymentCount };
    });

    await verify('nonmusic supplied payment intent is rejected', async () => {
      const identity = actionIdentity('wave4-hostile-payment-intent');
      const response = await patron.post('/api/request/create', {
        type: 'request',
        targetType: 'custom',
        menu_item_id: roomAMenu[1].id,
        title: 'Forged payment confirmation',
        subtitle: 'Must fail at room policy',
        senderName: 'Wave 4 Patron',
        amount: 25,
        payment_intent_id: `pi_wave4_${randomUUID().replaceAll('-', '')}`,
        client_request_id: identity.clientRequestId,
        idempotency_key: identity.idempotencyKey,
        patron_device_id_hash: patronHash,
        gig_id: roomA,
        currency: 'USD',
        expires_at: identity.expiresAt
      });
      const requestCount = await countByClientRequestId(proof, 'requests', identity.clientRequestId);
      const paymentCount = await countPaymentsByIdempotencyKey(proof, identity.idempotencyKey);
      assertNonMusicMoneyDenial(response, 'Non-music supplied payment intent', { requestCount, paymentCount });
      assert.equal(requestCount, 0);
      assert.equal(paymentCount, 0);
      return { status: response.status, code: response.body.code, requestCount, paymentCount };
    });

    const linkDenial = async ({ name, eventId, statuses, codes, expectedGap = false }) => {
      if (expectedGap) expectedProductGaps.add(name);
      await verify(name, async () => {
        const gigId = randomUUID();
        const response = await hostA.client.post('/api/session/start', roomStartBody({
          gigId,
          roomType: 'comedy',
          talentName: 'Wave 4 Link Denial Host',
          menu: roomAMenu,
          linkedEventId: eventId
        }));
        const persisted = await proof.query(
          'select count(*)::int as count from gig_sessions where id = $1',
          [gigId]
        );
        assertStatus(response, statuses, name, server);
        assert.ok(codes.includes(response.body.code), `${name}: unexpected code ${response.body.code}`);
        assert.equal(Number(persisted.rows[0]?.count ?? 0), 0, `${name}: denied room must not persist.`);
        return { status: response.status, code: response.body.code, gigId };
      });
    };

    await linkDenial({
      name: 'wrong-owner event linkage is denied',
      eventId: wrongOwnerEvent.id,
      statuses: 422,
      codes: ['linked_event_not_eligible']
    });
    await linkDenial({
      name: 'draft event linkage is denied',
      eventId: draftEvent.id,
      statuses: 422,
      codes: ['linked_event_not_eligible']
    });
    await linkDenial({
      name: 'native-ticket event linkage is denied',
      eventId: nativeEvent.id,
      statuses: 422,
      codes: ['linked_event_not_eligible']
    });
    await linkDenial({
      name: 'ended event linkage is denied',
      eventId: endedEvent.id,
      statuses: 422,
      codes: ['linked_event_not_eligible']
    });
    await linkDenial({
      name: 'duplicate active event linkage is denied',
      eventId: validEvent.id,
      statuses: 409,
      codes: ['linked_event_room_already_active']
    });
    await linkDenial({
      name: 'far-future event is outside the room-link window',
      eventId: outsideWindowEvent.id,
      statuses: 422,
      codes: ['linked_event_not_eligible', 'linked_event_outside_live_window'],
      expectedGap: true
    });

    await verify('concurrent link attempts produce one room and one conflict', async () => {
      const gigIds = [randomUUID(), randomUUID()];
      const responses = await Promise.all(gigIds.map((gigId) => hostA.client.post(
        '/api/session/start',
        roomStartBody({
          gigId,
          roomType: 'comedy',
          talentName: 'Wave 4 Concurrent Host',
          menu: roomAMenu,
          linkedEventId: concurrentEvent.id
        })
      )));
      const statuses = responses.map((response) => response.status).sort((left, right) => left - right);
      const linkedRows = await proof.query(
        `select id from gig_sessions
          where linked_event_id = $1
            and status in ('active', 'closeout_pending')`,
        [concurrentEvent.id]
      );
      assert.deepEqual(statuses, [200, 409]);
      const loser = responses.find((response) => response.status !== 200);
      assert.ok(
        loser?.body.code === 'linked_event_room_already_active'
          || (loser?.status === 409 && typeof loser?.body.error === 'string' && loser.body.error.length > 0),
        `The losing concurrent request must return a described 409 conflict, received ${JSON.stringify(loser?.body)}.`
      );
      assert.equal(linkedRows.rowCount, 1, 'The partial unique index must leave one active linked room.');
      return {
        gigIds,
        statuses,
        loserCode: loser?.body.code ?? null,
        loserError: loser?.body.error ?? null,
        persistedGigId: linkedRows.rows[0].id
      };
    });

    await verify('direct event mutation cannot bypass the linked-room lifecycle lock', async () => {
      await assert.rejects(
        proof.query(
          `update performer_events
              set starts_at = starts_at + interval '5 minutes'
            where id = $1`,
          [concurrentEvent.id]
        ),
        /Detach the active Sway room before changing linked event lifecycle fields/
      );
      const linked = await proof.query(
        `select count(*)::int as count
           from gig_sessions
          where linked_event_id = $1
            and status in ('active', 'closeout_pending')`,
        [concurrentEvent.id]
      );
      assert.equal(Number(linked.rows[0]?.count ?? 0), 1);
      return { directMutationRejected: true, activeLinkCount: Number(linked.rows[0]?.count ?? 0) };
    });

    await verify('service event reschedule atomically detaches the linked room with audit', async () => {
      const before = await proof.query(
        `select id, state_revision
           from gig_sessions
          where linked_event_id = $1
            and status in ('active', 'closeout_pending')`,
        [concurrentEvent.id]
      );
      assert.equal(before.rowCount, 1);
      const response = await hostA.client.request(`/api/talent/events/${concurrentEvent.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: concurrentEvent.updatedAt,
          startsAt: isoFromNow(40 * 60 * 1000)
        })
      });
      assertStatus(response, 200, 'linked event reschedule', server);
      const after = await proof.query(
        `select linked_event_id, state_revision,
                runtime_session_state ->> 'linkedEventId' as runtime_linked_event_id
           from gig_sessions
          where id = $1`,
        [before.rows[0].id]
      );
      const audit = await proof.query(
        `select count(*)::int as count
           from audit_events
          where entity_type = 'gig_session'
            and entity_id = $1
            and event_type = 'gig_session.linked_event_detached'
            and metadata ->> 'eventId' = $2`,
        [before.rows[0].id, concurrentEvent.id]
      );
      assert.equal(after.rows[0]?.linked_event_id, null);
      assert.equal(after.rows[0]?.runtime_linked_event_id, null);
      assert.equal(Number(after.rows[0]?.state_revision), Number(before.rows[0]?.state_revision) + 1);
      assert.equal(Number(audit.rows[0]?.count ?? 0), 1);
      return { roomId: before.rows[0].id, revisionIncremented: true, auditCount: 1 };
    });

    await verify('concurrent event cancellation and room linkage leave no stale active link', async () => {
      const gigId = randomUUID();
      const [startResponse, cancelResponse] = await Promise.all([
        hostA.client.post('/api/session/start', roomStartBody({
          gigId,
          roomType: 'comedy',
          talentName: 'Wave 4 Cancel Race Host',
          menu: roomAMenu,
          linkedEventId: concurrentCancelEvent.id
        })),
        hostA.client.post(`/api/talent/events/${concurrentCancelEvent.id}/cancel`, {
          expectedUpdatedAt: concurrentCancelEvent.updatedAt,
          cancellationReason: 'Disposable concurrent cancellation proof.'
        })
      ]);
      assertStatus(cancelResponse, 200, 'concurrent event cancellation', server);
      assert.ok(
        [200, 409, 422].includes(startResponse.status),
        `Concurrent room start returned ${startResponse.status}: ${JSON.stringify(startResponse.body)}\n${server.logs()}`
      );
      const truth = await proof.query(
        `select event.status,
                (select count(*)::int
                   from gig_sessions room
                  where room.linked_event_id = event.id
                    and room.status in ('active', 'closeout_pending')) as active_links
           from performer_events event
          where event.id = $1`,
        [concurrentCancelEvent.id]
      );
      assert.equal(truth.rows[0]?.status, 'cancelled');
      assert.equal(Number(truth.rows[0]?.active_links ?? 0), 0);
      return {
        startStatus: startResponse.status,
        cancelStatus: cancelResponse.status,
        finalStatus: truth.rows[0]?.status,
        activeLinks: 0
      };
    });

    await verify('host menu receives durable moderation review', async () => {
      const reviews = await proof.query(
        `select status, metadata
           from moderation_events
          where entity_type = 'room_menu_item'
            and metadata->>'gigId' = $1
          order by created_at asc`,
        [roomA]
      );
      assert.equal(reviews.rowCount, roomAMenu.length, 'Every public host menu item needs one durable review record.');
      assert.deepEqual(
        reviews.rows.map((row) => row.status),
        roomAMenu.map(() => 'allowed')
      );
      return { reviewCount: reviews.rowCount };
    });

    await verify('host menu moderation rejects abusive content', async () => {
      const gigId = randomUUID();
      const response = await hostA.client.post('/api/session/start', roomStartBody({
        gigId,
        roomType: 'comedy',
        talentName: 'Wave 4 Moderation Host',
        menu: [{
          id: 'abusive-menu-fixture',
          title: 'Fuck the heckler',
          description: 'Target one audience member for humiliation.',
          targetType: 'custom'
        }]
      }));
      const persisted = await proof.query(
        'select count(*)::int as count from gig_sessions where id = $1',
        [gigId]
      );
      assert.ok(
        [403, 422].includes(response.status),
        `Abusive menu was accepted: ${JSON.stringify({
          status: response.status,
          code: response.body.code ?? null,
          success: response.body.success ?? null,
          persisted: Number(persisted.rows[0]?.count ?? 0)
        })}`
      );
      assert.ok(
        [
          'room_menu_blocked',
          'room_menu_review_required',
          'room_menu_moderation_rejected',
          'room_menu_content_not_allowed'
        ].includes(response.body.code),
        `Unexpected abusive-menu code: ${response.body.code}`
      );
      assert.equal(Number(persisted.rows[0]?.count ?? 0), 0);
      return { status: response.status, code: response.body.code };
    });

    const expiredRoomMenuReportDedupeKey = hash(`expired-room-menu-report:${randomUUID()}`);
    const expiredRoomMenuReporterFingerprint = hash(`expired-room-menu-reporter:${randomUUID()}`);
    const expiredRoomMenuIpHash = hash(`expired-room-menu-ip:${randomUUID()}`);
    await proof.query(
      `insert into moderation_events (
         dedupe_key, reporter_fingerprint, requester_ip_hash,
         report_window_started_at, retention_expires_at,
         entity_type, entity_id, status, reason, metadata, created_at
       ) values (
         $1, $2, $3,
         date_trunc('day', now() - interval '31 days'), now() - interval '1 day',
         'room_menu_item_report', $4, 'held_for_review', $5, $6::jsonb,
         now() - interval '31 days'
       )`,
      [
        expiredRoomMenuReportDedupeKey,
        expiredRoomMenuReporterFingerprint,
        expiredRoomMenuIpHash,
        randomUUID(),
        'Expired Wave 4 room menu report proof',
        JSON.stringify({ source: 'moderation.room_menu.report', patronDeviceIdHash: patronHash })
      ]
    );
    const roomMenuReportReason = 'Wave 4 room menu report proof';
    const roomMenuReportDetails = 'Disposable room-menu report evidence only.';
    await verify('public room-menu report is durably recorded', async () => {
      const response = await patron.post('/api/moderation/report', {
        gig_id: roomA,
        menu_item_id: roomAMenu[0].id,
        reason: roomMenuReportReason,
        details: roomMenuReportDetails,
        patron_device_id_hash: patronHash
      });
      assertStatus(response, 202, 'room-menu report', server);
      assert.equal(response.body.moderation_action, 'room_menu_report_submitted');
      const report = await proof.query(
        `select status, reason, metadata
           from moderation_events
          where entity_type = 'room_menu_item_report'
            and reason = $1
          order by created_at desc
          limit 1`,
        [roomMenuReportReason]
      );
      assert.equal(report.rowCount, 1);
      assert.equal(report.rows[0].status, 'held_for_review');
      assert.equal(report.rows[0].metadata.source, 'moderation.room_menu.report');
      assert.equal(report.rows[0].metadata.gigId, roomA);
      assert.equal(report.rows[0].metadata.menuItemId, roomAMenu[0].id);
      const expiredReport = await proof.query(
        `select count(*)::int as count
           from moderation_events
          where dedupe_key = $1`,
        [expiredRoomMenuReportDedupeKey]
      );
      assert.equal(Number(expiredReport.rows[0]?.count ?? 0), 0);
      return {
        status: response.status,
        moderationAction: response.body.moderation_action,
        durableReportCount: report.rowCount,
        expiredReportCount: Number(expiredReport.rows[0]?.count ?? 0)
      };
    });

    await verify('identical room-menu report retry is idempotent', async () => {
      const duplicate = await patron.post('/api/moderation/report', {
        gig_id: roomA,
        menu_item_id: roomAMenu[0].id,
        reason: roomMenuReportReason,
        details: roomMenuReportDetails,
        patron_device_id_hash: patronHash
      });
      assertStatus(duplicate, 202, 'duplicate room-menu report', server);
      assert.equal(duplicate.body.moderation_action, 'room_menu_report_already_submitted');
      const persisted = await proof.query(
        `select count(*)::int as count
           from moderation_events
          where entity_type = 'room_menu_item_report'
            and reason = $1`,
        [roomMenuReportReason]
      );
      assert.equal(Number(persisted.rows[0]?.count ?? 0), 1);
      return {
        status: duplicate.status,
        moderationAction: duplicate.body.moderation_action,
        durableReportCount: Number(persisted.rows[0]?.count ?? 0)
      };
    });

    await verify('changed report text cannot bypass the durable reporter-menu identity', async () => {
      const responses = await Promise.all([
        patron.post('/api/moderation/report', {
          gig_id: roomA,
          menu_item_id: roomAMenu[0].id,
          reason: 'Wave 4 changed-text report proof A',
          details: 'First changed-text retry.',
          patron_device_id_hash: patronHash
        }),
        patron.post('/api/moderation/report', {
          gig_id: roomA,
          menu_item_id: roomAMenu[0].id,
          reason: 'Wave 4 changed-text report proof B',
          details: 'Second changed-text retry.',
          patron_device_id_hash: patronHash
        })
      ]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [202, 202]);
      assert.ok(responses.every(
        (response) => response.body.moderation_action === 'room_menu_report_already_submitted'
      ));
      const persisted = await proof.query(
        `select count(*)::int as count
           from moderation_events
          where entity_type = 'room_menu_item_report'
            and metadata ->> 'patronDeviceIdHash' = $1
            and entity_id = (
              select entity_id
              from moderation_events
              where entity_type = 'room_menu_item_report'
                and reason = $2
              limit 1
            )`,
        [patronHash, roomMenuReportReason]
      );
      assert.equal(Number(persisted.rows[0]?.count ?? 0), 1);
      return {
        statuses: responses.map((response) => response.status).sort(),
        moderationActions: responses.map((response) => response.body.moderation_action),
        durableIdentityCount: Number(persisted.rows[0]?.count ?? 0)
      };
    });

    await verify('concurrent reports for distinct menu items are durably rate bounded', async () => {
      const responses = await Promise.all([
        patron.post('/api/moderation/report', {
          gig_id: roomA,
          menu_item_id: roomAMenu[1].id,
          reason: 'Wave 4 bounded distinct menu proof A',
          details: 'First distinct menu report.',
          patron_device_id_hash: patronHash
        }),
        patron.post('/api/moderation/report', {
          gig_id: roomB,
          menu_item_id: roomBMenu[0].id,
          reason: 'Wave 4 bounded distinct menu proof B',
          details: 'Second distinct menu report.',
          patron_device_id_hash: patronHash
        })
      ]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [202, 429]);
      const rateLimited = responses.find((response) => response.status === 429);
      assert.equal(rateLimited?.body.code, 'room_menu_report_rate_limited');
      assert.match(rateLimited?.headers.get('retry-after') ?? '', /^\d+$/);
      const persisted = await proof.query(
        `select count(*)::int as count
           from moderation_events
          where entity_type = 'room_menu_item_report'
            and metadata ->> 'patronDeviceIdHash' = $1`,
        [patronHash]
      );
      assert.equal(Number(persisted.rows[0]?.count ?? 0), 2);
      return {
        statuses: responses.map((response) => response.status).sort(),
        rateLimitCode: rateLimited?.body.code,
        durableReportCount: Number(persisted.rows[0]?.count ?? 0)
      };
    });

    await verify('generic content report is durable for a menu-created request', async () => {
      const response = await patron.post('/api/moderation/report', {
        requestId: canonicalRuntimeRequest.id,
        reason: 'Wave 4 menu request report proof',
        details: 'Disposable report evidence only.',
        patron_device_id_hash: patronHash
      });
      assertStatus(response, 200, 'generic request report', server);
      assert.equal(response.body.moderation_action, 'report_submitted');
      const report = await proof.query(
        `select status, reason, metadata
           from moderation_events
          where entity_type = 'request_report'
            and reason = $1
          order by created_at desc
          limit 1`,
        ['Wave 4 menu request report proof']
      );
      assert.equal(report.rowCount, 1);
      assert.equal(report.rows[0].status, 'held_for_review');
      assert.equal(report.rows[0].metadata.source, 'moderation.report');
      return { status: response.status, durableReportCount: report.rowCount };
    });

    await verify('event cancellation atomically detaches the room and hides public room linkage', async () => {
      const before = await proof.query(
        `select linked_event_id, state_revision
           from gig_sessions
          where id = $1`,
        [roomA]
      );
      const response = await hostA.client.post(`/api/talent/events/${validEvent.id}/cancel`, {
        expectedUpdatedAt: validEvent.updatedAt,
        cancellationReason: 'Disposable Wave 4 cancellation lifecycle proof.'
      });
      assertStatus(response, 200, 'linked event cancellation', server);
      assert.equal(response.body.event.status, 'cancelled');
      const after = await proof.query(
        `select linked_event_id, state_revision,
                runtime_session_state ->> 'linkedEventId' as runtime_linked_event_id
           from gig_sessions
          where id = $1`,
        [roomA]
      );
      const publicEvent = await new HttpClient(server.baseUrl).get(`/api/public/events/${validEvent.id}`);
      assertStatus(publicEvent, 200, 'cancelled public event', server);
      assert.equal(after.rows[0]?.linked_event_id, null);
      assert.equal(after.rows[0]?.runtime_linked_event_id, null);
      assert.equal(Number(after.rows[0]?.state_revision), Number(before.rows[0]?.state_revision) + 1);
      assert.equal(publicEvent.body.event.status, 'cancelled');
      assert.equal(publicEvent.body.event.activeRoom, null);
      return {
        eventStatus: response.body.event.status,
        revisionIncremented: true,
        publicActiveRoom: publicEvent.body.event.activeRoom
      };
    });

    const summary = {
      proofKind: proof.kind,
      disposableServerBundleBuilds: 1,
      processStarts: 2,
      realSignupLoginAccounts: 2,
      paymentRuntimeFailClosed: paymentConfig.status === 503,
      checks,
      totals: {
        passed: checks.filter((check) => check.status === 'pass').length,
        failed: unmet.length,
        expectedNotYetLanded: unmet.filter((check) => check.expectedGap).length,
        unexpected: unmet.filter((check) => !check.expectedGap).length
      },
      menuReportRoute: 'The room-menu branch of /api/moderation/report was exercised with durable PostgreSQL evidence.'
    };
    console.log(JSON.stringify(summary, null, 2));

    if (unmet.length > 0) {
      throw new AggregateError(
        unmet.map((failure) => new Error(`${failure.name}: ${failure.error}`)),
        `Wave 4 HTTP/PostgreSQL proof found ${unmet.length} unmet product assertion(s).`
      );
    }
  } catch (error) {
    proofError = error;
  }

  const cleanupFailures = await collectCleanupFailures([
    ['Sway proof server shutdown failed', async () => server?.stop()],
    ['embedded PostgreSQL proof shutdown failed', async () => proof.close()],
    ['disposable server bundle cleanup failed', async () => removeDisposableServerBundle(bundle)]
  ]);

  if (proofError && cleanupFailures.length > 0) {
    throw new AggregateError(
      [proofError, ...cleanupFailures],
      'Generalized live-room proof failed and teardown also reported errors.',
      { cause: proofError }
    );
  }
  if (proofError) throw proofError;
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'Generalized live-room proof teardown failed.');
  }
}

run().catch((error) => {
  console.error('Generalized live-room HTTP/PostgreSQL integration proof failed:');
  console.error(errorMessage(error));
  process.exitCode = 1;
});
