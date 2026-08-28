import assert from 'node:assert/strict';
import {
  buildDiscoveryObservatorySnapshot,
  buildSwayDiscoveryQueryCollection,
  discoveryEntityUuid,
  discoveryExperimentVariant,
  normalizeDiscoveryJourneyEvent,
  normalizeDiscoveryObservation,
  resolvePerformerDiscoveryEligibility,
  type DiscoveryAuditRow,
  type DiscoveryQueryCandidate,
  type SwayDiscoverySupply
} from '../src/server/discovery-observatory';
import { getOrCreateDiscoveryJourneyId } from '../src/shells/discoveryAttribution';

const now = new Date('2026-08-08T18:00:00.000Z');
const entityKey = '10000000-0000-4000-8000-000000000001';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const localStorage = new MemoryStorage();
let sessionStorage = new MemoryStorage();
localStorage.setItem('sway.discovery.journeyId', '90000000-0000-4000-8000-000000000001');
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  get: () => ({ localStorage, sessionStorage })
});
const firstSessionJourney = getOrCreateDiscoveryJourneyId();
assert.equal(getOrCreateDiscoveryJourneyId(), firstSessionJourney, 'Journey ID must be reused within one tab session.');
assert.equal(localStorage.getItem('sway.discovery.journeyId'), null, 'Old persistent journey key must be removed.');
sessionStorage = new MemoryStorage();
const nextSessionJourney = getOrCreateDiscoveryJourneyId();
assert.notEqual(nextSessionJourney, firstSessionJourney, 'Journey ID must rotate at a new sessionStorage boundary.');
if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
else Reflect.deleteProperty(globalThis, 'window');

const safeObservation = {
  source: 'web_search', surface: 'exact_name_search', resultState: 'not_observed' as const,
  queryEvidenceState: 'known' as const, query: 'DJ Example Sway', observedAt: '2026-08-08',
  observedPrecision: 'day' as const, locationContext: 'unknown', deviceContext: 'unknown',
  displayedPage: null, publicEntityKind: 'performer' as const, publicEntityKey: 'dj-example',
  outsideSources: ['Unrelated result'], competitors: ['Example competitor'], evidenceNote: 'Independent check.',
  linkStrength: 'unknown_unavailable' as const
};

const normalizedObservation = normalizeDiscoveryObservation(safeObservation, now);
assert.equal(normalizedObservation.observed_at, '2026-08-08', 'Day precision must not invent a timestamp.');
assert.equal(normalizedObservation.query_evidence_state, 'known');
assert.deepEqual(normalizedObservation.competitors, ['Example competitor']);

assert.throws(() => normalizeDiscoveryObservation({ ...safeObservation, queryEvidenceState: 'unknown', query: 'DJ Example' }, now), /requires query to be null/);
assert.throws(() => normalizeDiscoveryObservation({ ...safeObservation, queryEvidenceState: 'known', query: null }, now), /requires a safe nonempty query/);
assert.throws(() => normalizeDiscoveryObservation({ ...safeObservation, query: 'dj@example.com' }, now), /contact details/);
assert.throws(() => normalizeDiscoveryObservation({ ...safeObservation, query: 'https:\/\/private.example' }, now), /contact details/);
assert.throws(() => normalizeDiscoveryObservation({ ...safeObservation, query: 'order 123456789' }, now), /long numeric/);
assert.throws(() => normalizeDiscoveryObservation({ ...safeObservation, competitors: ['https://competitor.example'] }, now), /contact details/);
assert.throws(() => normalizeDiscoveryObservation({ ...safeObservation, observedAt: '2026-08-09' }, now), /future/);
assert.throws(() => normalizeDiscoveryObservation({ ...safeObservation, observedPrecision: 'timestamp' }, now), /must match/);

const journeyBase = {
  journeyId: '20000000-0000-4000-8000-000000000001', surface: 'public-discover',
  source: 'direct', entryPath: '/discover', visibilityEligibility: 'eligible' as const,
  linkStrength: 'client_correlated_unverified' as const
};
assert.throws(() => normalizeDiscoveryJourneyEvent({
  ...journeyBase, stage: 'action', eventType: 'unlisted_event', actionKind: 'other'
}, now), /not allowed/);
assert.throws(() => normalizeDiscoveryJourneyEvent({
  ...journeyBase, stage: 'action', eventType: 'internal_search_zero_result', actionKind: 'other', searchPhrase: 'call 3125550199'
}, now), /contact details/);
assert.throws(() => normalizeDiscoveryJourneyEvent({
  ...journeyBase, stage: 'action', eventType: 'internal_search_zero_result', actionKind: 'other', searchPhrase: 'https://example.com'
}, now), /contact details/);
assert.throws(() => normalizeDiscoveryJourneyEvent({
  ...journeyBase, stage: 'entry', eventType: 'discovery_landing', actionKind: 'other'
}, now), /Entry evidence/);

assert.equal(resolvePerformerDiscoveryEligibility({
  isActive: true,
  onboardingStatus: 'gig_ready',
  visibilityState: 'public',
  claimed: true,
  handle: 'eligible',
  displayName: 'Eligible Artist',
  bio: 'A resolvable performer profile.'
}).eligible, true);
for (const visibilityState of ['draft', 'unlisted', 'suspended', 'removed', null] as const) {
  assert.equal(resolvePerformerDiscoveryEligibility({ isActive: true, onboardingStatus: 'gig_ready', visibilityState }).eligible, false);
}
assert.equal(resolvePerformerDiscoveryEligibility({ isActive: true, onboardingStatus: 'gig_ready' }).evidence, 'explicit_visibility_unavailable_legacy_fallback');

const supply: SwayDiscoverySupply = {
  performers: [
    { id: entityKey, displayName: 'Eligible Artist', handle: 'eligible', bio: 'A resolvable performer profile.', city: 'Chicago', specialties: ['House'], visibilityState: 'public', isActive: true, onboardingStatus: 'gig_ready', claimed: true },
    { id: '10000000-0000-4000-8000-000000000002', displayName: 'Draft Artist', handle: 'draft', bio: 'A draft performer profile.', city: 'Chicago', specialties: ['Jazz'], visibilityState: 'draft', isActive: true, onboardingStatus: 'gig_ready', claimed: true }
  ],
  events: [
    { id: '30000000-0000-4000-8000-000000000001', performerId: entityKey, title: 'Eligible Show', startsAt: '2026-08-08T23:00:00Z', timeZone: 'UTC', city: 'Chicago', locationName: 'The Room', ticketAvailable: true },
    { id: '30000000-0000-4000-8000-000000000002', performerId: '10000000-0000-4000-8000-000000000002', title: 'Draft Show', startsAt: '2026-08-08T23:00:00Z', timeZone: 'UTC', city: 'Chicago', locationName: 'Hidden', ticketAvailable: true }
  ],
  rooms: [
    { gigId: '40000000-0000-4000-8000-000000000001', performerId: entityKey, performerName: 'Eligible Artist', city: 'Chicago', routePath: '/g/40000000-0000-4000-8000-000000000001', startedAt: '2026-08-08T17:00:00Z' },
    { gigId: '40000000-0000-4000-8000-000000000002', performerId: null, performerName: 'Unverified Artist', city: 'Chicago', routePath: '/g/40000000-0000-4000-8000-000000000002', startedAt: null }
  ],
  releases: [], internalZeroResults: [{ phrase: 'Eligible Show tickets', observedAt: '2026-08-08T17:00:00Z' }]
};
const collectedQueries = buildSwayDiscoveryQueryCollection(supply, now);
assert.ok(collectedQueries.some((query) => query.query === 'Eligible Artist'));
assert.ok(collectedQueries.some((query) => query.query === 'Eligible Show tickets'));
assert.ok(!collectedQueries.some((query) => query.query.includes('Draft Artist') || query.query.includes('Draft Show')));
assert.ok(!collectedQueries.some((query) => query.query.includes('Unverified Artist')), 'Rooms without verified eligible performer IDs must fail closed.');

function evidenceRow(input: {
  eventId: string;
  journeyId: string;
  eventType: string;
  occurredAt: string;
  stage: 'entry' | 'action' | 'outcome';
  entityKind: 'performer' | 'event' | 'live_room';
  actionKind?: 'follow' | 'room_entry' | 'ticket' | 'tip';
  outcomeStatus?: 'completed' | 'unknown';
  eligibility?: 'eligible' | 'ineligible' | 'unknown';
  linkStrength?: 'direct_server_observed' | 'client_correlated_unverified';
  experimentKey?: string;
}): DiscoveryAuditRow {
  return {
    eventId: input.eventId,
    entityType: 'shell_friction',
    entityId: discoveryEntityUuid(input.journeyId),
    eventType: input.eventType,
    createdAt: input.occurredAt,
    metadata: {
      platform: 'sway', stage: input.stage, journey_id: input.journeyId, event_type: input.eventType,
      occurred_at: input.occurredAt, source: 'web_search', surface: 'proof', entry_path: '/discover',
      entity_kind: input.entityKind, entity_key: entityKey, action_kind: input.actionKind ?? null,
      outcome_status: input.outcomeStatus ?? null, visibility_eligibility: input.eligibility ?? 'eligible',
      link_strength: input.linkStrength ?? 'client_correlated_unverified', experiment_key: input.experimentKey ?? null
    }
  };
}

const roomJourney = '50000000-0000-4000-8000-000000000001';
const ineligibleJourney = '50000000-0000-4000-8000-000000000002';
const orphanJourney = '50000000-0000-4000-8000-000000000003';
const spoofJourney = '50000000-0000-4000-8000-000000000004';
const followJourney = '50000000-0000-4000-8000-000000000005';
const tipJourney = '50000000-0000-4000-8000-000000000006';
const experimentJourney = '50000000-0000-4000-8000-000000000007';
const unassignedExperimentJourney = '50000000-0000-4000-8000-000000000008';
const experimentKey = 'sway-performer-named-link-discovery-v1';
const auditRows: DiscoveryAuditRow[] = [
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000001', journeyId: roomJourney, eventType: 'discovery_landing', occurredAt: '2026-08-08T10:00:00Z', stage: 'entry', entityKind: 'live_room' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000001', journeyId: roomJourney, eventType: 'discovery_landing', occurredAt: '2026-08-08T10:00:00Z', stage: 'entry', entityKind: 'live_room' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000002', journeyId: roomJourney, eventType: 'room_entry_attempted', occurredAt: '2026-08-08T10:01:00Z', stage: 'action', entityKind: 'live_room', actionKind: 'room_entry', linkStrength: 'direct_server_observed' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000003', journeyId: roomJourney, eventType: 'room_entry_completed', occurredAt: '2026-08-08T10:02:00Z', stage: 'outcome', entityKind: 'live_room', actionKind: 'room_entry', outcomeStatus: 'completed', linkStrength: 'direct_server_observed' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000004', journeyId: ineligibleJourney, eventType: 'discovery_landing', occurredAt: '2026-08-08T10:00:00Z', stage: 'entry', entityKind: 'live_room', eligibility: 'ineligible' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000005', journeyId: orphanJourney, eventType: 'room_entry_attempted', occurredAt: '2026-08-08T10:01:00Z', stage: 'action', entityKind: 'live_room', actionKind: 'room_entry', linkStrength: 'direct_server_observed' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000006', journeyId: spoofJourney, eventType: 'discovery_landing', occurredAt: '2026-08-08T10:00:00Z', stage: 'entry', entityKind: 'live_room' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000007', journeyId: spoofJourney, eventType: 'room_entry_attempted', occurredAt: '2026-08-08T10:01:00Z', stage: 'action', entityKind: 'live_room', actionKind: 'room_entry' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000008', journeyId: spoofJourney, eventType: 'room_entry_completed', occurredAt: '2026-08-08T10:02:00Z', stage: 'outcome', entityKind: 'live_room', actionKind: 'room_entry', outcomeStatus: 'completed', linkStrength: 'client_correlated_unverified' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000009', journeyId: followJourney, eventType: 'discovery_landing', occurredAt: '2026-08-08T10:00:00Z', stage: 'entry', entityKind: 'performer' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000010', journeyId: followJourney, eventType: 'discovery_primary_action', occurredAt: '2026-08-08T10:01:00Z', stage: 'action', entityKind: 'performer', actionKind: 'follow' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000011', journeyId: followJourney, eventType: 'tip_action_completed', occurredAt: '2026-08-08T10:02:00Z', stage: 'outcome', entityKind: 'performer', actionKind: 'follow', outcomeStatus: 'completed', linkStrength: 'direct_server_observed' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000012', journeyId: tipJourney, eventType: 'discovery_landing', occurredAt: '2026-08-08T11:00:00Z', stage: 'entry', entityKind: 'live_room' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000013', journeyId: tipJourney, eventType: 'discovery_primary_action', occurredAt: '2026-08-08T11:01:00Z', stage: 'action', entityKind: 'live_room', actionKind: 'tip', linkStrength: 'direct_server_observed' }),
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000014', journeyId: tipJourney, eventType: 'tip_action_completed', occurredAt: '2026-08-08T11:02:00Z', stage: 'outcome', entityKind: 'live_room', actionKind: 'tip', outcomeStatus: 'completed', linkStrength: 'direct_server_observed' }),
  {
    eventId: '60000000-0000-4000-8000-000000000015', entityType: 'shell_friction', entityId: discoveryEntityUuid(experimentJourney),
    eventType: 'discovery_experiment.assignment', createdAt: '2026-08-08T09:00:00Z', metadata: { stage: 'experiment', journey_id: experimentJourney, experiment_key: experimentKey, assigned_at: '2026-08-08T09:00:00Z', variant: discoveryExperimentVariant(experimentJourney, experimentKey), controlled_change_key: 'eligible-exact-name-discover-link-v1', controlled_change_count: 1 }
  },
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000016', journeyId: experimentJourney, eventType: 'discovery_landing', occurredAt: '2026-08-08T09:01:00Z', stage: 'entry', entityKind: 'performer', experimentKey }),
  { ...evidenceRow({ eventId: '60000000-0000-4000-8000-000000000017', journeyId: roomJourney, eventType: 'discovery_landing', occurredAt: '2026-08-08T10:00:00Z', stage: 'entry', entityKind: 'live_room' }), entityId: '70000000-0000-4000-8000-000000000001' },
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000018', journeyId: roomJourney, eventType: 'discovery_landing', occurredAt: '2026-08-09T10:00:00Z', stage: 'entry', entityKind: 'live_room' }),
  {
    eventId: '60000000-0000-4000-8000-000000000019', entityType: 'discovery_observation', entityId: entityKey,
    eventType: 'discovery_observation.recorded', createdAt: '2026-08-08T08:00:00Z', metadata: { stage: 'observation', source: 'web_search', result_state: 'observed', observed_at: '2026-08-08', observed_precision: 'day', query: 'Eligible Artist', query_evidence_state: 'known', outside_sources: ['Search result A'], competitors: ['Competitor A'], link_strength: 'unknown_unavailable' }
  },
  {
    eventId: '60000000-0000-4000-8000-000000000020', entityType: 'discovery_observation', entityId: entityKey,
    eventType: 'discovery_observation.recorded', createdAt: '2026-08-08T08:05:00Z', metadata: { stage: 'observation', source: 'web_search', result_state: 'not_observed', observed_at: '2026-08-08', observed_precision: 'day', query: 'No result', query_evidence_state: 'known', outside_sources: ['Must not count'], competitors: ['Must not count'], link_strength: 'unknown_unavailable' }
  },
  evidenceRow({ eventId: '60000000-0000-4000-8000-000000000021', journeyId: unassignedExperimentJourney, eventType: 'discovery_landing', occurredAt: '2026-08-08T09:01:00Z', stage: 'entry', entityKind: 'performer', experimentKey })
];

function snapshot(queries: DiscoveryQueryCandidate[], freshnessFailures: Array<Record<string, unknown>> = []) {
  return buildDiscoveryObservatorySnapshot({
    auditRows, queryCollection: queries, visibilitySchema: 'explicit_visibility_available',
    visibilityCounts: { eligible: 1, ineligible: 1, unknown: 0 }, freshnessFailures,
    eligibilityExclusions: { events: 1, rooms: 1, releases: 0, unknownPerformerRooms: 1 },
    sourceAvailability: [{ source: 'audit_store', state: 'available', asOf: now.toISOString(), note: 'proof' }],
    now
  });
}

const result = snapshot(collectedQueries);
const roomFunnel = result.funnels.find((funnel) => funnel.name === 'event_room_entry')!;
const followFunnel = result.funnels.find((funnel) => funnel.name === 'profile_follow')!;
const tipFunnel = result.funnels.find((funnel) => funnel.name === 'ticket_tip')!;
assert.equal(roomFunnel.entries, 3, 'Distinct eligible journeys only; duplicate event IDs and ineligible rows must not multiply counts.');
assert.equal(roomFunnel.actions, 2);
assert.equal(roomFunnel.completedOutcomes, 1, 'Client-correlated completed claims must not count as durable outcomes.');
assert.equal(roomFunnel.exclusions.ineligibleJourneys, 1);
assert.equal(roomFunnel.exclusions.actionsLackingPriorEntry, 1);
assert.equal(followFunnel.completedOutcomes, 0, 'An audit-only follow row is not durable follow state.');
assert.equal(followFunnel.actions, 0, 'An unused follow event name must not imply a real action surface.');
assert.equal(followFunnel.actionAvailability, 'unavailable_no_real_follow_action_surface');
assert.match(followFunnel.outcomeAvailability, /unavailable/);
assert.equal(tipFunnel.entries, 3);
assert.equal(tipFunnel.actions, 1);
assert.equal(tipFunnel.completedOutcomes, 1);
assert.match(tipFunnel.outcomeAvailabilityByAction.ticket, /unavailable/);
assert.match(tipFunnel.outcomeAvailabilityByAction.tip, /committed_durable_tip_state/);
assert.equal(result.quality.duplicateRowsExcluded, 1);
assert.equal(result.quality.futureRowsExcluded, 1);
assert.equal(result.quality.integrityRowsExcluded, 2);
assert.equal(result.quality.invalidExperimentOrderRowsExcluded, 1);
assert.deepEqual(result.repeatedOutsideSources, [{ source: 'Search result A', count: 1 }]);
assert.deepEqual(result.repeatedCompetitors, [{ competitor: 'Competitor A', count: 1 }]);
assert.ok(!result.discoverySources.some((source) => source.source === 'unknown'), 'Invalid/ineligible rows must not inflate eligible source views.');
assert.equal(result.unclaimedEntitiesReceivingDemand.state, 'unavailable');
assert.equal(result.unclaimedEntitiesReceivingDemand.count, null);
assert.equal(result.pagesWithImpressionsButNoActions.state, 'unavailable');
assert.equal(result.sourceAvailability[0]?.asOf, now.toISOString());

const measuredUnclaimed = buildDiscoveryObservatorySnapshot({
  auditRows,
  queryCollection: [],
  visibilitySchema: 'explicit_visibility_available',
  visibilityCounts: { eligible: 1, ineligible: 1, unknown: 0 },
  freshnessFailures: [],
  claimOwnershipSource: {
    state: 'available',
    asOf: now.toISOString(),
    unclaimedPublicEntities: [{ entityKind: 'performer', entityKey }]
  },
  now
});
assert.equal(measuredUnclaimed.unclaimedEntitiesReceivingDemand.state, 'measured');
assert.equal(measuredUnclaimed.unclaimedEntitiesReceivingDemand.count, 1);
assert.equal(measuredUnclaimed.unclaimedEntitiesReceivingDemand.entities[0]?.uniqueJourneys, 2);

const releaseQueries: DiscoveryQueryCandidate[] = Array.from({ length: 8 }, (_, index) => ({
  query: `Release ${index}`, kind: 'release_title', entityKind: 'release', entityKey: `release-${index}`,
  market: null, evidence: 'real_public_supply', timeSensitive: false, expiresAt: null
}));
assert.equal(snapshot(releaseQueries).experiments[0]?.key, 'sway-confirmed-release-credit-query-v1');
assert.equal(snapshot(releaseQueries, [{ reason: 'stale' }, { reason: 'stale' }, { reason: 'stale' }]).experiments[0]?.key, 'sway-time-sensitive-event-room-freshness-v1');

console.log('Sway Discovery Observatory behavior tests passed.');
