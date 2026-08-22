import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const schema = read('src/db/schema.ts');
const server = read('server.ts');
const policy = read('src/server/live-room-menu-policy.ts');
const capabilityAuthorization = read('src/server/talent-capability-authorization.ts');
const moderation = read('src/server/moderation-service.ts');
const eventService = read('src/server/performer-event-service.ts');
const store = read('src/server/business-store.ts');
const publicState = read('src/server/public-room-state.ts');
const roomSetup = read('src/components/PerformerRoomSetup.tsx');
const patronView = read('src/components/PatronView.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
const eventPage = read('src/components/PublicEventPage.tsx');
const browserHarness = read('scripts/browser-fixtures/sway-generalized-live-room-harness.tsx');
const browserProof = read('scripts/sway-generalized-live-room.browser.test.ts');
const httpPostgresProofSource = read('scripts/sway-generalized-live-room.integration.test.mjs');

function requireTerms(source, label, terms) {
  for (const term of terms) {
    assert.equal(source.includes(term), true, `${label} is missing: ${term}`);
  }
}

requireTerms(schema, 'Generalized live-room schema', [
  "export const liveRoomTypeEnum = pgEnum('live_room_type', [",
  "export const performerEventAttendanceModeEnum = pgEnum('performer_event_attendance_mode', [",
  "roomType: liveRoomTypeEnum('room_type').notNull().default('music')",
  "linkedEventId: uuid('linked_event_id')",
  "requestMenu: jsonb('request_menu')",
  "uniqueIndex('gig_sessions_active_linked_event_idx')",
  "uniqueIndex('moderation_events_dedupe_key_idx')",
  "name: 'gig_sessions_linked_event_owner_fk'",
  "'gig_sessions_request_menu_shape'",
  "'performer_events_published_attendance_ready'",
  "'performer_events_published_walk_in_has_location'",
  "'performer_events_attendance_mode_shape'"
]);

const migrationName = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .find((name) => read(`drizzle/${name}`).includes('CREATE TYPE "public"."live_room_type"'));
assert.ok(migrationName, 'Generated generalized live-room migration is missing.');
const migration = read(`drizzle/${migrationName}`);
requireTerms(migration, 'Generalized live-room migration', [
  'CREATE TYPE "public"."live_room_type" AS ENUM(\'music\', \'comedy\', \'service\', \'general\')',
  'CREATE TYPE "public"."performer_event_attendance_mode"',
  'ADD COLUMN "room_type" "live_room_type" DEFAULT \'music\' NOT NULL',
  'ADD COLUMN "linked_event_id" uuid',
  'ADD COLUMN "request_menu" jsonb DEFAULT \'[]\'::jsonb NOT NULL',
  'ADD COLUMN "dedupe_key" text',
  'CREATE UNIQUE INDEX "moderation_events_dedupe_key_idx"',
  'UPDATE "performer_events"',
  'WHEN "ticketing_mode" = \'native_ga\' THEN \'native_ticket\'',
  'WHEN "external_ticket_label" = \'RSVP\' THEN \'external_rsvp\'',
  'CONSTRAINT "gig_sessions_linked_event_owner_fk" FOREIGN KEY ("linked_event_id","performer_id")',
  'CREATE UNIQUE INDEX "gig_sessions_active_linked_event_idx"',
  'CONSTRAINT "gig_sessions_request_menu_shape"',
  'CONSTRAINT "performer_events_published_attendance_ready"',
  'CONSTRAINT "performer_events_published_walk_in_has_location"',
  'sway_sync_legacy_performer_event_attendance_mode',
  'performers_wave4_baseline_capabilities',
  'performer_events_10_grant_owner_authority',
  'gig_sessions_capability_guard',
  'performer_events_90_enforce_capabilities',
  'CONSTRAINT "performer_events_attendance_mode_shape"'
]);
assert.ok(
  migration.indexOf('UPDATE "performer_events"') < migration.indexOf('CONSTRAINT "performer_events_attendance_mode_shape"'),
  'Legacy events must be backfilled before the attendance-shape constraint is installed.'
);

requireTerms(policy, 'Room menu policy', [
  'const MAX_ROOM_MENU_ITEMS = 8',
  'room_menu_money_claim_not_allowed',
  'room_menu_regulated_offer_not_allowed',
  'room_menu_unsafe_offer_not_allowed',
  'duplicate_room_menu_id',
  'resolveRoomRequestSelection',
  'room_menu_item_not_available',
  'room_request_target_mismatch'
]);
requireTerms(server, 'Generalized room server authority', [
  'normalizeRoomRequestMenu(requestMenu, normalizedRoomType)',
  "code: 'non_music_room_money_not_available'",
  "code: 'idempotency_identity_mismatch'",
  'clientRequestId: client_request_id',
  'patronDeviceIdHash: resolvedPatronDeviceIdHash',
  'performerEventService.getOwnedEvent({',
  '!isPerformerEventRoomLinkEligible(ownedEvent)',
  "code: 'linked_event_room_already_active'",
  'resolveRoomRequestSelection({',
  'menuItemId: menu_item_id',
  'menuItem?.title ?? normalizeLibraryText(title, 160)',
  'menuItem?.description ?? normalizeLibraryText(subtitle, 500)',
  'text: `${canonicalTitle} ${canonicalSubtitle} ${message || \'\'}`',
  'requestMenuItemIds: roomState.session.requestMenu.map((item) => item.id)'
]);
requireTerms(`${store}\n${server}`, 'Retryable linked-event room closeout', [
  'ROOM_CLOSEOUT_EVENT_LIFECYCLE_RETRY_DELAYS_MS',
  'isEventLifecycleRetryConflict',
  "status: 'retryable_conflict'",
  'Every retry starts a new transaction',
  'writeAuditEvent(tx, {',
  "barrier.status === 'retryable_conflict'",
  "code: 'room_event_lifecycle_retry_required'",
  "status: 'barrier_retryable'"
]);
requireTerms(httpPostgresProofSource, 'Strict HTTP closeout lifecycle proof', [
  'proveHttpCloseoutEventLifecycleRetry',
  "if (proof.kind === 'real-postgres')",
  "select sway_event_room_link_lock($1::uuid)",
  "assertStatus(conflicted, 409",
  "conflicted.body.code, 'room_event_lifecycle_retry_required'",
  "truth.status, 'closeout_pending'",
  'truth.audit_count), 1',
  'truth.payment_operation_count), 0',
  "new HttpClient(server.baseUrl).get('/api/health/network-probe')"
]);
requireTerms(`${capabilityAuthorization}\n${server}`, 'Current talent authorization', [
  'requireCapability',
  'requireEventOrganizerAuthority',
  "'live_rooms'",
  "'event_publication'",
  "'external_ticket_links'",
  'requireCurrentEventOrganizerAuthority'
]);
requireTerms(`${moderation}\n${server}`, 'Room menu moderation and reporting', [
  'recordRoomMenuReview',
  'recordRoomMenuReport',
  "code: 'room_menu_blocked'",
  "code: 'room_menu_review_required'",
  "moderation_action: 'room_menu_report_submitted'",
  "moderation_action: 'room_menu_report_already_submitted'",
  "code: 'room_menu_report_rate_limited'",
  'pg_advisory_xact_lock',
  'DEFAULT_ROOM_MENU_REPORT_RETENTION_DAYS',
  'roomMenuReportUtcWindowStart',
  'pruneExpiredRoomMenuReports',
  'continuationRequired',
  'onConflictDoNothing'
]);
requireTerms(eventService, 'Canonical event-room timing', [
  'PERFORMER_EVENT_ROOM_LINK_OPEN_BEFORE_MS',
  'PERFORMER_EVENT_ROOM_LINK_DEFAULT_DURATION_MS',
  'isPerformerEventWithinRoomLinkWindow',
  'hasActionableWalkInLocation'
]);
requireTerms(store, 'Durable room restoration', [
  'roomType: gigSessions.roomType',
  'linkedEventId: gigSessions.linkedEventId',
  'requestMenu: gigSessions.requestMenu',
  'restoredSession.roomType = normalizeLiveRoomType(sessionRow.roomType)',
  'restoredSession.requestMenu = normalizeRoomRequestMenu(',
  'isPerformerEventRoomLinkEligible({',
  'status: sessionRow.linkedEventStatus',
  'linkedEventId: session.linkedEventId',
  'requestMenu: session.requestMenu'
]);
requireTerms(publicState, 'Public room projection', [
  'roomType: inputState.session.roomType',
  'requestMenu: inputState.session.requestMenu',
  'linkedEvent: inputState.session.linkedEvent'
]);
requireTerms(`${server}\n${patronView}\n${patronApp}`, 'Room-scoped degraded recovery', [
  '`sway.pendingAction:${gigId ?? \'missing-room\'}`',
  'const storedPendingAction = readPendingAction(localStorage, pendingActionStorageKey);',
  'identity.gigId !== gigId',
  'expected_gig_id: expectedGigId',
  "code: 'pending_action_room_mismatch'",
  'resolveTrustedLegacyReconciliationGigId',
  "code: 'legacy_room_scope_required'",
  "'trusted_route_legacy'"
]);
requireTerms(patronView, 'Wave 4 patron client boundaries', [
  "LEGACY_PENDING_ACTION_STORAGE_KEY = 'sway.pendingAction'",
  'migrateLegacyPendingActionForRoom(',
  'parsed?.gigId !== gigId',
  'storage.setItem(roomKey, legacyAction)',
  'storage.getItem(LEGACY_PENDING_ACTION_STORAGE_KEY) === legacyAction',
  'data-sway-report-menu-item',
  'onReportMenuItem(',
  "'Host menu item safety report'",
  "requestMenuLabel: 'Comedy request menu'",
  "requestMenuLabel: 'Service request menu'",
  "requestMenuLabel: 'Professional request menu'"
]);
assert.match(
  patronApp,
  /postJson\('\/api\/moderation\/report',\s*\{\s*\n\s*gig_id: gigId,\s*\n\s*menu_item_id: menuItemId,\s*\n\s*reason,\s*\n\s*details\s*\n\s*\}\)/,
  'Patron shell must send the exact room-menu report API fields.'
);
requireTerms(patronApp, 'Room-menu report callback wiring', [
  'onReportMenuItem={handleReportMenuItem}'
]);
requireTerms(browserHarness, 'Room-menu report browser harness', [
  'setReportProof({ gig_id: gigId, menu_item_id: menuItemId, reason, details })',
  "moderation_action: 'room_menu_report_submitted'"
]);
requireTerms(browserProof, 'Wave 4 client browser proof', [
  'width: 320',
  'width: 390',
  'width: 430',
  "legacyMode: 'foreign'",
  "legacyMode: 'room-and-foreign'",
  "legacyMode: 'matching'",
  'A legacy action belonging to another room must remain untouched.',
  'Matching legacy action must migrate into the current room key.',
  'Fixture menu title must exercise realistic long content.',
  'room must not expose music-only performer, DJ, or track language.'
]);
requireTerms(roomSetup, 'Professional room setup', [
  "{ id: 'comedy', label: 'Comedy'",
  "{ id: 'service', label: 'Service'",
  "{ id: 'general', label: 'General'",
  'This room is free-only. Requests and upvotes work; tips, paid requests, and paid boosts stay off.',
  'Link an event — optional',
  'Native ticket sales remain outside this release.'
]);
requireTerms(eventPage, 'Truthful event attendance and room join', [
  "attendanceMode: 'walk_in' | 'external_rsvp' | 'external_ticket' | 'native_ticket'",
  'Walk in · no ticket required',
  'Join live room',
  'No Sway ticket or RSVP is required.'
]);

for (const unsafeUiDefault of [
  /\bfree drink\b/i,
  /\bbuy a drink\b/i,
  /\bskip the line\b/i,
  /\bfire stunt\b/i,
  /\bdangerous stunt\b/i
]) {
  assert.equal(
    unsafeUiDefault.test(`${roomSetup}\n${patronView}`),
    false,
    `Production room UI contains an unsafe hardcoded offer: ${unsafeUiDefault}`
  );
}

const clientContract = spawnSync(
  process.execPath,
  [join(root, 'scripts/sway-wave4-client.contract.test.mjs')],
  { cwd: root, encoding: 'utf8' }
);
if (clientContract.stdout) process.stdout.write(clientContract.stdout);
if (clientContract.stderr) process.stderr.write(clientContract.stderr);
if (clientContract.status !== 0) {
  console.error('Wave 4 client contract failed.');
  process.exit(1);
}

const behavior = spawnSync(
  process.execPath,
  ['--import', 'tsx', join(root, 'scripts/sway-generalized-live-room.behavior.test.ts')],
  { cwd: root, encoding: 'utf8' }
);
if (behavior.stdout) process.stdout.write(behavior.stdout);
if (behavior.stderr) process.stderr.write(behavior.stderr);
if (behavior.status !== 0) {
  console.error('Generalized live-room behavior proof failed.');
  process.exit(1);
}

const browserJourney = spawnSync(
  process.execPath,
  ['--import', 'tsx', join(root, 'scripts/sway-generalized-live-room.browser.test.ts')],
  { cwd: root, encoding: 'utf8' }
);
if (browserJourney.stdout) process.stdout.write(browserJourney.stdout);
if (browserJourney.stderr) process.stderr.write(browserJourney.stderr);
if (browserJourney.status !== 0) {
  console.error('Generalized live-room mobile browser journey failed.');
  process.exit(1);
}

const httpPostgresProof = spawnSync(
  process.execPath,
  ['--import', 'tsx', join(root, 'scripts/sway-generalized-live-room.integration.test.mjs')],
  { cwd: root, encoding: 'utf8' }
);
if (httpPostgresProof.stdout) process.stdout.write(httpPostgresProof.stdout);
if (httpPostgresProof.stderr) process.stderr.write(httpPostgresProof.stderr);
if (httpPostgresProof.status !== 0) {
  console.error('Generalized live-room HTTP/PostgreSQL proof failed.');
  process.exit(1);
}

console.log(`Sway generalized live-room contract passed (${migrationName}).`);
