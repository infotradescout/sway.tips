import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema';
import {
  createPerformerEventService,
  EventServiceError,
  type PerformerEventService
} from '../src/server/performer-event-service';

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
const incompleteWalkInClientRequestId = '00000000-0000-4000-8000-000000000307';
const rsvpDraftClientRequestId = '00000000-0000-4000-8000-000000000308';

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

  await database.query(
    `update performers set visibility_state = 'draft' where id = $1`,
    [ownerPerformerId]
  );
  assert.deepEqual(
    await service.getOwnerPublicationCapability({
      performerId: ownerPerformerId,
      actorUserId: ownerUserId
    }),
    {
      canPublish: false,
      reach: null,
      reasonCode: 'performer_public_page_not_ready',
      message: 'Finish your Public Page before publishing: add a valid handle, display name, and bio, then choose Public or Unlisted visibility.'
    }
  );
  await expectEventError(
    () => service.publishEvent({
      eventId: created.event.id,
      performerId: ownerPerformerId,
      actorUserId: ownerUserId,
      expectedUpdatedAt: updated.updatedAt
    }),
    'performer_public_page_not_ready',
    422
  );
  await database.query(
    `update performers set visibility_state = 'public', bio = null where id = $1`,
    [ownerPerformerId]
  );
  await expectEventError(
    () => service.publishEvent({
      eventId: created.event.id,
      performerId: ownerPerformerId,
      actorUserId: ownerUserId,
      expectedUpdatedAt: updated.updatedAt
    }),
    'performer_public_page_not_ready',
    422
  );
  await database.query(
    `update performers set bio = 'A resolvable public performer profile.' where id = $1`,
    [ownerPerformerId]
  );
  assert.equal(
    (await service.getOwnerPublicationCapability({
      performerId: ownerPerformerId,
      actorUserId: ownerUserId
    })).reach,
    'discover'
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
  await database.query(
    `update performers set visibility_state = 'unlisted' where id = $1`,
    [ownerPerformerId]
  );
  assert.equal(
    (await service.getOwnerPublicationCapability({
      performerId: ownerPerformerId,
      actorUserId: ownerUserId
    })).reach,
    'link_only'
  );
  const unlistedPublished = await service.publishEvent({
    eventId: unlisted.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: unlisted.event.updatedAt
  });
  assert.equal(unlistedPublished.status, 'published');
  assert.equal(unlistedPublished.publicationReach, 'link_only');
  assert.ok(await service.getPublicEvent(unlisted.event.id));
  await database.query(
    `update performers set visibility_state = 'public' where id = $1`,
    [ownerPerformerId]
  );

  const walkIn = await service.createEvent({
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    clientRequestId: walkInClientRequestId,
    title: 'Walk-in showcase',
    startsAt: '2035-07-20T19:00:00-05:00',
    timeZone: 'America/Chicago',
    locationName: 'The Listening Room',
    city: 'Chicago',
    attendanceMode: 'walk_in',
    visibility: 'public'
  });
  assert.equal(walkIn.event.attendanceMode, 'walk_in');
  assert.equal(walkIn.event.externalTicketUrl, null);
  const publishedWalkIn = await service.publishEvent({
    eventId: walkIn.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: walkIn.event.updatedAt
  });
  assert.equal(publishedWalkIn.status, 'published');
  const publicWalkIn = await service.getPublicEvent(walkIn.event.id);
  assert.equal(publicWalkIn?.attendanceMode, 'walk_in');
  assert.equal(publicWalkIn?.externalTicketUrl, null);

  const rsvpDraft = await service.createEvent({
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    clientRequestId: rsvpDraftClientRequestId,
    title: 'RSVP details pending',
    startsAt: '2035-08-04T19:00:00-05:00',
    timeZone: 'America/Chicago',
    attendanceMode: 'external_rsvp',
    externalTicketUrl: 'https://rsvp.example.com/temporary',
    externalTicketLabel: 'RSVP',
    visibility: 'unlisted'
  });
  const clearedRsvpDraft = await service.updateEvent({
    eventId: rsvpDraft.event.id,
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    expectedUpdatedAt: rsvpDraft.event.updatedAt,
    attendanceMode: 'external_rsvp',
    externalTicketUrl: null,
    externalTicketLabel: null
  });
  assert.equal(
    clearedRsvpDraft.attendanceMode,
    'external_rsvp',
    'Clearing a draft RSVP URL must not silently rewrite its attendance mode.'
  );
  assert.equal(clearedRsvpDraft.externalTicketUrl, null);

  const incompleteWalkIn = await service.createEvent({
    performerId: ownerPerformerId,
    actorUserId: ownerUserId,
    clientRequestId: incompleteWalkInClientRequestId,
    title: 'Location still needed',
    startsAt: '2035-08-03T19:00:00-05:00',
    timeZone: 'America/Chicago',
    locationIsTba: true,
    attendanceMode: 'walk_in',
    visibility: 'public'
  });
  await expectEventError(
    () => service.publishEvent({
      eventId: incompleteWalkIn.event.id,
      performerId: ownerPerformerId,
      actorUserId: ownerUserId,
      expectedUpdatedAt: incompleteWalkIn.event.updatedAt
    }),
    'walk_in_location_required',
    422
  );

  const publicFeedEvents = await service.listPublicEvents({
    performerId: ownerPerformerId,
    now: '2035-01-01T00:00:00Z'
  });
  assert.deepEqual(
    publicFeedEvents.map((event) => event.id),
    [walkIn.event.id, created.event.id],
    'The feed source must include only future, published, public events.'
  );

  await expectEventError(
    () => service.listPublicEvents({ audience: 'direct' }),
    'performer_id_required',
    422
  );
  await database.query(
    `update performers set visibility_state = 'unlisted' where id = $1`,
    [ownerPerformerId]
  );
  assert.deepEqual(
    await service.listPublicEvents({ performerId: ownerPerformerId, now: '2035-01-01T00:00:00Z' }),
    [],
    'An unlisted performer must not be enumerable in discovery.'
  );
  assert.ok(
    await service.getPublicEvent(created.event.id),
    'An unlisted performer may still resolve through a direct event link.'
  );
  assert.ok((await service.listPublicEvents({
    performerId: ownerPerformerId,
    audience: 'direct',
    now: '2035-01-01T00:00:00Z'
  })).length > 0);

  await database.query(
    `update performers set visibility_state = 'draft' where id = $1`,
    [ownerPerformerId]
  );
  assert.equal(await service.getPublicEvent(created.event.id), null);
  await database.query(
    `update performers set visibility_state = 'public', onboarding_status = 'restricted' where id = $1`,
    [ownerPerformerId]
  );
  assert.equal(await service.getPublicEvent(created.event.id), null);
  await expectEventError(
    () => service.publishEvent({
      eventId: incompleteWalkIn.event.id,
      performerId: ownerPerformerId,
      actorUserId: ownerUserId,
      expectedUpdatedAt: incompleteWalkIn.event.updatedAt
    }),
    'performer_restricted',
    403
  );
  await database.query(
    `update performers set onboarding_status = 'gig_ready', is_active = false where id = $1`,
    [ownerPerformerId]
  );
  assert.equal(await service.getPublicEvent(created.event.id), null);
  await database.query(
    `update performers set is_active = true, bio = null where id = $1`,
    [ownerPerformerId]
  );
  assert.equal(await service.getPublicEvent(created.event.id), null);
  await database.query(
    `update performers set bio = 'A resolvable public performer profile.' where id = $1`,
    [ownerPerformerId]
  );
  await database.query(
    `update performers set handle = 'platynum-47' where id = $1`,
    [ownerPerformerId]
  );
  assert.equal(
    await service.getPublicEvent(created.event.id),
    null,
    'An internal-test performer handle must not resolve through a direct event link.'
  );
  assert.deepEqual(
    await service.listPublicEvents({ performerId: ownerPerformerId, now: '2035-01-01T00:00:00Z' }),
    [],
    'An internal-test performer handle must not enter event discovery.'
  );
  await database.query(
    `update performers set handle = 'event-owner' where id = $1`,
    [ownerPerformerId]
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
    (await service.listPublicEvents({
      performerId: ownerPerformerId,
      now: '2035-01-01T00:00:00Z'
    })).map((event) => event.id),
    [walkIn.event.id],
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
      bio,
      is_active,
      visibility_state,
      onboarding_status
    ) values
      (
        '${ownerPerformerId}',
        '${ownerUserId}',
        'Event Owner',
        'event-owner',
        'A resolvable public performer profile.',
        true,
        'public',
        'gig_ready'
      ),
      (
        '${outsiderPerformerId}',
        '${outsiderUserId}',
        'Event Outsider',
        'event-outsider',
        'Another resolvable public performer profile.',
        true,
        'public',
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
