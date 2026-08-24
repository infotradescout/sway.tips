import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { build } from 'esbuild';
import * as schema from '../src/db/schema';
import {
  createPerformerEventService,
  EventServiceError,
  type PerformerEventService
} from '../src/server/performer-event-service';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

const root = process.cwd();
const migrationDirectory = join(root, 'drizzle');
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

const ownerUserId = '00000000-0000-4000-8000-000000000101';
const outsiderUserId = '00000000-0000-4000-8000-000000000102';
const ownerPerformerId = '00000000-0000-4000-8000-000000000201';
const outsiderPerformerId = '00000000-0000-4000-8000-000000000202';

const mainClientRequestId = '00000000-0000-4000-8000-000000000301';
const draftClientRequestId = '00000000-0000-4000-8000-000000000302';
const unlistedClientRequestId = '00000000-0000-4000-8000-000000000303';
const endedClientRequestId = '00000000-0000-4000-8000-000000000304';
const unauthorizedClientRequestId = '00000000-0000-4000-8000-000000000305';
const walkInClientRequestId = '00000000-0000-4000-8000-000000000306';
const walkInTbaClientRequestId = '00000000-0000-4000-8000-000000000307';
const walkInMissingNameClientRequestId = '00000000-0000-4000-8000-000000000308';
const walkInMissingDestinationClientRequestId = '00000000-0000-4000-8000-000000000309';

type JsonResponse = {
  status: number;
  body: Record<string, any>;
  headers: Headers;
};

function proofHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function reserveProofPort() {
  const socket = createServer();
  await new Promise<void>((resolveReady, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolveReady);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a route-proof port.');
  await new Promise<void>((resolveClosed, reject) => {
    socket.close((error) => error ? reject(error) : resolveClosed());
  });
  return address.port;
}

async function buildRouteProofServer() {
  const tempRoot = join(root, '.tmp');
  await mkdir(tempRoot, { recursive: true });
  const prefix = join(tempRoot, 'sway-public-event-route-');
  const directory = await mkdtemp(prefix);
  const entryPath = join(directory, 'server.cjs');
  await build({
    entryPoints: [join(root, 'server.ts')],
    outfile: entryPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    sourcemap: false,
    logLevel: 'silent'
  });
  return { directory, entryPath, prefix };
}

async function removeRouteProofServer(bundle: {
  directory: string;
  entryPath: string;
  prefix: string;
} | null) {
  if (!bundle) return;
  const resolvedDirectory = resolve(bundle.directory);
  const resolvedPrefix = resolve(bundle.prefix);
  if (!resolvedDirectory.startsWith(resolvedPrefix)) {
    throw new Error(`Refusing to remove unexpected route-proof directory: ${resolvedDirectory}`);
  }
  await rm(resolvedDirectory, { recursive: true, force: true });
}

async function startRouteProofServer(
  databaseUrl: string,
  entryPath: string,
  port: number
) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [entryPath], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      APP_URL: baseUrl,
      SWAY_APP_BASE_URL: baseUrl,
      SWAY_API_ONLY_TEST_MODE: 'true',
      SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION: 'true',
      DISABLE_HMR: 'true',
      SWAY_EMAIL_PROVIDER: '',
      SWAY_EMAIL_API_KEY: '',
      SWAY_EMAIL_FROM: '',
      STRIPE_SECRET_KEY: '',
      STRIPE_PUBLISHABLE_KEY: '',
      VITE_STRIPE_PUBLISHABLE_KEY: '',
      STRIPE_WEBHOOK_SECRET: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams;
  let output = '';
  const appendOutput = (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-20_000);
  };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Route-proof server exited before readiness.\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/build-marker`);
      if (response.ok) return { baseUrl, child, output: () => output };
    } catch {
      // Listener is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`Route-proof server did not become ready.\n${output}`);
}

async function stopRouteProofServer(child: ChildProcessWithoutNullStreams | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise<void>((resolveStopped) => child.once('exit', () => resolveStopped()));
  child.kill('SIGTERM');
  await Promise.race([
    stopped,
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000))
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function createRouteClient(baseUrl: string) {
  let cookie = '';
  return async function request(path: string, init: RequestInit = {}): Promise<JsonResponse> {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      redirect: init.redirect ?? 'manual'
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';', 1)[0] ?? cookie;
    const text = await response.text();
    let body: Record<string, any> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, any>;
      } catch {
        body = { text };
      }
    }
    return { status: response.status, body, headers: response.headers };
  };
}

async function runWalkInPublishRouteProof() {
  const postgres = await startEmbeddedPostgresProof('public_event_walk_in_route');
  const port = await reserveProofPort();
  let bundle: Awaited<ReturnType<typeof buildRouteProofServer>> | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    bundle = await buildRouteProofServer();
    const server = await startRouteProofServer(postgres.databaseUrl, bundle.entryPath, port);
    child = server.child;
    const request = createRouteClient(server.baseUrl);
    const suffix = `${process.pid}${Date.now().toString(36)}`.toLowerCase();
    const email = `walk-in-route-${suffix}@example.test`;
    const password = `Sway-WalkIn-${suffix}-Proof!`;
    const handle = `walkin${suffix}`.slice(0, 30);
    const signup = await request('/api/account/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        displayName: 'Walk-in Route Proof',
        password,
        confirmPassword: password,
        termsAccepted: true,
        next: '/account?intent=performer'
      })
    });
    assert.equal(signup.status, 202, `Route-proof signup failed: ${JSON.stringify(signup.body)}\n${server.output()}`);
    const verificationUrl = new URL(String(signup.body.verificationLink));
    const verification = await request(`${verificationUrl.pathname}${verificationUrl.search}`);
    assert.equal(verification.status, 302, `Route-proof verification failed: ${JSON.stringify(verification.body)}`);
    const login = await request('/api/account/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, next: '/account?intent=performer' })
    });
    assert.equal(login.status, 200, `Route-proof login failed: ${JSON.stringify(login.body)}`);
    const activation = await request('/api/account/pro-mode/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Walk-in Route Proof', handle })
    });
    assert.equal(activation.status, 200, `Route-proof Pro Mode activation failed: ${JSON.stringify(activation.body)}`);
    const performerResult = await postgres.query<{ id: string }>(
      `select performers.id
         from performers
         inner join users on users.id = performers.owner_user_id
        where users.email = $1`,
      [email]
    );
    const performerId = performerResult.rows[0]?.id;
    assert.ok(performerId, 'Route-proof performer must persist before capability setup.');
    const currentPublicationGrant = await postgres.query<{
      decision: string;
      expires_at: Date | null;
    }>(
      `select decision::text as decision, expires_at
         from performer_capability_grant_events
        where performer_id = $1
          and capability = 'event_publication'
        order by event_sequence desc
        limit 1`,
      [performerId]
    );
    const publicationGrant = currentPublicationGrant.rows[0];
    if (
      publicationGrant?.decision !== 'granted'
      || (publicationGrant.expires_at && publicationGrant.expires_at.getTime() <= Date.now())
    ) {
      await postgres.query(
        `insert into performer_capability_grant_events (
           performer_id, capability, decision, actor_type, actor_user_id,
           reason, evidence, idempotency_key_hash
         ) values ($1, 'event_publication', 'granted', 'system', null,
           'Disposable route proof authorization', '{"proof":"public-event-route"}'::jsonb, $2)`,
        [performerId, proofHash(`event-publication:${performerId}`)]
      );
    }

    const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    for (const location of [
      { locationName: 'Community Room', locationAddress: '123 Main Street', city: 'Chicago', locationIsTba: true },
      { locationName: null, locationAddress: '123 Main Street', city: 'Chicago', locationIsTba: false },
      { locationName: 'Community Room', locationAddress: null, city: null, locationIsTba: false }
    ]) {
      const created = await request('/api/talent/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientRequestId: randomUUID(),
          title: 'Incomplete route walk-in',
          startsAt,
          timeZone: 'UTC',
          attendanceMode: 'walk_in',
          externalTicketUrl: null,
          externalTicketLabel: null,
          visibility: 'public',
          ...location
        })
      });
      assert.equal(created.status, 201, `Route-proof event create failed: ${JSON.stringify(created.body)}\n${server.output()}`);
      const eventId = String(created.body.event.id);
      const currentOrganizerAuthority = await postgres.query<{
        decision: string;
        expires_at: Date | null;
      }>(
        `select decision::text as decision, expires_at
           from performer_authority_events
          where performer_id = $1
            and authority_kind = 'event_organizer'
            and subject_type = 'event'
            and subject_id = $2
          order by event_sequence desc
          limit 1`,
        [performerId, eventId]
      );
      const organizerAuthority = currentOrganizerAuthority.rows[0];
      if (
        organizerAuthority?.decision !== 'granted'
        || (organizerAuthority.expires_at && organizerAuthority.expires_at.getTime() <= Date.now())
      ) {
        await postgres.query(
          `insert into performer_authority_events (
             performer_id, authority_kind, subject_type, subject_id, decision,
             actor_type, actor_user_id, reason, evidence, idempotency_key_hash
           ) values ($1, 'event_organizer', 'event', $2, 'granted',
             'system', null, 'Disposable route proof authority',
             '{"reference":"public-event-route"}'::jsonb, $3)`,
          [performerId, eventId, proofHash(`event-authority:${eventId}`)]
        );
      }
      const published = await request(`/api/talent/events/${encodeURIComponent(String(created.body.event.id))}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: created.body.event.updatedAt })
      });
      assert.equal(published.status, 422, `Incomplete walk-in unexpectedly published: ${JSON.stringify(published.body)}`);
      assert.equal(published.body.code, 'walk_in_location_required');
    }
  } finally {
    await stopRouteProofServer(child);
    await postgres.close();
    await removeRouteProofServer(bundle);
  }
}

async function applyAllMigrations(database: PGlite) {
  for (const migrationFile of migrationFiles) {
    const migrationSql = readFileSync(join(migrationDirectory, migrationFile), 'utf8');
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const [statementIndex, statement] of statements.entries()) {
      try {
        await database.exec(statement);
      } catch (error) {
        throw new Error(
          `Migration failed: ${migrationFile}, statement ${statementIndex + 1}`,
          { cause: error }
        );
      }
    }
  }
}

async function expectEventError(
  action: () => Promise<unknown>,
  expectedCode: string,
  expectedStatus: number
) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof EventServiceError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.status, expectedStatus);
    return true;
  });
}

async function countAuditEvents(database: PGlite, eventId: string, eventType: string) {
  const result = await database.query<{ count: number }>(
    `select count(*)::int as count
       from audit_events
      where entity_id = $1
        and event_type = $2`,
    [eventId, eventType]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function runIntegrationProof(
  database: PGlite,
  service: PerformerEventService
) {
  // Ownership is rechecked inside the service transaction. Possessing a valid
  // performer UUID and an otherwise valid create payload is not enough.
  await expectEventError(
    () => service.createEvent({
      performerId: ownerPerformerId,
      actorUserId: outsiderUserId,
      clientRequestId: unauthorizedClientRequestId,
      title: 'Unauthorized listing',
      startsAt: '2035-07-26T19:00:00-05:00',
      timeZone: 'America/Chicago',
      externalTicketUrl: 'https://tickets.example.com/unauthorized',
      visibility: 'public'
    }),
    'performer_owner_required',
    403
  );

  const created = await service.createEvent({
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    clientRequestId: mainClientRequestId,
    title: 'Summer Night',
    description: 'Doors at seven.',
    startsAt: '2035-07-26T19:00:00-05:00',
    endsAt: '2035-07-26T22:00:00-05:00',
    timeZone: 'America/Chicago',
    locationName: 'Private room name',
    locationAddress: '123 Private Address',
    city: 'Private City',
    locationIsTba: true,
    coverImageUrl: 'https://images.example.com/summer-night.png',
    externalTicketUrl: 'https://tickets.example.com/summer-night',
    externalTicketLabel: 'Get tickets',
    visibility: 'public'
  });

  assert.equal(created.created, true);
  assert.equal(created.event.status, 'draft');
  assert.equal(created.event.locationIsTba, true);
  assert.equal(
    await countAuditEvents(database, created.event.id, 'performer_event.create'),
    1
  );

  const persistedCreate = await database.query<{
    title: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `select title, created_at, updated_at
       from performer_events
      where id = $1`,
    [created.event.id]
  );
  assert.equal(persistedCreate.rows[0]?.title, 'Summer Night');
  assert.equal(
    persistedCreate.rows[0]?.created_at.toISOString(),
    created.event.createdAt
  );
  assert.equal(
    persistedCreate.rows[0]?.updated_at.toISOString(),
    created.event.updatedAt
  );

  // This is the critical first optimistic mutation after a DB insert. It proves
  // the persisted timestamp round-trips at the precision used by the WHERE
  // version guard.
  const updated = await service.updateEvent({
    eventId: created.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: created.event.updatedAt,
    title: 'Summer Night — updated'
  });
  assert.equal(updated.title, 'Summer Night — updated');
  assert.notEqual(updated.updatedAt, created.event.updatedAt);
  assert.equal(
    await countAuditEvents(database, created.event.id, 'performer_event.update'),
    1
  );

  await expectEventError(
    () => service.updateEvent({
      eventId: created.event.id,
      performerId: ownerPerformerId,
      actorUserId: ownerUserId,
      expectedUpdatedAt: created.event.updatedAt,
      description: 'A stale writer must not win.'
    }),
    'event_version_conflict',
    409
  );

  // A different valid performer owner still receives a scoped not-found
  // response and cannot infer or mutate the first performer's event.
  await expectEventError(
    () => service.updateEvent({
      eventId: created.event.id,
      performerId: outsiderPerformerId,
      actorUserId: outsiderUserId,
      expectedUpdatedAt: updated.updatedAt,
      title: 'Cross-performer takeover'
    }),
    'event_not_found',
    404
  );

  const published = await service.publishEvent({
    eventId: created.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: updated.updatedAt
  });
  assert.equal(published.status, 'published');
  assert.ok(published.publishedAt);

  // Terminal-state retry semantics: the original request version may be stale
  // after the first publish, but an identical desired state must replay safely.
  const publishedReplay = await service.publishEvent({
    eventId: created.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: updated.updatedAt
  });
  assert.equal(publishedReplay.status, 'published');
  assert.equal(publishedReplay.updatedAt, published.updatedAt);
  assert.equal(
    await countAuditEvents(database, created.event.id, 'performer_event.publish'),
    1
  );

  const publicMain = await service.getPublicEvent(created.event.id);
  assert.ok(publicMain);
  assert.equal(publicMain.status, 'published');
  assert.equal(publicMain.locationIsTba, true);
  assert.equal(publicMain.locationName, null);
  assert.equal(publicMain.locationAddress, null);
  assert.equal(publicMain.city, null);

  const incompleteWalkIns: Array<{ id: string }> = [];
  for (const input of [
    {
      clientRequestId: walkInTbaClientRequestId,
      title: 'TBA walk-in',
      locationName: 'Community Room',
      locationAddress: '123 Main Street',
      city: 'Chicago',
      locationIsTba: true
    },
    {
      clientRequestId: walkInMissingNameClientRequestId,
      title: 'Unnamed walk-in',
      locationName: null,
      locationAddress: '123 Main Street',
      city: 'Chicago',
      locationIsTba: false
    },
    {
      clientRequestId: walkInMissingDestinationClientRequestId,
      title: 'No destination walk-in',
      locationName: 'Community Room',
      locationAddress: null,
      city: null,
      locationIsTba: false
    }
  ] as const) {
    const incomplete = await service.createEvent({
      performerId: ownerPerformerId,
      actorUserId: ownerUserId,
      ...input,
      startsAt: '2035-07-29T19:00:00-05:00',
      timeZone: 'America/Chicago',
      attendanceMode: 'walk_in',
      externalTicketUrl: null,
      externalTicketLabel: null,
      visibility: 'public'
    });
    incompleteWalkIns.push(incomplete.event);
    await expectEventError(
      () => service.publishEvent({
        eventId: incomplete.event.id,
        performerId: ownerPerformerId,
        actorUserId: ownerUserId,
        expectedUpdatedAt: incomplete.event.updatedAt
      }),
      'walk_in_location_required',
      422
    );
  }

  // The same publication invariant survives callers that bypass the service.
  for (const incompleteWalkIn of incompleteWalkIns) {
    await assert.rejects(() => database.query(
      `update performer_events
          set status = 'published',
              published_at = now()
        where id = $1`,
      [incompleteWalkIn.id]
    ));
  }

  const walkIn = await service.createEvent({
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    clientRequestId: walkInClientRequestId,
    title: 'Open mic walk-in',
    startsAt: '2035-07-30T19:00:00-05:00',
    timeZone: 'America/Chicago',
    locationName: 'Community Room',
    city: 'Chicago',
    attendanceMode: 'walk_in',
    externalTicketUrl: null,
    externalTicketLabel: null,
    visibility: 'public'
  });
  assert.equal(walkIn.event.attendanceMode, 'walk_in');
  const walkInPublished = await service.publishEvent({
    eventId: walkIn.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: walkIn.event.updatedAt
  });
  assert.equal(walkInPublished.status, 'published');
  const publicWalkIn = await service.getPublicEvent(walkIn.event.id);
  assert.ok(publicWalkIn);
  assert.equal(publicWalkIn.attendanceMode, 'walk_in');
  assert.equal(publicWalkIn.externalTicketUrl, null);
  assert.equal(publicWalkIn.externalTicketLabel, null);
  await expectEventError(
    () => service.updateEvent({
      eventId: walkIn.event.id,
      performerId: ownerPerformerId,
      actorUserId: ownerUserId,
      expectedUpdatedAt: walkInPublished.updatedAt,
      locationIsTba: true
    }),
    'walk_in_location_required',
    422
  );
  await database.query(
    `update performer_events
        set external_ticket_url = 'https://tickets.example.com/not-a-walk-in',
            external_ticket_label = 'Get tickets'
      where id = $1`,
    [walkIn.event.id]
  );
  const legacyExternalUpdate = await database.query<{ attendance_mode: string }>(
    `select attendance_mode::text as attendance_mode
       from performer_events
      where id = $1`,
    [walkIn.event.id]
  );
  assert.equal(
    legacyExternalUpdate.rows[0]?.attendance_mode,
    'external_ticket',
    'The rolling-writer trigger must translate an old external-link update.'
  );
  await assert.rejects(() => database.query(
    `update performer_events
        set attendance_mode = 'walk_in'
      where id = $1`,
    [walkIn.event.id]
  ));
  await database.query(
    `update performer_events
        set attendance_mode = 'walk_in',
            external_ticket_url = null,
            external_ticket_label = null
      where id = $1`,
    [walkIn.event.id]
  );

  // Draft and unlisted records remain directly owner-manageable without
  // leaking into the public discovery query.
  const draft = await service.createEvent({
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    clientRequestId: draftClientRequestId,
    title: 'Public-looking draft',
    startsAt: '2035-08-01T19:00:00-05:00',
    timeZone: 'America/Chicago',
    externalTicketUrl: 'https://tickets.example.com/draft',
    visibility: 'public'
  });
  assert.equal(draft.event.status, 'draft');

  // Service invariants are also encoded in the migration, so direct SQL
  // cannot claim a published listing without an external handoff or claim a
  // cancellation without a prior publish timestamp and public reason.
  await assert.rejects(() => database.query(
    `update performer_events
        set status = 'published',
            published_at = now(),
            external_ticket_url = null,
            external_ticket_label = null
      where id = $1`,
    [draft.event.id]
  ));
  await assert.rejects(() => database.query(
    `update performer_events
        set status = 'cancelled',
            published_at = now(),
            cancelled_at = now(),
            cancellation_reason = null
      where id = $1`,
    [draft.event.id]
  ));

  const unlisted = await service.createEvent({
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    clientRequestId: unlistedClientRequestId,
    title: 'Link-only event',
    startsAt: '2035-08-02T19:00:00-05:00',
    timeZone: 'America/Chicago',
    externalTicketUrl: 'https://tickets.example.com/link-only',
    visibility: 'unlisted'
  });
  const unlistedPublished = await service.publishEvent({
    eventId: unlisted.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: unlisted.event.updatedAt
  });
  assert.equal(unlistedPublished.status, 'published');
  assert.ok(await service.getPublicEvent(unlisted.event.id));

  const publicFeedEvents = await service.listPublicEvents({
    performerId: ownerPerformerId,
    now: '2035-01-01T00:00:00Z'
  });
  assert.deepEqual(
    publicFeedEvents.map((event) => event.id),
    [created.event.id, walkIn.event.id],
    'The feed source must include only future, published, public events.'
  );

  await database.query(
    `update performers
        set onboarding_status = 'suspended'
      where id = $1`,
    [ownerPerformerId]
  );
  assert.deepEqual(
    await service.listPublicEvents({
      performerId: ownerPerformerId,
      now: '2035-01-01T00:00:00Z'
    }),
    [],
    'Suspended performers must disappear from public event discovery.'
  );
  assert.equal(
    await service.getPublicEvent(created.event.id),
    null,
    'A suspended performer direct event page must fail closed.'
  );
  await database.query(
    `update performers
        set onboarding_status = 'gig_ready'
      where id = $1`,
    [ownerPerformerId]
  );

  const cancelled = await service.cancelEvent({
    eventId: created.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: published.updatedAt,
    cancellationReason: 'Weather'
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancellationReason, 'Weather');

  const cancelledWalkIn = await service.cancelEvent({
    eventId: walkIn.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: walkInPublished.updatedAt,
    cancellationReason: 'Organizer cancelled'
  });
  assert.equal(cancelledWalkIn.status, 'cancelled');
  assert.equal(cancelledWalkIn.attendanceMode, 'walk_in');

  const cancelledReplay = await service.cancelEvent({
    eventId: created.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: published.updatedAt,
    cancellationReason: ' Weather '
  });
  assert.equal(cancelledReplay.status, 'cancelled');
  assert.equal(cancelledReplay.updatedAt, cancelled.updatedAt);
  assert.equal(
    await countAuditEvents(database, created.event.id, 'performer_event.cancel'),
    1
  );

  const publicCancelled = await service.getPublicEvent(created.event.id);
  assert.ok(publicCancelled);
  assert.equal(publicCancelled.status, 'cancelled');
  assert.equal(publicCancelled.externalTicketUrl, null);
  assert.equal(publicCancelled.externalTicketLabel, null);
  assert.deepEqual(
    await service.listPublicEvents({
      performerId: ownerPerformerId,
      now: '2035-01-01T00:00:00Z'
    }),
    [],
    'Cancelled, draft, and unlisted events must all stay out of discovery.'
  );

  const endedDraft = await service.createEvent({
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    clientRequestId: endedClientRequestId,
    title: 'Event that will end',
    startsAt: '2036-01-01T19:00:00-06:00',
    endsAt: '2036-01-01T21:00:00-06:00',
    timeZone: 'America/Chicago',
    externalTicketUrl: 'https://tickets.example.com/ended',
    visibility: 'public'
  });
  const endedPublished = await service.publishEvent({
    eventId: endedDraft.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: endedDraft.event.updatedAt
  });

  await expectEventError(
    () => service.updateEvent({
      eventId: endedDraft.event.id,
      performerId: ownerPerformerId,
      actorUserId: ownerUserId,
      expectedUpdatedAt: endedPublished.updatedAt,
      startsAt: '2020-01-01T19:00:00-06:00',
      endsAt: '2020-01-01T21:00:00-06:00'
    }),
    'published_event_must_remain_active',
    422
  );

  // Simulate normal time passage for an already-published historical row
  // without waiting for the clock. This controlled SQL setup is not a product
  // mutation path; the assertions below exercise the service's historical lock.
  await database.query(
    `update performer_events
        set starts_at = '2020-01-02T01:00:00.000Z',
            ends_at = '2020-01-02T03:00:00.000Z'
      where id = $1`,
    [endedPublished.id]
  );

  await expectEventError(
    () => service.updateEvent({
      eventId: endedPublished.id,
      performerId: ownerPerformerId,
      actorUserId: ownerUserId,
      expectedUpdatedAt: endedPublished.updatedAt,
      description: 'A completed record must remain historical.'
    }),
    'event_already_ended',
    409
  );

  await expectEventError(
    () => service.cancelEvent({
      eventId: endedPublished.id,
      performerId: ownerPerformerId,
      actorUserId: ownerUserId,
      expectedUpdatedAt: endedPublished.updatedAt,
      cancellationReason: 'A completed event cannot be rewritten.'
    }),
    'event_already_ended',
    409
  );

  const persistedEnded = await database.query<{ status: string }>(
    `select status::text as status
      from performer_events
      where id = $1`,
    [endedPublished.id]
  );
  assert.equal(persistedEnded.rows[0]?.status, 'published');
}

const database = new PGlite();

try {
  await applyAllMigrations(database);

  await database.exec(`
    insert into users (id, email, role) values
      ('${ownerUserId}', 'event-owner@example.test', 'performer'),
      ('${outsiderUserId}', 'event-outsider@example.test', 'performer');

    insert into performers (
      id,
      owner_user_id,
      display_name,
      handle,
      is_active,
      onboarding_status
    ) values
      (
        '${ownerPerformerId}',
        '${ownerUserId}',
        'Event Owner',
        'event-owner',
        true,
        'gig_ready'
      ),
      (
        '${outsiderPerformerId}',
        '${outsiderUserId}',
        'Event Outsider',
        'event-outsider',
        true,
        'gig_ready'
      );
  `);

  const db = drizzle(database, { schema });
  const service = createPerformerEventService(db as never);
  await runIntegrationProof(database, service);

  console.log(
    `Public event listings integration test passed (${migrationFiles.length} migrations).`
  );
} finally {
  await database.close();
}

await runWalkInPublishRouteProof();
console.log('Public event walk-in publish route proof passed.');
