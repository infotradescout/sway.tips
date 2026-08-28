import { isIP } from 'node:net';
import { and, asc, desc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  auditEvents,
  performerEvents,
  performerPublicProfiles,
  performers
} from '../db/schema';
import {
  evaluatePublicEventPerformerEligibility,
  INTERNAL_TEST_PROFILE_HANDLES
} from './public-profile';

export type PerformerEventStatus = 'draft' | 'published' | 'cancelled';
export type PerformerEventVisibility = 'public' | 'unlisted';
export type PerformerEventTicketingMode = 'external' | 'native_ga';
export type PerformerEventAttendanceMode =
  | 'walk_in'
  | 'external_rsvp'
  | 'external_ticket'
  | 'native_ticket';
export type PerformerEventPublicationReach = 'discover' | 'link_only';
export type PerformerEventPublicationCapability = {
  canPublish: boolean;
  reach: PerformerEventPublicationReach | null;
  reasonCode: string | null;
  message: string | null;
};
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
  attendanceMode: PerformerEventAttendanceMode;
  externalTicketUrl: string | null;
  externalTicketLabel: string | null;
  visibility: PerformerEventVisibility;
  status: PerformerEventStatus;
  publishedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  publicationReach?: PerformerEventPublicationReach;
  createdAt: string;
  updatedAt: string;
};

export type PublicEventPerformerDto = {
  displayName: string;
  handle: string | null;
  headline: string | null;
  city: string | null;
  avatarUrl: string | null;
  visibility: 'public' | 'unlisted';
};

export type PublicPerformerEventDto = {
  id: string;
  performerId: string;
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
  attendanceMode: PerformerEventAttendanceMode;
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
  attendanceMode?: PerformerEventAttendanceMode;
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
  attendanceMode?: PerformerEventAttendanceMode;
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

type OwnedPerformerRow = {
  id: string;
  ownerUserId: string | null;
  displayName: string;
  handle: string | null;
  bio: string | null;
  visibilityState: string;
  isActive: boolean;
  onboardingStatus: string;
};

type PublicEventRow = {
  event: EventRow;
  performerOwnerUserId: string;
  performerDisplayName: string;
  performerHandle: string | null;
  performerBio: string | null;
  performerVisibilityState: string;
  performerIsActive: boolean;
  performerOnboardingStatus: string;
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

export function hasActionableWalkInLocation(event: {
  locationName: string | null | undefined;
  locationAddress: string | null | undefined;
  city: string | null | undefined;
  locationIsTba: boolean;
}): boolean {
  const hasText = (value: string | null | undefined) => Boolean(value?.trim());
  return !event.locationIsTba
    && hasText(event.locationName)
    && (hasText(event.locationAddress) || hasText(event.city));
}

function assertWalkInLocationReady(event: {
  attendanceMode: PerformerEventAttendanceMode;
  locationName: string | null | undefined;
  locationAddress: string | null | undefined;
  city: string | null | undefined;
  locationIsTba: boolean;
}) {
  if (event.attendanceMode === 'walk_in' && !hasActionableWalkInLocation(event)) {
    serviceError(
      422,
      'walk_in_location_required',
      'Add a location name and either a street address or city, and turn off Location TBA, before publishing a walk-in event.'
    );
  }
}

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

function normalizeAttendanceMode(
  value: unknown,
  ticketingMode: PerformerEventTicketingMode,
  externalTicketLabel: unknown
): PerformerEventAttendanceMode {
  if (value === undefined || value === null || value === '') {
    if (ticketingMode === 'native_ga') return 'native_ticket';
    return externalTicketLabel === 'RSVP' ? 'external_rsvp' : 'external_ticket';
  }
  if (
    typeof value !== 'string'
    || !['walk_in', 'external_rsvp', 'external_ticket', 'native_ticket'].includes(value)
  ) {
    return serviceError(
      422,
      'invalid_attendance_mode',
      'Attendance mode must be walk_in, external_rsvp, external_ticket, or native_ticket.'
    );
  }
  if (ticketingMode === 'native_ga' && value !== 'native_ticket') {
    return serviceError(
      422,
      'native_ticket_attendance_required',
      'Native Sway tickets require native_ticket attendance mode.'
    );
  }
  if (ticketingMode === 'external' && value === 'native_ticket') {
    return serviceError(
      422,
      'external_attendance_required',
      'External events cannot use native_ticket attendance mode.'
    );
  }
  return value as PerformerEventAttendanceMode;
}

function attendanceModeForEvent(event: {
  attendanceMode?: PerformerEventAttendanceMode | null;
  ticketingMode?: PerformerEventTicketingMode | null;
  externalTicketLabel?: string | null;
}): PerformerEventAttendanceMode {
  if (event.attendanceMode) return event.attendanceMode;
  if (event.ticketingMode === 'native_ga') return 'native_ticket';
  return event.externalTicketLabel === 'RSVP' ? 'external_rsvp' : 'external_ticket';
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
  attendanceMode: unknown;
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
  const attendanceMode = normalizeAttendanceMode(
    input.attendanceMode,
    ticketingMode,
    requestedExternalTicketLabel
  );
  if (attendanceMode === 'walk_in' && (externalTicketUrl || requestedExternalTicketLabel)) {
    serviceError(
      422,
      'walk_in_external_link_conflict',
      'Walk-in events cannot use an external ticket or RSVP link.'
    );
  }
  if (attendanceMode === 'external_rsvp' && requestedExternalTicketLabel && requestedExternalTicketLabel !== 'RSVP') {
    serviceError(422, 'rsvp_label_required', 'External RSVP events must use the RSVP button label.');
  }
  if (attendanceMode === 'external_ticket' && requestedExternalTicketLabel === 'RSVP') {
    serviceError(422, 'ticket_label_required', 'External ticket events cannot use the RSVP button label.');
  }
  if (requestedExternalTicketLabel && !externalTicketUrl) {
    serviceError(422, 'ticket_label_without_url', 'An external ticket label requires an external ticket URL.');
  }
  const externalTicketLabel = externalTicketUrl
    ? attendanceMode === 'external_rsvp'
      ? 'RSVP'
      : requestedExternalTicketLabel || PUBLIC_EVENT_EXTERNAL_TICKET_LABELS[0]
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
    attendanceMode,
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

async function requireOwnedPerformer(
  executor: DbExecutor,
  performerId: string,
  actorUserId: string,
  lock = false
) {
  assertUuid(performerId, 'performerId');
  assertUuid(actorUserId, 'actorUserId');
  const query = executor
    .select({
      id: performers.id,
      ownerUserId: performers.ownerUserId,
      displayName: performers.displayName,
      handle: performers.handle,
      bio: performers.bio,
      visibilityState: performers.visibilityState,
      isActive: performers.isActive,
      onboardingStatus: performers.onboardingStatus
    })
    .from(performers)
    .where(and(
      eq(performers.id, performerId),
      eq(performers.ownerUserId, actorUserId)
    ));
  const [performer] = lock
    ? await query.for('update').limit(1)
    : await query.limit(1);
  if (!performer) {
    serviceError(403, 'performer_owner_required', 'Only the performer owner can manage these events.');
  }
  return performer;
}

function publicationCapabilityForPerformer(
  performer: OwnedPerformerRow
): PerformerEventPublicationCapability {
  if (!performer.isActive) {
    return {
      canPublish: false,
      reach: null,
      reasonCode: 'performer_inactive',
      message: 'Activate your performer account before publishing shows.'
    };
  }
  if (['restricted', 'suspended'].includes(performer.onboardingStatus)) {
    return {
      canPublish: false,
      reach: null,
      reasonCode: 'performer_restricted',
      message: 'This performer cannot publish shows.'
    };
  }
  const eligibility = evaluatePublicEventPerformerEligibility({
    audience: 'direct',
    claimed: Boolean(performer.ownerUserId),
    hasOwner: Boolean(performer.ownerUserId),
    isActive: performer.isActive,
    onboardingStatus: performer.onboardingStatus,
    visibilityState: performer.visibilityState,
    handle: performer.handle,
    displayName: performer.displayName,
    bio: performer.bio
  });
  if (!eligibility.eligible || !eligibility.visibility) {
    return {
      canPublish: false,
      reach: null,
      reasonCode: 'performer_public_page_not_ready',
      message: 'Finish your Public Page before publishing: add a valid handle, display name, and bio, then choose Public or Unlisted visibility.'
    };
  }
  return {
    canPublish: true,
    reach: eligibility.visibility === 'public' ? 'discover' : 'link_only',
    reasonCode: null,
    message: null
  };
}

function assertPerformerPublicationReady(performer: OwnedPerformerRow) {
  const capability = publicationCapabilityForPerformer(performer);
  if (!capability.canPublish) {
    serviceError(
      capability.reasonCode === 'performer_inactive' || capability.reasonCode === 'performer_restricted'
        ? 403
        : 422,
      capability.reasonCode ?? 'performer_public_page_not_ready',
      capability.message ?? 'Finish your Public Page before publishing shows.'
    );
  }
  return capability.reach as PerformerEventPublicationReach;
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
    && attendanceModeForEvent(event) === normalized.attendanceMode
    && event.externalTicketUrl === normalized.externalTicketUrl
    && event.externalTicketLabel === normalized.externalTicketLabel
    && event.visibility === normalized.visibility;
}

export function serializePerformerEvent(
  event: EventRow,
  publicationReach?: PerformerEventPublicationReach
): PerformerEventDto {
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
    attendanceMode: attendanceModeForEvent(event),
    externalTicketUrl: event.externalTicketUrl,
    externalTicketLabel: event.externalTicketLabel,
    visibility: event.visibility,
    status: event.status,
    publishedAt: event.publishedAt?.toISOString() ?? null,
    cancelledAt: event.cancelledAt?.toISOString() ?? null,
    cancellationReason: event.cancellationReason,
    ...(publicationReach ? {
      publicationReach: event.visibility === 'unlisted' ? 'link_only' : publicationReach
    } : {}),
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString()
  };
}

function serializePublicEvent(
  row: PublicEventRow,
  performerVisibility: 'public' | 'unlisted'
): PublicPerformerEventDto {
  const cancelled = row.event.status === 'cancelled';
  return {
    id: row.event.id,
    performerId: row.event.performerId,
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
    attendanceMode: attendanceModeForEvent(row.event),
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
      avatarUrl: row.performerAvatarUrl,
      visibility: performerVisibility
    },
    createdAt: row.event.createdAt.toISOString(),
    updatedAt: row.event.updatedAt.toISOString()
  };
}

function publicEventSelection() {
  return {
    event: performerEvents,
    performerOwnerUserId: performers.ownerUserId,
    performerDisplayName: performers.displayName,
    performerHandle: performers.handle,
    performerBio: performers.bio,
    performerVisibilityState: performers.visibilityState,
    performerIsActive: performers.isActive,
    performerOnboardingStatus: performers.onboardingStatus,
    performerHeadline: performerPublicProfiles.headline,
    performerCity: performerPublicProfiles.city,
    performerAvatarUrl: performerPublicProfiles.avatarUrl
  };
}

function resolvePublicEventPerformer(
  row: PublicEventRow,
  audience: 'discovery' | 'direct'
) {
  return evaluatePublicEventPerformerEligibility({
    audience,
    claimed: Boolean(row.performerOwnerUserId),
    hasOwner: Boolean(row.performerOwnerUserId),
    isActive: row.performerIsActive,
    onboardingStatus: row.performerOnboardingStatus,
    visibilityState: row.performerVisibilityState,
    handle: row.performerHandle,
    displayName: row.performerDisplayName,
    bio: row.performerBio
  });
}

export function createPerformerEventService(db: SwayDb) {
  async function getOwnerPublicationCapability(input: {
    performerId: string;
    actorUserId: string;
  }): Promise<PerformerEventPublicationCapability> {
    const performer = await requireOwnedPerformer(db, input.performerId, input.actorUserId);
    return publicationCapabilityForPerformer(performer as OwnedPerformerRow);
  }

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
    return events.map((event) => serializePerformerEvent(event));
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
      attendanceMode: input.attendanceMode,
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
      'attendanceMode',
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
        && input.attendanceMode !== undefined
        && input.attendanceMode !== attendanceModeForEvent(current)
      ) {
        serviceError(
          409,
          'published_attendance_mode_locked',
          'Attendance mode cannot be changed after an event is published.'
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
        attendanceMode: input.attendanceMode !== undefined
          ? input.attendanceMode
          : attendanceModeForEvent(current),
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
        && ['external_rsvp', 'external_ticket'].includes(normalized.attendanceMode)
        && !normalized.externalTicketUrl
      ) {
        serviceError(
          422,
          'external_ticket_url_required',
          'A published event must keep a public HTTPS ticket or RSVP link.'
        );
      }
      if (current.status === 'published') {
        assertWalkInLocationReady(normalized);
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
      const performer = await requireOwnedPerformer(tx, input.performerId, input.actorUserId, true);
      if (['restricted', 'suspended'].includes(performer.onboardingStatus)) {
        serviceError(403, 'performer_restricted', 'This performer cannot publish events.');
      }
      if (!performer.isActive) {
        serviceError(403, 'performer_inactive', 'Activate the performer profile before publishing events.');
      }
      const performerReach = assertPerformerPublicationReady(performer as OwnedPerformerRow);
      const current = await loadOwnedEvent(tx, input.eventId, input.performerId);
      if (current.status === 'published') return serializePerformerEvent(current, performerReach);
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
      if (
        ['external_rsvp', 'external_ticket'].includes(attendanceModeForEvent(current))
        && !current.externalTicketUrl
      ) {
        serviceError(422, 'external_ticket_url_required', 'Add a public HTTPS ticket or RSVP link before publishing.');
      }
      assertWalkInLocationReady({
        ...current,
        attendanceMode: attendanceModeForEvent(current)
      });
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
      return serializePerformerEvent(published, performerReach);
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
        inArray(performerEvents.status, ['published', 'cancelled'])
      ))
      .limit(1);
    if (!row) return null;
    const typedRow = row as PublicEventRow;
    const eligibility = resolvePublicEventPerformer(typedRow, 'direct');
    return eligibility.eligible && eligibility.visibility
      ? serializePublicEvent(typedRow, eligibility.visibility)
      : null;
  }

  async function listPublicEvents(input: {
    performerId?: string;
    limit?: number;
    now?: string | Date;
    audience?: 'discovery' | 'direct';
  } = {}): Promise<PublicPerformerEventDto[]> {
    if (input.performerId !== undefined) assertUuid(input.performerId, 'performerId');
    if (input.audience === 'direct' && input.performerId === undefined) {
      serviceError(422, 'performer_id_required', 'Direct event listing requires a resolved performer.');
    }
    const now = input.now instanceof Date
      ? input.now
      : input.now
        ? parseDateTime(input.now, 'now')
        : new Date();
    if (Number.isNaN(now.getTime())) {
      serviceError(422, 'invalid_datetime', 'now is invalid.');
    }
    const limit = Math.max(1, Math.min(30, Math.trunc(Number(input.limit) || 12)));
    const audience = input.audience ?? 'discovery';
    const publicConditions = and(
      eq(performerEvents.status, 'published'),
      eq(performerEvents.visibility, 'public'),
      gt(performerEvents.startsAt, now),
      eq(performers.isActive, true),
      notInArray(performers.onboardingStatus, ['restricted', 'suspended']),
      audience === 'discovery'
        ? eq(performers.visibilityState, 'public')
        : inArray(performers.visibilityState, ['public', 'unlisted']),
      sql`${performers.handle} = trim(${performers.handle})`,
      sql`lower(trim(${performers.handle})) ~ '^[a-z0-9_-]{1,64}$'`,
      notInArray(sql<string>`lower(trim(${performers.handle}))`, [...INTERNAL_TEST_PROFILE_HANDLES]),
      sql`nullif(trim(${performers.displayName}), '') is not null`,
      sql`nullif(trim(${performers.bio}), '') is not null`
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
    return rows.flatMap((row) => {
      const typedRow = row as PublicEventRow;
      const eligibility = resolvePublicEventPerformer(typedRow, audience);
      return eligibility.eligible && eligibility.visibility
        ? [serializePublicEvent(typedRow, eligibility.visibility)]
        : [];
    });
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
    getOwnerPublicationCapability,
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
