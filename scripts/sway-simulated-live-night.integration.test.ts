import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

type JsonObject = Record<string, any>;

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function reservePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => resolve());
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a local proof port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

class HttpClient {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly defaultHeaders: Record<string, string> = {}
  ) {}

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private captureCookies(cookies: string[]) {
    for (const cookie of cookies) {
      const pair = cookie.split(';', 1)[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (/max-age=0/i.test(cookie) || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async navigate(path: string, headers: Record<string, string>) {
    const url = new URL(path, this.baseUrl);
    return new Promise<{ status: number; body: JsonObject; headers: Headers }>((resolve, reject) => {
      const request = httpRequest(url, { method: 'GET', headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          this.captureCookies(response.headers['set-cookie'] ?? []);
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
            else if (value !== undefined) responseHeaders.set(name, String(value));
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let body: JsonObject = {};
          if (text) {
            try {
              body = JSON.parse(text) as JsonObject;
            } catch {
              body = { text };
            }
          }
          resolve({ status: response.statusCode ?? 0, body, headers: responseHeaders });
        });
      });
      request.on('error', reject);
      request.end();
    });
  }

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(this.defaultHeaders);
    for (const [name, value] of new Headers(init.headers).entries()) headers.set(name, value);
    if (this.cookies.size) {
      headers.set('cookie', [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, redirect: init.redirect ?? 'manual' });
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter((value): value is string => Boolean(value));
    this.captureCookies(cookies);
    const text = await response.text();
    let body: JsonObject = {};
    if (text) {
      try {
        body = JSON.parse(text) as JsonObject;
      } catch {
        body = { text };
      }
    }
    return { status: response.status, body, headers: response.headers };
  }

  get(path: string, init: RequestInit = {}) {
    return this.request(path, { ...init, method: 'GET' });
  }

  post(path: string, body: JsonObject, init: RequestInit = {}) {
    return this.request(path, {
      ...init,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(init.headers).entries()) },
      body: JSON.stringify(body)
    });
  }
}

type RunningServer = {
  baseUrl: string;
  logs: () => string;
  stop: () => Promise<void>;
};

async function startSwayServer(
  databaseUrl: string,
  port: number,
  envOverrides: Record<string, string> = {}
): Promise<RunningServer> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DISABLE_HMR: 'true',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      SWAY_APP_BASE_URL: baseUrl,
      APP_URL: baseUrl,
      APP_BASE_URL: baseUrl,
      SWAY_DISCOVERY_ATTRIBUTION_SECRET: 'simulated-live-night-attribution-secret-2026',
      VITE_SWAY_DEMO_MODE: 'false',
      SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED: 'false',
      STRIPE_SECRET_KEY: '',
      STRIPE_PUBLISHABLE_KEY: '',
      VITE_STRIPE_PUBLISHABLE_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED: 'false',
      SWAY_EMAIL_PROVIDER: '',
      SWAY_EMAIL_API_KEY: '',
      SWAY_EMAIL_FROM: '',
      ...envOverrides
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams;

  const output: string[] = [];
  const record = (chunk: Buffer) => {
    output.push(chunk.toString('utf8'));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);

  const earlyExit = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code, signal) => reject(new Error(
      `Sway proof server exited before readiness (code=${code}, signal=${signal}).\n${output.join('')}`
    )));
  });
  const readiness = (async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}/api/health/network-probe`);
        if (response.status === 204) return;
      } catch {
        // The listener is not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for the Sway proof server.\n${output.join('')}`);
  })();

  const stopChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const forced = new Promise<void>((resolve) => setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      resolve();
    }, 5_000));
    await Promise.race([stopped, forced]);
  };
  try {
    await Promise.race([readiness, earlyExit]);
  } catch (error) {
    await stopChild();
    throw error;
  }

  return {
    baseUrl,
    logs: () => output.join(''),
    stop: stopChild
  };
}

function assertStatus(
  response: { status: number; body: JsonObject },
  expected: number | number[],
  label: string,
  server: RunningServer
) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status),
    `${label}: expected ${statuses.join(' or ')}, received ${response.status}: ${JSON.stringify(response.body)}\n${server.logs()}`);
}

async function waitForDatabaseState(
  assertion: () => Promise<boolean>,
  label: string,
  timeoutMs = 15_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function discoveryLandingBody(
  journeyId: string,
  linkStrength: 'direct_server_observed' | 'client_correlated_unverified' = 'client_correlated_unverified'
) {
  return {
    event: 'discovery_landing',
    shell: 'patron',
    surface: 'public-discover',
    route_family: 'public-discover',
    has_route_context: true,
    has_session_context: false,
    build_commit: 'client-runtime',
    attribution_channel: 'google',
    journey_id: journeyId,
    entry_path: '/discover',
    visibility_eligibility: 'unknown',
    link_strength: linkStrength
  };
}

async function createPerformerAccount(input: {
  server: RunningServer;
  suffix: string;
  displayName: string;
  handle: string;
  discoveryJourneyId?: string;
}) {
  const client = new HttpClient(input.server.baseUrl);
  const email = `simulated-${input.suffix}@example.test`;
    const password = `Sway!${input.suffix}-Pilot-2026-Long`;
  if (input.discoveryJourneyId) {
    const landing = await client.navigate('/discover?utm_source=google&utm_medium=organic&utm_campaign=simulated-live-night', {
      referer: 'https://www.google.com/search?q=sway+tips',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document'
    });
    assertStatus(landing, 200, `${input.suffix} signed discovery landing`, input.server);
    const discoveryEntry = await client.post('/api/analytics/shell', discoveryLandingBody(input.discoveryJourneyId));
    assertStatus(discoveryEntry, 202, `${input.suffix} durable discovery entry`, input.server);
  }
  const signup = await client.post('/api/account/signup', {
    displayName: input.displayName,
    email,
    password,
    confirmPassword: password,
    termsAccepted: true,
    next: '/account?intent=performer',
    discoveryJourneyId: input.discoveryJourneyId
  });
  assertStatus(signup, 202, `${input.suffix} account signup`, input.server);
  assert.match(String(signup.body.verificationLink ?? ''), /\/api\/account\/verify-email\/consume\?token=/);

  const verificationUrl = new URL(String(signup.body.verificationLink));
  const verification = await client.get(`${verificationUrl.pathname}${verificationUrl.search}`);
  assertStatus(verification, 302, `${input.suffix} email verification`, input.server);
  const verificationLocation = new URL(String(verification.headers.get('location') ?? ''), input.server.baseUrl);
  assert.equal(verificationLocation.pathname, '/account/login');
  assert.equal(verificationLocation.searchParams.get('verified'), '1');
  assert.equal(verificationLocation.searchParams.get('next'), '/account?intent=performer');

  const login = await client.post('/api/account/login', { email, password, next: '/account?intent=performer' });
  assertStatus(login, 200, `${input.suffix} account login`, input.server);
  assert.equal(login.body.redirectPath, '/account?intent=performer');

  const beforePro = await client.get('/api/account/session');
  assertStatus(beforePro, 200, `${input.suffix} pre-Pro account session`, input.server);
  assert.equal(beforePro.body.account.proModeStatus, 'disabled');
  assert.equal(beforePro.body.performer, null);

  const activation = await client.post('/api/account/pro-mode/activate', {
    displayName: input.displayName,
    handle: input.handle
  });
  assertStatus(activation, 200, `${input.suffix} Pro Mode activation`, input.server);
  assert.equal(activation.body.status, 'active');
  assert.equal(activation.body.redirectPath, '/talent');

  const afterPro = await client.get('/api/account/session');
  assertStatus(afterPro, 200, `${input.suffix} performer account session`, input.server);
  assert.equal(afterPro.body.account.proModeStatus, 'active');
  assert.equal(afterPro.body.performer.handle, input.handle);
  return { client, email, performerId: String(afterPro.body.performer.id) };
}

function freeRequestBody(input: {
  gigId: string;
  label: string;
  deviceHash: string;
  message?: string;
}) {
  const clientRequestId = `${input.label}-${randomUUID()}`;
  return {
    body: {
      type: 'request',
      targetType: 'music',
      title: input.label,
      subtitle: 'Simulated Artist',
      senderName: `Patron ${input.label}`,
      message: input.message ?? '',
      amount: 0,
      client_request_id: clientRequestId,
      idempotency_key: `idempotency-${clientRequestId}`,
      patron_device_id_hash: input.deviceHash,
      gig_id: input.gigId,
      currency: 'USD',
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    },
    clientRequestId
  };
}

async function main() {
  const proof = await startEmbeddedPostgresProof('simulated_live_night');
  const port = await reservePort();
  let server: RunningServer | null = null;

  try {
    server = await startSwayServer(proof.databaseUrl, port);
    const runtime = await new HttpClient(server.baseUrl).get('/api/runtime-config-status');
    assertStatus(runtime, 200, 'runtime safety status', server);
    assert.equal(runtime.body.liveRoomDurabilityWritesEnabled, true);
    assert.equal(runtime.body.liveRoomDurabilityKillSwitchActive, false);
    const paymentConfig = await new HttpClient(server.baseUrl).get('/api/payment/config');
    assertStatus(paymentConfig, 503, 'payment provider disabled in simulated night', server);
    assert.notEqual(paymentConfig.body.mode, 'live');
    const legacySignup = await new HttpClient(server.baseUrl).post('/api/talent/signup', {
      displayName: 'Legacy Split Account',
      handle: 'legacy-split-account',
      email: 'legacy-split@example.test',
      password: 'Sway!Legacy-2026',
      confirmPassword: 'Sway!Legacy-2026',
      termsAccepted: true
    });
    assertStatus(legacySignup, 410, 'legacy performer signup is terminal', server);
    assert.equal(legacySignup.body.code, 'universal_account_required');
    assert.equal(legacySignup.body.redirectPath, '/account/signup?intent=performer');

    const forgedJourneyId = randomUUID();
    const forgedEntry = await new HttpClient(server.baseUrl).post(
      '/api/analytics/shell',
      discoveryLandingBody(forgedJourneyId, 'direct_server_observed'),
      {
        headers: {
          host: 'attacker.example',
          referer: 'https://attacker.example/discover?utm_source=google&utm_medium=organic&utm_campaign=forged'
        }
      }
    );
    assertStatus(forgedEntry, 202, 'forged Host and Referer discovery entry', server);
    const forgedEvidence = await proof.query<{ source_class: string; link_strength: string; utm_source: string | null }>(
      `select metadata->>'source_class' as source_class,
              metadata->>'link_strength' as link_strength,
              metadata->>'utm_source' as utm_source
       from audit_events
       where entity_type = 'shell_friction' and metadata->>'journey_id' = $1
       order by created_at asc limit 1`,
      [forgedJourneyId]
    );
    assert.deepEqual(forgedEvidence.rows[0], {
      source_class: 'unknown',
      link_strength: 'client_correlated_unverified',
      utm_source: null
    }, 'Caller-forged Host, Referer, UTM, and link strength must never become organic evidence.');

    const directTypedJourneyId = randomUUID();
    const directTypedClient = new HttpClient(server.baseUrl);
    const directTypedLanding = await directTypedClient.get(
      '/discover?utm_source=google&utm_medium=organic&utm_campaign=typed-directly'
    );
    assertStatus(directTypedLanding, 200, 'directly typed organic UTM landing', server);
    assert.doesNotMatch(directTypedClient.cookieHeader(), /sway_discovery_attribution=/,
      'UTM parameters without independently observed provider navigation must not receive a signed receipt.');
    const directTypedEntry = await directTypedClient.post(
      '/api/analytics/shell',
      discoveryLandingBody(directTypedJourneyId, 'direct_server_observed')
    );
    assertStatus(directTypedEntry, 202, 'directly typed UTM discovery entry', server);
    const directTypedEvidence = await proof.query<{ source_class: string; link_strength: string }>(
      `select metadata->>'source_class' as source_class, metadata->>'link_strength' as link_strength
       from audit_events
       where entity_type = 'shell_friction' and metadata->>'journey_id' = $1
       order by created_at asc limit 1`,
      [directTypedJourneyId]
    );
    assert.deepEqual(directTypedEvidence.rows[0], {
      source_class: 'unknown',
      link_strength: 'client_correlated_unverified'
    });

    const receiptReuseClient = new HttpClient(server.baseUrl);
    const receiptLanding = await receiptReuseClient.navigate(
      '/discover?utm_source=google&utm_medium=organic&utm_campaign=receipt-reuse',
      {
        referer: 'https://www.google.com/search?q=sway+tips',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document'
      }
    );
    assertStatus(receiptLanding, 200, 'receipt replay trusted landing', server);
    const reusableCookie = receiptReuseClient.cookieHeader();
    assert.match(reusableCookie, /sway_discovery_attribution=/);
    const receiptJourneyA = randomUUID();
    const receiptJourneyB = randomUUID();
    const receiptFirstUse = await receiptReuseClient.post('/api/analytics/shell', discoveryLandingBody(receiptJourneyA));
    assertStatus(receiptFirstUse, 202, 'receipt first journey use', server);
    const receiptReplay = await new HttpClient(server.baseUrl, { cookie: reusableCookie }).post(
      '/api/analytics/shell',
      discoveryLandingBody(receiptJourneyB)
    );
    assertStatus(receiptReplay, 409, 'receipt cross-journey replay', server);
    const receiptRows = await proof.query<{ journey_id: string; source_class: string; link_strength: string }>(
      `select metadata->>'journey_id' as journey_id,
              metadata->>'source_class' as source_class,
              metadata->>'link_strength' as link_strength
       from audit_events
       where metadata->>'attribution_receipt_id' is not null
         and metadata->>'journey_id' in ($1, $2)`,
      [receiptJourneyA, receiptJourneyB]
    );
    assert.deepEqual(receiptRows.rows, [{
      journey_id: receiptJourneyA,
      source_class: 'unknown',
      link_strength: 'client_correlated_unverified'
    }], 'Forged navigation headers may preserve one-time context but cannot become organic proof or cross journeys.');

    const primaryDiscoveryJourneyId = randomUUID();
    const primary = await createPerformerAccount({
      server,
      suffix: 'primary',
      displayName: 'DJ Simulated',
      handle: 'dj-simulated',
      discoveryJourneyId: primaryDiscoveryJourneyId
    });
    const primaryAttribution = await proof.query<{
      source_channel: string;
      source_class: string;
      evidence_strength: string;
      utm_campaign: string | null;
      claimed_source_class: string | null;
    }>(
      `select attribution.source_channel, attribution.source_class,
              attribution.evidence_strength, attribution.utm_campaign,
              source_event.metadata->>'claimed_source_class' as claimed_source_class
       from account_discovery_attributions attribution
       inner join users on users.id = attribution.user_id
       inner join audit_events source_event on source_event.event_id = attribution.source_event_id
       where users.email = $1`,
      [primary.email]
    );
    assert.deepEqual(primaryAttribution.rows[0], {
      source_channel: 'google',
      source_class: 'unknown',
      evidence_strength: 'client_correlated_unverified',
      utm_campaign: 'simulated-live-night',
      claimed_source_class: 'organic_unpaid'
    }, 'Public discovery must preserve signed source context without falsely awarding organic proof.');

    // Production once contained pre-deadline JSON snapshots whose relational
    // auto_closeout_at had already expired. The worker must restore that
    // canonical deadline from the row and close the room instead of keeping a
    // legacy fixture publicly active forever.
    const legacyExpiredGigId = randomUUID();
    const legacyExpiredSession = {
      status: 'active',
      startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      closedAt: null,
      ownerActorUserId: null,
      lastMutationActorUserId: null,
      talentName: 'Legacy Expired Room',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5,
      endGigTimerStartedAt: null,
      isFeatured: false,
      featuredExpiresAt: null,
      featuredCost: 0,
      featuredDurationHours: 0,
      requestsOpen: true,
      requestWindowMode: 'manual',
      requestWindowExpiresAt: null,
      requestWindowDuration: null,
      requestWindowLabel: null,
      requestPresets: [],
      operatingMode: 'manual',
      searchScope: 'library',
      paymentsEnabled: false,
      tipsEnabled: false,
      totals: { totalTips: 0, accumulatedFees: 0, totalCount: 0, topRequest: 'None yet' }
    };
    await proof.query(`
      insert into gig_sessions (
        id, performer_id, owner_actor_user_id, last_mutation_actor_user_id,
        status, title, runtime_session_state, started_at, last_activity_at, auto_closeout_at
      ) values ($1, $2, null, null, 'active', 'legacy_expired_room', $3::jsonb,
        now() - interval '5 hours', now() - interval '5 hours', now() - interval '1 hour')
    `, [legacyExpiredGigId, primary.performerId, JSON.stringify(legacyExpiredSession)]);
    await proof.query(`
      insert into active_room_registry (
        gig_id, performer_id, owner_actor_user_id, talent_name, talent_role,
        route_path, registry_status, started_at, last_activity_at
      ) values ($1::uuid, $2::uuid, null, 'Legacy Expired Room', 'DJ', '/g/' || $1::uuid::text,
        'active', now() - interval '5 hours', now() - interval '5 hours')
    `, [legacyExpiredGigId, primary.performerId]);

    await waitForDatabaseState(async () => {
      const result = await proof.query<{ session_status: string; registry_status: string }>(`
        select g.status as session_status, r.registry_status
        from gig_sessions g
        join active_room_registry r on r.gig_id = g.id
        where g.id = $1
      `, [legacyExpiredGigId]);
      return result.rows[0]?.session_status === 'closed'
        && result.rows[0]?.registry_status === 'closed';
    }, 'legacy room automatic closeout');
    const expiredLegacyPublic = await new HttpClient(server.baseUrl).get(`/api/state/${legacyExpiredGigId}`);
    assertStatus(expiredLegacyPublic, 410, 'legacy expired room is no longer publicly readable', server);

    const missingStartId = await primary.client.post('/api/session/start', {
      talentName: 'DJ Simulated',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5,
      paymentsEnabled: false,
      searchScope: 'catalog'
    });
    assertStatus(missingStartId, 422, 'room start requires a stable identity', server);
    assert.equal(missingStartId.body.code, 'room_start_id_required');
    const malformedStartId = await primary.client.post('/api/session/start', {
      gig_id: 'not-a-uuid',
      talentName: 'DJ Simulated',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5,
      paymentsEnabled: false,
      searchScope: 'catalog'
    });
    assertStatus(malformedStartId, 422, 'malformed room start identity is rejected', server);
    const unavailablePaidRoom = await primary.client.post('/api/session/start', {
      gig_id: randomUUID(),
      talentName: 'DJ Simulated',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5,
      paymentsEnabled: true,
      searchScope: 'catalog'
    });
    assertStatus(unavailablePaidRoom, 503, 'paid room fails closed without verified Stripe test execution', server);
    assert.equal(unavailablePaidRoom.body.code, 'test_payment_runtime_unavailable');
    const unavailableConnect = await primary.client.post('/api/talent/connect/onboard', {});
    assertStatus(unavailableConnect, 503, 'Connect fails closed without verified Stripe test execution', server);

    const gigId = randomUUID();
    const roomStartBody = {
      gig_id: gigId,
      talentName: 'DJ Simulated',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5,
      paymentsEnabled: false,
      searchScope: 'catalog'
    };
    const roomStarts = await Promise.all(
      Array.from({ length: 20 }, () => primary.client.post('/api/session/start', roomStartBody))
    );
    for (const [index, response] of roomStarts.entries()) {
      assertStatus(response, 200, `duplicate room start ${index + 1}`, server);
      assert.equal(response.body.state.activeGigId, gigId);
    }
    const mismatchedRoomStart = await primary.client.post('/api/session/start', {
      ...roomStartBody,
      searchScope: 'library'
    });
    assertStatus(mismatchedRoomStart, 409, 'room start identity rejects changed setup', server);
    const unavailablePaidToggle = await primary.client.post('/api/session/payments-enabled', {
      gig_id: gigId,
      enabled: true
    });
    assertStatus(unavailablePaidToggle, 503, 'paid-room toggle fails closed without verified Stripe test execution', server);
    assert.equal(unavailablePaidToggle.body.code, 'test_payment_runtime_unavailable');

    const initialRooms = await primary.client.get('/api/talent/active-rooms');
    assertStatus(initialRooms, 200, 'primary active room registry', server);
    assert.deepEqual(initialRooms.body.rooms.map((room: JsonObject) => room.gigId), [gigId]);

    const directlyKnownDraftRoom = await fetch(`${server.baseUrl}/g/${gigId}`);
    assert.equal(directlyKnownDraftRoom.status, 200, 'A known room link remains directly reachable for invited QA participants.');
    const draftPublicFeed = await new HttpClient(server.baseUrl).get('/api/public/feed');
    assertStatus(draftPublicFeed, 200, 'draft performer public feed containment', server);
    assert.equal(
      draftPublicFeed.body.rooms.some((room: JsonObject) => room.gigId === gigId),
      false,
      'A draft performer room must never enter public discovery.'
    );
    const professionalSetup = await primary.client.post('/api/talent/professional-setup', {
      clientMutationId: randomUUID(),
      primaryIdentity: { kind: 'dj', customLabel: null },
      secondaryIdentities: [],
      earningModes: ['live_tips', 'audience_requests'],
      desiredCapabilities: ['profile_publication', 'live_rooms']
    });
    assertStatus(professionalSetup, 202, 'save disposable professional identity', server);
    const publishPrimary = await primary.client.post('/api/talent/profile/visibility', { visibilityState: 'public' });
    assertStatus(publishPrimary, 200, 'publish performer for public-room feed proof', server);
    const thinPublicFeed = await new HttpClient(server.baseUrl).get('/api/public/feed');
    assertStatus(thinPublicFeed, 200, 'thin public performer room containment', server);
    assert.equal(
      thinPublicFeed.body.rooms.some((room: JsonObject) => room.gigId === gigId),
      false,
      'A public status alone must not publish a thin room card.'
    );
    const completePublicProfile = await primary.client.post('/api/talent/profile/public', {
      bio: 'Disposable integration performer used only to prove complete public eligibility.',
      headline: 'Disposable public eligibility proof',
      specialties: ['Integration testing']
    });
    assertStatus(completePublicProfile, 202, 'complete disposable public profile facts', server);
    const publishedPublicFeed = await new HttpClient(server.baseUrl).get('/api/public/feed');
    assertStatus(publishedPublicFeed, 200, 'public performer room discovery', server);
    assert.equal(
      publishedPublicFeed.body.rooms.some((room: JsonObject) => room.gigId === gigId),
      true,
      'A published performer room must remain eligible for public discovery.'
    );
    const restoreDraft = await primary.client.post('/api/talent/profile/visibility', { visibilityState: 'draft' });
    assertStatus(restoreDraft, 200, 'restore disposable performer to draft', server);

    const patronAHash = hash('simulated-patron-a');
    const patronBHash = hash('simulated-patron-b');
    const patronCHash = hash('simulated-patron-c');
    const patronA = new HttpClient(server.baseUrl, { 'x-sway-device-id-hash': patronAHash });
    const patronB = new HttpClient(server.baseUrl, { 'x-sway-device-id-hash': patronBHash });
    const patronC = new HttpClient(server.baseUrl, { 'x-sway-device-id-hash': patronCHash });

    const requestA = freeRequestBody({ gigId, label: 'Simulated Song A', deviceHash: patronAHash });
    const requestB = freeRequestBody({ gigId, label: 'Simulated Song B', deviceHash: patronBHash });
    const requestC = freeRequestBody({ gigId, label: 'Simulated Song C', deviceHash: patronCHash });
    const created = await Promise.all([
      patronA.post('/api/request/create', requestA.body),
      patronB.post('/api/request/create', requestB.body),
      patronC.post('/api/request/create', requestC.body)
    ]);
    for (const [index, response] of created.entries()) {
      assertStatus(response, 200, `patron request ${index + 1}`, server);
      assert.equal(response.body.patron_status.status, 'hold');
      assert.match(String(response.body.patron_status_receipt ?? ''), /^[A-Za-z0-9_-]{43}$/);
    }

    const duplicateResponses = await Promise.all(
      Array.from({ length: 10 }, () => patronA.post('/api/request/create', requestA.body))
    );
    for (const [index, response] of duplicateResponses.entries()) {
      assertStatus(response, [200, 202], `duplicate patron replay ${index + 1}`, server);
    }
    const duplicateReconcile = await patronA.post('/api/pending-action/reconcile', {
      client_request_id: requestA.body.client_request_id,
      idempotency_key: requestA.body.idempotency_key
    });
    assertStatus(duplicateReconcile, 200, 'duplicate patron canonical reconciliation', server);
    assert.equal(duplicateReconcile.body.status, 'reconciled');

    const privateState = await primary.client.get(`/api/state/${gigId}`);
    assertStatus(privateState, 200, 'performer private room state', server);
    assert.equal(privateState.body.requests.length, 3);
    const byTitle = new Map<string, JsonObject>(
      privateState.body.requests.map((request: JsonObject) => [String(request.title), request] as const)
    );
    const runtimeRequestA = byTitle.get('Simulated Song A');
    const runtimeRequestB = byTitle.get('Simulated Song B');
    const runtimeRequestC = byTitle.get('Simulated Song C');
    assert.ok(runtimeRequestA?.id && runtimeRequestB?.id && runtimeRequestC?.id);

    const approveA = await primary.client.post('/api/request/triage', {
      requestId: runtimeRequestA.id,
      action: 'approve'
    });
    assertStatus(approveA, 200, 'approve first request', server);

    const boostClientRequestId = `boost-${randomUUID()}`;
    const boost = await patronC.post('/api/request/boost', {
      requestId: runtimeRequestA.id,
      patronName: 'Patron C',
      boostAmount: 0,
      client_request_id: boostClientRequestId,
      idempotency_key: `idempotency-${boostClientRequestId}`,
      patron_device_id_hash: patronCHash,
      gig_id: gigId,
      currency: 'USD',
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    });
    assertStatus(boost, 200, 'free-room boost', server);

    const fulfillA = await primary.client.post('/api/request/fulfill', { requestId: runtimeRequestA.id });
    assertStatus(fulfillA, 200, 'fulfill first request', server);
    const denyB = await primary.client.post('/api/request/triage', { requestId: runtimeRequestB.id, action: 'deny' });
    assertStatus(denyB, 200, 'deny second request', server);
    const hideC = await primary.client.post('/api/moderation/hide', {
      requestId: runtimeRequestC.id,
      reason: 'Simulated safety hide'
    });
    assertStatus(hideC, 200, 'hide third request', server);

    const closeWindow = await primary.client.post('/api/session/window/toggle', { gig_id: gigId, open: false });
    assertStatus(closeWindow, 200, 'pause request window', server);
    const pausedAttempt = freeRequestBody({ gigId, label: 'Paused Request', deviceHash: patronAHash });
    const pausedResponse = await patronA.post('/api/request/create', pausedAttempt.body);
    assertStatus(pausedResponse, 400, 'request rejected while paused', server);
    const openWindow = await primary.client.post('/api/session/window/toggle', { gig_id: gigId, open: true });
    assertStatus(openWindow, 200, 'resume request window', server);

    const tipClientRequestId = `tip-${randomUUID()}`;
    const tip = await patronB.post('/api/request/create', {
      type: 'tip',
      targetType: 'straight_tip',
      senderName: 'Patron B',
      amount: 5,
      client_request_id: tipClientRequestId,
      idempotency_key: `idempotency-${tipClientRequestId}`,
      patron_device_id_hash: patronBHash,
      gig_id: gigId,
      currency: 'USD',
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    });
    assertStatus(tip, 409, 'tip blocked without payout readiness', server);
    assert.equal(tip.body.code, 'seller_payout_not_ready');

    const reconnectRequest = freeRequestBody({ gigId, label: 'Reconnect Song', deviceHash: patronAHash });
    await patronA.post('/api/request/create', reconnectRequest.body); // Simulate a response the browser never receives.
    const reconnectedPatronA = new HttpClient(server.baseUrl, { 'x-sway-device-id-hash': patronAHash });
    const reconnectTruth = await reconnectedPatronA.post('/api/pending-action/reconcile', {
      client_request_id: reconnectRequest.body.client_request_id,
      idempotency_key: reconnectRequest.body.idempotency_key
    });
    assertStatus(reconnectTruth, 200, 'reconnect recovers canonical request result', server);
    assert.equal(reconnectTruth.body.status, 'reconciled');

    const publicState = await new HttpClient(server.baseUrl).get(`/api/state/${gigId}`);
    assertStatus(publicState, 200, 'public room state', server);
    assert.deepEqual(publicState.body.requests.map((request: JsonObject) => request.title), ['Simulated Song A']);
    assert.equal(publicState.body.requests[0].status, 'fulfilled');
    assert.equal(publicState.body.requests[0].boosts.length, 1);
    const publicJson = JSON.stringify(publicState.body);
    for (const privateField of [
      'patronDeviceIdHash', 'idempotencyKey', 'clientRequestId', 'paymentId',
      'paymentIntentId', 'patronStatusReceiptHash', 'ownerActorUserId'
    ]) assert.ok(!publicJson.includes(privateField), `Public room leaked ${privateField}.`);

    await server.stop();
    server = null;
    const databaseTruth = await proof.query<{
      users: string;
      performers: string;
      proModeEvents: string;
      gigs: string;
      requests: string;
      boosts: string;
      payments: string;
    }>(`
      select
        (select count(*) from users where email = 'simulated-primary@example.test')::text as users,
        (select count(*) from performers where owner_user_id = (
          select id from users where email = 'simulated-primary@example.test'
        ))::text as performers,
        (select count(*) from pro_mode_status_events where user_id = (
          select id from users where email = 'simulated-primary@example.test'
        ))::text as "proModeEvents",
        (select count(*) from gig_sessions where id = $1)::text as gigs,
        (select count(*) from requests where gig_id = $1 and activated_at is not null)::text as requests,
        (select count(*) from request_boosts where gig_id = $1 and activated_at is not null)::text as boosts,
        (select count(*) from payments where gig_id = $1)::text as payments
    `, [gigId]);
    assert.equal(Number(databaseTruth.rows[0].users), 1);
    assert.equal(Number(databaseTruth.rows[0].performers), 1);
    assert.equal(Number(databaseTruth.rows[0].proModeEvents), 1, 'One Pro Mode activation must create one status event.');
    assert.equal(Number(databaseTruth.rows[0].gigs), 1);
    assert.equal(Number(databaseTruth.rows[0].requests), 4);
    assert.equal(Number(databaseTruth.rows[0].boosts), 1);
    assert.equal(Number(databaseTruth.rows[0].payments), 0);

    server = await startSwayServer(proof.databaseUrl, port);
    const restartedPrivateState = await primary.client.get(`/api/state/${gigId}`);
    assertStatus(restartedPrivateState, 200, 'room survives process restart', server);
    assert.equal(restartedPrivateState.body.requests.length, 4);

    // Simulate configuration disappearing after a paid room was persisted.
    // Direct API callers must not bypass the payment-form/start-room gates.
    await proof.query(`
      update gig_sessions
      set runtime_session_state = jsonb_set(
            jsonb_set(runtime_session_state, '{paymentsEnabled}', 'true'::jsonb),
            '{tipsEnabled}', 'true'::jsonb
          ),
          state_revision = state_revision + 1,
          updated_at = now()
      where id = $1
    `, [gigId]);
    const unavailableDirectPaidRequest = freeRequestBody({
      gigId,
      label: 'Configuration Loss Paid Request',
      deviceHash: patronBHash
    });
    unavailableDirectPaidRequest.body.amount = 5;
    const unavailableDirectPaidResponse = await patronB.post('/api/request/create', unavailableDirectPaidRequest.body);
    assertStatus(unavailableDirectPaidResponse, 503, 'direct paid request fails closed after runtime configuration loss', server);
    assert.equal(unavailableDirectPaidResponse.body.code, 'test_payment_runtime_unavailable');
    const unavailableDirectPaidTruth = await proof.query<{ actions: string; payments: string }>(`
      select
        (select count(*) from client_pending_actions where idempotency_key = $1)::text as actions,
        (select count(*) from payments where idempotency_key = $1)::text as payments
    `, [unavailableDirectPaidRequest.body.idempotency_key]);
    assert.equal(Number(unavailableDirectPaidTruth.rows[0].actions), 0);
    assert.equal(Number(unavailableDirectPaidTruth.rows[0].payments), 0);
    const unavailableDirectBoostId = `configuration-loss-boost-${randomUUID()}`;
    const unavailableDirectBoost = await patronC.post('/api/request/boost', {
      requestId: runtimeRequestA.id,
      patronName: 'Patron C',
      boostAmount: 5,
      client_request_id: unavailableDirectBoostId,
      idempotency_key: `idempotency-${unavailableDirectBoostId}`,
      patron_device_id_hash: patronCHash,
      gig_id: gigId,
      currency: 'USD',
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    });
    assertStatus(unavailableDirectBoost, 503, 'direct paid boost fails closed after runtime configuration loss', server);
    assert.equal(unavailableDirectBoost.body.code, 'test_payment_runtime_unavailable');
    const unavailableDirectBoostTruth = await proof.query<{ actions: string; payments: string }>(`
      select
        (select count(*) from client_pending_actions where idempotency_key = $1)::text as actions,
        (select count(*) from payments where idempotency_key = $1)::text as payments
    `, [`idempotency-${unavailableDirectBoostId}`]);
    assert.equal(Number(unavailableDirectBoostTruth.rows[0].actions), 0);
    assert.equal(Number(unavailableDirectBoostTruth.rows[0].payments), 0);
    await proof.query(`
      update gig_sessions
      set runtime_session_state = jsonb_set(
            jsonb_set(runtime_session_state, '{paymentsEnabled}', 'false'::jsonb),
            '{tipsEnabled}', 'false'::jsonb
          ),
          state_revision = state_revision + 1,
          updated_at = now()
      where id = $1
    `, [gigId]);

    const secondary = await createPerformerAccount({
      server,
      suffix: 'secondary',
      displayName: 'DJ Isolated',
      handle: 'dj-isolated'
    });
    const secondaryGigId = randomUUID();
    const secondaryStart = await secondary.client.post('/api/session/start', {
      gig_id: secondaryGigId,
      talentName: 'DJ Isolated',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5,
      paymentsEnabled: false,
      searchScope: 'catalog'
    });
    assertStatus(secondaryStart, 200, 'secondary performer room start', server);

    const primaryRooms = await primary.client.get('/api/talent/active-rooms');
    const secondaryRooms = await secondary.client.get('/api/talent/active-rooms');
    assertStatus(primaryRooms, 200, 'primary room isolation', server);
    assertStatus(secondaryRooms, 200, 'secondary room isolation', server);
    assert.deepEqual(primaryRooms.body.rooms.map((room: JsonObject) => room.gigId), [gigId]);
    assert.deepEqual(secondaryRooms.body.rooms.map((room: JsonObject) => room.gigId), [secondaryGigId]);
    const crossRoom = await secondary.client.get(`/api/state/${gigId}`);
    assertStatus(crossRoom, 200, 'secondary receives only public projection for primary room', server);
    assert.ok(!JSON.stringify(crossRoom.body).includes('Reconnect Song'));

    const endSecondary = await secondary.client.post('/api/session/end', { gig_id: secondaryGigId });
    assertStatus(endSecondary, 200, 'secondary room end', server);
    const closeSecondary = await secondary.client.post('/api/session/closeout', { gig_id: secondaryGigId });
    assertStatus(closeSecondary, 200, 'secondary room closeout', server);

    const endPrimary = await primary.client.post('/api/session/end', { gig_id: gigId });
    assertStatus(endPrimary, 200, 'primary room end', server);
    const closePrimary = await primary.client.post('/api/session/closeout', { gig_id: gigId });
    assertStatus(closePrimary, 200, 'primary room closeout', server);
    const endedPublicRoom = await new HttpClient(server.baseUrl).get(`/api/state/${gigId}`);
    assertStatus(endedPublicRoom, 410, 'closed room is no longer publicly readable', server);
    const history = await primary.client.get('/api/talent/rooms/history');
    assertStatus(history, 200, 'closed room history', server);
    assert.ok(history.body.rooms.some((room: JsonObject) => room.gigId === gigId));

    // Owner-authorized Stripe test rehearsal: matching test-looking keys plus
    // the explicit switch may start a paid-mode room without Connect. No
    // provider call is made here; provider authorization/capture/refund is
    // proven separately by the deterministic payment durability integration.
    await server.stop();
    server = null;
    server = await startSwayServer(proof.databaseUrl, port, {
      STRIPE_SECRET_KEY: 'sk_test_platform_balance_runtime_proof',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_platform_balance_runtime_proof',
      VITE_STRIPE_PUBLISHABLE_KEY: 'pk_test_platform_balance_runtime_proof',
      STRIPE_WEBHOOK_SECRET: 'whsec_platform_balance_runtime_proof',
      SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED: 'true',
      SWAY_TEST_MODE_PLATFORM_BALANCE_PERFORMER_IDS: primary.performerId
    });
    const testMoneyConfig = await new HttpClient(server.baseUrl).get('/api/payment/config');
    assertStatus(testMoneyConfig, 200, 'platform test-balance runtime config', server);
    assert.equal(testMoneyConfig.body.mode, 'test');
    assert.equal(testMoneyConfig.body.testModePlatformBalanceEnabled, true);
    const unapprovedTestMoneyRoom = await secondary.client.post('/api/session/start', {
      gig_id: randomUUID(),
      talentName: 'Secondary Performer',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5,
      paymentsEnabled: true,
      searchScope: 'catalog'
    });
    assertStatus(unapprovedTestMoneyRoom, 409, 'unallowlisted performer cannot start a test paid room', server);
    assert.equal(unapprovedTestMoneyRoom.body.code, 'seller_payout_not_ready');
    const testMoneyGigId = randomUUID();
    const testMoneyRoom = await primary.client.post('/api/session/start', {
      gig_id: testMoneyGigId,
      talentName: 'DJ Simulated',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5,
      paymentsEnabled: true,
      searchScope: 'catalog'
    });
    assertStatus(testMoneyRoom, 200, 'test paid room starts without Connect', server);
    assert.equal(testMoneyRoom.body.state.session.paymentsEnabled, true);
    assert.equal(testMoneyRoom.body.state.session.tipsEnabled, true);
    const endTestMoneyRoom = await primary.client.post('/api/session/end', { gig_id: testMoneyGigId });
    assertStatus(endTestMoneyRoom, 200, 'test paid room end', server);
    const closeTestMoneyRoom = await primary.client.post('/api/session/closeout', { gig_id: testMoneyGigId });
    assertStatus(closeTestMoneyRoom, 200, 'test paid room closeout', server);

    console.log('Sway simulated live-night integration proof passed.');
  } catch (error) {
    if (server) console.error(server.logs());
    throw error;
  } finally {
    if (server) await server.stop();
    await proof.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
