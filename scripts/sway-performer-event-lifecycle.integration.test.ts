import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { createSwayDb } from '../src/db/client';
import {
  createPerformerEventService,
  EventServiceError,
  type PerformerEventService
} from '../src/server/performer-event-service';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

type Proof = Awaited<ReturnType<typeof startEmbeddedPostgresProof>>;

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    delay(milliseconds).then(() => {
      throw new Error(`${label} exceeded ${milliseconds}ms.`);
    })
  ]);
}

async function seedEventOwner(proof: Proof) {
  const userId = randomUUID();
  const performerId = randomUUID();
  await proof.query(
    `insert into users (id, email, role)
     values ($1, $2, 'performer')`,
    [userId, `event-lifecycle-${userId}@example.test`]
  );
  await proof.query(
    `insert into performers (
       id, owner_user_id, display_name, handle, is_active,
       visibility_state, onboarding_status
     ) values ($1, $2, 'Event Lifecycle Proof', $3, true, 'public', 'gig_ready')`,
    [performerId, userId, `event-lifecycle-${performerId.slice(0, 8)}`]
  );
  return { userId, performerId };
}

async function insertPublishedEventAndRoom(input: {
  client: Client;
  userId: string;
  performerId: string;
  title: string;
  startsAtExpression: string;
  endsAtExpression: string;
}) {
  const eventId = randomUUID();
  const roomId = randomUUID();
  await input.client.query(
    `insert into performer_events (
       id, performer_id, client_request_id, created_by_actor_user_id,
       last_mutation_actor_user_id, title, starts_at, ends_at, time_zone,
       ticketing_mode, attendance_mode, external_ticket_url,
       external_ticket_label, visibility, status, published_at
     ) values (
       $1, $2, $3, $4, $4, $5,
       ${input.startsAtExpression}, ${input.endsAtExpression}, 'America/Chicago',
       'external', 'external_ticket', $6, 'Get tickets',
       'public', 'published', clock_timestamp()
     )`,
    [
      eventId,
      input.performerId,
      randomUUID(),
      input.userId,
      input.title,
      `https://tickets.example.test/${eventId}`
    ]
  );
  await input.client.query(
    `insert into gig_sessions (
       id, performer_id, owner_actor_user_id, last_mutation_actor_user_id,
       status, room_type, money_enabled, linked_event_id, request_menu,
       title, runtime_session_state, started_at, auto_closeout_at
     ) values (
       $1, $2, $3, $3, 'active', 'music', false, $4::uuid, '[]'::jsonb,
       $5, jsonb_build_object('linkedEventId', ($4::uuid)::text),
       clock_timestamp(), clock_timestamp() + interval '6 hours'
     )`,
    [roomId, input.performerId, input.userId, eventId, input.title]
  );
  return { eventId, roomId };
}

async function proveStarvationFreeReconciliation(
  proof: Proof,
  service: PerformerEventService,
  owner: { userId: string; performerId: string }
) {
  const client = new Client({ connectionString: proof.databaseUrl });
  await client.connect();
  let expired: { eventId: string; roomId: string } | null = null;
  try {
    await client.query('begin');
    for (let index = 0; index < 50; index += 1) {
      await insertPublishedEventAndRoom({
        client,
        ...owner,
        title: `Eligible event ${String(index + 1).padStart(2, '0')}`,
        startsAtExpression: "clock_timestamp() + interval '1 hour'",
        endsAtExpression: "clock_timestamp() + interval '2 hours'"
      });
    }
    expired = await insertPublishedEventAndRoom({
      client,
      ...owner,
      title: 'Expired event after fifty eligible links',
      startsAtExpression: "clock_timestamp() - interval '1 hour'",
      endsAtExpression: "clock_timestamp() + interval '1 second'"
    });
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }

  assert.ok(expired);
  await delay(1_250);
  const fixture = await proof.query<{
    eligible_links: number;
    expired_links: number;
    expired_at: Date;
    evaluated_at: Date;
  }>(
    `select
       count(*) filter (
         where room.linked_event_id <> $1
           and sway_event_room_link_is_eligible(
             event.status, event.ticketing_mode, event.attendance_mode,
             event.starts_at, event.ends_at, event.location_is_tba,
             event.location_name, event.location_address, event.city,
             clock_timestamp()
           )
       )::integer as eligible_links,
       count(*) filter (where room.linked_event_id = $1)::integer as expired_links,
       max(event.ends_at) filter (where room.linked_event_id = $1) as expired_at,
       clock_timestamp() as evaluated_at
     from gig_sessions room
     inner join performer_events event on event.id = room.linked_event_id
     where room.status in ('active', 'closeout_pending')`,
    [expired.eventId]
  );
  assert.equal(fixture.rows[0]?.eligible_links, 50);
  assert.equal(fixture.rows[0]?.expired_links, 1);
  assert.ok(
    fixture.rows[0]!.evaluated_at.getTime() >= fixture.rows[0]!.expired_at.getTime(),
    'The proof fixture must cross the event close boundary before reconciliation.'
  );

  const firstPass = await service.detachIneligibleRoomLinks({ limit: 50 });
  assert.deepEqual(firstPass, { inspected: 1, detached: 1 });

  const truth = await proof.query<{
    linked_event_id: string | null;
    state_revision: number;
    runtime_linked_event_id: string | null;
    eligible_links: number;
    audit_count: number;
  }>(
    `select room.linked_event_id,
            room.state_revision,
            room.runtime_session_state ->> 'linkedEventId' as runtime_linked_event_id,
            (
              select count(*)::integer
              from gig_sessions eligible
              where eligible.performer_id = $2
                and eligible.linked_event_id is not null
                and eligible.status in ('active', 'closeout_pending')
            ) as eligible_links,
            (
              select count(*)::integer
              from audit_events audit
              where audit.entity_type = 'gig_session'
                and audit.entity_id = room.id
                and audit.event_type = 'gig_session.linked_event_detached'
                and audit.metadata ->> 'eventId' = $1
                and audit.metadata ->> 'source' = 'event_room_maintenance'
            ) as audit_count
       from gig_sessions room
      where room.id = $3`,
    [expired.eventId, owner.performerId, expired.roomId]
  );
  assert.deepEqual(truth.rows[0], {
    linked_event_id: null,
    state_revision: 1,
    runtime_linked_event_id: null,
    eligible_links: 50,
    audit_count: 1
  });

  const replay = await service.detachIneligibleRoomLinks({ limit: 50 });
  assert.deepEqual(replay, { inspected: 0, detached: 0 });
  const replayAudit = await proof.query<{ count: number }>(
    `select count(*)::integer as count
       from audit_events
      where entity_type = 'gig_session'
        and entity_id = $1
        and event_type = 'gig_session.linked_event_detached'`,
    [expired.roomId]
  );
  assert.equal(replayAudit.rows[0]?.count, 1, 'Reconciliation replay must not duplicate the audit record.');
}

async function provePublishUpdateLockOrder(
  proof: Proof,
  service: PerformerEventService,
  owner: { userId: string; performerId: string }
) {
  const created = await service.createEvent({
    performerId: owner.performerId,
    actorUserId: owner.userId,
    clientRequestId: randomUUID(),
    title: 'Publish versus update lock-order proof',
    startsAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
    timeZone: 'America/Chicago',
    attendanceMode: 'external_ticket',
    externalTicketUrl: 'https://tickets.example.test/publish-update-lock-order',
    externalTicketLabel: 'Get tickets',
    visibility: 'public'
  });
  const blocker = new Client({ connectionString: proof.databaseUrl });
  await blocker.connect();
  let transactionOpen = false;
  try {
    await blocker.query('begin');
    transactionOpen = true;
    await blocker.query(
      'select id from performer_events where id = $1 for update',
      [created.event.id]
    );

    const publishOutcome = service.publishEvent({
      eventId: created.event.id,
      performerId: owner.performerId,
      actorUserId: owner.userId,
      expectedUpdatedAt: created.event.updatedAt
    }).then(
      (event) => ({ status: 'resolved' as const, event }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );

    // The publisher owns the advisory lock while it waits for this row. A
    // direct writer already owns the row, so its trigger must not then request
    // the advisory lock in the opposite order.
    await delay(150);
    await withTimeout(
      blocker.query(
        `update performer_events
            set title = 'Concurrent update won',
                updated_at = clock_timestamp()
          where id = $1`,
        [created.event.id]
      ),
      5_000,
      'The row-lock holder event update'
    );
    await blocker.query('commit');
    transactionOpen = false;

    const outcome = await withTimeout(publishOutcome, 5_000, 'The blocked publish request');
    assert.equal(outcome.status, 'rejected');
    assert.ok(outcome.error instanceof EventServiceError);
    assert.equal(outcome.error.code, 'event_version_conflict');
    assert.equal(outcome.error.status, 409);

    const truth = await proof.query<{ title: string; status: string; publish_audits: number }>(
      `select event.title,
              event.status::text as status,
              (
                select count(*)::integer
                from audit_events audit
                where audit.entity_type = 'performer_event'
                  and audit.entity_id = event.id
                  and audit.event_type = 'performer_event.publish'
              ) as publish_audits
         from performer_events event
        where event.id = $1`,
      [created.event.id]
    );
    assert.deepEqual(truth.rows[0], {
      title: 'Concurrent update won',
      status: 'draft',
      publish_audits: 0
    });
  } finally {
    if (transactionOpen) await blocker.query('rollback').catch(() => undefined);
    await blocker.end();
  }
}

async function proveLinkedRoomMutationFailsFastWithoutDeadlock(
  proof: Proof,
  service: PerformerEventService,
  owner: { userId: string; performerId: string }
) {
  const fixtureClient = new Client({ connectionString: proof.databaseUrl });
  await fixtureClient.connect();
  let linked: { eventId: string; roomId: string } | null = null;
  try {
    linked = await insertPublishedEventAndRoom({
      client: fixtureClient,
      ...owner,
      title: 'Linked room row versus event advisory proof',
      startsAtExpression: "clock_timestamp() + interval '1 hour'",
      endsAtExpression: "clock_timestamp() + interval '2 hours'"
    });
  } finally {
    await fixtureClient.end();
  }
  assert.ok(linked);
  await proof.query(
    `update performer_events
        set updated_at = date_trunc('milliseconds', updated_at)
      where id = $1`,
    [linked.eventId]
  );
  const eventTruth = await proof.query<{ updated_at: Date }>(
    'select updated_at from performer_events where id = $1',
    [linked.eventId]
  );
  const expectedUpdatedAt = eventTruth.rows[0]?.updated_at;
  assert.ok(expectedUpdatedAt);

  const blocker = new Client({ connectionString: proof.databaseUrl });
  await blocker.connect();
  let transactionOpen = false;
  try {
    await blocker.query('begin');
    transactionOpen = true;
    await blocker.query(
      'select id from gig_sessions where id = $1 for update',
      [linked.roomId]
    );

    const updateOutcome = service.updateEvent({
      eventId: linked.eventId,
      performerId: owner.performerId,
      actorUserId: owner.userId,
      expectedUpdatedAt: expectedUpdatedAt.toISOString(),
      startsAt: new Date(Date.now() + 90 * 60 * 1_000).toISOString()
    }).then(
      (event) => ({ status: 'resolved' as const, event }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );

    // The service owns event advisory -> event row and is waiting for this
    // room. This pre-existing room row must never wait back on the advisory
    // lock; its trigger returns a retryable serialization failure immediately.
    await delay(150);
    await assert.rejects(
      withTimeout(
        blocker.query(
          `update gig_sessions
              set title = 'Concurrent room mutation must retry'
            where id = $1`,
          [linked.roomId]
        ),
        800,
        'The row-first linked-room mutation'
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '40001');
        return true;
      }
    );
    await blocker.query('rollback');
    transactionOpen = false;

    const outcome = await withTimeout(updateOutcome, 5_000, 'The linked event lifecycle update');
    if (outcome.status === 'rejected') throw outcome.error;
    assert.equal(outcome.status, 'resolved');
    const roomTruth = await proof.query<{ linked_event_id: string | null }>(
      'select linked_event_id from gig_sessions where id = $1',
      [linked.roomId]
    );
    assert.equal(roomTruth.rows[0]?.linked_event_id, null);
  } finally {
    if (transactionOpen) await blocker.query('rollback').catch(() => undefined);
    await blocker.end();
  }
}

async function proveEventExpiryAfterLifecycleLockWait(
  proof: Proof,
  owner: { userId: string; performerId: string }
) {
  const eventId = randomUUID();
  const roomId = randomUUID();
  await proof.query(
    `insert into performer_events (
       id, performer_id, client_request_id, created_by_actor_user_id,
       last_mutation_actor_user_id, title, starts_at, ends_at, time_zone,
       ticketing_mode, attendance_mode, external_ticket_url,
       external_ticket_label, visibility, status, published_at
     ) values (
       $1, $2, $3, $4, $4, 'Expiry after lifecycle-lock wait',
       clock_timestamp() - interval '1 hour',
       clock_timestamp() + interval '1 second', 'America/Chicago',
       'external', 'external_ticket', $5, 'Get tickets',
       'public', 'published', clock_timestamp()
     )`,
    [
      eventId,
      owner.performerId,
      randomUUID(),
      owner.userId,
      `https://tickets.example.test/${eventId}`
    ]
  );

  const blocker = new Client({ connectionString: proof.databaseUrl });
  const contender = new Client({ connectionString: proof.databaseUrl });
  await Promise.all([blocker.connect(), contender.connect()]);
  let blockerOpen = false;
  let contenderOpen = false;
  try {
    await blocker.query('begin');
    blockerOpen = true;
    await blocker.query('select sway_event_room_link_lock($1::uuid)', [eventId]);

    await contender.query('begin');
    contenderOpen = true;
    const insertOutcome = contender.query(
      `insert into gig_sessions (
         id, performer_id, owner_actor_user_id, last_mutation_actor_user_id,
         status, room_type, money_enabled, linked_event_id, request_menu,
         title, runtime_session_state, started_at, auto_closeout_at
       ) values (
         $1, $2, $3, $3, 'active', 'music', false, $4::uuid, '[]'::jsonb,
         'Expired lock-wait room', jsonb_build_object('linkedEventId', $4::uuid::text),
         clock_timestamp(), clock_timestamp() + interval '4 hours'
       )`,
      [roomId, owner.performerId, owner.userId, eventId]
    );

    // The contender transaction began before expiry. Only a post-lock wall
    // clock evaluation can reject it after the lifecycle wait crosses ends_at.
    await delay(1_250);
    await blocker.query('rollback');
    blockerOpen = false;
    await assert.rejects(
      withTimeout(insertOutcome, 5_000, 'The post-expiry linked-room insert'),
      /gig_sessions_linked_event_eligible|not eligible/i
    );
    await contender.query('rollback');
    contenderOpen = false;

    const roomTruth = await proof.query<{ count: number }>(
      'select count(*)::integer as count from gig_sessions where id = $1',
      [roomId]
    );
    assert.equal(roomTruth.rows[0]?.count, 0);
  } finally {
    if (blockerOpen) await blocker.query('rollback').catch(() => undefined);
    if (contenderOpen) await contender.query('rollback').catch(() => undefined);
    await Promise.all([blocker.end(), contender.end()]);
  }
}

const proof = await startEmbeddedPostgresProof('performer_event_lifecycle');
try {
  const owner = await seedEventOwner(proof);
  const db = createSwayDb(proof.databaseUrl);
  const service = createPerformerEventService(db);

  await proveStarvationFreeReconciliation(proof, service, owner);
  console.log('Event lifecycle reconciliation proof passed: 50 eligible links did not hide one expired link.');

  if (proof.kind === 'real-postgres') {
    await provePublishUpdateLockOrder(proof, service, owner);
    console.log('Event lifecycle real-PostgreSQL lock-order proof passed without deadlock.');
    await proveLinkedRoomMutationFailsFastWithoutDeadlock(proof, service, owner);
    console.log('Linked-room row/advisory inversion fails fast without deadlock.');
    await proveEventExpiryAfterLifecycleLockWait(proof, owner);
    console.log('Event lifecycle post-lock wall-clock expiry proof passed.');
  } else {
    console.log('Event lifecycle lock-order proof requires the strict real-PostgreSQL lane; embedded functional proof completed.');
  }
} finally {
  await proof.close();
}
