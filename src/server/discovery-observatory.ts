import { createHash } from 'node:crypto';
import { evaluatePublicEventPerformerEligibility } from './public-profile';

export const SWAY_DISCOVERY_PLATFORM = 'sway' as const;

export type DiscoveryEvidenceStage = 'observation' | 'entry' | 'action' | 'outcome' | 'experiment';
export type DiscoveryLinkStrength =
  | 'direct_server_observed'
  | 'client_correlated_unverified'
  | 'unknown_unavailable';
export type DiscoveryEvidenceState = 'observed' | 'not_observed' | 'unknown' | 'unavailable';
export type DiscoveryQueryEvidenceState = 'known' | 'unknown' | 'unavailable';
export type PerformerDiscoveryVisibilityState = 'draft' | 'unlisted' | 'public' | 'suspended' | 'removed';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,127}$/i;
const SAFE_PUBLIC_PATH_PATTERN = /^\/(?:$|p\/[^?#\s]+|e\/[0-9a-f-]{36}|g\/[0-9a-f-]{36}|r\/[0-9a-f-]{36}|discover\/?$)/i;
const OBSERVATION_RESULT_STATES = ['observed', 'not_observed', 'unknown', 'unavailable'] as const;
const QUERY_EVIDENCE_STATES = ['known', 'unknown', 'unavailable'] as const;
const LINK_STRENGTHS = ['direct_server_observed', 'client_correlated_unverified', 'unknown_unavailable'] as const;
const JOURNEY_EVENT_TYPES = {
  entry: ['discovery_landing', 'discovery_entity_view', 'room_entry_viewed'],
  action: [
    'discovery_primary_action',
    'request_started',
    'boost_started',
    'internal_search_zero_result',
    'room_entry_attempted'
  ],
  outcome: ['room_entry_completed', 'tip_action_completed']
} as const;
const EVENT_ACTION_KIND: Record<string, DiscoveryJourneyEventInput['actionKind']> = {
  request_started: 'request',
  boost_started: 'boost',
  internal_search_zero_result: 'other',
  room_entry_attempted: 'room_entry',
  room_entry_completed: 'room_entry',
  tip_action_completed: 'tip'
};

export type DiscoveryObservationInput = {
  source: string;
  surface: string;
  resultState: DiscoveryEvidenceState;
  queryEvidenceState: DiscoveryQueryEvidenceState;
  observedAt: string;
  observedPrecision: 'timestamp' | 'day';
  query?: string | null;
  locationContext?: string | null;
  deviceContext?: string | null;
  displayedPage?: string | null;
  publicEntityKind?: 'performer' | 'event' | 'release' | 'live_room' | null;
  publicEntityKey?: string | null;
  outsideSources?: string[];
  competitors?: string[];
  evidenceNote: string;
  linkStrength?: DiscoveryLinkStrength;
};

export type NormalizedDiscoveryObservation = {
  platform: typeof SWAY_DISCOVERY_PLATFORM;
  stage: 'observation';
  source: string;
  surface: string;
  result_state: DiscoveryEvidenceState;
  query_evidence_state: DiscoveryQueryEvidenceState;
  observed_at: string;
  observed_precision: 'timestamp' | 'day';
  query: string | null;
  location_context: string | null;
  device_context: string | null;
  displayed_page: string | null;
  entity_kind: 'performer' | 'event' | 'release' | 'live_room' | null;
  entity_key: string | null;
  outside_sources: string[];
  competitors: string[];
  evidence_note: string;
  link_strength: DiscoveryLinkStrength;
  source_freshness: 'fresh' | 'aging' | 'stale';
};

export type DiscoveryJourneyEventInput = {
  journeyId: string;
  stage: Exclude<DiscoveryEvidenceStage, 'observation' | 'experiment'>;
  eventType: string;
  occurredAt?: string;
  source?: string | null;
  surface: string;
  entryPath?: string | null;
  entityKind?: 'performer' | 'event' | 'release' | 'live_room' | null;
  entityKey?: string | null;
  actionKind?: 'follow' | 'room_entry' | 'event_entry' | 'ticket' | 'tip' | 'request' | 'boost' | 'share' | 'other' | null;
  outcomeStatus?: 'completed' | 'failed' | 'pending' | 'unknown' | 'unavailable' | null;
  experimentKey?: string | null;
  visibilityEligibility?: 'eligible' | 'ineligible' | 'unknown' | null;
  linkStrength: DiscoveryLinkStrength;
  searchPhrase?: string | null;
};

export type DiscoveryAuditRow = {
  eventId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date | string;
};

export type DiscoveryQueryCandidate = {
  query: string;
  kind:
    | 'performer_name'
    | 'performer_city'
    | 'genre_city'
    | 'live_music_time'
    | 'venue_date'
    | 'event_title'
    | 'ticket_availability'
    | 'live_room_availability'
    | 'release_title'
    | 'confirmed_credit'
    | 'internal_zero_result';
  entityKind: 'performer' | 'event' | 'release' | 'live_room' | 'internal_search';
  entityKey: string | null;
  market: string | null;
  evidence: 'real_public_supply' | 'internal_zero_result';
  timeSensitive: boolean;
  expiresAt: string | null;
};

export type SwayDiscoverySupply = {
  performers: Array<{
    id: string;
    displayName: string;
    handle: string | null;
    city: string | null;
    specialties: string[];
    visibilityState?: PerformerDiscoveryVisibilityState | null;
    isActive: boolean;
    onboardingStatus: string;
    claimed: boolean;
    bio: string | null;
  }>;
  events: Array<{
    id: string;
    performerId: string;
    title: string;
    startsAt: string;
    timeZone: string;
    city: string | null;
    locationName: string | null;
    ticketAvailable: boolean;
  }>;
  rooms: Array<{
    gigId: string;
    performerId: string | null;
    performerName: string;
    city: string | null;
    routePath: string;
    startedAt: string | null;
  }>;
  releases: Array<{
    id: string;
    performerId: string;
    title: string;
    primaryArtistName: string;
    credits: Array<{ displayName: string; role: string }>;
  }>;
  internalZeroResults: Array<{ phrase: string; observedAt: string }>;
};

export type DiscoverySourceAvailability = {
  source: string;
  state: 'available' | 'unavailable';
  asOf: string | null;
  note: string;
};

export type SwayDiscoveryExperiment = {
  key: string;
  defaultRank: number;
  question: string;
  currentBaseline: string;
  controlledChange: string;
  controlledChangeKey: string;
  target: string;
  intendedAction: string;
  observationPeriod: string;
  successMeasure: string;
  failureCondition: string;
  rollbackCondition: string;
  evidenceBoundary: string;
  timeSensitive: boolean;
  defaultStatus: 'owner_review';
};

export const SWAY_DISCOVERY_EXPERIMENTS: readonly SwayDiscoveryExperiment[] = [
  {
    key: 'sway-time-sensitive-event-room-freshness-v1',
    defaultRank: 1,
    question: 'Does one current event or active Live Room, linked with its verified time and place, earn more qualified entry than the same performer profile without that fresh surface?',
    currentBaseline: 'Calculated at runtime from current event/room observations, freshness failures, real eligible supply, and completed entries.',
    controlledChange: 'Add one owner-approved, server-rendered link from the eligible performer and Discover surfaces to one verified upcoming public event or active Live Room; change no other page fact.',
    controlledChangeKey: 'verified-current-event-room-link-v1',
    target: 'One eligible performer plus one verified public event or active Live Room.',
    intendedAction: 'Completed Live Room entry or event entry.',
    observationPeriod: 'From 48 hours before the verified start time through 12 hours after it; stop when the room closes or event becomes stale.',
    successMeasure: 'At least one directly linked completed entry and a higher entry-per-eligible-event-page rate than the pre-change baseline.',
    failureCondition: 'No completed entry, stale facts, or a mismatch between the public time/place and the source record.',
    rollbackCondition: 'Remove the added link immediately if the event is cancelled, the room closes, or any displayed fact becomes stale or ineligible.',
    evidenceBoundary: 'Search appearance, platform entry, and completed room/event entry stay separate; no search result is credited without a linked journey.',
    timeSensitive: true,
    defaultStatus: 'owner_review'
  },
  {
    key: 'sway-performer-named-link-discovery-v1',
    defaultRank: 2,
    question: 'Does one crawlable, exact-name link from Sway Discover improve discovery and qualified profile entry for an eligible performer?',
    currentBaseline: 'Calculated at runtime from current performer observations, real eligible profiles, exact-name query coverage, and attributable profile entries.',
    controlledChange: 'Add one exact-name server-rendered performer link to the existing Discover surface for an explicitly eligible performer; do not change biography, claims, or ranking language.',
    controlledChangeKey: 'eligible-exact-name-discover-link-v1',
    target: 'One explicitly eligible performer profile selected from current supply after visibility eligibility is confirmed.',
    intendedAction: 'Performer profile entry; follow outcome remains unavailable until Sway has durable readable follow state.',
    observationPeriod: '28 days, with checks on days 0, 7, 14, and 28.',
    successMeasure: 'The exact performer query surfaces the canonical Sway page or attributable profile entries rise above the frozen baseline.',
    failureCondition: 'No appearance and no qualified entries after 28 days, or the performer becomes ineligible.',
    rollbackCondition: 'Remove the link if eligibility changes, facts drift, or the link creates a duplicate canonical path.',
    evidenceBoundary: 'A search observation is not a visit; a profile entry is not a follow; follow completion remains unavailable without product state.',
    timeSensitive: false,
    defaultStatus: 'owner_review'
  },
  {
    key: 'sway-confirmed-release-credit-query-v1',
    defaultRank: 3,
    question: 'Do confirmed release-title and credit facts create qualified discovery entries without exposing draft catalog data?',
    currentBaseline: 'Calculated at runtime from current release observations, eligible public releases, confirmed-credit queries, and attributable release actions.',
    controlledChange: 'Strengthen one eligible release page internal link using only already-public release title and confirmed credit text; make no distribution or availability claim.',
    controlledChangeKey: 'confirmed-release-credit-link-v1',
    target: 'One non-private public release whose artwork, recordings, rights, and credits pass the existing public projection.',
    intendedAction: 'Release page entry or deliberate share action.',
    observationPeriod: '28 days.',
    successMeasure: 'At least one observed exact-title or confirmed-credit appearance plus a directly attributable release entry or share action.',
    failureCondition: 'No appearance or action, or any credit/public-availability fact becomes disputed or unavailable.',
    rollbackCondition: 'Remove the changed link if rights, credits, or public-release eligibility changes.',
    evidenceBoundary: 'Only provider-confirmed availability and cleared public credits count; planned delivery never counts as live.',
    timeSensitive: false,
    defaultStatus: 'owner_review'
  }
] as const;

function requiredText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string') throw new Error(`${label} is required.`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > maxLength) throw new Error(`${label} must be 1-${maxLength} characters.`);
  return normalized;
}

function optionalText(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, maxLength);
}

function safeObservedSearchPhrase(value: unknown, label: string, maxLength: number) {
  const normalized = optionalText(value, label, maxLength);
  if (!normalized) return null;
  if (
    /@|https?:\/\/|www\.|\b\d{7,}\b|\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/i.test(normalized)
  ) {
    throw new Error(`${label} must not contain contact details, URLs, or long numeric identifiers.`);
  }
  return normalized;
}

function parseObservedAt(value: unknown, now: Date, options?: { allowDayPrecision?: boolean }) {
  const normalized = requiredText(value, 'observedAt', 64);
  const dayPrecision = /^\d{4}-\d{2}-\d{2}$/.test(normalized);
  if (dayPrecision && !options?.allowDayPrecision) {
    throw new Error('observedAt must include a timestamp.');
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw new Error('observedAt must be a valid timestamp.');
  if (parsed.getTime() > now.getTime()) throw new Error('observedAt cannot be in the future.');
  return { parsed, normalized: dayPrecision ? normalized : parsed.toISOString(), dayPrecision };
}

function sourceFreshness(observedAt: Date, now: Date): 'fresh' | 'aging' | 'stale' {
  const ageMs = Math.max(0, now.getTime() - observedAt.getTime());
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) return 'fresh';
  if (ageMs <= 30 * 24 * 60 * 60 * 1000) return 'aging';
  return 'stale';
}

function normalizeDisplayedPage(value: unknown) {
  const normalized = optionalText(value, 'displayedPage', 500);
  if (!normalized) return null;
  if (normalized.startsWith('/')) {
    if (!SAFE_PUBLIC_PATH_PATTERN.test(normalized)) throw new Error('displayedPage must be a supported public Sway path.');
    return normalized;
  }
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('displayedPage must be a safe HTTPS URL.');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function normalizeEvidenceLabels(value: unknown, label: string) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => safeObservedSearchPhrase(item, label, 160)).filter((item): item is string => Boolean(item)))].slice(0, 20);
}

export function normalizeDiscoveryObservation(
  input: DiscoveryObservationInput,
  now = new Date()
): NormalizedDiscoveryObservation {
  const observedAt = parseObservedAt(input.observedAt, now, { allowDayPrecision: true });
  if (!['timestamp', 'day'].includes(input.observedPrecision)) throw new Error('observedPrecision is invalid.');
  if ((input.observedPrecision === 'day') !== observedAt.dayPrecision) {
    throw new Error('observedPrecision must match observedAt.');
  }
  if (!OBSERVATION_RESULT_STATES.includes(input.resultState)) {
    throw new Error('resultState is invalid.');
  }
  if (!QUERY_EVIDENCE_STATES.includes(input.queryEvidenceState)) throw new Error('queryEvidenceState is invalid.');
  const query = safeObservedSearchPhrase(input.query, 'query', 300);
  if (input.queryEvidenceState === 'known' && !query) {
    throw new Error('A known query requires a safe nonempty query.');
  }
  if (input.queryEvidenceState !== 'known' && query) {
    throw new Error('Unknown or unavailable query evidence requires query to be null.');
  }
  const outsideSources = normalizeEvidenceLabels(input.outsideSources, 'outside source');
  const competitors = normalizeEvidenceLabels(input.competitors, 'competitor');
  const entityKind = input.publicEntityKind ?? null;
  if (entityKind && !['performer', 'event', 'release', 'live_room'].includes(entityKind)) {
    throw new Error('publicEntityKind is invalid.');
  }
  const entityKey = optionalText(input.publicEntityKey, 'publicEntityKey', 160);
  if (entityKey && !SAFE_KEY_PATTERN.test(entityKey)) throw new Error('publicEntityKey is invalid.');
  const linkStrength = input.linkStrength ?? 'unknown_unavailable';
  if (!LINK_STRENGTHS.includes(linkStrength)) {
    throw new Error('linkStrength is invalid.');
  }
  return {
    platform: SWAY_DISCOVERY_PLATFORM,
    stage: 'observation',
    source: requiredText(input.source, 'source', 80).toLowerCase(),
    surface: requiredText(input.surface, 'surface', 120).toLowerCase(),
    result_state: input.resultState,
    query_evidence_state: input.queryEvidenceState,
    observed_at: observedAt.normalized,
    observed_precision: input.observedPrecision,
    query,
    location_context: optionalText(input.locationContext, 'locationContext', 160),
    device_context: optionalText(input.deviceContext, 'deviceContext', 160),
    displayed_page: normalizeDisplayedPage(input.displayedPage),
    entity_kind: entityKind,
    entity_key: entityKey,
    outside_sources: outsideSources,
    competitors,
    evidence_note: requiredText(input.evidenceNote, 'evidenceNote', 1200),
    link_strength: linkStrength,
    source_freshness: sourceFreshness(observedAt.parsed, now)
  };
}

export function normalizeDiscoveryJourneyEvent(
  input: DiscoveryJourneyEventInput,
  now = new Date()
) {
  if (!UUID_PATTERN.test(input.journeyId)) throw new Error('journeyId must be a UUID.');
  if (!['entry', 'action', 'outcome'].includes(input.stage)) throw new Error('stage is invalid.');
  const allowedEventTypes = JOURNEY_EVENT_TYPES[input.stage];
  if (!(allowedEventTypes as readonly string[]).includes(input.eventType)) {
    throw new Error(`eventType is not allowed for the ${input.stage} stage.`);
  }
  const occurredAt = input.occurredAt ? parseObservedAt(input.occurredAt, now).parsed : now;
  const entryPath = optionalText(input.entryPath, 'entryPath', 300);
  if (entryPath && !SAFE_PUBLIC_PATH_PATTERN.test(entryPath)) throw new Error('entryPath must be a supported public path without a query string.');
  const entityKey = optionalText(input.entityKey, 'entityKey', 160);
  if (entityKey && !SAFE_KEY_PATTERN.test(entityKey)) throw new Error('entityKey is invalid.');
  const experimentKey = optionalText(input.experimentKey, 'experimentKey', 128);
  if (experimentKey && !SWAY_DISCOVERY_EXPERIMENTS.some((experiment) => experiment.key === experimentKey)) {
    throw new Error('experimentKey is not predeclared.');
  }
  const linkStrength = input.linkStrength;
  if (!LINK_STRENGTHS.includes(linkStrength)) throw new Error('linkStrength is invalid.');
  const entityKind = input.entityKind ?? null;
  if (entityKind && !['performer', 'event', 'release', 'live_room'].includes(entityKind)) {
    throw new Error('entityKind is invalid.');
  }
  const actionKind = input.actionKind ?? null;
  if (actionKind && !['follow', 'room_entry', 'event_entry', 'ticket', 'tip', 'request', 'boost', 'share', 'other'].includes(actionKind)) {
    throw new Error('actionKind is invalid.');
  }
  const outcomeStatus = input.outcomeStatus ?? null;
  if (outcomeStatus && !['completed', 'failed', 'pending', 'unknown', 'unavailable'].includes(outcomeStatus)) {
    throw new Error('outcomeStatus is invalid.');
  }
  const visibilityEligibility = input.visibilityEligibility ?? 'unknown';
  if (!['eligible', 'ineligible', 'unknown'].includes(visibilityEligibility)) {
    throw new Error('visibilityEligibility is invalid.');
  }
  if (input.stage === 'entry' && (actionKind || outcomeStatus)) {
    throw new Error('Entry evidence cannot carry action or outcome state.');
  }
  if (input.stage === 'action' && (!actionKind || outcomeStatus)) {
    throw new Error('Action evidence requires actionKind and cannot carry outcome state.');
  }
  if (input.stage === 'outcome' && (!actionKind || !outcomeStatus)) {
    throw new Error('Outcome evidence requires actionKind and outcomeStatus.');
  }
  const expectedActionKind = EVENT_ACTION_KIND[input.eventType];
  if (expectedActionKind && actionKind !== expectedActionKind) {
    throw new Error(`${input.eventType} requires actionKind=${expectedActionKind}.`);
  }
  return {
    platform: SWAY_DISCOVERY_PLATFORM,
    stage: input.stage,
    journey_id: input.journeyId.toLowerCase(),
    event_type: requiredText(input.eventType, 'eventType', 120),
    occurred_at: occurredAt.toISOString(),
    source: optionalText(input.source, 'source', 80)?.toLowerCase() ?? null,
    surface: requiredText(input.surface, 'surface', 80).toLowerCase(),
    entry_path: entryPath,
    entity_kind: entityKind,
    entity_key: entityKey,
    action_kind: actionKind,
    outcome_status: outcomeStatus,
    experiment_key: experimentKey,
    visibility_eligibility: visibilityEligibility,
    link_strength: linkStrength,
    search_phrase: safeObservedSearchPhrase(input.searchPhrase, 'searchPhrase', 160)
  };
}

export function normalizeDiscoveryExperimentAssignment(input: {
  journeyId: string;
  experimentKey: string;
  assignedAt?: string;
}, now = new Date()) {
  if (!UUID_PATTERN.test(input.journeyId)) throw new Error('journeyId must be a UUID.');
  if (!SWAY_DISCOVERY_EXPERIMENTS.some((experiment) => experiment.key === input.experimentKey)) {
    throw new Error('Experiment is not predeclared.');
  }
  const assignedAt = input.assignedAt ? parseObservedAt(input.assignedAt, now).parsed : now;
  return {
    journey_id: input.journeyId.toLowerCase(),
    experiment_key: input.experimentKey,
    assigned_at: assignedAt.toISOString()
  };
}

export function discoveryEntityUuid(input: string) {
  const digest = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function discoveryExperimentVariant(journeyId: string, experimentKey: string): 'control' | 'treatment' {
  const digest = createHash('sha256').update(`${experimentKey}:${journeyId.toLowerCase()}`).digest();
  return digest[0] % 2 === 0 ? 'control' : 'treatment';
}

export function resolvePerformerDiscoveryEligibility(input: {
  isActive: boolean;
  onboardingStatus: string;
  visibilityState?: string | null;
  claimed?: boolean;
  handle?: string | null;
  displayName?: string | null;
  bio?: string | null;
}) {
  if (input.visibilityState !== undefined) {
    const valid = typeof input.visibilityState === 'string'
      && ['draft', 'unlisted', 'public', 'suspended', 'removed'].includes(input.visibilityState);
    const policy = valid
      ? evaluatePublicEventPerformerEligibility({
          audience: 'discovery',
          claimed: input.claimed === true,
          hasOwner: input.claimed === true,
          isActive: input.isActive,
          onboardingStatus: input.onboardingStatus,
          visibilityState: input.visibilityState,
          handle: input.handle,
          displayName: input.displayName,
          bio: input.bio
        })
      : { eligible: false };
    return {
      eligible: policy.eligible,
      visibilityState: valid ? input.visibilityState as PerformerDiscoveryVisibilityState : null,
      evidence: valid ? 'explicit_visibility' as const : 'invalid_visibility' as const
    };
  }
  return {
    eligible: input.isActive && !['restricted', 'suspended'].includes(input.onboardingStatus),
    visibilityState: null,
    evidence: 'explicit_visibility_unavailable_legacy_fallback' as const
  };
}

function dateLabel(value: string, timeZone: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone
  }).format(parsed);
}

function localDateKey(value: string | Date, timeZone: string) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone
  }).format(parsed);
}

export function buildSwayDiscoveryQueryCollection(supply: SwayDiscoverySupply, now = new Date()) {
  const candidates: DiscoveryQueryCandidate[] = [];
  const eligiblePerformerIds = new Set<string>();
  for (const performer of supply.performers) {
    const eligibility = resolvePerformerDiscoveryEligibility(performer);
    if (!eligibility.eligible) continue;
    eligiblePerformerIds.add(performer.id);
    if (!performer.handle) continue;
    candidates.push({
      query: performer.displayName,
      kind: 'performer_name',
      entityKind: 'performer',
      entityKey: performer.id,
      market: performer.city,
      evidence: 'real_public_supply',
      timeSensitive: false,
      expiresAt: null
    });
    if (performer.city) {
      candidates.push({
        query: `${performer.displayName} ${performer.city}`,
        kind: 'performer_city', entityKind: 'performer', entityKey: performer.id, market: performer.city,
        evidence: 'real_public_supply', timeSensitive: false, expiresAt: null
      });
      for (const specialty of performer.specialties.slice(0, 8)) {
        candidates.push({
          query: `${specialty} ${performer.city}`,
          kind: 'genre_city', entityKind: 'performer', entityKey: performer.id, market: performer.city,
          evidence: 'real_public_supply', timeSensitive: false, expiresAt: null
        });
      }
    }
  }

  for (const event of supply.events) {
    if (!eligiblePerformerIds.has(event.performerId)) continue;
    const date = dateLabel(event.startsAt, event.timeZone);
    candidates.push({
      query: event.title,
      kind: 'event_title', entityKind: 'event', entityKey: event.id, market: event.city,
      evidence: 'real_public_supply', timeSensitive: true, expiresAt: event.startsAt
    });
    if (event.locationName && date) {
      candidates.push({
        query: `${event.locationName} ${date}`,
        kind: 'venue_date', entityKind: 'event', entityKey: event.id, market: event.city,
        evidence: 'real_public_supply', timeSensitive: true, expiresAt: event.startsAt
      });
    }
    if (event.ticketAvailable) {
      candidates.push({
        query: `${event.title} tickets`,
        kind: 'ticket_availability', entityKind: 'event', entityKey: event.id, market: event.city,
        evidence: 'real_public_supply', timeSensitive: true, expiresAt: event.startsAt
      });
    }
    if (event.city && localDateKey(event.startsAt, event.timeZone) === localDateKey(now, event.timeZone)) {
      candidates.push({
        query: `live music tonight ${event.city}`,
        kind: 'live_music_time', entityKind: 'event', entityKey: event.id, market: event.city,
        evidence: 'real_public_supply', timeSensitive: true, expiresAt: event.startsAt
      });
    }
  }

  for (const room of supply.rooms) {
    if (!room.performerId || !eligiblePerformerIds.has(room.performerId)) continue;
    candidates.push({
      query: `${room.performerName} live room`,
      kind: 'live_room_availability', entityKind: 'live_room', entityKey: room.gigId, market: room.city,
      evidence: 'real_public_supply', timeSensitive: true, expiresAt: null
    });
    if (room.city) {
      candidates.push({
        query: `live music tonight ${room.city}`,
        kind: 'live_music_time', entityKind: 'live_room', entityKey: room.gigId, market: room.city,
        evidence: 'real_public_supply', timeSensitive: true, expiresAt: null
      });
    }
  }

  for (const release of supply.releases) {
    if (!eligiblePerformerIds.has(release.performerId)) continue;
    candidates.push({
      query: `${release.title} ${release.primaryArtistName}`,
      kind: 'release_title', entityKind: 'release', entityKey: release.id, market: null,
      evidence: 'real_public_supply', timeSensitive: false, expiresAt: null
    });
    for (const credit of release.credits.slice(0, 20)) {
      candidates.push({
        query: `${release.title} ${credit.displayName} ${credit.role.replaceAll('_', ' ')}`,
        kind: 'confirmed_credit', entityKind: 'release', entityKey: release.id, market: null,
        evidence: 'real_public_supply', timeSensitive: false, expiresAt: null
      });
    }
  }

  for (const zero of supply.internalZeroResults) {
    candidates.push({
      query: zero.phrase,
      kind: 'internal_zero_result', entityKind: 'internal_search', entityKey: null, market: null,
      evidence: 'internal_zero_result', timeSensitive: false, expiresAt: null
    });
  }

  const unique = new Map<string, DiscoveryQueryCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.query.toLowerCase()}|${candidate.kind}|${candidate.entityKey ?? ''}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()].sort((left, right) => (
    Number(right.timeSensitive) - Number(left.timeSensitive)
    || left.query.localeCompare(right.query)
  ));
}

function metadataString(metadata: Record<string, unknown>, key: string) {
  return typeof metadata[key] === 'string' ? metadata[key] as string : null;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function buildFunnel(
  name: 'profile_follow' | 'event_room_entry' | 'ticket_tip',
  rows: DiscoveryAuditRow[]
) {
  const entries = new Map<string, number>();
  const actions = new Map<string, number>();
  const outcomes = new Map<string, number>();
  const excludedIneligible = new Set<string>();
  const excludedUnknown = new Set<string>();
  const firstTime = (map: Map<string, number>, key: string, value: number) => {
    if (!map.has(key) || value < map.get(key)!) map.set(key, value);
  };
  for (const row of rows) {
    const metadata = row.metadata ?? {};
    const stage = metadataString(metadata, 'stage');
    const entityKind = metadataString(metadata, 'entity_kind');
    const actionKind = metadataString(metadata, 'action_kind');
    const outcomeStatus = metadataString(metadata, 'outcome_status');
    const linkStrength = metadataString(metadata, 'link_strength');
    const eligibility = metadataString(metadata, 'visibility_eligibility') ?? 'unknown';
    const key = row.entityId;
    const occurredAt = new Date(metadataString(metadata, 'occurred_at') ?? row.createdAt).getTime();
    const relevant = name === 'profile_follow'
      ? entityKind === 'performer' || actionKind === 'follow'
      : name === 'event_room_entry'
        ? entityKind === 'event' || entityKind === 'live_room' || actionKind === 'event_entry' || actionKind === 'room_entry'
        : entityKind === 'event' || entityKind === 'live_room' || actionKind === 'ticket' || actionKind === 'tip';
    if (!relevant || !Number.isFinite(occurredAt)) continue;
    if (eligibility !== 'eligible') {
      (eligibility === 'ineligible' ? excludedIneligible : excludedUnknown).add(key);
      continue;
    }
    if (name === 'profile_follow') {
      if (stage === 'entry' && entityKind === 'performer') firstTime(entries, key, occurredAt);
      if (stage === 'action' && actionKind === 'follow' && metadata.follow_action_surface_id) firstTime(actions, key, occurredAt);
      // No audit-only follow event is allowed to count as a completed follow.
      if (stage === 'outcome' && actionKind === 'follow' && outcomeStatus === 'completed'
        && linkStrength === 'direct_server_observed' && metadata.follow_state_id) firstTime(outcomes, key, occurredAt);
    } else if (name === 'event_room_entry') {
      if (stage === 'entry' && (entityKind === 'event' || entityKind === 'live_room')) firstTime(entries, key, occurredAt);
      if (stage === 'action' && (actionKind === 'event_entry' || actionKind === 'room_entry')) firstTime(actions, key, occurredAt);
      if (stage === 'outcome' && (actionKind === 'event_entry' || actionKind === 'room_entry')
        && outcomeStatus === 'completed' && linkStrength === 'direct_server_observed') firstTime(outcomes, key, occurredAt);
    } else {
      if (stage === 'entry' && (entityKind === 'event' || entityKind === 'live_room')) firstTime(entries, key, occurredAt);
      if (stage === 'action' && (actionKind === 'ticket' || actionKind === 'tip')) firstTime(actions, key, occurredAt);
      if (stage === 'outcome' && (actionKind === 'ticket' || actionKind === 'tip')
        && outcomeStatus === 'completed' && linkStrength === 'direct_server_observed') firstTime(outcomes, key, occurredAt);
    }
  }
  const linkedActions = new Set([...actions.entries()]
    .filter(([journey, at]) => entries.has(journey) && entries.get(journey)! <= at)
    .map(([journey]) => journey));
  const linkedOutcomes = new Set([...outcomes.entries()]
    .filter(([journey, at]) => linkedActions.has(journey) && actions.get(journey)! <= at)
    .map(([journey]) => journey));
  const actionsLackingPriorEntry = [...actions.entries()]
    .filter(([journey, at]) => !entries.has(journey) || entries.get(journey)! > at).length;
  const outcomesLackingPriorAction = [...outcomes.entries()]
    .filter(([journey, at]) => !actions.has(journey) || actions.get(journey)! > at).length;
  return {
    name,
    entries: entries.size,
    actions: linkedActions.size,
    completedOutcomes: linkedOutcomes.size,
    entryToActionRate: ratio(linkedActions.size, entries.size),
    actionToOutcomeRate: ratio(linkedOutcomes.size, linkedActions.size),
    denominators: {
      entryToAction: 'unique anonymous journeys with an eligible platform entry',
      actionToOutcome: 'unique anonymous journeys with a deliberate action attempt'
    },
    exclusions: {
      ineligibleJourneys: excludedIneligible.size,
      unknownEligibilityJourneys: excludedUnknown.size,
      actionsLackingPriorEntry,
      outcomesLackingPriorAction
    },
    actionAvailability: name === 'profile_follow'
      ? 'unavailable_no_real_follow_action_surface'
      : 'measured_from_deliberate_action_events',
    ...(name === 'ticket_tip' ? {
      outcomeAvailabilityByAction: {
        ticket: 'unavailable_no_authoritative_ticket_completion_writer',
        tip: 'measured_from_committed_durable_tip_state'
      }
    } : {}),
    ...(name === 'profile_follow' && linkedOutcomes.size === 0
      ? { outcomeAvailability: 'unavailable_until_durable_readable_follow_state_exists' }
      : { outcomeAvailability: 'measured_from_durable_outcome_events' })
  };
}

export function buildDiscoveryObservatorySnapshot(input: {
  auditRows: DiscoveryAuditRow[];
  queryCollection: DiscoveryQueryCandidate[];
  visibilitySchema: 'explicit_visibility_available' | 'explicit_visibility_unavailable';
  visibilityCounts: { eligible: number; ineligible: number; unknown: number };
  freshnessFailures: Array<Record<string, unknown>>;
  eligibilityExclusions?: { events: number; rooms: number; releases: number; unknownPerformerRooms: number };
  sourceAvailability?: DiscoverySourceAvailability[];
  unclaimedDemand?: {
    state: 'measured';
    asOf: string;
    count: number;
    entities: Array<{ entityKind: string; entityKey: string; uniqueJourneys: number }>;
  } | null;
  claimOwnershipSource?: {
    state: 'available';
    asOf: string;
    unclaimedPublicEntities: Array<{
      entityKind: 'performer' | 'event' | 'release' | 'live_room';
      entityKey: string;
    }>;
  } | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const uniqueRows = [...new Map(input.auditRows.map((row) => [row.eventId, row])).values()]
    .filter((row) => {
      const metadata = row.metadata ?? {};
      const evidenceTime = metadataString(metadata, 'observed_at')
        ?? metadataString(metadata, 'occurred_at')
        ?? metadataString(metadata, 'assigned_at')
        ?? row.createdAt;
      const time = new Date(evidenceTime).getTime();
      return Number.isFinite(time) && time <= now.getTime();
    });
  const assignments = new Map<string, { assignedAt: number; variant: 'control' | 'treatment'; controlledChangeKey: string }>();
  let invalidAssignmentRowsExcluded = 0;
  for (const row of uniqueRows) {
    const metadata = row.metadata ?? {};
    if (row.eventType !== 'discovery_experiment.assignment') continue;
    const experimentKey = metadataString(metadata, 'experiment_key');
    const assignedAt = new Date(metadataString(metadata, 'assigned_at') ?? row.createdAt).getTime();
    const journeyId = metadataString(metadata, 'journey_id');
    const variant = metadataString(metadata, 'variant');
    const controlledChangeKey = metadataString(metadata, 'controlled_change_key');
    const definition = SWAY_DISCOVERY_EXPERIMENTS.find((experiment) => experiment.key === experimentKey);
    if (!experimentKey || !journeyId || !definition || !Number.isFinite(assignedAt)
      || variant !== discoveryExperimentVariant(journeyId, experimentKey)
      || controlledChangeKey !== definition.controlledChangeKey
      || metadata.controlled_change_count !== 1) {
      invalidAssignmentRowsExcluded += 1;
      continue;
    }
    const assignmentKey = `${row.entityId}|${experimentKey}`;
    if (assignments.has(assignmentKey)) {
      invalidAssignmentRowsExcluded += 1;
      continue;
    }
    assignments.set(assignmentKey, {
      assignedAt,
      variant,
      controlledChangeKey
    });
  }
  let integrityRowsExcluded = 0;
  let invalidExperimentOrderRowsExcluded = 0;
  const journeyRows = uniqueRows.filter((row) => {
    if (row.entityType !== 'shell_friction' || row.eventType === 'discovery_experiment.assignment') return false;
    const metadata = row.metadata ?? {};
    const journeyId = metadataString(metadata, 'journey_id');
    const entityKind = metadataString(metadata, 'entity_kind');
    const entityKey = metadataString(metadata, 'entity_key');
    if (!journeyId || !UUID_PATTERN.test(journeyId) || row.entityId !== discoveryEntityUuid(journeyId)
      || Boolean(entityKind) !== Boolean(entityKey)) {
      integrityRowsExcluded += 1;
      return false;
    }
    try {
      normalizeDiscoveryJourneyEvent({
        journeyId,
        stage: metadataString(metadata, 'stage') as DiscoveryJourneyEventInput['stage'],
        eventType: row.eventType,
        occurredAt: metadataString(metadata, 'occurred_at') ?? undefined,
        source: metadataString(metadata, 'source'),
        surface: metadataString(metadata, 'surface') ?? '',
        entryPath: metadataString(metadata, 'entry_path'),
        entityKind: entityKind as DiscoveryJourneyEventInput['entityKind'],
        entityKey,
        actionKind: metadataString(metadata, 'action_kind') as DiscoveryJourneyEventInput['actionKind'],
        outcomeStatus: metadataString(metadata, 'outcome_status') as DiscoveryJourneyEventInput['outcomeStatus'],
        experimentKey: metadataString(metadata, 'experiment_key'),
        visibilityEligibility: metadataString(metadata, 'visibility_eligibility') as DiscoveryJourneyEventInput['visibilityEligibility'],
        linkStrength: metadataString(metadata, 'link_strength') as DiscoveryJourneyEventInput['linkStrength'],
        searchPhrase: metadataString(metadata, 'search_phrase')
      }, now);
      if (metadataString(metadata, 'event_type') !== row.eventType) throw new Error('event type mismatch');
    } catch {
      integrityRowsExcluded += 1;
      return false;
    }
    const experimentKey = metadataString(metadata, 'experiment_key');
    if (experimentKey) {
      const occurredAt = new Date(metadataString(metadata, 'occurred_at') ?? row.createdAt).getTime();
      const assignment = assignments.get(`${row.entityId}|${experimentKey}`);
      if (!assignment || assignment.assignedAt > occurredAt) {
        invalidExperimentOrderRowsExcluded += 1;
        return false;
      }
    }
    return true;
  });
  const observationRows = uniqueRows.filter((row) => row.eventType === 'discovery_observation.recorded');
  const unclaimedDemand = (() => {
    if (input.unclaimedDemand) return input.unclaimedDemand;
    if (!input.claimOwnershipSource) return null;
    const unclaimedKeys = new Set(input.claimOwnershipSource.unclaimedPublicEntities
      .map((entity) => `${entity.entityKind}|${entity.entityKey.toLowerCase()}`));
    const demand = new Map<string, Set<string>>();
    for (const row of journeyRows) {
      const metadata = row.metadata ?? {};
      if (metadataString(metadata, 'stage') !== 'entry'
        || metadataString(metadata, 'visibility_eligibility') !== 'eligible') continue;
      const entityKind = metadataString(metadata, 'entity_kind');
      const entityKey = metadataString(metadata, 'entity_key');
      if (!entityKind || !entityKey) continue;
      const key = `${entityKind}|${entityKey.toLowerCase()}`;
      if (!unclaimedKeys.has(key)) continue;
      if (!demand.has(key)) demand.set(key, new Set());
      demand.get(key)!.add(row.entityId);
    }
    const entities = [...demand.entries()].map(([key, journeys]) => {
      const [entityKind, entityKey] = key.split('|');
      return { entityKind, entityKey, uniqueJourneys: journeys.size };
    }).sort((left, right) => right.uniqueJourneys - left.uniqueJourneys || left.entityKey.localeCompare(right.entityKey));
    return {
      state: 'measured' as const,
      asOf: input.claimOwnershipSource.asOf,
      count: entities.length,
      entities,
      source: 'current_performer_owner_user_id'
    };
  })();

  const sourceEntries = new Map<string, Set<string>>();
  const pages = new Map<string, { entries: Set<string>; actions: Set<string> }>();
  const outsideSources = new Map<string, number>();
  const competitors = new Map<string, number>();
  const unknownEvidence: Array<Record<string, unknown>> = [];
  const validJourneyEventIds = new Set(journeyRows.map((row) => row.eventId));
  for (const row of uniqueRows) {
    const metadata = row.metadata ?? {};
    const stage = metadataString(metadata, 'stage');
    const source = metadataString(metadata, 'source') ?? metadataString(metadata, 'attribution_channel') ?? 'unknown';
    const entryPath = metadataString(metadata, 'entry_path');
    const eligibleJourneyRow = validJourneyEventIds.has(row.eventId)
      && metadataString(metadata, 'visibility_eligibility') === 'eligible';
    if (eligibleJourneyRow && stage === 'entry') {
      if (!sourceEntries.has(source)) sourceEntries.set(source, new Set());
      sourceEntries.get(source)!.add(row.entityId);
    }
    if (eligibleJourneyRow && entryPath) {
      if (!pages.has(entryPath)) pages.set(entryPath, { entries: new Set(), actions: new Set() });
      if (stage === 'entry') pages.get(entryPath)!.entries.add(row.entityId);
      if (stage === 'action') pages.get(entryPath)!.actions.add(row.entityId);
    }
    if (row.eventType === 'discovery_observation.recorded' && metadataString(metadata, 'result_state') === 'observed') {
      const outside = Array.isArray(metadata.outside_sources) ? metadata.outside_sources : [];
      for (const value of outside) {
        if (typeof value !== 'string') continue;
        outsideSources.set(value, (outsideSources.get(value) ?? 0) + 1);
      }
      const observedCompetitors = Array.isArray(metadata.competitors) ? metadata.competitors : [];
      for (const value of observedCompetitors) {
        if (typeof value !== 'string') continue;
        competitors.set(value, (competitors.get(value) ?? 0) + 1);
      }
    }
    const state = metadataString(metadata, 'result_state');
    const linkStrength = metadataString(metadata, 'link_strength');
    if (state === 'unknown' || state === 'unavailable' || linkStrength === 'unknown_unavailable') {
      unknownEvidence.push({
        eventId: row.eventId,
        stage,
        source,
        state: state ?? 'unknown',
        linkStrength: linkStrength ?? 'unknown_unavailable',
        observedAt: metadataString(metadata, 'observed_at') ?? null
      });
    }
  }

  const experimentCandidates = SWAY_DISCOVERY_EXPERIMENTS.map((experiment) => {
    const decisions = uniqueRows
      .filter((row) => row.eventType === 'discovery_experiment.decision' && metadataString(row.metadata ?? {}, 'experiment_key') === experiment.key)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
    const observedKinds = observationRows.map((row) => ({
      kind: metadataString(row.metadata ?? {}, 'entity_kind'),
      state: metadataString(row.metadata ?? {}, 'result_state')
    }));
    const timeQueries = input.queryCollection.filter((query) => query.timeSensitive).length;
    const performerQueries = input.queryCollection.filter((query) => query.entityKind === 'performer').length;
    const releaseQueries = input.queryCollection.filter((query) => query.entityKind === 'release').length;
    const experimentAssignments = [...assignments.entries()]
      .filter(([key]) => key.endsWith(`|${experiment.key}`))
      .map(([, assignment]) => assignment);
    const zeroPhrases = new Set(input.queryCollection
      .filter((query) => query.kind === 'internal_zero_result')
      .map((query) => query.query.toLowerCase()));
    const matchingZeroResults = (entityKind: DiscoveryQueryCandidate['entityKind']) => input.queryCollection
      .filter((query) => query.entityKind === entityKind && query.kind !== 'internal_zero_result' && zeroPhrases.has(query.query.toLowerCase()))
      .length;
    const runtime = experiment.key === 'sway-time-sensitive-event-room-freshness-v1'
      ? {
          score: timeQueries + input.freshnessFailures.length * 4
            + matchingZeroResults('event') * 3 + matchingZeroResults('live_room') * 3
            + observedKinds.filter((item) => (item.kind === 'event' || item.kind === 'live_room') && item.state !== 'observed').length * 3,
          currentBaseline: `${timeQueries} time-sensitive real-supply queries; ${input.freshnessFailures.length} freshness failures; ${observedKinds.filter((item) => item.kind === 'event' || item.kind === 'live_room').length} stored outside observations.`
        }
      : experiment.key === 'sway-performer-named-link-discovery-v1'
        ? {
            score: performerQueries + matchingZeroResults('performer') * 3
              + observedKinds.filter((item) => item.kind === 'performer' && item.state !== 'observed').length * 3
              + input.visibilityCounts.unknown * 2,
            currentBaseline: `${performerQueries} eligible performer queries; ${observedKinds.filter((item) => item.kind === 'performer').length} stored outside observations; ${input.visibilityCounts.unknown} performers with unknown explicit visibility evidence.`
          }
        : {
            score: releaseQueries + matchingZeroResults('release') * 3
              + observedKinds.filter((item) => item.kind === 'release' && item.state !== 'observed').length * 3,
            currentBaseline: `${releaseQueries} eligible release/credit queries; ${observedKinds.filter((item) => item.kind === 'release').length} stored outside observations.`
          };
    return {
      ...experiment,
      ...runtime,
      status: metadataString(decisions[0]?.metadata ?? {}, 'decision') ?? experiment.defaultStatus,
      lastDecisionAt: decisions[0] ? new Date(decisions[0].createdAt).toISOString() : null,
      assignments: {
        control: experimentAssignments.filter((assignment) => assignment.variant === 'control').length,
        treatment: experimentAssignments.filter((assignment) => assignment.variant === 'treatment').length,
        total: experimentAssignments.length,
        controlShare: ratio(
          experimentAssignments.filter((assignment) => assignment.variant === 'control').length,
          experimentAssignments.length
        )
      }
    };
  });
  const experiments = experimentCandidates
    .sort((left, right) => right.score - left.score || left.defaultRank - right.defaultRank)
    .map((experiment, index) => ({ ...experiment, rank: index + 1 }));

  return {
    generatedAt: now.toISOString(),
    platform: SWAY_DISCOVERY_PLATFORM,
    evidenceSemantics: {
      observation: 'An outside surface result independently recorded.',
      entry: 'An actual landing on Sway.',
      action: 'A deliberate audience attempt.',
      outcome: 'A durable follow, room, ticket, or tip result; never inferred from an action.',
      experiment: 'A predeclared assignment with exactly one controlled change.'
    },
    linkStrengths: {
      direct_server_observed: 'The server or durable product state directly confirms the event.',
      client_correlated_unverified: 'The anonymous browser journey correlates the event, but the server did not directly observe the external source.',
      unknown_unavailable: 'The evidence cannot safely connect the records.'
    },
    journeyGrain: 'One pseudonymous top-level browser-tab session. The browser rotates the UUID at the sessionStorage boundary; the server stores only its deterministic audit hash.',
    funnels: [
      buildFunnel('profile_follow', journeyRows),
      buildFunnel('event_room_entry', journeyRows),
      buildFunnel('ticket_tip', journeyRows)
    ],
    discoverySources: [...sourceEntries.entries()]
      .map(([source, journeys]) => ({ source, uniqueEntries: journeys.size }))
      .sort((left, right) => right.uniqueEntries - left.uniqueEntries || left.source.localeCompare(right.source)),
    queries: input.queryCollection,
    observedPages: observationRows.map((row) => {
      const metadata = row.metadata ?? {};
      const observedAt = metadataString(metadata, 'observed_at');
      const observedDate = observedAt ? new Date(observedAt) : null;
      return {
        eventId: row.eventId,
        source: metadataString(metadata, 'source'),
        query: metadataString(metadata, 'query'),
        queryEvidenceState: metadataString(metadata, 'query_evidence_state'),
        resultState: metadataString(metadata, 'result_state'),
        displayedPage: metadataString(metadata, 'displayed_page'),
        observedAt,
        observedPrecision: metadataString(metadata, 'observed_precision'),
        sourceFreshness: observedDate && Number.isFinite(observedDate.getTime())
          ? sourceFreshness(observedDate, now)
          : 'unavailable',
        linkStrength: metadataString(metadata, 'link_strength')
      };
    }),
    repeatedOutsideSources: [...outsideSources.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((left, right) => right.count - left.count || left.source.localeCompare(right.source)),
    repeatedCompetitors: [...competitors.entries()]
      .map(([competitor, count]) => ({ competitor, count }))
      .sort((left, right) => right.count - left.count || left.competitor.localeCompare(right.competitor)),
    pagesWithEntriesButNoActions: [...pages.entries()]
      .filter(([, counts]) => counts.entries.size > 0 && counts.actions.size === 0)
      .map(([path, counts]) => ({ path, uniqueEntries: counts.entries.size })),
    pagesWithImpressionsButNoActions: {
      state: 'unavailable' as const,
      pages: [],
      reason: 'No authorized impression source such as Search Console or Bing Webmaster is connected; entries are shown separately and are not relabeled as impressions.'
    },
    internalZeroResults: input.queryCollection.filter((query) => query.kind === 'internal_zero_result'),
    freshnessFailures: input.freshnessFailures,
    experiments,
    visibility: {
      schema: input.visibilitySchema,
      ...input.visibilityCounts
    },
    eligibilityExclusions: input.eligibilityExclusions ?? {
      events: 0, rooms: 0, releases: 0, unknownPerformerRooms: 0
    },
    sourceAvailability: input.sourceAvailability ?? [],
    unclaimedEntitiesReceivingDemand: unclaimedDemand ?? {
      state: 'unavailable' as const,
      asOf: null,
      count: null,
      entities: [],
      reason: 'No trustworthy claim or ownership source is connected; an empty list must not be read as zero.'
    },
    unknownOrUnavailableEvidence: unknownEvidence,
    quality: {
      rawAuditRows: input.auditRows.length,
      auditWindowLimitReached: input.auditRows.length >= 10_000,
      uniqueAuditRows: uniqueRows.length,
      duplicateRowsExcluded: input.auditRows.length - new Set(input.auditRows.map((row) => row.eventId)).size,
      futureRowsExcluded: [...new Map(input.auditRows.map((row) => [row.eventId, row])).values()].length - uniqueRows.length,
      integrityRowsExcluded,
      invalidExperimentOrderRowsExcluded,
      invalidAssignmentRowsExcluded,
      joinRule: 'Each event is de-duplicated by eventId and each funnel count is de-duplicated by anonymous journey entityId.'
    }
  };
}
