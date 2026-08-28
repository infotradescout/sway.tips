import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const failures = [];

function requireTerms(source, label, terms) {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${label} is missing: ${term}`);
  }
}

function forbidPatterns(source, label, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(source)) failures.push(`${label} crosses the external-listing boundary: ${pattern}`);
  }
}

const schema = read('src/db/schema.ts');
const service = read('src/server/performer-event-service.ts');
const publicProfilePolicy = read('src/server/public-profile.ts');
const server = read('server.ts');
const manager = read('src/components/PerformerEventsManager.tsx');
const eventPage = read('src/components/PublicEventPage.tsx');
const discoverPage = read('src/components/PublicDiscoverPage.tsx');
const profilePage = read('src/components/PerformerPublicProfilePage.tsx');
const dashboard = read('src/components/TalentDashboard.tsx');
const workspaceRouting = read('src/performer-workspace-routing.ts');
const talentApp = read('src/shells/TalentApp.tsx');
const patronShell = read('src/shells/PatronApp.tsx');
const publicLanding = read('shells/public.html');
const laneRegistry = read('docs/REPO_LANES.md');
const eventPlan = read('docs/SWAY_EVENT_TICKETS_AND_PUBLIC_FEED_PLAN.md');
const laneMemo = read('docs/SWAY_FUTURE_LANE_EVENT_TICKET_SALES.md');

const migrationName = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .find((name) => read(`drizzle/${name}`).includes('CREATE TABLE "performer_events"'));
if (!migrationName) {
  failures.push('Generated performer_events migration is missing.');
}
const migration = migrationName ? read(`drizzle/${migrationName}`) : '';
const attendanceMigrationName = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^0038_.+\.sql$/.test(name))
  .find((name) => read(`drizzle/${name}`).includes('performer_event_attendance_mode'));
if (!attendanceMigrationName) failures.push('Generated performer attendance migration is missing.');
const attendanceMigration = attendanceMigrationName ? read(`drizzle/${attendanceMigrationName}`) : '';
const attendanceCompatibilityMigrationName = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^0039_.+\.sql$/.test(name))
  .find((name) => read(`drizzle/${name}`).includes('CREATE OR REPLACE FUNCTION "sway_sync_legacy_performer_event_attendance_mode"'));
if (!attendanceCompatibilityMigrationName) failures.push('Performer attendance compatibility follow-up migration is missing.');
const attendanceCompatibilityMigration = attendanceCompatibilityMigrationName
  ? read(`drizzle/${attendanceCompatibilityMigrationName}`)
  : '';

const eventSchemaStart = schema.indexOf("export const performerEvents = pgTable('performer_events'");
const eventSchemaEnd = schema.indexOf('// Native paid GA tickets', eventSchemaStart);
const eventSchema = eventSchemaStart >= 0 && eventSchemaEnd > eventSchemaStart
  ? schema.slice(eventSchemaStart, eventSchemaEnd)
  : '';

requireTerms(schema, 'Event schema', [
  "pgEnum('performer_event_status', ['draft', 'published', 'cancelled'])",
  "pgEnum('performer_event_visibility', ['public', 'unlisted'])",
  "pgEnum('performer_event_attendance_mode'",
  "export const performerEvents = pgTable('performer_events'",
  "performerId: uuid('performer_id').notNull().references(() => performers.id",
  "clientRequestId: uuid('client_request_id').notNull()",
  "createdByActorUserId: uuid('created_by_actor_user_id').notNull().references(() => users.id)",
  "lastMutationActorUserId: uuid('last_mutation_actor_user_id').notNull().references(() => users.id)",
  "uniqueIndex('performer_events_performer_client_request_idx')",
  "'performer_events_ends_after_starts'",
  "'performer_events_published_has_timestamp'",
  "'performer_events_published_attendance_ready'",
  "'performer_events_published_walk_in_has_location'",
  "'performer_events_attendance_mode_shape'",
  "'performer_events_cancelled_has_timestamp'",
  "'performer_events_cancelled_was_published'",
  "'performer_events_cancelled_has_reason'",
  "'performer_events_cover_image_uses_https'",
  "'performer_events_external_ticket_uses_https'",
  "'performer_events_external_ticket_shape'",
  "'performer_events_external_ticket_label_allowed'"
]);

requireTerms(attendanceMigration, 'Generated attendance migration', [
  'CREATE TYPE "public"."performer_event_attendance_mode"',
  'ADD COLUMN "attendance_mode" "performer_event_attendance_mode"',
  'CREATE FUNCTION "sway_sync_legacy_performer_event_attendance_mode"',
  'BEFORE INSERT OR UPDATE OF "ticketing_mode", "external_ticket_url", "external_ticket_label"',
  'WHERE "attendance_mode" IS NULL',
  'VALIDATE CONSTRAINT "performer_events_attendance_mode_not_null"',
  'ALTER COLUMN "attendance_mode" SET NOT NULL',
  'CONSTRAINT "performer_events_published_attendance_ready"',
  'CONSTRAINT "performer_events_published_walk_in_has_location"',
  'CONSTRAINT "performer_events_attendance_mode_shape"',
  'DROP CONSTRAINT "performer_events_published_has_external_ticket"'
]);

requireTerms(attendanceCompatibilityMigration, 'Attendance compatibility follow-up migration', [
  'CREATE OR REPLACE FUNCTION "sway_sync_legacy_performer_event_attendance_mode"',
  "NEW.attendance_mode = 'external_rsvp'",
  "NEW.attendance_mode = 'external_ticket'",
  "NEW.attendance_mode = 'walk_in'",
  'NULL;'
]);

requireTerms(migration, 'Generated event migration', [
  'CREATE TABLE "performer_events"',
  '"performer_id" uuid NOT NULL',
  '"client_request_id" uuid NOT NULL',
  'CONSTRAINT "performer_events_ends_after_starts"',
  '"ends_at" IS NULL OR "performer_events"."ends_at" > "performer_events"."starts_at"',
  'CONSTRAINT "performer_events_published_has_timestamp"',
  'CONSTRAINT "performer_events_published_has_external_ticket"',
  'CONSTRAINT "performer_events_cancelled_has_timestamp"',
  'CONSTRAINT "performer_events_cancelled_was_published"',
  'CONSTRAINT "performer_events_cancelled_has_reason"',
  'CONSTRAINT "performer_events_cover_image_uses_https"',
  'CONSTRAINT "performer_events_external_ticket_uses_https"',
  'CONSTRAINT "performer_events_external_ticket_shape"',
  'CONSTRAINT "performer_events_external_ticket_label_allowed"',
  'CREATE UNIQUE INDEX "performer_events_performer_client_request_idx"',
  'FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id")'
]);

forbidPatterns(`${eventSchema}\n${migration}`, 'Event persistence', [
  /\bvenue_id\b/i,
  /\bhost_(?:id|user_id)\b/i,
  /\bcapacity\b/i,
  /\binventory\b/i,
  /\bprice(?:_cents)?\b/i,
  /\bcurrency\b/i,
  /\bticket_orders?\b/i,
  /\bpayment_intent\b/i,
  /\badmission\b/i,
  /\bqr_token\b/i
]);

requireTerms(service, 'Event service', [
  'function normalizeEventValues',
  'function normalizeSafeHttpsUrl',
  "parsed.protocol !== 'https:'",
  'parsed.username',
  'parsed.password',
  'isUnsafeHostname(parsed.hostname)',
  "hostname === 'localhost'",
  "hostname.endsWith('.local')",
  "hostname.endsWith('.internal')",
  'function mappedIpv4FromIpv6',
  'if (mappedIpv4) return isPrivateIpv4(mappedIpv4)',
  'PUBLIC_EVENT_EXTERNAL_TICKET_LABELS',
  'PerformerEventAttendanceMode',
  'function normalizeAttendanceMode',
  "typeof value !== 'string'",
  'function attendanceModeForEvent',
  'function assertWalkInLocationReady',
  "'walk_in_location_required'",
  "'invalid_external_ticket_label'",
  'eq(performers.ownerUserId, actorUserId)',
  "serviceError(403, 'performer_owner_required'",
  'function sameIdempotentCreate',
  'eq(performerEvents.clientRequestId, input.clientRequestId)',
  'createdAt: now',
  'updatedAt: now',
  '.onConflictDoNothing()',
  "'event_idempotency_conflict'",
  "eventType: 'performer_event.create'",
  "eventType: 'performer_event.update'",
  "eventType: 'performer_event.publish'",
  "eventType: 'performer_event.cancel'",
  'if (!performer.isActive)',
  'function publicationCapabilityForPerformer',
  'function assertPerformerPublicationReady',
  "'performer_public_page_not_ready'",
  "requireOwnedPerformer(tx, input.performerId, input.actorUserId, true)",
  "'performer_inactive'",
  "'external_ticket_url_required'",
  'Add a public HTTPS ticket or RSVP link before publishing.',
  "['external_rsvp', 'external_ticket'].includes",
  '!normalized.externalTicketUrl',
  "'published_event_must_remain_active'",
  'const cancellationDeadline = current.endsAt ?? current.startsAt',
  "'event_already_ended'",
  "inArray(performerEvents.status, ['published', 'cancelled'])",
  'eq(performerEvents.status, \'published\')',
  "eq(performerEvents.visibility, 'public')",
  'gt(performerEvents.startsAt, now)',
  'eq(performers.isActive, true)',
  "notInArray(performers.onboardingStatus, ['restricted', 'suspended'])",
  'evaluatePublicEventPerformerEligibility',
  'locationName: row.event.locationIsTba ? null : row.event.locationName',
  'city: row.event.locationIsTba ? null : row.event.city',
  "externalTicketUrl: cancelled ? null : row.event.externalTicketUrl"
]);

forbidPatterns(service, 'Event service', [
  /\bdeleteEvent\b/,
  /\bStripe\b/,
  /\bpaymentIntent\b/,
  /\bchargeId\b/,
  /\brefundEvent\b/,
  /\bissueTicket\b/,
  /\bvalidateAdmission\b/,
  /\bvenueId\b/,
  /\bhostUserId\b/
]);

requireTerms(server, 'Performer event API', [
  'async function requirePerformerEventOwner',
  'applyNoStoreHeaders(res)',
  "console.error('Performer event owner lookup failed:', error)",
  "res.status(503).json({ error: 'Performer event access is temporarily unavailable.' })",
  'accessControl.requireTalentAccess(req)',
  'loadOwnedPerformerByActorUserId(talentAccess.actor.actorId)',
  "app.get('/api/talent/events'",
  "app.post('/api/talent/events'",
  "app.patch('/api/talent/events/:eventId'",
  "app.post('/api/talent/events/:eventId/publish'",
  "app.post('/api/talent/events/:eventId/cancel'",
  'clientRequestId: req.body?.clientRequestId',
  'attendanceMode: req.body?.attendanceMode',
  'expectedUpdatedAt: req.body?.expectedUpdatedAt',
  'idempotentReplay: !result.created',
  'publicationCapability',
  'publicationReach: event.publicationReach'
]);

requireTerms(server, 'Public event API', [
  "app.get('/api/public/events/:eventId'",
  "app.get('/api/public/events/:eventId/ticket'",
  "app.get('/api/public/feed'",
  "app.get('/api/public/performer/:handle'",
  "return res.status(503).json({ error: 'Public events are temporarily unavailable.' })",
  'performerEventService.getPublicEvent(req.params.eventId)',
  "event.status !== 'published'",
  '!event.externalTicketUrl',
  'new Date(event.startsAt).getTime() <= Date.now()',
  "normalizePublicEventHttpsUrl(event.externalTicketUrl, 'External attendance URL')",
  "res.setHeader('Referrer-Policy', 'no-referrer')",
  'return res.redirect(302, safeDestination)',
  'performerEventService.listPublicEvents({ limit: eventLimit })',
  'events: await Promise.all(publicEvents.map(toPublicEventResponseWithTicket))',
  'performerEventService.listPublicEvents({',
  'performerId: publicProfilePerformerId',
  'events: await Promise.all(publicEventRows.map(toPublicEventResponseWithTicket))'
]);

requireTerms(server, 'Public event response', [
  'eventPath: `/e/${event.id}`',
  "const externalTicketIsOpen = event.status === 'published'",
  'attendanceMode: event.attendanceMode',
  'externalTicket: externalTicketIsOpen && event.externalTicketUrl',
  'isPublicEventExternalTicketLabel(event.externalTicketLabel)',
  'performerPath: event.performer.handle ? `/p/${event.performer.handle}` : null',
]);
if (server.includes('recordPublicEventAudit')) {
  failures.push('Anonymous event reads must not create unbounded audit rows.');
}

requireTerms(server, 'Public event shell and share metadata', [
  "urlPath.startsWith('/r/') || urlPath.startsWith('/e/') || urlPath === '/discover'",
  "pathParts[0] === 'e'",
  'performerEventService.getPublicEvent(pathParts[1])',
  'async function renderPublicEventDocument',
  'buildPublicEventShareMetadata(req, event)',
  "event.performer.visibility === 'unlisted'",
  'title: `${event.title} on Sway`',
  'url: `/e/${event.id}`',
  'image: event.coverImageUrl || event.performer.avatarUrl || DEFAULT_SHARE_IMAGE_PATH',
  "robots: event.visibility === 'unlisted'",
  "'noindex, nofollow'"
]);
requireTerms(publicProfilePolicy, 'Public event performer eligibility policy', [
  "export type PublicEventPerformerAudience = 'discovery' | 'direct'",
  'export function evaluatePublicEventPerformerEligibility',
  "INTERNAL_TEST_PROFILE_HANDLES = ['platynum-47']",
  "handle !== handle.trim()",
  'isDiscoveryEligibleHandle(input.handle)',
  "input.audience === 'direct' || policy.visibility === 'public'",
  "typeof input.bio !== 'string' || !input.bio.trim()"
]);
const observatoryEventQuery = server.slice(
  server.indexOf('async function loadSwayDiscoverySupply'),
  server.indexOf('const publicReleases =', server.indexOf('async function loadSwayDiscoverySupply'))
);
requireTerms(observatoryEventQuery, 'Pre-limit observatory event exclusion', [
  'notInArray(sql<string>`lower(trim(${performers.handle}))`, [...INTERNAL_TEST_PROFILE_HANDLES])',
  '.orderBy(asc(performerEvents.startsAt)).limit(100)',
  'attendanceMode: performerEvents.attendanceMode'
]);
requireTerms(server, 'Truthful observatory ticket supply', [
  "ticketAvailable: event.attendanceMode === 'external_ticket' && Boolean(event.externalTicketUrl)"
]);
requireTerms(server, 'Public event discovery eligibility handoffs', [
  'evaluatePublicEventPerformerEligibility({',
  "audience: 'discovery'",
  "audience: 'direct'",
  ".innerJoin(performers, eq(performers.id, performerEvents.performerId))",
  'INTERNAL_TEST_PROFILE_HANDLES',
  'notInArray(sql<string>`lower(trim(${performers.handle}))`, [...INTERNAL_TEST_PROFILE_HANDLES])',
  "notInArray(performers.onboardingStatus, ['restricted', 'suspended'])"
]);
requireTerms(service, 'Pre-limit internal-test event exclusion', [
  'INTERNAL_TEST_PROFILE_HANDLES',
  'sql`${performers.handle} = trim(${performers.handle})`',
  'notInArray(sql<string>`lower(trim(${performers.handle}))`, [...INTERNAL_TEST_PROFILE_HANDLES])'
]);

const performerEventRouteSource = server.slice(
  server.indexOf("app.get('/api/talent/events'"),
  server.indexOf("app.get('/api/talent/profile/public'")
);
const performerEventRouteCount = performerEventRouteSource
  .match(/app\.(?:get|post|put|patch|delete)\('\/api\/talent\/events(?:\/[^']*)?'/g)?.length ?? 0;
const ownerGateCount = performerEventRouteSource
  .match(/requirePerformerEventOwner\(req, res\)/g)?.length ?? 0;
if (performerEventRouteCount < 9 || ownerGateCount !== performerEventRouteCount) {
  failures.push(
    `Every performer event route must use the performer-owner gate `
      + `(routes ${performerEventRouteCount}, gates ${ownerGateCount}).`
  );
}

const feedRoute = server.slice(
  server.indexOf("app.get('/api/public/feed'"),
  server.indexOf("app.get('/api/public/performer/:handle/share-card.png'")
);
if (feedRoute.includes("return res.json({ rooms: [] });")) {
  failures.push('Public feed must not return rooms alone and hide independently available events.');
}
if (!/return res\.json\(\{[\s\S]*rooms:[\s\S]*events:/.test(feedRoute)) {
  failures.push('Public feed must return both rooms and events.');
}

requireTerms(manager, 'Performer event manager', [
  'data-sway-events-manager="true"',
  "fetch('/api/talent/events'",
  '`/api/talent/events/${encodeURIComponent(event.id)}/publish`',
  '`/api/talent/events/${encodeURIComponent(event.id)}/cancel`',
  "type AttendanceMode = 'walk_in' | 'external_rsvp' | 'external_ticket' | 'native_ticket'",
  "attendanceMode: 'walk_in'",
  "const EXTERNAL_TICKET_LABELS = ['Get tickets', 'View details']",
  'Walk-in · admission handled at the venue',
  'No Sway ticket or RSVP link.',
  'Location TBA prevents walk-in publishing',
  'function hasExternalAttendanceLink',
  'Cancelling here removes the walk-in attendance action from Sway.',
  'externalProviderConfirmed',
  'normalizePublicationCapability',
  'effectivePublicationReach',
  'Finish Public Page',
  'focusStatusMessage()',
  'statusMessageRef',
  '`/api/public/events/${encodeURIComponent(event.id)}/ticket`'
]);
const publicationCapabilityNormalizer = manager.slice(
  manager.indexOf('function normalizePublicationCapability'),
  manager.indexOf('function zonedParts', manager.indexOf('function normalizePublicationCapability'))
);
requireTerms(publicationCapabilityNormalizer, 'Fail-closed publication capability normalization', [
  "if (!value || typeof value !== 'object') return null;",
  "if (typeof value.canPublish !== 'boolean') return null;",
  "value.reach === 'discover' || value.reach === 'link_only'",
  'if (value.canPublish && !reach) return null;'
]);
requireTerms(manager, 'Fail-closed publication readiness UI', [
  'setPublicationCapability(normalizePublicationCapability(data?.publicationCapability));',
  'publicationCapability?.canPublish !== true || !publicationCapability.reach',
  'Publication readiness is unavailable. Reload Shows before publishing.',
  'Publish unavailable'
]);
requireTerms(manager, 'Link-only publication copy', [
  "event.visibility === 'unlisted' || publicationCapability.reach === 'link_only'",
  'Event published as link-only. Share its event-page URL directly.',
  'Public Page + direct link (not Discover)',
  '<option value="unlisted">Link only</option>',
  'Publish link-only'
]);
requireTerms(manager, 'Performer event editor focus recovery', [
  "document.getElementById('sway-event-title')?.focus({ preventScroll: true })",
  'restoreEditorTriggerFocus()',
  'onClick={closeEventEditor}',
  'scroll-mt-32'
]);
const profileWorkspaceStart = dashboard.indexOf("inactiveWorkspace === 'profile'");
const showsWorkspaceStart = dashboard.indexOf("inactiveWorkspace === 'shows'", profileWorkspaceStart);
const libraryWorkspaceStart = dashboard.indexOf("inactiveWorkspace === 'library'", showsWorkspaceStart);
const profileWorkspace = dashboard.slice(profileWorkspaceStart, showsWorkspaceStart);
const showsWorkspace = dashboard.slice(showsWorkspaceStart, libraryWorkspaceStart);
if (profileWorkspaceStart < 0 || showsWorkspaceStart < 0 || libraryWorkspaceStart < 0) {
  failures.push('Talent dashboard must define separate Profile and Shows workspaces.');
} else {
  if (!profileWorkspace.includes('<PerformerPublicProfileEditor') || profileWorkspace.includes('<PerformerEventsManager')) {
    failures.push('Profile workspace must contain profile editing only.');
  }
  if (!showsWorkspace.includes('<PerformerEventsManager previewMode={previewMode} />') || showsWorkspace.includes('<PerformerPublicProfileEditor')) {
    failures.push('Shows workspace must own event management separately from Profile.');
  }
}
requireTerms(dashboard, 'Performer Shows navigation', [
  "{ id: 'shows', label: 'Shows'",
  "{ id: 'profile', label: 'Public Page'",
  "{ id: 'account', label: 'Money'",
  "openInactiveWorkspace('shows')",
  'window.history.pushState',
  'window.history.replaceState',
  "window.addEventListener('popstate'",
  "window.addEventListener('hashchange'"
]);
requireTerms(workspaceRouting, 'Performer workspace paths', [
  "shows: '/talent/shows'",
  "profile: '/talent/profile'",
  "LEGACY_SHOWS_WORKSPACE_HASH = '#sway-events-manager'",
  "if (hash === LEGACY_SHOWS_WORKSPACE_HASH) return 'shows'"
]);
requireTerms(talentApp, 'Legacy Shows login continuation', [
  'resolvePerformerLoginWorkspaceRedirect(legacyRedirect, outerHash)'
]);
const eventLoadSource = manager.slice(
  manager.indexOf('const loadEvents = async'),
  manager.indexOf('useEffect(() =>', manager.indexOf('const loadEvents = async'))
);
if (eventLoadSource.includes('/api/talent/events/native-ticket-capability')) {
  failures.push('Ordinary event-list loading must not depend on native-ticket capability readiness.');
}
if (!manager.includes("nativeCapability?.salesAvailable === true || form.ticketingMode === 'native_ga'")) {
  failures.push('Native ticket selection must stay hidden unless it is available or already configured.');
}
const capabilityRoute = server.slice(
  server.indexOf("app.get('/api/talent/events/native-ticket-capability'"),
  server.indexOf("app.post('/api/talent/events'", server.indexOf("app.get('/api/talent/events/native-ticket-capability'"))
);
requireTerms(capabilityRoute, 'Native-ticket capability failure response', [
  'if (!owner) return;',
  'if (!eventTicketService)',
  "code: 'native_ticket_readiness_unavailable'",
  'return res.status(503).json'
]);
if (!publicLanding.includes('href="/discover">Discover shows</a>')) {
  failures.push('Public landing must provide a direct discovery entry point.');
}

requireTerms(eventPage, 'Public event page', [
  "fetch(`/api/public/events/${encodeURIComponent(eventId)}`",
  'return `/api/public/events/${encodeURIComponent(eventId)}/ticket`',
  'You are leaving Sway.',
  'handled under the external ticket provider',
  'function resolvedAttendanceMode',
  'function attendanceModeLabel',
  'Walk-in · admission handled at the venue',
  'No Sway ticket or RSVP link. Contact the performer or venue for admission details.',
  'The listed attendance action is unavailable. Contact the performer or venue for details.',
  'function externalTicketCtaLabel',
  'function externalAttendanceSiteLabel',
  "attendanceMode === 'external_rsvp' ? 'other' : 'ticket'",
  'opens in a new tab',
  'isEventCancelled'
]);
if (/\bfree\b/i.test(`${manager}\n${eventPage}`)) {
  failures.push('Walk-in UI must not make a free-admission or price claim.');
}
requireTerms(discoverPage, 'Public discovery page', [
  "fetch('/api/public/feed'",
  'Array.isArray(data.events)',
  '<PublicEventCard',
  'No live rooms or upcoming shows right now'
]);
requireTerms(profilePage, 'Public performer profile events', [
  'events?: PublicEventDto[]',
  'setEvents(Array.isArray(data.events) ? data.events : [])',
  '<PublicEventCard'
]);
requireTerms(patronShell, 'Public event routes', [
  "if (pathname === '/discover') return { name: 'discover' }",
  "if (parts[0] === 'e' && parts[1]) return { name: 'event', eventId: parts[1] }",
  "if (route.name === 'event') return <PublicEventPage eventId={route.eventId} />",
  "if (route.name === 'discover') return <PublicDiscoverPage />"
]);

const eventRuntime = [
  eventSchema,
  service,
  manager,
  eventPage,
  discoverPage
].join('\n');
forbidPatterns(eventRuntime, 'Activated event-listing runtime', [
  /\bvenueId\b/,
  /\bvenueAccount\b/,
  /\bhostUserId\b/
]);

requireTerms(laneRegistry, 'Repository lane registry', [
  '| `public-event-listings` |',
  'The `public-event-listings` slice was activated on 2026-07-26.',
  'Performer is the only seller-side product actor.',
  'Sway does not sell the external ticket',
  '| `event-tickets-native-ga` |'
]);
requireTerms(eventPlan, 'Event listing plan', [
  '**Status:** Walk-in and external listings are active. Native paid-GA v1 implementation is active behind a fail-closed production sales gate.',
  'Performer is the only seller-side product actor.',
  'The merged external-listing product does **not** sell tickets.',
  'A direct `/e/:eventId` page may preserve a truthful public/unlisted previously published event',
  'Walk-in publication requires a non-TBA location name plus either a street address or city.',
  'External ticket URLs must be safe HTTPS handoffs.',
  'No location or venue field creates a venue actor, account, dashboard, or authority boundary.'
]);
requireTerms(laneMemo, 'Event lane memo', [
  '**Status:** Walk-in and external event listings are active. The first native paid-GA implementation slice is authorized but production sales remain fail-closed.',
  'The performer remains the seller-side product actor',
  'An external link is a handoff only.',
  'No marketing or readiness record may call native sales production-ready'
]);

if (failures.length) {
  console.error('Public event listings contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

for (const [label, script] of [
  ['workspace routing', 'scripts/sway-performer-workspace-routing.behavior.test.ts'],
  ['behavior', 'scripts/sway-public-event-listings.behavior.test.ts'],
  ['integration', 'scripts/sway-public-event-listings.integration.test.ts'],
  ['attendance migration integration', 'scripts/sway-performer-event-attendance-migration.integration.test.ts']
]) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(root, script)],
    { cwd: root, encoding: 'utf8' }
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(`Public event listings ${label} gate failed with status ${result.status ?? 'unknown'}.`);
    process.exit(1);
  }
}

console.log(`Public event listings contract passed (${migrationName}).`);
