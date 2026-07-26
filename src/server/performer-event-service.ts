import { isIP } from 'node:net';
import { and, asc, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  auditEvents,
  performerEvents,
  performerPublicProfiles,
  performers
} from '../db/schema';

export type PerformerEventStatus = 'draft' | 'published' | 'cancelled';
export type PerformerEventVisibility = 'public' | 'unlisted';
export type PerformerEventTicketingMode = 'external' | 'native_ga';
export const PUBLIC_EVENT_EXTERNAL_TICKET_LABELS = [
  'Get tickets',
  'RSVP',
  'View details'
] as const;
export type PublicEventExternalTicketLabel = typeof PUBLIC_EVENT_EXTERNAL_TICKET_LABELS[number];

export type PerformerEventDto = {
  id: string;
  performerId: string;
  clientRequestId: string;
  title: string;
  description: string | null;
  startsAt: string;
  doorOpensAt: string | null;
  endsAt: string | null;
  timeZone: string;
  locationName: string | null;
  locationAddress: string | null;
  city: string | null;
  locationIsTba: boolean;
  coverImageUrl: string | null;
  ticketingMode: PerformerEventTicketingMode;
  externalTicketUrl: string | null;
  externalTicketLabel: string | null;
  visibility: PerformerEventVisibility;
  status: PerformerEventStatus;
  publishedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicEventPerformerDto = {
  displayName: string;
  handle: string | null;
  headline: string | null;
  city: string | null;
  avatarUrl: string | null;
};

export type PublicPerformerEventDto = {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  doorOpensAt: string | null;
  endsAt: string | null;
  timeZone: string;
  locationName: string | null;
  locationAddress: string | null;
  city: string | null;
  locationIsTba: boolean;
  coverImageUrl: string | null;
  ticketingMode: PerformerEventTicketingMode;
  externalTicketUrl: string | null;
  externalTicketLabel: string | null;
  visibility: PerformerEventVisibility;
  status: 'published' | 'cancelled';
  publishedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  performer: PublicEventPerformerDto;
  createdAt: string;
  updatedAt: string;
};

export type CreatePerformerEventInput = {
  performerId: string;
  actorUserId: string;
  clientRequestId: string;
  title: string;
  description?: string | null;
  startsAt: string;
  doorOpensAt?: string | null;
  endsAt?: string | null;
  timeZone: string;
  locationName?: string | null;
  locationAddress?: string | null;
  city?: string | null;
  locationIsTba?: boolean;
  coverImageUrl?: string | null;
  ticketingMode?: PerformerEventTicketingMode;
  externalTicketUrl?: string | null;
  externalTicketLabel?: string | null;
  visibility?: PerformerEventVisibility;
};

export type UpdatePerformerEventInput = {
  eventId: string;
  performerId: string;
  actorUserId: string;
  expectedUpdatedAt: string;
  title?: string;
  description?: string | null;
  startsAt?: string;
  doorOpensAt?: string | null;
  endsAt?: string | null;
  timeZone?: string;
  locationName?: string | null;
  locationAddress?: string | null;
  city?: string | null;
  locationIsTba?: boolean;
  coverImageUrl?: string | null;
  externalTicketUrl?: string | null;
  externalTicketLabel?: string | null;
  visibility?: PerformerEventVisibility;
};

export type PublishPerformerEventInput = {
  eventId: string;
  performerId: string;
  actorUserId: string;
  expectedUpdatedAt: string;
};

export type CancelPerformerEventInput = PublishPerformerEventInput & {
  cancellationReason: string;
};

export class EventServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'EventServiceError';
    this.status = status;
    this.code = code;
  }
}

type EventRow = typeof performerEvents.$inferSelect;
type DbExecutor = SwayDb | any;

type PublicEventRow = {
  event: EventRow;
  performerDisplayName: string;
  performerHandle: string | null;
  performerHeadline: string | null;
  performerCity: string | null;
  performerAvatarUrl: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENT_TITLE_LENGTH = 160;
const MAX_EVENT_DESCRIPTION_LENGTH = 4_000;
const MAX_TIME_ZONE_LENGTH = 100;
const MAX_LOCATION_NAME_LENGTH = 160;
const MAX_LOCATION_ADDRESS_LENGTH = 500;
const MAX_CITY_LENGTH = 120;
const MAX_EXTERNAL_URL_LENGTH = 2_048;
const MAX_CANCELLATION_REASON_LENGTH = 500;

function serviceError(status: number, code: string, message: string): never {
  throw new EventServiceError(status, code, message);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    serviceError(422, 'invalid_uuid', `${label} must be a UUID.`);
  }
}

function normalizeRequiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    serviceError(422, 'invalid_text', `${label} is required.`);
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    serviceError(422, 'invalid_text', `${label} is required.`);
  }
  if (normalized.length > maxLength) {
    serviceError(422, 'text_too_long', `${label} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    serviceError(422, 'invalid_text', `${label} must be text.`);
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    serviceError(422, 'text_too_long', `${label} must be ${maxLength} characters or fewer.`);
  }
  return normalized;
}

function normalizeDescription(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    serviceError(422, 'invalid_description', 'Description must be text.');
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > MAX_EVENT_DESCRIPTION_LENGTH) {
    serviceError(
      422,
      'description_too_long',
      `Description must be ${MAX_EVENT_DESCRIPTION_LENGTH} characters or fewer.`
    );
  }
  return normalized;
}

function parseDateTime(value: unknown, label: string): Date {
  if (
    typeof value !== 'string'
    || !/[Tt].*(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value.trim())
  ) {
    serviceError(422, 'invalid_datetime', `${label} must be an ISO-8601 date-time with a UTC offset.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    serviceError(422, 'invalid_datetime', `${label} is invalid.`);
  }
  return parsed;
}

function normalizeTimeZone(value: unknown): string {
  const timeZone = normalizeRequiredText(value, 'Time zone', MAX_TIME_ZONE_LENGTH);
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    serviceError(422, 'invalid_time_zone', 'Time zone must be a valid IANA time zone.');
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = parts;
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
}

function mappedIpv4FromIpv6(hostname: string): string | null {
  const dottedMatch = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dottedMatch) return dottedMatch[1];

  const hexadecimalMatch = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexadecimalMatch) return null;
  const high = Number.parseInt(hexadecimalMatch[1], 16);
  const low = Number.parseInt(hexadecimalMatch[2], 16);
  return [
    high >>> 8,
    high & 0xff,
    low >>> 8,
    low & 0xff
  ].join('.');
}

function isUnsafeHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
  ) {
    return true;
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4(hostname);
  if (ipVersion === 6) {
    const mappedIpv4 = mappedIpv4FromIpv6(hostname);
    if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
    return hostname === '::'
      || hostname === '::1'
      || hostname.startsWith('fc')
      || hostname.startsWith('fd')
      || hostname.startsWith('fe8')
      || hostname.startsWith('fe9')
      || hostname.startsWith('fea')
      || hostname.startsWith('feb')
      || hostname.startsWith('ff');
  }
  return false;
}

function normalizeSafeHttpsUrl(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    serviceError(422, 'invalid_url', `${label} must be a URL.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_EXTERNAL_URL_LENGTH) {
    serviceError(422, 'invalid_url', `${label} must be ${MAX_EXTERNAL_URL_LENGTH} characters or fewer.`);
  }

  try {
    const parsed = new URL(normalized);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || isUnsafeHostname(parsed.hostname)
    ) {
      serviceError(422, 'unsafe_url', `${label} must be a safe public HTTPS URL.`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof EventServiceError) throw error;
    serviceError(422, 'invalid_url', `${label} must be a valid HTTPS URL.`);
  }
}

export function normalizePublicEventHttpsUrl(value: unknown, label = 'External URL') {
  return normalizeSafeHttpsUrl(value, label);
}

export function isPublicEventExternalTicketLabel(
  value: unknown
): value is PublicEventExternalTicketLabel {
  return typeof value === 'string'
    && PUBLIC_EVENT_EXTERNAL_TICKET_LABELS.some((label) => label === value);
}

function normalizeVisibility(value: unknown): PerformerEventVisibility {
  if (value === undefined || value === null || value === '') return 'unlisted';
  if (value === 'public' || value === 'unlisted') return value;
  return serviceError(422, 'invalid_visibility', 'Visibility must be public or unlisted.');
}

function normalizeTicketingMode(value: unknown): PerformerEventTicketingMode {
  if (value === undefined || value === null || value === '') return 'external';
  if (value === 'external' || value === 'native_ga') return value;
  return serviceError(
    422,
    'invalid_ticketing_mode',
    'Ticketing mode must be external or native_ga.'
  );
}

function normalizeLocationIsTba(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    serviceError(422, 'invalid_location_tba', 'locationIsTba must be true or false.');
  }
  return value;
}

function parseOptionalDateTime(value: unknown, label: string): Date | null {
  if (value === null || value === undefined || value === '') return null;
  return parseDateTime(value, label);
}

function assertDateOrder(startsAt: Date, endsAt: Date | null) {
  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    serviceError(422, 'invalid_date_range', 'Event end time must be after its start time.');
  }
}

function normalizeEventValues(input: {
  title: unknown;
  description: unknown;
  startsAt: unknown;
  doorOpensAt: unknown;
  endsAt: unknown;
  timeZone: unknown;
  locationName: unknown;
  locationAddress: unknown;
  city: unknown;
  locationIsTba: unknown;
  coverImageUrl: unknown;
  ticketingMode: unknown;
  externalTicketUrl: unknown;
  externalTicketLabel: unknown;
  visibility: unknown;
}) {
  const startsAt = parseDateTime(input.startsAt, 'Event start time');
  const doorOpensAt = parseOptionalDateTime(input.doorOpensAt, 'Door-open time');
  const endsAt = parseOptionalDateTime(input.endsAt, 'Event end time');
  assertDateOrder(startsAt, endsAt);
  const ticketingMode = normalizeTicketingMode(input.ticketingMode);
  if (ticketingMode === 'native_ga' && !doorOpensAt) {
    serviceError(
      422,
      'native_ticket_door_time_required',
      'A native ticket event requires a separate door-open time.'
    );
  }
  if (doorOpensAt && doorOpensAt.getTime() > startsAt.getTime()) {
    serviceError(
      422,
      'event_door_after_start',
      'Door-open time must be at or before the event start time.'
    );
  }
  if (ticketingMode === 'external' && doorOpensAt) {
    serviceError(
      422,
      'external_event_door_time_not_supported',
      'Door-open time is currently reserved for native Sway ticket events.'
    );
  }
  if (ticketingMode === 'native_ga' && !endsAt) {
    serviceError(
      422,
      'native_ticket_event_end_required',
      'A native ticket event requires an end time for automatic refund settlement.'
    );
  }

  const externalTicketUrl = normalizeSafeHttpsUrl(input.externalTicketUrl, 'External ticket URL');
  if (ticketingMode === 'native_ga' && externalTicketUrl) {
    serviceError(
      422,
      'native_ticket_external_url_conflict',
      'A native Sway ticket event cannot also use an external ticket URL.'
    );
  }
  const requestedExternalTicketLabel = normalizeOptionalText(
    input.externalTicketLabel,
    'External ticket label',
    80
  );
  if (requestedExternalTicketLabel && !externalTicketUrl) {
    serviceError(422, 'ticket_label_without_url', 'An external ticket label requires an external ticket URL.');
  }
  const externalTicketLabel = externalTicketUrl
    ? requestedExternalTicketLabel || PUBLIC_EVENT_EXTERNAL_TICKET_LABELS[0]
    : null;
  if (externalTicketLabel && !isPublicEventExternalTicketLabel(externalTicketLabel)) {
    serviceError(
      422,
      'invalid_external_ticket_label',
      `External ticket label must be one of: ${PUBLIC_EVENT_EXTERNAL_TICKET_LABELS.join(', ')}.`
    );
  }

  return {
    title: normalizeRequiredText(input.title, 'Event title', MAX_EVENT_TITLE_LENGTH),
    description: normalizeDescription(input.description),
    startsAt,
    doorOpensAt,
    endsAt,
    timeZone: normalizeTimeZone(input.timeZone),
    locationName: normalizeOptionalText(input.locationName, 'Location name', MAX_LOCATION_NAME_LENGTH),
    locationAddress: normalizeOptionalText(input.locationAddress, 'Location address', MAX_LOCATION_ADDRESS_LENGTH),
    city: normalizeOptionalText(input.city, 'City', MAX_CITY_LENGTH),
    locationIsTba: normalizeLocationIsTba(input.locationIsTba),
    coverImageUrl: normalizeSafeHttpsUrl(input.coverImageUrl, 'Cover image URL'),
    ticketingMode,
    externalTicketUrl,
    externalTicketLabel: externalTicketUrl ? externalTicketLabel : null,
    visibility: normalizeVisibility(input.visibility)
  };
}

function parseExpectedUpdatedAt(value: unknown): Date {
  return parseDateTime(value, 'expectedUpdatedAt');
}

function assertExpectedUpdatedAt(current: Date, expected: Date) {
  if (current.toISOString() !== expected.toISOString()) {
    serviceError(409, 'event_version_conflict', 'Event changed in another session. Reload before saving.');
  }
}

async function requireOwnedPerformer(executor: DbExecutor, performerId: string, actorUserId: string) {
  assertUuid(performerId, 'performerId');
  assertUuid(actorUserId, 'actorUserId');
  const [performer] = await executor
    .select({
      id: performers.id,
      isActive: performers.isActive,
      onboardingStatus: performers.onboardingStatus
    })
    .from(performers)
    .where(and(
      eq(performers.id, performerId),
      eq(performers.ownerUserId, actorUserId)
    ))
    .limit(1);
  if (!performer) {
    serviceError(403, 'performer_owner_required', 'Only the performer owner can manage these events.');
  }
  return performer;
}

async function loadOwnedEvent(executor: DbExecutor, eventId: string, performerId: string): Promise<EventRow> {
  assertUuid(eventId, 'eventId');
  const [event] = await executor
    .select()
    .from(performerEvents)
    .where(and(
      eq(performerEvents.id, eventId),
      eq(performerEvents.performerId, performerId)
    ))
    .limit(1);
  if (!event) {
    serviceError(404, 'event_not_found', 'Event not found.');
  }
  return event;
}

function sameIdempotentCreate(event: EventRow, normalized: ReturnType<typeof normalizeEventValues>) {
  return event.title === normalized.title
    && event.description === normalized.description
    && event.startsAt.getTime() === normalized.startsAt.getTime()
    && (event.doorOpensAt?.getTime() ?? null) === (normalized.doorOpensAt?.getTime() ?? null)
    && (event.endsAt?.getTime() ?? null) === (normalized.endsAt?.getTime() ?? null)
    && event.timeZone === normalized.timeZone
    && event.locationName === normalized.locationName
    && event.locationAddress === normalized.locationAddress
    && event.city === normalized.city
    && event.locationIsTba === normalized.locationIsTba
    && event.coverImageUrl === normalized.coverImageUrl
    && (event.ticketingMode ?? 'external') === normalized.ticketingMode
    && event.externalTicketUrl === normalized.externalTicketUrl
    && event.externalTicketLabel === normalized.externalTicketLabel
    && event.visibility === normalized.visibility;
}

export function serializePerformerEvent(event: EventRow): PerformerEventDto {
  return {
    id: event.id,
    performerId: event.performerId,
    clientRequestId: event.clientRequestId,
    title: event.title,
    description: event.description,
    startsAt: event.startsAt.toISOString(),
    doorOpensAt: event.doorOpensAt?.toISOString() ?? null,
    endsAt: event.endsAt?.toISOString() ?? null,
    timeZone: event.timeZone,
    locationName: event.locationName,
    locationAddress: event.locationAddress,
    city: event.city,
    locationIsTba: event.locationIsTba,
    coverImageUrl: event.coverImageUrl,
    ticketingMode: event.ticketingMode ?? 'external',
    externalTicketUrl: event.externalTicketUrl,
    externalTicketLabel: event.externalTicketLabel,
    visibility: event.visibility,
    status: event.status,
    publishedAt: event.publishedAt?.toISOString() ?? null,
    cancelledAt: event.cancelledAt?.toISOString() ?? null,
    cancellationReason: event.cancellationReason,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString()
  };
}

function serializePublicEvent(row: PublicEventRow): PublicPerformerEventDto {
  const cancelled = row.event.status === 'cancelled';
  return {
    id: row.event.id,
    title: row.event.title,
    description: row.event.description,
    startsAt: row.event.startsAt.toISOString(),
    doorOpensAt: row.event.doorOpensAt?.toISOString() ?? null,
    endsAt: row.event.endsAt?.toISOString() ?? null,
    timeZone: row.event.timeZone,
    locationName: row.event.locationIsTba ? null : row.event.locationName,
    locationAddress: row.event.locationIsTba ? null : row.event.locationAddress,
    city: row.event.locationIsTba ? null : row.event.city,
    locationIsTba: row.event.locationIsTba,
    coverImageUrl: row.event.coverImageUrl,
    ticketingMode: row.event.ticketingMode ?? 'external',
    externalTicketUrl: cancelled ? null : row.event.externalTicketUrl,
    externalTicketLabel: cancelled ? null : row.event.externalTicketLabel,
    visibility: row.event.visibility,
    status: cancelled ? 'cancelled' : 'published',
    publishedAt: row.event.publishedAt?.toISOString() ?? null,
    cancelledAt: row.event.cancelledAt?.toISOString() ?? null,
    cancellationReason: row.event.cancellationReason,
    performer: {
      displayName: row.performerDisplayName,
      handle: row.performerHandle,
      headline: row.performerHeadline,
      city: row.performerCity,
      avatarUrl: row.performerAvatarUrl
    },
    createdAt: row.event.createdAt.toISOString(),
    updatedAt: row.event.updatedAt.toISOString()
  };
}

function publicEventSelection() {
  return {
    event: performerEvents,
    performerDisplayName: performers.displayName,
    performerHandle: performers.handle,
    performerHeadline: performerPublicProfiles.headline,
    performerCity: performerPublicProfiles.city,
    performerAvatarUrl: performerPublicProfiles.avatarUrl
  };
}

export function createPerformerEventService(db: SwayDb) {
  async function listOwnedEvents(input: {
    performerId: string;
    actorUserId: string;
    limit?: number;
  }): Promise<PerformerEventDto[]> {
    await requireOwnedPerformer(db, input.performerId, input.actorUserId);
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit) || 50)));
    const events = await db
      .select()
      .from(performerEvents)
      .where(eq(performerEvents.performerId, input.performerId))
      .orderBy(
        asc(sql`case when ${performerEvents.startsAt} >= now() then 0 else 1 end`),
        asc(sql`case when ${performerEvents.startsAt} >= now() then ${performerEvents.startsAt} end`),
        desc(sql`case when ${performerEvents.startsAt} < now() then ${performerEvents.startsAt} end`),
        desc(performerEvents.createdAt)
      )
      .limit(limit);
    return events.map(serializePerformerEvent);
  }

  async function createEvent(input: CreatePerformerEventInput): Promise<{
    event: PerformerEventDto;
    created: boolean;
  }> {
    assertUuid(input.clientRequestId, 'clientRequestId');
    const normalized = normalizeEventValues({
      ...input,
      description: input.description,
      doorOpensAt: input.doorOpensAt,
      endsAt: input.endsAt,
      locationName: input.locationName,
      locationAddress: input.locationAddress,
      city: input.city,
      locationIsTba: input.locationIsTba,
      coverImageUrl: input.coverImageUrl,
      ticketingMode: input.ticketingMode,
      externalTicketUrl: input.externalTicketUrl,
      externalTicketLabel: input.externalTicketLabel,
      visibility: input.visibility
    });

    return db.transaction(async (tx) => {
      await requireOwnedPerformer(tx, input.performerId, input.actorUserId);
      const [existing] = await tx
        .select()
        .from(performerEvents)
        .where(and(
          eq(performerEvents.performerId, input.performerId),
          eq(performerEvents.clientRequestId, input.clientRequestId)
        ))
        .limit(1);

      if (existing) {
        if (!sameIdempotentCreate(existing, normalized)) {
          serviceError(
            409,
            'event_idempotency_conflict',
            'clientRequestId was already used for different event details.'
          );
        }
        return { event: serializePerformerEvent(existing), created: false };
      }

      // Persist JS-millisecond timestamps explicitly. node-postgres returns
      // timestamps at millisecond precision, so relying on Postgres now()
      // microseconds would make the first optimistic updatedAt equality miss.
      const now = new Date();
      const [created] = await tx
        .insert(performerEvents)
        .values({
          performerId: input.performerId,
          clientRequestId: input.clientRequestId,
          createdByActorUserId: input.actorUserId,
          lastMutationActorUserId: input.actorUserId,
          createdAt: now,
          updatedAt: now,
          ...normalized
        })
        .onConflictDoNothing()
        .returning();

      if (!created) {
        const [concurrentExisting] = await tx
          .select()
          .from(performerEvents)
          .where(and(
            eq(performerEvents.performerId, input.performerId),
            eq(performerEvents.clientRequestId, input.clientRequestId)
          ))
          .limit(1);
        if (!concurrentExisting || !sameIdempotentCreate(concurrentExisting, normalized)) {
          serviceError(
            409,
            'event_idempotency_conflict',
            'clientRequestId was already used for different event details.'
          );
        }
        return { event: serializePerformerEvent(concurrentExisting), created: false };
      }

      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'performer_event',
        entityId: created.id,
        eventType: 'performer_event.create',
        previousStatus: null,
        nextStatus: 'draft',
        metadata: {
          performerId: input.performerId,
          clientRequestId: input.clientRequestId,
          visibility: created.visibility
        }
      });

      return { event: serializePerformerEvent(created), created: true };
    });
  }

  async function updateEvent(input: UpdatePerformerEventInput): Promise<PerformerEventDto> {
    const expectedUpdatedAt = parseExpectedUpdatedAt(input.expectedUpdatedAt);
    const mutableKeys: Array<keyof UpdatePerformerEventInput> = [
      'title',
      'description',
      'startsAt',
      'doorOpensAt',
      'endsAt',
      'timeZone',
      'locationName',
      'locationAddress',
      'city',
      'locationIsTba',
      'coverImageUrl',
      'externalTicketUrl',
      'externalTicketLabel',
      'visibility'
    ];
    const changedFields = mutableKeys.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
    if (!changedFields.length) {
      serviceError(422, 'event_update_empty', 'At least one event field must be supplied.');
    }

    return db.transaction(async (tx) => {
      await requireOwnedPerformer(tx, input.performerId, input.actorUserId);
      const current = await loadOwnedEvent(tx, input.eventId, input.performerId);
      if (current.status === 'cancelled') {
        serviceError(409, 'event_cancelled', 'A cancelled event cannot be edited.');
      }
      if (
        current.status === 'published'
        && (current.ticketingMode ?? 'external') === 'native_ga'
      ) {
        serviceError(
          409,
          'published_native_ticket_event_locked',
          'Published native ticket event details are sealed to preserve the sale, admission, and refund terms accepted by buyers.'
        );
      }
      if (
        current.status === 'published'
        && (current.endsAt ?? current.startsAt).getTime() <= Date.now()
      ) {
        serviceError(409, 'event_already_ended', 'A completed published event cannot be edited.');
      }
      assertExpectedUpdatedAt(current.updatedAt, expectedUpdatedAt);

      const normalized = normalizeEventValues({
        title: input.title ?? current.title,
        description: input.description !== undefined ? input.description : current.description,
        startsAt: input.startsAt ?? current.startsAt.toISOString(),
        doorOpensAt: input.doorOpensAt !== undefined
          ? input.doorOpensAt
          : current.doorOpensAt?.toISOString() ?? null,
        endsAt: input.endsAt !== undefined
          ? input.endsAt
          : current.endsAt?.toISOString() ?? null,
        timeZone: input.timeZone ?? current.timeZone,
        locationName: input.locationName !== undefined ? input.locationName : current.locationName,
        locationAddress: input.locationAddress !== undefined ? input.locationAddress : current.locationAddress,
        city: input.city !== undefined ? input.city : current.city,
        locationIsTba: input.locationIsTba ?? current.locationIsTba,
        coverImageUrl: input.coverImageUrl !== undefined ? input.coverImageUrl : current.coverImageUrl,
        ticketingMode: current.ticketingMode ?? 'external',
        externalTicketUrl: input.externalTicketUrl !== undefined
          ? input.externalTicketUrl
          : current.externalTicketUrl,
        externalTicketLabel: input.externalTicketLabel !== undefined
          ? input.externalTicketLabel
          : current.externalTicketLabel,
        visibility: input.visibility ?? current.visibility
      });
      if (
        current.status === 'published'
        && (current.ticketingMode ?? 'external') === 'external'
        && !normalized.externalTicketUrl
      ) {
        serviceError(
          422,
          'external_ticket_url_required',
          'A published event must keep a public HTTPS ticket or RSVP link.'
        );
      }
      if (
        current.status === 'published'
        && (normalized.endsAt ?? normalized.startsAt).getTime() <= Date.now()
      ) {
        serviceError(
          422,
          'published_event_must_remain_active',
          'A published event update must keep its end time, or its start when no end is set, in the future.'
        );
      }
      const now = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
      const [updated] = await tx
        .update(performerEvents)
        .set({
          ...normalized,
          lastMutationActorUserId: input.actorUserId,
          updatedAt: now
        })
        .where(and(
          eq(performerEvents.id, current.id),
          eq(performerEvents.performerId, input.performerId),
          eq(performerEvents.updatedAt, current.updatedAt)
        ))
        .returning();
      if (!updated) {
        serviceError(409, 'event_version_conflict', 'Event changed in another session. Reload before saving.');
      }

      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'performer_event',
        entityId: current.id,
        eventType: 'performer_event.update',
        previousStatus: current.status,
        nextStatus: current.status,
        metadata: {
          performerId: input.performerId,
          expectedUpdatedAt: expectedUpdatedAt.toISOString(),
          changedFields
        }
      });

      return serializePerformerEvent(updated);
    });
  }

  async function publishEvent(input: PublishPerformerEventInput): Promise<PerformerEventDto> {
    const expectedUpdatedAt = parseExpectedUpdatedAt(input.expectedUpdatedAt);
    return db.transaction(async (tx) => {
      const performer = await requireOwnedPerformer(tx, input.performerId, input.actorUserId);
      if (performer.onboardingStatus === 'suspended') {
        serviceError(403, 'performer_suspended', 'A suspended performer cannot publish events.');
      }
      if (!performer.isActive) {
        serviceError(403, 'performer_inactive', 'Activate the performer profile before publishing events.');
      }
      const current = await loadOwnedEvent(tx, input.eventId, input.performerId);
      if (current.status === 'published') return serializePerformerEvent(current);
      if (current.status === 'cancelled') {
        serviceError(409, 'event_cancelled', 'A cancelled event cannot be published.');
      }
      if ((current.ticketingMode ?? 'external') === 'native_ga') {
        serviceError(
          409,
          'native_ticket_publish_requires_ticket_service',
          'Native ticket events must be published through the ticket ledger service.'
        );
      }
      assertExpectedUpdatedAt(current.updatedAt, expectedUpdatedAt);

      const now = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
      if (current.startsAt.getTime() <= now.getTime()) {
        serviceError(422, 'event_start_not_future', 'Only a future event can be published.');
      }
      if (!current.externalTicketUrl) {
        serviceError(422, 'external_ticket_url_required', 'Add a public HTTPS ticket or RSVP link before publishing.');
      }
      const [published] = await tx
        .update(performerEvents)
        .set({
          status: 'published',
          publishedAt: now,
          lastMutationActorUserId: input.actorUserId,
          updatedAt: now
        })
        .where(and(
          eq(performerEvents.id, current.id),
          eq(performerEvents.performerId, input.performerId),
          eq(performerEvents.status, 'draft'),
          eq(performerEvents.updatedAt, current.updatedAt)
        ))
        .returning();
      if (!published) {
        serviceError(409, 'event_version_conflict', 'Event changed in another session. Reload before publishing.');
      }

      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'performer_event',
        entityId: current.id,
        eventType: 'performer_event.publish',
        previousStatus: 'draft',
        nextStatus: 'published',
        metadata: {
          performerId: input.performerId,
          expectedUpdatedAt: expectedUpdatedAt.toISOString(),
          visibility: published.visibility
        }
      });
      return serializePerformerEvent(published);
    });
  }

  async function cancelEvent(input: CancelPerformerEventInput): Promise<PerformerEventDto> {
    const expectedUpdatedAt = parseExpectedUpdatedAt(input.expectedUpdatedAt);
    const cancellationReason = normalizeRequiredText(
      input.cancellationReason,
      'Cancellation reason',
      MAX_CANCELLATION_REASON_LENGTH
    );
    return db.transaction(async (tx) => {
      await requireOwnedPerformer(tx, input.performerId, input.actorUserId);
      const current = await loadOwnedEvent(tx, input.eventId, input.performerId);
      if (current.status === 'cancelled') {
        if (current.cancellationReason === cancellationReason) return serializePerformerEvent(current);
        serviceError(409, 'event_already_cancelled', 'This event was already cancelled with a different reason.');
      }
      if (current.status !== 'published') {
        serviceError(409, 'event_not_published', 'Only a published event can be cancelled.');
      }
      if ((current.ticketingMode ?? 'external') === 'native_ga') {
        serviceError(
          409,
          'native_ticket_cancel_requires_ticket_service',
          'Native ticket events must be cancelled through the ticket ledger service.'
        );
      }
      const cancellationDeadline = current.endsAt ?? current.startsAt;
      if (cancellationDeadline.getTime() <= Date.now()) {
        serviceError(
          409,
          'event_already_ended',
          current.endsAt
            ? 'A completed event cannot be rewritten as cancelled.'
            : 'An event without an end time cannot be cancelled after it starts.'
        );
      }
      assertExpectedUpdatedAt(current.updatedAt, expectedUpdatedAt);

      const now = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
      const [cancelled] = await tx
        .update(performerEvents)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          cancellationReason,
          lastMutationActorUserId: input.actorUserId,
          updatedAt: now
        })
        .where(and(
          eq(performerEvents.id, current.id),
          eq(performerEvents.performerId, input.performerId),
          eq(performerEvents.status, 'published'),
          eq(performerEvents.updatedAt, current.updatedAt)
        ))
        .returning();
      if (!cancelled) {
        serviceError(409, 'event_version_conflict', 'Event changed in another session. Reload before cancelling.');
      }

      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'performer_event',
        entityId: current.id,
        eventType: 'performer_event.cancel',
        previousStatus: 'published',
        nextStatus: 'cancelled',
        metadata: {
          performerId: input.performerId,
          expectedUpdatedAt: expectedUpdatedAt.toISOString(),
          cancellationReason
        }
      });
      return serializePerformerEvent(cancelled);
    });
  }

  async function getPublicEvent(eventId: string): Promise<PublicPerformerEventDto | null> {
    assertUuid(eventId, 'eventId');
    const [row] = await db
      .select(publicEventSelection())
      .from(performerEvents)
      .innerJoin(performers, eq(performers.id, performerEvents.performerId))
      .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
      .where(and(
        eq(performerEvents.id, eventId),
        inArray(performerEvents.status, ['published', 'cancelled']),
        eq(performers.isActive, true),
        notInArray(performers.onboardingStatus, ['suspended'])
      ))
      .limit(1);
    return row ? serializePublicEvent(row as PublicEventRow) : null;
  }

  async function listPublicEvents(input: {
    performerId?: string;
    limit?: number;
    now?: string | Date;
  } = {}): Promise<PublicPerformerEventDto[]> {
    if (input.performerId !== undefined) assertUuid(input.performerId, 'performerId');
    const now = input.now instanceof Date
      ? input.now
      : input.now
        ? parseDateTime(input.now, 'now')
        : new Date();
    if (Number.isNaN(now.getTime())) {
      serviceError(422, 'invalid_datetime', 'now is invalid.');
    }
    const limit = Math.max(1, Math.min(30, Math.trunc(Number(input.limit) || 12)));
    const publicConditions = and(
      eq(performerEvents.status, 'published'),
      eq(performerEvents.visibility, 'public'),
      gt(performerEvents.startsAt, now),
      eq(performers.isActive, true),
      notInArray(performers.onboardingStatus, ['suspended'])
    );
    const rows = await db
      .select(publicEventSelection())
      .from(performerEvents)
      .innerJoin(performers, eq(performers.id, performerEvents.performerId))
      .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
      .where(input.performerId
        ? and(publicConditions, eq(performerEvents.performerId, input.performerId))
        : publicConditions)
      .orderBy(asc(performerEvents.startsAt), asc(performerEvents.id))
      .limit(limit);
    return rows.map((row) => serializePublicEvent(row as PublicEventRow));
  }

  async function getOwnedEvent(input: {
    eventId: string;
    performerId: string;
    actorUserId: string;
  }): Promise<PerformerEventDto> {
    await requireOwnedPerformer(db, input.performerId, input.actorUserId);
    return serializePerformerEvent(await loadOwnedEvent(db, input.eventId, input.performerId));
  }

  return {
    listOwnedEvents,
    getOwnedEvent,
    createEvent,
    updateEvent,
    publishEvent,
    cancelEvent,
    getPublicEvent,
    listPublicEvents
  };
}

export type PerformerEventService = ReturnType<typeof createPerformerEventService>;
