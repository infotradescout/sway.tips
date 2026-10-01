import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';
import { toAuditEntityUuid } from '../src/server/audit-log';

type JsonObject = Record<string, any>;

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
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
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string
  ) {}

  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('authorization', `Bearer ${this.token}`);
    console.log(`visibility-request ${init.method ?? 'GET'} ${path}`);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    let body: JsonObject = {};
    if (text) {
      try {
        body = JSON.parse(text) as JsonObject;
      } catch {
        body = { text };
      }
    }
    return { status: response.status, body };
  }

  get(path: string) {
    return this.request(path, { method: 'GET' });
  }

  post(path: string, body: JsonObject) {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  }
}

type RunningServer = {
  baseUrl: string;
  logs: () => string;
  stop: () => Promise<void>;
};

async function startSwayServer(databaseUrl: string, port: number): Promise<RunningServer> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      SWAY_APP_BASE_URL: baseUrl,
      APP_URL: baseUrl,
      APP_BASE_URL: baseUrl,
      SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION: 'true',
      VITE_SWAY_DEMO_MODE: 'false',
      SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED: 'false',
      STRIPE_SECRET_KEY: '',
      STRIPE_PUBLISHABLE_KEY: '',
      VITE_STRIPE_PUBLISHABLE_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      SWAY_EMAIL_PROVIDER: '',
      SWAY_EMAIL_API_KEY: '',
      SWAY_EMAIL_FROM: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams;

  const secrets = [databaseUrl, new URL(databaseUrl).password, decodeURIComponent(new URL(databaseUrl).password)].filter(Boolean);
  const redact = (value: string) => {
    let text = value;
    for (const secret of secrets.sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
    return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[REDACTED_URI]');
  };
  let output = '', truncated = false, closed = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const close = new Promise<void>((resolve) => child.once('close', () => { closed = true; resolve(); }));
  const record = (chunk: Buffer) => {
    if (truncated) return;
    if (output.length + chunk.length > 262144) { output = ''; truncated = true; return; }
    output += chunk.toString('utf8');
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);

  const earlyExit = new Promise<never>((_resolve, reject) => {
    child.once('error', (error) => reject(new Error(`Owned proof server spawn failed: ${(error as NodeJS.ErrnoException).code ?? error.name}`)));
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      reject(new Error(`Sway visibility proof server exited before readiness (code=${code}, signal=${signal}).\n${redact(output)}`));
    });
  });
  const waitForClose = async (milliseconds: number) => {
    if (closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([close.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  const stop = async () => {
    if (!closed && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (!await waitForClose(5_000) && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    assert(await waitForClose(5_000), 'Owned visibility proof server close was not observed within bounded cleanup.');
    console.log('visibility-owned-server-close ' + JSON.stringify({ pid: child.pid, exit, closed }));
  };
  const readiness = (async () => {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      try {
        const timeout = Math.max(1, Math.floor(Math.min(3_000, deadline - performance.now())));
        const response = await fetch(`${baseUrl}/api/health/network-probe`, { signal: AbortSignal.timeout(timeout) });
        if (performance.now() < deadline && response.status === 204) return;
      } catch {
        // The listener is not ready yet.
      }
      const remaining = deadline - performance.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    }
    throw new Error(`Timed out waiting for the Sway visibility proof server.\n${redact(output)}`);
  })();
  try { await Promise.race([readiness, earlyExit]); }
  catch (error) { await stop(); throw error; }

  return {
    baseUrl,
    logs: () => redact(output),
    stop
  };
}

function assertStatus(response: { status: number; body: JsonObject }, expected: number, label: string, server: RunningServer) {
  assert.equal(response.status, expected, `${label}: ${JSON.stringify(response.body)}\n${server.logs()}`);
}

async function main() {
  const proof = await startEmbeddedPostgresProof('performer_visibility_control');
  console.log('visibility-proof-ready');
  let server: RunningServer | null = null;

  try {
    const ownerUserId = randomUUID();
    const otherUserId = randomUUID();
    const ownerPerformerId = randomUUID();
    const otherPerformerId = randomUUID();
    const ownerToken = `visibility-owner-${randomUUID()}`;
    const otherToken = `visibility-other-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await proof.query(
      `INSERT INTO users (id, email, display_name, role, pro_mode_status)
       VALUES ($1, $3, $4, 'performer', 'active'), ($2, $5, $6, 'performer', 'active')`,
      [ownerUserId, otherUserId, 'visibility-owner@example.test', 'Visibility Owner', 'visibility-other@example.test', 'Visibility Other']
    );
    await proof.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name, is_active, onboarding_status, visibility_state)
       VALUES ($1, $3, 'visibility-owner', 'Visibility Owner', true, 'gig_ready', 'draft'),
              ($2, $4, 'visibility-other', 'Visibility Other', true, 'gig_ready', 'draft')`,
      [ownerPerformerId, otherPerformerId, ownerUserId, otherUserId]
    );
    await proof.query(
      `INSERT INTO performer_public_profiles (performer_id, headline, specialties, city)
       VALUES ($1, 'Initial visibility headline', '[]'::jsonb, 'Pensacola'),
              ($2, 'Other performer headline', '[]'::jsonb, 'Mobile')`,
      [ownerPerformerId, otherPerformerId]
    );
    await proof.query(
      `INSERT INTO performer_sessions (actor_user_id, token_hash, expires_at, issued_by)
       VALUES ($1, $3, $5, $1), ($2, $4, $5, $2)`,
      [ownerUserId, otherUserId, hashToken(ownerToken), hashToken(otherToken), expiresAt]
    );
    console.log('visibility-fixtures-seeded');

    const port = await reservePort();
    server = await startSwayServer(proof.databaseUrl, port);
    console.log('visibility-server-ready');
    const owner = new HttpClient(server.baseUrl, ownerToken);
    const other = new HttpClient(server.baseUrl, otherToken);
    const unauthenticated = new HttpClient(server.baseUrl);

    const initial = await owner.get('/api/talent/profile/public');
    assertStatus(initial, 200, 'owner profile read', server);
    assert.equal(initial.body.profile.visibilityState, 'draft');

    const unauthenticatedAttempt = await unauthenticated.post('/api/talent/profile/visibility', { visibilityState: 'public' });
    assert.ok([401, 403].includes(unauthenticatedAttempt.status), `Unauthenticated visibility mutation must be denied: ${unauthenticatedAttempt.status}`);

    const invalid = await owner.post('/api/talent/profile/visibility', { visibilityState: 'hidden' });
    assertStatus(invalid, 422, 'invalid visibility state', server);

    const otherAttempt = await other.post('/api/talent/profile/visibility', {
      performerId: ownerPerformerId,
      visibilityState: 'public'
    });
    assertStatus(otherAttempt, 200, 'other owner visibility mutation', server);
    assert.equal(otherAttempt.body.visibilityState, 'public');
    const ownerAfterOtherAttempt = await proof.query<{ visibility_state: string }>('SELECT visibility_state FROM performers WHERE id = $1', [ownerPerformerId]);
    const otherAfterOtherAttempt = await proof.query<{ visibility_state: string }>('SELECT visibility_state FROM performers WHERE id = $1', [otherPerformerId]);
    assert.equal(ownerAfterOtherAttempt.rows[0]?.visibility_state, 'draft');
    assert.equal(otherAfterOtherAttempt.rows[0]?.visibility_state, 'public');

    const published = await owner.post('/api/talent/profile/visibility', {
      performerId: otherPerformerId,
      visibilityState: 'public'
    });
    assertStatus(published, 200, 'owner public visibility mutation', server);
    assert.equal(published.body.visibilityState, 'public');
    const publicState = await proof.query<{ visibility_state: string }>('SELECT visibility_state FROM performers WHERE id = $1', [ownerPerformerId]);
    assert.equal(publicState.rows[0]?.visibility_state, 'public');

    const unlisted = await owner.post('/api/talent/profile/visibility', { visibilityState: 'unlisted' });
    assertStatus(unlisted, 200, 'owner unlisted visibility mutation', server);
    assert.equal(unlisted.body.visibilityState, 'unlisted');

    const profilePayload = {
      roles: ['dj', 'host', 'producer'],
      stageName: 'Visibility Owner',
      headline: 'Updated visibility headline',
      specialties: ['live'],
      bio: 'Profile content changed without publication change.',
      city: 'Pensacola',
      avatarUrl: null,
      booking: { email: null, phone: null },
      socialLinks: { facebook: null, instagram: null, tiktok: null, youtube: null, soundcloud: null, website: null },
      links: []
    };
    // Keep the existing versionless save as an independent compatibility proof.
    const profileSave = await owner.post('/api/talent/profile/public', profilePayload);
    assertStatus(profileSave, 202, 'ordinary profile save', server);
    assert.equal(profileSave.body.profile.visibilityState, 'unlisted');
    assert.equal(profileSave.body.profile.primaryRole, 'dj');
    assert.deepEqual(profileSave.body.profile.roles, ['dj', 'host', 'producer']);

    const afterProfileSave = await owner.get('/api/talent/profile/public');
    assertStatus(afterProfileSave, 200, 'profile read after ordinary save', server);
    assert.equal(afterProfileSave.body.profile.visibilityState, 'unlisted');
    assert.equal(afterProfileSave.body.profile.primaryRole, 'dj');
    assert.deepEqual(afterProfileSave.body.profile.roles, ['dj', 'host', 'producer']);

    assert.equal(initial.body.profile.nativeVersion, '0');
    assert.equal(profileSave.body.profile.nativeVersion, '1');
    assert.equal(afterProfileSave.body.profile.nativeVersion, '1');
    // A nonempty fixture link makes an unintended stale delete observable.
    await proof.query(`INSERT INTO performer_profile_links (performer_id, label, url, kind)
      VALUES ($1, 'Original fixture link', 'https://example.com/original', 'other')`, [ownerPerformerId]);
    const snapshotNative = async (id: string) => ({
      performer: (await proof.query('SELECT * FROM performers WHERE id = $1', [id])).rows,
      profile: (await proof.query('SELECT * FROM performer_public_profiles WHERE performer_id = $1', [id])).rows,
      links: (await proof.query('SELECT * FROM performer_profile_links WHERE performer_id = $1 ORDER BY id', [id])).rows,
      profileAudits: (await proof.query(`SELECT * FROM audit_events WHERE entity_id = $1
        AND event_type = 'performer_public_profile.update' ORDER BY event_id`, [toAuditEntityUuid(id)])).rows
    });
    const beforeStale = await snapshotNative(ownerPerformerId);
    const foreignBefore = await snapshotNative(otherPerformerId);
    const staleSave = await owner.post('/api/talent/profile/public', {
      ...profilePayload, expectedNativeVersion: initial.body.profile.nativeVersion,
      headline: 'Rejected stale headline', bio: 'Rejected stale bio', city: 'Rejected stale city', roles: ['host']
    });
    assertStatus(staleSave, 409, 'stale manual native profile CAS', server);
    assert.deepEqual(await snapshotNative(ownerPerformerId), beforeStale, 'Rejected CAS must leave performer/profile/links/audit unchanged');
    const afterStale = await owner.get('/api/talent/profile/public');
    assertStatus(afterStale, 200, 'profile read after stale rejection', server);
    assert.equal(afterStale.body.profile.nativeVersion, '1');
    assert.equal(afterStale.body.profile.headline, profilePayload.headline);
    assert.equal(afterStale.body.profile.bio, profilePayload.bio);
    assert.equal(afterStale.body.profile.links[0]?.label, 'Original fixture link');

    const currentSave = await owner.post('/api/talent/profile/public', {
      ...profilePayload, performerId: otherPerformerId,
      expectedNativeVersion: afterStale.body.profile.nativeVersion, headline: 'Current native revision accepted'
    });
    assertStatus(currentSave, 202, 'current manual native profile CAS', server);
    assert.equal(currentSave.body.profile.performerId, ownerPerformerId);
    assert.equal(currentSave.body.profile.nativeVersion, '2');
    assert.equal(currentSave.body.profile.visibilityState, 'unlisted');
    assert.deepEqual(await snapshotNative(otherPerformerId), foreignBefore, 'Untrusted performerId must not change the foreign performer/profile/links/audit');
    const afterCurrent = await owner.get('/api/talent/profile/public');
    assertStatus(afterCurrent, 200, 'profile read after current CAS', server);
    assert.equal(afterCurrent.body.profile.nativeVersion, '2');
    assert.equal(afterCurrent.body.profile.headline, 'Current native revision accepted');
    assert.equal((await snapshotNative(ownerPerformerId)).profileAudits.length, 2, 'Only the two accepted saves may create profile audits');
    console.log('visibility-native-cas-proof stale409/current202/original-owner/unchanged-foreign persisted; sequential synthetic-actor proof');

    const draft = await owner.post('/api/talent/profile/visibility', { visibilityState: 'draft' });
    assertStatus(draft, 200, 'owner draft visibility mutation', server);
    assert.equal(draft.body.visibilityState, 'draft');

    const otherDraft = await other.post('/api/talent/profile/visibility', { visibilityState: 'draft' });
    assertStatus(otherDraft, 200, 'other owner draft visibility mutation', server);
    assert.equal(otherDraft.body.visibilityState, 'draft');

    const finalState = await proof.query<{ visibility_state: string }>('SELECT visibility_state FROM performers WHERE id = $1', [ownerPerformerId]);
    assert.equal(finalState.rows[0]?.visibility_state, 'draft');
    const otherState = await proof.query<{ visibility_state: string }>('SELECT visibility_state FROM performers WHERE id = $1', [otherPerformerId]);
    assert.equal(otherState.rows[0]?.visibility_state, 'draft');

    const audits = await proof.query<{ previous_status: string; next_status: string; metadata: JsonObject }>(
      `SELECT previous_status, next_status, metadata
       FROM audit_events
       WHERE entity_id = $1 AND event_type = 'performer_visibility.update'
       ORDER BY created_at ASC`,
      [toAuditEntityUuid(ownerPerformerId)]
    );
    assert.deepEqual(audits.rows.map((row) => [row.previous_status, row.next_status]), [
      ['draft', 'public'],
      ['public', 'unlisted'],
      ['unlisted', 'draft']
    ]);
    assert.equal(audits.rows[0]?.metadata?.control, 'owner');

    console.log('Sway performer visibility control integration passed.');
  } finally {
    try {
      if (server) await server.stop();
    } finally {
      await proof.close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
