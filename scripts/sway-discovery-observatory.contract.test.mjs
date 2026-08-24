import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const server = read('server.ts');
const observatory = read('src/server/discovery-observatory.ts');
const store = read('src/server/discovery-observatory-store.ts');
const adminEntry = read('src/entries/admin.tsx');
const adminPage = read('src/shells/DiscoveryObservatoryPage.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
const attribution = read('src/shells/discoveryAttribution.ts');
const patronShared = read('src/shells/shared.tsx');
const discoverPage = read('src/components/PublicDiscoverPage.tsx');
const evidence = JSON.parse(read('docs/process/SWAY_DISCOVERY_OBSERVATORY_WAVE1_LOCAL_EVIDENCE.json'));
const packageJson = JSON.parse(read('package.json'));
const failures = [];

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(message);
}

for (const route of [
  "app.get('/api/admin/discovery-observatory'",
  "app.post('/api/admin/discovery-observatory/observations'",
  "app.post('/api/admin/discovery-observatory/experiments/:experimentKey/decision'"
]) {
  requireIncludes(server, route, `Missing Discovery Observatory route: ${route}`);
}
requireIncludes(server, "app.use('/admin/discovery-observatory'", 'The Observatory HTML boundary must be explicit.');
requireIncludes(server, 'accessControl.requireAdminAccess(req)', 'Observatory routes and HTML must require admin access.');
requireIncludes(adminEntry, "window.location.pathname === '/admin/discovery-observatory'", 'Admin entrypoint must route to the Observatory.');
requireIncludes(adminPage, 'Separate discovery funnels', 'Admin UI must show separate funnel views.');
for (const funnel of ['profile_follow', 'event_room_entry', 'ticket_tip']) {
  requireIncludes(observatory, `'${funnel}'`, `Snapshot must keep ${funnel} separate.`);
}
for (const semantic of [
  'An outside surface result independently recorded.',
  'An actual landing on Sway.',
  'A deliberate audience attempt.',
  'A durable follow, room, ticket, or tip result; never inferred from an action.',
  'A predeclared assignment with exactly one controlled change.'
]) {
  requireIncludes(observatory, semantic, `Missing verifier semantic: ${semantic}`);
}
for (const linkStrength of ['direct_server_observed', 'client_correlated_unverified', 'unknown_unavailable']) {
  requireIncludes(observatory, linkStrength, `Missing link-strength boundary: ${linkStrength}`);
}

const telemetryRoute = server.slice(server.indexOf('app.post("/api/analytics/shell"'), server.indexOf('function executeRows'));
requireIncludes(telemetryRoute, 'resolveReceiptBackedAttributionEvidence', 'Anonymous entry telemetry may be strengthened only by a signed server landing receipt.');
requireIncludes(telemetryRoute, "linkStrength: attributionEvidence?.linkStrength ?? 'client_correlated_unverified'", 'Caller-only anonymous telemetry must remain client-correlated.');
requireIncludes(telemetryRoute, 'readDiscoveryAttributionReceiptCookie', 'Anonymous entry strength must come from the HttpOnly receipt, not caller fields.');
requireIncludes(telemetryRoute, 'resolveDiscoveryEntityVisibilityEligibility', 'Client-claimed visibility must be resolved against current server state.');
requireIncludes(telemetryRoute, 'Client eligibility is never trusted', 'Funnel eligibility must fail closed at the telemetry boundary.');
requireIncludes(telemetryRoute, 'Anonymous shell telemetry cannot submit outcome evidence.', 'Anonymous completion claims must be rejected at the event allowlist.');
const telemetryStageMapper = telemetryRoute.slice(telemetryRoute.indexOf('function discoveryStageForTelemetryEvent'), telemetryRoute.indexOf('app.post("/api/analytics/shell"'));
if (telemetryStageMapper.includes('room_entry_completed') || telemetryStageMapper.includes('tip_action_completed')) failures.push('Anonymous outcome event names must not map into Observatory outcomes.');
requireIncludes(store, "normalized.outcome_status === 'completed' && normalized.link_strength !== 'direct_server_observed'", 'Store must reject spoofable completed outcomes.');
requireIncludes(server, 'recordDirectRoomDiscoveryOutcome', 'Authoritative active-room response must own room completion evidence.');
requireIncludes(server, 'recordDirectTipDiscoveryOutcome', 'Committed durable tip state must own tip completion evidence.');
requireIncludes(server, 'await idempotencyStore.completePendingAction', 'Tip evidence must follow durable action completion.');
requireIncludes(patronShared, "'x-sway-discovery-entry-once': '1'", 'Room proof must use the one-shot authoritative state boundary.');
requireIncludes(patronApp, 'discovery_journey_id: getOrCreateDiscoveryJourneyId()', 'Tip persistence must receive the pseudonymous journey ID.');
requireIncludes(attribution, 'window.sessionStorage.getItem(JOURNEY_ID_KEY)', 'Journey IDs must be session scoped.');
requireIncludes(attribution, 'window.localStorage.removeItem(JOURNEY_ID_KEY)', 'Old persistent journey IDs must be removed.');
if (attribution.includes('window.localStorage.setItem(JOURNEY_ID_KEY')) failures.push('Journey IDs must not persist in localStorage.');
requireIncludes(observatory, 'One pseudonymous top-level browser-tab session.', 'Dashboard must document the distinct-journey grain.');

if (patronApp.includes("sendDiscoveryEvent('discovery_primary_action'")) {
  failures.push('PatronApp must not fire a primary action from room page load.');
}
for (const componentPath of [
  'src/components/PerformerPublicProfilePage.tsx',
  'src/components/PublicEventPage.tsx',
  'src/components/PublicReleasePage.tsx',
  'src/components/PublicDiscoverPage.tsx'
]) {
  const component = read(componentPath);
  if (component.includes("sendDiscoveryEvent('discovery_primary_action'") && !component.includes('onClick')) {
    failures.push(`${componentPath} must only capture deliberate primary actions.`);
  }
}
requireIncludes(observatory, 'unavailable_no_real_follow_action_surface', 'Missing explicit unavailable follow-action state.');
requireIncludes(observatory, 'unavailable_until_durable_readable_follow_state_exists', 'Missing explicit unavailable durable-follow outcome state.');

for (const boundary of [
  'queryEvidenceState',
  'A known query requires a safe nonempty query.',
  'Unknown or unavailable query evidence requires query to be null.',
  'contact details, URLs, or long numeric identifiers',
  'searchPhrase',
  'competitors'
]) {
  requireIncludes(observatory, boundary, `Missing observation privacy/evidence boundary: ${boundary}`);
}
requireIncludes(observatory, 'JOURNEY_EVENT_TYPES', 'Journey event types must be runtime allowlisted.');
requireIncludes(observatory, 'eventType is not allowed for the', 'Stage/event mismatch must fail at runtime.');
requireIncludes(store, 'onConflictDoNothing({ target: auditEvents.eventId })', 'Concurrent idempotency must be enforced by the audit-event primary key.');
requireIncludes(store, '`attribution-receipt:${attributionReceiptId.toLowerCase()}`', 'Signed attribution receipts must have one global deterministic event identity.');
requireIncludes(store, 'throw new AttributionReceiptConflictError()', 'A receipt replay across journeys must fail closed.');
requireIncludes(store, 'experiment-assignment:', 'Experiment assignment must have a deterministic event ID.');
requireIncludes(observatory, 'discoveryExperimentVariant', 'Experiment cohort must be derived server-side from experiment and journey.');
requireIncludes(store, 'controlled_change_key: definition.controlledChangeKey', 'Assignment must persist immutable controlled-change identity.');
requireIncludes(store, 'Existing experiment assignment conflicts with the deterministic cohort contract.', 'Conflicting assignment replay must fail closed.');
requireIncludes(server, "key !== 'journey_id'", 'Public assignment endpoint must reject client-selected variant or change fields.');
requireIncludes(observatory, 'assignments:', 'Admin snapshot must expose control/treatment assignment counts.');
requireIncludes(store, 'Experiment assignment must precede journey evidence.', 'Experiment evidence must follow assignment.');
requireIncludes(observatory, 'invalidExperimentOrderRowsExcluded', 'Snapshot must reject invalid experiment order.');
requireIncludes(observatory, 'integrityRowsExcluded', 'Snapshot must expose journey/entity integrity exclusions.');
requireIncludes(observatory, 'actionsLackingPriorEntry', 'Snapshot must expose orphan actions.');
requireIncludes(observatory, 'outcomesLackingPriorAction', 'Snapshot must expose orphan outcomes.');
requireIncludes(observatory, 'visibility_eligibility', 'Funnel eligibility must be explicit.');
requireIncludes(observatory, 'new Set', 'Funnel denominators must be de-duplicated.');
requireIncludes(observatory, 'sourceFreshness(observedDate, now)', 'Observation freshness must be recomputed as of the dashboard read.');

requireIncludes(server, "column_name = 'visibility_state'", 'Visibility compatibility must inspect the existing schema without modifying it.');
requireIncludes(server, "sql.raw('p.visibility_state')", 'Explicit visibility must be read when present.');
requireIncludes(observatory, 'if (!room.performerId || !eligiblePerformerIds.has(room.performerId)) continue;', 'Room queries must fail closed without an eligible performer.');
requireIncludes(server, 'unknownPerformerRooms', 'Unknown room-performer eligibility must remain visible.');
requireIncludes(observatory, 'repeatedCompetitors', 'Competitor appearances must have a distinct aggregate.');
requireIncludes(observatory, "metadataString(metadata, 'result_state') === 'observed'", 'Only observed results may aggregate outside appearances.');
requireIncludes(observatory, 'unclaimedEntitiesReceivingDemand', 'Unclaimed demand must have an explicit state.');
requireIncludes(observatory, 'an empty list must not be read as zero', 'Unavailable unclaimed demand must not be presented as zero.');
requireIncludes(observatory, 'pagesWithImpressionsButNoActions', 'Impression-to-action gaps must remain a distinct operating view.');
requireIncludes(observatory, 'entries are shown separately and are not relabeled as impressions', 'Entry evidence must not be inferred to be impression evidence.');
requireIncludes(observatory, 'current_performer_owner_user_id', 'Trustworthy internal ownership state must drive measured unclaimed demand when available.');
for (const source of ['audit_store', 'current_public_supply', 'performer_visibility', 'performer_ownership', 'google_search_console', 'bing_webmaster_tools']) {
  requireIncludes(server, `source: '${source}'`, `Source-availability ledger missing ${source}.`);
}

assert.equal(evidence.automaticImport, false, 'Local evidence must never auto-import.');
assert.equal(evidence.productionMetric, false, 'Local evidence must never be a production metric.');
assert.equal(evidence.capturePrecision, 'day', 'Independent checks must preserve real day precision.');
assert.ok(evidence.observations.every((observation) => observation.locationContext === 'unknown'), 'Unknown capture location must remain explicit.');
const disposablePerformerName = ['DJ', '3X'].join('');
if (server.includes(`"${disposablePerformerName}" Sway performer`) || observatory.includes(disposablePerformerName)) {
  failures.push('A disposable performer baseline must not be hard-coded into production ranking or counts.');
}
requireIncludes(discoverPage, "sendDiscoveryEvent('internal_search_zero_result'", 'Internal zero results must come from a deliberate real search.');
requireIncludes(discoverPage, 'searchPhrase.trim()', 'Internal search phrase must come from the explicit search input.');
requireIncludes(observatory, 'matchingZeroResults', 'Experiment rank must use current stored zero-result evidence.');
requireIncludes(observatory, '.sort((left, right) => right.score - left.score', 'Experiment rank must be computed at runtime.');

const contracts = packageJson.scripts?.['test:contracts'] ?? '';
requireIncludes(contracts, 'sway-discovery-observatory.contract.test.mjs', 'Repository contract gate must include the Observatory contract.');
requireIncludes(packageJson.scripts?.['test:integration:discovery-observatory'] ?? '', 'sway-discovery-observatory.integration.test.ts', 'Package scripts must expose the disposable integration proof.');

if (failures.length) {
  console.error('Sway Discovery Observatory contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

execFileSync(process.execPath, ['--import', 'tsx', 'scripts/sway-discovery-observatory.behavior.test.ts'], {
  cwd: root,
  stdio: 'inherit'
});
console.log('Sway Discovery Observatory contract passed.');
