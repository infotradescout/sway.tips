import assert from 'node:assert/strict';
import {
  createPerformerEventService,
  EventServiceError,
  type CreatePerformerEventInput,
  type PerformerEventAttendanceMode
} from '../src/server/performer-event-service';
import { evaluatePublicEventPerformerEligibility } from '../src/server/public-profile';

const performerId = '11111111-1111-4111-8111-111111111111';
const actorUserId = '22222222-2222-4222-8222-222222222222';
const clientRequestId = '33333333-3333-4333-8333-333333333333';
const eventId = '44444444-4444-4444-8444-444444444444';
const createdAt = new Date('2026-07-26T12:00:00.000Z');
const updatedAt = new Date('2026-07-26T12:00:01.000Z');

const ownedPerformerRow = {
  id: performerId,
  ownerUserId: actorUserId,
  displayName: 'Event Owner',
  handle: 'event-owner',
  bio: 'A resolvable performer profile.',
  visibilityState: 'public',
  isActive: true,
  onboardingStatus: 'complete'
};

const normalizedRow = {
  id: eventId,
  performerId,
  clientRequestId,
  createdByActorUserId: actorUserId,
  lastMutationActorUserId: actorUserId,
  title: 'Summer Night',
  description: 'Doors at seven.\nMusic at eight.',
  startsAt: new Date('2030-07-28T00:00:00.000Z'),
  doorOpensAt: null,
  endsAt: null,
  timeZone: 'America/Chicago',
  locationName: 'The Listening Room',
  locationAddress: '123 Music Ave',
  city: 'Chicago',
  locationIsTba: false,
  coverImageUrl: 'https://images.example.com/summer-night.png',
  ticketingMode: 'external' as const,
  attendanceMode: 'external_ticket' as PerformerEventAttendanceMode,
  externalTicketUrl: 'https://tickets.example.com/summer-night',
  externalTicketLabel: 'Get tickets',
  visibility: 'unlisted' as const,
  status: 'draft' as const,
  publishedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  createdAt,
  updatedAt
};

const replayInput: CreatePerformerEventInput = {
  performerId,
  actorUserId,
  clientRequestId,
  title: '  Summer    Night  ',
  description: '  Doors at seven.\nMusic at eight.  ',
  startsAt: '2030-07-27T19:00:00-05:00',
  endsAt: null,
  timeZone: 'america/chicago',
  locationName: ' The   Listening   Room ',
  locationAddress: ' 123   Music   Ave ',
  city: ' Chicago ',
  locationIsTba: false,
  coverImageUrl: ' https://images.example.com/summer-night.png ',
  externalTicketUrl: ' https://tickets.example.com/summer-night ',
  externalTicketLabel: ' Get   tickets ',
  visibility: undefined
};

assert.deepEqual(evaluatePublicEventPerformerEligibility({
  audience: 'discovery',
  claimed: true,
  hasOwner: true,
  isActive: true,
  onboardingStatus: 'gig_ready',
  visibilityState: 'public',
  handle: ' tickets ',
  displayName: 'Whitespace Reserved Handle',
  bio: 'Should never be discoverable.'
}), { eligible: false, visibility: null });

function fakeReplayDb(eventRow = normalizedRow) {
  return fakeSelectOnlyDb([
    [ownedPerformerRow],
    [eventRow]
  ]);
}

function fakeSelectOnlyDb(resultsInput: unknown[][]) {
  const results = [...resultsInput];
  const tx = {
    select() {
      const result = results.shift() ?? [];
      const chain = {
        from() {
          return chain;
        },
        where() {
          return chain;
        },
        for() {
          return chain;
        },
        limit() {
          return Promise.resolve(result);
        }
      };
      return chain;
    }
  };

  return {
    transaction<T>(callback: (executor: typeof tx) => Promise<T>) {
      return callback(tx);
    }
  };
}

function noDatabaseExpected() {
  return {
    transaction() {
      throw new Error('Validation must fail before opening a transaction.');
    }
  };
}

async function expectEventError(
  changes: Partial<CreatePerformerEventInput>,
  code: string,
  status = 422
) {
  const service = createPerformerEventService(noDatabaseExpected() as never);
  await assert.rejects(
    service.createEvent({ ...replayInput, ...changes }),
    (error: unknown) => {
      assert.ok(error instanceof EventServiceError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      return true;
    }
  );
}

// The public create method exercises the private normalizer before entering a
// transaction. A matching prior row proves the normalized payload is stable
// and that a repeated clientRequestId resolves as a replay, not a second event.
{
  const service = createPerformerEventService(fakeReplayDb() as never);
  const result = await service.createEvent(replayInput);
  assert.equal(result.created, false);
  assert.equal(result.event.title, 'Summer Night');
  assert.equal(result.event.description, 'Doors at seven.\nMusic at eight.');
  assert.equal(result.event.startsAt, '2030-07-28T00:00:00.000Z');
  assert.equal(result.event.endsAt, null);
  assert.equal(result.event.timeZone, 'America/Chicago');
  assert.equal(result.event.locationName, 'The Listening Room');
  assert.equal(result.event.locationAddress, '123 Music Ave');
  assert.equal(result.event.city, 'Chicago');
  assert.equal(result.event.coverImageUrl, 'https://images.example.com/summer-night.png');
  assert.equal(result.event.externalTicketUrl, 'https://tickets.example.com/summer-night');
  assert.equal(result.event.externalTicketLabel, 'Get tickets');
  assert.equal(result.event.visibility, 'unlisted');
}

// The same idempotency key cannot silently overwrite different normalized
// event details.
{
  const service = createPerformerEventService(fakeReplayDb({
    ...normalizedRow,
    title: 'Different event'
  }) as never);
  await assert.rejects(
    service.createEvent(replayInput),
    (error: unknown) => {
      assert.ok(error instanceof EventServiceError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'event_idempotency_conflict');
      return true;
    }
  );
}

// Date-times require an explicit offset. End time is optional, but when
// supplied it must be valid and later than the start.
await expectEventError({ startsAt: '2030-07-27T19:00:00' }, 'invalid_datetime');
await expectEventError({ endsAt: '2030-07-27T21:00:00' }, 'invalid_datetime');
await expectEventError(
  {
    startsAt: '2030-07-27T19:00:00-05:00',
    endsAt: '2030-07-27T18:59:59-05:00'
  },
  'invalid_date_range'
);
await expectEventError({ timeZone: 'Not/A_Time_Zone' }, 'invalid_time_zone');
await expectEventError({ visibility: 'friends-only' as never }, 'invalid_visibility');
await expectEventError({ locationIsTba: 'yes' as never }, 'invalid_location_tba');
await expectEventError({ externalTicketUrl: null, externalTicketLabel: 'Buy now' }, 'ticket_label_without_url');
await expectEventError({ attendanceMode: 'unsupported' as never }, 'invalid_attendance_mode');
await expectEventError({ attendanceMode: ['walk_in'] as never }, 'invalid_attendance_mode');
await expectEventError({ attendanceMode: 'walk_in' }, 'walk_in_external_link_conflict');
await expectEventError({ attendanceMode: 'external_rsvp', externalTicketLabel: 'Get tickets' }, 'rsvp_label_required');
await expectEventError({ attendanceMode: 'external_ticket', externalTicketLabel: 'RSVP' }, 'ticket_label_required');
await expectEventError(
  { externalTicketLabel: 'Buy on Sway' },
  'invalid_external_ticket_label'
);

// A missing label resolves to the fixed, truthful default rather than letting
// arbitrary performer copy become a Sway-owned commerce claim.
{
  const service = createPerformerEventService(fakeReplayDb() as never);
  const result = await service.createEvent({
    ...replayInput,
    externalTicketLabel: null
  });
  assert.equal(result.created, false);
  assert.equal(result.event.externalTicketLabel, 'Get tickets');
}

// External ticket and cover-image destinations are HTTPS-only and reject
// credentials, loopback, private/link-local IPs, and local-only hostnames.
for (const unsafeUrl of [
  'http://tickets.example.com/show',
  'https://user:password@tickets.example.com/show',
  'https://localhost/show',
  'https://tickets.local/show',
  'https://tickets.internal/show',
  'https://127.0.0.1/show',
  'https://10.10.10.10/show',
  'https://169.254.1.1/show',
  'https://172.16.0.1/show',
  'https://192.168.1.1/show',
  'https://[::1]/show',
  'https://[::ffff:127.0.0.1]/show',
  'https://[::ffff:192.168.1.1]/show',
  'https://[fd00::1]/show',
  'https://[fe80::1]/show',
  'https://[ff02::1]/show'
]) {
  await expectEventError({ externalTicketUrl: unsafeUrl }, 'unsafe_url');
}
await expectEventError({ coverImageUrl: 'https://127.0.0.1/cover.png' }, 'unsafe_url');

// Walk-in is explicit intent. It persists without a ticket/RSVP URL, while an
// omitted mode keeps the legacy external-ticket interpretation.
{
  const walkInRow = {
    ...normalizedRow,
    attendanceMode: 'walk_in' as const,
    externalTicketUrl: null,
    externalTicketLabel: null
  };
  const service = createPerformerEventService(fakeReplayDb(walkInRow) as never);
  const result = await service.createEvent({
    ...replayInput,
    attendanceMode: 'walk_in',
    externalTicketUrl: null,
    externalTicketLabel: null
  });
  assert.equal(result.created, false);
  assert.equal(result.event.attendanceMode, 'walk_in');
  assert.equal(result.event.externalTicketUrl, null);
}

// Publishing is fail-closed unless the owning performer is active. A valid
// external HTTPS URL does not let an inactive account publish.
{
  const service = createPerformerEventService(fakeSelectOnlyDb([
    [{ ...ownedPerformerRow, isActive: false }]
  ]) as never);
  await assert.rejects(
    service.publishEvent({
      eventId,
      performerId,
      actorUserId,
      expectedUpdatedAt: updatedAt.toISOString()
    }),
    (error: unknown) => {
      assert.ok(error instanceof EventServiceError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 'performer_inactive');
      return true;
    }
  );
}

// An explicit external mode still cannot publish without its HTTPS ticket or
// RSVP destination. An ambiguous missing link never becomes walk-in.
{
  const eventWithoutExternalLink = {
    ...normalizedRow,
    externalTicketUrl: null,
    externalTicketLabel: null
  };
  const service = createPerformerEventService(fakeSelectOnlyDb([
    [ownedPerformerRow],
    [eventWithoutExternalLink]
  ]) as never);
  await assert.rejects(
    service.publishEvent({
      eventId,
      performerId,
      actorUserId,
      expectedUpdatedAt: updatedAt.toISOString()
    }),
    (error: unknown) => {
      assert.ok(error instanceof EventServiceError);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'external_ticket_url_required');
      return true;
    }
  );
}

// A walk-in draft may omit ticket/RSVP data, but publishing still requires a
// venue visitors can act on.
{
  const incompleteWalkIn = {
    ...normalizedRow,
    attendanceMode: 'walk_in' as const,
    externalTicketUrl: null,
    externalTicketLabel: null,
    locationName: null,
    locationAddress: null,
    city: null,
    locationIsTba: true
  };
  const service = createPerformerEventService(fakeSelectOnlyDb([
    [ownedPerformerRow],
    [incompleteWalkIn]
  ]) as never);
  await assert.rejects(
    service.publishEvent({
      eventId,
      performerId,
      actorUserId,
      expectedUpdatedAt: updatedAt.toISOString()
    }),
    (error: unknown) => {
      assert.ok(error instanceof EventServiceError);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'walk_in_location_required');
      return true;
    }
  );
}

// A lost response can be retried safely: once the requested state is already
// durable, publish and same-reason cancellation replay the current event
// instead of creating duplicate audit/state transitions.
{
  const publishedAt = new Date('2026-07-26T12:05:00.000Z');
  const publishedEvent = {
    ...normalizedRow,
    status: 'published' as const,
    publishedAt,
    updatedAt: publishedAt
  };
  const service = createPerformerEventService(fakeSelectOnlyDb([
    [ownedPerformerRow],
    [publishedEvent]
  ]) as never);
  const result = await service.publishEvent({
    eventId,
    performerId,
    actorUserId,
    expectedUpdatedAt: updatedAt.toISOString()
  });
  assert.equal(result.status, 'published');
  assert.equal(result.updatedAt, publishedAt.toISOString());
}

{
  const cancelledAt = new Date('2026-07-26T12:06:00.000Z');
  const cancelledEvent = {
    ...normalizedRow,
    status: 'cancelled' as const,
    publishedAt: new Date('2026-07-26T12:05:00.000Z'),
    cancelledAt,
    cancellationReason: 'Weather closure',
    updatedAt: cancelledAt
  };
  const service = createPerformerEventService(fakeSelectOnlyDb([
    [ownedPerformerRow],
    [cancelledEvent]
  ]) as never);
  const result = await service.cancelEvent({
    eventId,
    performerId,
    actorUserId,
    expectedUpdatedAt: updatedAt.toISOString(),
    cancellationReason: ' Weather   closure '
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancellationReason, 'Weather closure');
}

// A completed event remains a truthful historical record. For events without
// an end time, the start time closes the cancellation window.
for (const endedEvent of [
  {
    ...normalizedRow,
    status: 'published' as const,
    startsAt: new Date('2020-07-28T00:00:00.000Z'),
    endsAt: new Date('2020-07-28T03:00:00.000Z'),
    publishedAt: new Date('2020-07-27T00:00:00.000Z')
  },
  {
    ...normalizedRow,
    status: 'published' as const,
    startsAt: new Date('2020-07-28T00:00:00.000Z'),
    endsAt: null,
    publishedAt: new Date('2020-07-27T00:00:00.000Z')
  }
]) {
  const service = createPerformerEventService(fakeSelectOnlyDb([
    [ownedPerformerRow],
    [endedEvent]
  ]) as never);
  await assert.rejects(
    service.cancelEvent({
      eventId,
      performerId,
      actorUserId,
      expectedUpdatedAt: updatedAt.toISOString(),
      cancellationReason: 'Too late'
    }),
    (error: unknown) => {
      assert.ok(error instanceof EventServiceError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'event_already_ended');
      return true;
    }
  );
}

console.log('Public event listings behavior tests passed.');
