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
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
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

  const output: string[] = [];
  const record = (chunk: Buffer) => {
    output.push(chunk.toString('utf8'));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);

  const earlyExit = new Promise<never>((_resolve, reject) => {
    child.once('exit', (code, signal) => reject(new Error(
      `Sway visibility proof server exited before readiness (code=${code}, signal=${signal}).\n${output.join('')}`
    )));
  });
  const readiness = (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}/api/health/network-probe`, { signal: AbortSignal.timeout(3_000) });
        if (response.status === 204) return;
      } catch {
        // The listener is not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for the Sway visibility proof server.\n${output.join('')}`);
  })();
  await Promise.race([readiness, earlyExit]);

  return {
    baseUrl,
    logs: () => output.join(''),
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const forced = new Promise<void>((resolve) => setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 5_000));
      await Promise.race([stopped, forced]);
    }
  };
}

function assertStatus(response: { status: number; body: JsonObject }, expected: number, label: string, server: RunningServer) {
  assert.equal(response.status, expected, `${label}: ${JSON.stringify(response.body)}\n${server.logs()}`);
}

function databaseErrorDetails(error: unknown) {
  let candidate: unknown = error;
  for (let depth = 0; depth < 5 && candidate && typeof candidate === 'object'; depth += 1) {
    const databaseError = candidate as { code?: string; constraint?: string; cause?: unknown };
    if (databaseError.code || databaseError.constraint) {
      return { code: databaseError.code, constraint: databaseError.constraint };
    }
    candidate = databaseError.cause;
  }
  return { code: undefined, constraint: undefined };
}

async function assertDatabaseConstraintRejected(
  operation: () => Promise<unknown>,
  expectedCode: string,
  expectedConstraint: string,
  label: string
) {
  await assert.rejects(operation, (error: unknown) => {
    const details = databaseErrorDetails(error);
    assert.equal(details.code, expectedCode, `${label}: unexpected database error code`);
    assert.equal(details.constraint, expectedConstraint, `${label}: unexpected database constraint`);
    return true;
  }, label);
}

function publicProfilePayload(overrides: JsonObject = {}): JsonObject {
  return {
    primaryRole: 'dj',
    stageName: 'Visibility Owner',
    headline: 'Updated visibility headline',
    specialties: ['live'],
    bio: 'Profile content changed without publication change.',
    city: 'Pensacola',
    avatarUrl: null,
    booking: { email: null, phone: null },
    socialLinks: { facebook: null, instagram: null, tiktok: null, youtube: null, soundcloud: null, website: null },
    links: [],
    ...overrides
  };
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
       VALUES ($1, $3, $4, 'performer', 'active'),
              ($2, $5, $6, 'performer', 'active')`,
      [
        ownerUserId,
        otherUserId,
        'visibility-owner@example.test',
        'Visibility Owner',
        'visibility-other@example.test',
        'Visibility Other'
      ]
    );
    await proof.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name, is_active, onboarding_status, visibility_state)
       VALUES ($1, $3, NULL, 'Legacy Visibility Owner', true, 'gig_ready', 'draft'),
              ($2, $4, 'visibility-other', 'Visibility Other', true, 'gig_ready', 'draft')`,
      [ownerPerformerId, otherPerformerId, ownerUserId, otherUserId]
    );
    await proof.query(
      `INSERT INTO performer_profile_previews (id, handle, claimed_performer_id, display_name, is_active)
       VALUES ($1, 'owner-recovery', $3, 'Owner Recovery Preview', true),
              ($2, 'reserved-preview', NULL, 'Reserved Preview', true)`,
      [randomUUID(), randomUUID(), ownerPerformerId]
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

    await assertDatabaseConstraintRejected(
      () => proof.query(
        'UPDATE performers SET handle = $2 WHERE id = $1',
        [ownerPerformerId, 'RESERVED-PREVIEW']
      ),
      '23505',
      'sway_global_performer_handle_unique',
      'database rejects performer handle reserved by active unclaimed preview'
    );

    const conflictingPreviewId = randomUUID();
    await assertDatabaseConstraintRejected(
      () => proof.query(
        `INSERT INTO performer_profile_previews (id, handle, display_name, is_active)
         VALUES ($1, $2, 'Conflicting Preview', true)`,
        [conflictingPreviewId, 'VISIBILITY-OTHER']
      ),
      '23505',
      'sway_global_performer_handle_unique',
      'database rejects active unclaimed preview handle reserved by performer'
    );

    await assertDatabaseConstraintRejected(
      () => proof.query(
        `INSERT INTO performer_profile_previews (id, handle, display_name, is_active)
         VALUES ($1, $2, 'Noncanonical Preview', true)`,
        [randomUUID(), ' preview-spaced ']
      ),
      '23514',
      'performer_profile_previews_handle_canonical',
      'database rejects noncanonical preview handle whitespace'
    );

    await assertDatabaseConstraintRejected(
      () => proof.query(
        'UPDATE performers SET handle = $2 WHERE id = $1',
        [ownerPerformerId, 'tickets']
      ),
      '23514',
      'performers_handle_not_reserved',
      'database rejects reserved performer handle'
    );

    await assertDatabaseConstraintRejected(
      () => proof.query(
        'UPDATE performers SET handle = $2 WHERE id = $1',
        [ownerPerformerId, ' spaced-handle ']
      ),
      '23514',
      'performers_handle_canonical',
      'database rejects noncanonical performer handle whitespace'
    );

    const invariantRows = await proof.query<{ owner_handle: string | null; conflicting_preview_count: number }>(
      `SELECT
         (SELECT handle FROM performers WHERE id = $1) AS owner_handle,
         (SELECT count(*)::int FROM performer_profile_previews WHERE id = $2) AS conflicting_preview_count`,
      [ownerPerformerId, conflictingPreviewId]
    );
    assert.deepEqual(invariantRows.rows[0], {
      owner_handle: null,
      conflicting_preview_count: 0
    });

    const port = await reservePort();
    server = await startSwayServer(proof.databaseUrl, port);
    console.log('visibility-server-ready');
    const owner = new HttpClient(server.baseUrl, ownerToken);
    const other = new HttpClient(server.baseUrl, otherToken);
    const unauthenticated = new HttpClient(server.baseUrl);

    const initial = await owner.get('/api/talent/profile/public');
    assertStatus(initial, 200, 'owner profile read', server);
    assert.equal(initial.body.profile.visibilityState, 'draft');
    assert.equal(initial.body.profile.handle, null);
    assert.equal(initial.body.profile.displayName, 'Legacy Visibility Owner');

    const invalidHandleType = await owner.post('/api/talent/profile/public', publicProfilePayload({
      displayName: 'Visibility Owner',
      handle: ['owner-recovery']
    }));
    assertStatus(invalidHandleType, 422, 'array handle rejected', server);

    const reservedHandle = await owner.post('/api/talent/profile/public', publicProfilePayload({
      displayName: 'Visibility Owner',
      handle: 'admin'
    }));
    assertStatus(reservedHandle, 422, 'reserved handle rejected', server);

    const blankDisplayName = await owner.post('/api/talent/profile/public', publicProfilePayload({
      displayName: '   ',
      handle: 'owner-recovery'
    }));
    assertStatus(blankDisplayName, 422, 'blank display name rejected', server);

    const performerHandleConflict = await owner.post('/api/talent/profile/public', publicProfilePayload({
      displayName: 'Visibility Owner',
      handle: 'VISIBILITY-OTHER'
    }));
    assertStatus(performerHandleConflict, 409, 'other performer handle conflict', server);

    const previewHandleConflict = await owner.post('/api/talent/profile/public', publicProfilePayload({
      displayName: 'Visibility Owner',
      handle: 'RESERVED-PREVIEW'
    }));
    assertStatus(previewHandleConflict, 409, 'active unclaimed preview handle conflict', server);

    const recoveredIdentity = await owner.post('/api/talent/profile/public', publicProfilePayload({
      displayName: '  Recovered Visibility Owner  ',
      handle: '  OWNER-RECOVERY  '
    }));
    assertStatus(recoveredIdentity, 202, 'missing handle recovery with owned preview', server);
    assert.equal(recoveredIdentity.body.profile.performerId, ownerPerformerId);
    assert.equal(recoveredIdentity.body.profile.displayName, 'Recovered Visibility Owner');
    assert.equal(recoveredIdentity.body.profile.handle, 'OWNER-RECOVERY');

    const recoveredRow = await proof.query<{ display_name: string; handle: string | null }>(
      'SELECT display_name, handle FROM performers WHERE id = $1',
      [ownerPerformerId]
    );
    assert.deepEqual(recoveredRow.rows[0], {
      display_name: 'Recovered Visibility Owner',
      handle: 'OWNER-RECOVERY'
    });

    const otherIdentityAttempt = await other.post('/api/talent/profile/public', publicProfilePayload({
      performerId: ownerPerformerId,
      displayName: 'Other Performer Edited',
      handle: 'other-performer-edited'
    }));
    assertStatus(otherIdentityAttempt, 202, 'other owner edits only own identity', server);
    assert.equal(otherIdentityAttempt.body.profile.performerId, otherPerformerId);
    const ownerAfterOtherIdentityAttempt = await proof.query<{ display_name: string; handle: string | null }>(
      'SELECT display_name, handle FROM performers WHERE id = $1',
      [ownerPerformerId]
    );
    assert.deepEqual(ownerAfterOtherIdentityAttempt.rows[0], {
      display_name: 'Recovered Visibility Owner',
      handle: 'OWNER-RECOVERY'
    });

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

    const profileSave = await owner.post('/api/talent/profile/public', publicProfilePayload());
    assertStatus(profileSave, 202, 'ordinary profile save', server);
    assert.equal(profileSave.body.profile.visibilityState, 'unlisted');
    assert.equal(profileSave.body.profile.handle, 'OWNER-RECOVERY');
    assert.equal(profileSave.body.profile.displayName, 'Recovered Visibility Owner');

    const afterProfileSave = await owner.get('/api/talent/profile/public');
    assertStatus(afterProfileSave, 200, 'profile read after ordinary save', server);
    assert.equal(afterProfileSave.body.profile.visibilityState, 'unlisted');

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

    const profileAudits = await proof.query<{ metadata: JsonObject }>(
      `SELECT metadata
       FROM audit_events
       WHERE entity_id = $1 AND event_type = 'performer_public_profile.update'
       ORDER BY created_at ASC`,
      [toAuditEntityUuid(ownerPerformerId)]
    );
    assert.deepEqual(profileAudits.rows[0]?.metadata?.changedIdentityFields, ['displayName', 'handle']);
    assert.equal(profileAudits.rows[0]?.metadata?.previousDisplayName, 'Legacy Visibility Owner');
    assert.equal(profileAudits.rows[0]?.metadata?.nextDisplayName, 'Recovered Visibility Owner');
    assert.equal(profileAudits.rows[0]?.metadata?.previousHandle, null);
    assert.equal(profileAudits.rows[0]?.metadata?.nextHandle, 'OWNER-RECOVERY');
    assert.equal(profileAudits.rows[0]?.metadata?.claimedPreviewReservationUsed, true);

    console.log('Sway performer visibility control integration passed.');
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
