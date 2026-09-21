import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const dashboard = read('src/components/TalentDashboard.tsx');
const choices = read('src/components/PerformerSourceImportChoices.tsx');
const importer = read('src/music-file-import.ts');
const accountHome = read('src/components/PerformerAccountHome.tsx');
const shareKit = read('src/components/PerformerShareKit.tsx');
const routing = read('src/performer-workspace-routing.ts');
const safeNext = read('src/file-collaboration-routing.ts');
const schema = read('src/db/schema.ts');
const server = read('server.ts');
const packageJson = JSON.parse(read('package.json'));
const failures = [];
const linkedSourceSchema = schema.slice(
  schema.indexOf("export const performerLibrarySources = pgTable('performer_library_sources'"),
  schema.indexOf("export const performerLibraryTracks = pgTable('performer_library_tracks'")
);
const linkedSourceRoute = server.slice(
  server.indexOf("app.post('/api/talent/library/sources'"),
  server.indexOf("app.post('/api/talent/library/sources/:sourceId/rotate-key'")
);

for (const term of [
  "| 'connections'",
  "connections: '/talent/connections'",
  "if (normalizedPath === '/talent/connections') return 'connections'"
]) {
  if (!routing.includes(term)) failures.push(`Connections routing missing term: ${term}`);
}

for (const term of [
  "{ id: 'connections', label: 'Sources'",
  'data-sway-performer-connections-workspace="true"',
  'data-sway-open-room-tools="true"',
  'onClick={() => setRoomToolsExpanded(true)}',
  'role="dialog"',
  '<PerformerShareKit activeGigId={activeGigId} />',
  'Your music',
  'data-sway-linked-sources="true"',
  'Add each music source once. It stays on your account and is ready for every future room.',
  'Saved for every room',
  '<PerformerSourceImportChoices',
  'await importMusicFile({',
  'onDjLibraryFileImport={handleDjLibraryFileImport}',
  'Advanced: reusable booth computer helper',
  'musicStatus={musicReadinessStatus}',
  "const requestableTrackCount = catalogLibraryTracks.length + externalLibraryTracks.length",
  "const [linkedSourcesStatus, setLinkedSourcesStatus]",
  'Couldn’t check all of your saved music',
  'Your music was not removed.',
  'Sway uploads',
  'Saved request list',
  'onRetry={retrySavedMusic}',
  'data-sway-room-source-readiness="true"',
  'Add your music once before creating the room. Skip this for non-music rooms.',
  'data-sway-current-room-tools="true"',
  'This room only',
  'Your saved music sources are not changed here.',
  'Prepare VirtualDJ connection',
  'data-sway-dj-software-truth="true"',
  'OBS / Streamlabs',
  'Stream Deck / Companion',
  'Download Sway Booth for Windows',
  'data-sway-windows-booth-download="true"',
  'VirtualDJ on Windows',
  'VirtualDJ 2023+ Pro',
  'Serato · rekordbox · Traktor · djay',
  'Keyboard or MIDI transport controls'
]) {
  if (!dashboard.includes(term)) failures.push(`Connections workspace missing term: ${term}`);
}
for (const term of ['Apple Music / iTunes', 'Serato', 'rekordbox', 'Traktor', 'VirtualDJ', 'Mixxx', 'Local / USB playlists', 'Song list / setlist', 'Spotify playlist', 'Music uploaded to Sway', 'onChange={props.onDjLibraryFileImport}', 'onSubmit={props.onSpotifyPlaylistImport}', 'onClick={props.onOpenCatalog}']) {
  if (!choices.includes(term)) failures.push(`Actionable source choice missing: ${term}`);
}
for (const term of ["'/api/talent/library/import'", "'/api/talent/library/sources'", 'sourceKey: parsed.sourceKey', 'sourceLabel: parsed.sourceLabel', 'tracks: parsed.tracks', 'if (!confirm(', "data?.success !== true", "existing.syncKeyPreview !== 'file-import'"]) {
  if (!importer.includes(term)) failures.push(`Confirmed file import missing: ${term}`);
}

for (const term of [
  'ref={roomToolsTriggerRef}',
  'inert={roomToolsExpanded || Boolean(removeConfirmationRequest) ? true : undefined}',
  'closeButtonRef.current?.focus()',
  "event.key !== 'Tab'",
  'roomToolsTriggerRef.current?.focus()'
]) {
  if (!dashboard.includes(term)) failures.push(`Room Tools keyboard safety missing term: ${term}`);
}

for (const term of ['Add music for audience requests', 'Add or update music', "href: '/talent/connections'"]) {
  if (!accountHome.includes(term)) failures.push(`Performer Home source readiness missing term: ${term}`);
}

const sourcesWorkspaceStart = dashboard.indexOf('function PerformerConnectionsWorkspace');
const sourcesWorkspaceEnd = dashboard.indexOf('export default function TalentDashboard', sourcesWorkspaceStart);
const sourcesWorkspace = sourcesWorkspaceStart >= 0 && sourcesWorkspaceEnd > sourcesWorkspaceStart
  ? dashboard.slice(sourcesWorkspaceStart, sourcesWorkspaceEnd)
  : '';
if (!sourcesWorkspace.includes('<PerformerSourceImportChoices')) failures.push('The expanded chooser must be mounted in Sources, not left as an unused component.');
// Saved libraries stay account-owned. The separately bounded player section
// may use the shell's confirmed selected room; its runtime tests run below.
// Do not copy the live room's unrelated sharing/mapping dialog into libraries.
for (const forbidden of ['PerformerShareKit', 'HardwareMappingPanel', 'Room tools', 'Current room only']) {
  if (sourcesWorkspace.includes(forbidden)) failures.push(`Saved library workspace must not absorb unrelated room tools: ${forbidden}`);
}

const roomToolsButtonStart = dashboard.indexOf('data-sway-open-room-tools="true"');
const roomToolsButtonEnd = dashboard.indexOf('</button>', roomToolsButtonStart);
const roomToolsButton = roomToolsButtonStart >= 0 && roomToolsButtonEnd > roomToolsButtonStart
  ? dashboard.slice(roomToolsButtonStart, roomToolsButtonEnd)
  : '';
if (roomToolsButton.includes("openInactiveWorkspace('connections')")) {
  failures.push('Opening live Room Tools must stay in the live room instead of navigating to account-level Sources.');
}

for (const term of [
  'performerId: uuid(\'performer_id\')',
  'performer_library_sources_performer_source_idx'
]) {
  if (!linkedSourceSchema.includes(term)) failures.push(`Linked-source account scope missing term: ${term}`);
}

if (linkedSourceSchema.includes('gigId') || linkedSourceSchema.includes("'gig_id'")) {
  failures.push('Linked sources must belong to the performer account, not to an individual room.');
}

for (const term of [
  '.onConflictDoNothing({',
  'existing: true',
  "eq(performerLibrarySources.performerId, performerOwner.performerId)",
  'No relinking is needed.'
]) {
  const source = term === 'No relinking is needed.' ? dashboard : linkedSourceRoute;
  if (!source.includes(term)) failures.push(`Reusable linked-source behavior missing term: ${term}`);
}

if (linkedSourceRoute.includes('.onConflictDoUpdate(')) {
  failures.push('Re-submitting an existing linked source must not silently rotate its saved key.');
}

for (const forbidden of ['Armed now. Room actions begin', 'Room, stream & booth setup', 'data-sway-open-connections="true"']) {
  if (dashboard.includes(forbidden)) failures.push(`Connections workspace retains confusing default copy: ${forbidden}`);
}

for (const term of [
  'data-sway-streaming-outputs="true"',
  'Branded room screen',
  'Transparent OBS layer',
  "overlayUrl.searchParams.set('transparent', '1')",
  '1920×1080 OBS/Streamlabs Browser Source',
  'Copy URL',
  'Test'
]) {
  if (!shareKit.includes(term)) failures.push(`Streaming setup missing term: ${term}`);
}

if (!safeNext.includes("'/talent/connections'")) {
  failures.push('Login continuation allowlist must include /talent/connections.');
}

if (!(packageJson.scripts?.['test:contracts'] ?? '').includes('node scripts/sway-performer-connections.contract.test.mjs')) {
  failures.push('test:contracts must include the performer Connections contract.');
}

if (failures.length) {
  console.error('Performer Connections contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

// Player setup belongs to this already-registered Sources contract. No second
// hard-contract entry or optional helper can leave its behavioral proof out.
const wrapper = read('src/components/TalentDashboardWithSources.tsx');
const shell = read('src/shells/TalentApp.tsx');
const setup = read('src/components/PerformerSourcePlayerSetup.tsx');
assert(choices.includes('<PerformerSourcePlayerSetup />'), 'Sources must mount the actual player setup.');
assert(shell.includes('const TalentDashboard = withSourcePlayerContext(BaseTalentDashboard)'), 'The real performer shell must supply context while preserving the dashboard boundary.');
for (const required of ['props.activeGigId === gigId', "props.session.status === 'active'", '!props.roomActionsBlocked', 'profile?.owner_user_id', 'onSelectRoom: props.onSelectGigId', '<TalentDashboard {...props} />']) assert(wrapper.includes(required), required);
for (const required of ['context.accountId, context.performerId, context.gigId, context.ready, context.previewMode', 'lifetime.current !== scope', 'request.current?.abort()', 'busyRef.current', 'confirmReplacement', 'SourcePlayerAccessError', 'Date.parse(download.expiresAt) <= Date.now()', 'player connection is not confirmed yet', '<PerformerPlaybackController']) assert(setup.includes(required), required);
for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie', "'/api/state'"]) assert(!setup.includes(forbidden), forbidden);
for (const args of [
  ['--import', 'tsx', 'scripts/sway-spotify-catalog.behavior.test.ts'],
  ['--import', 'tsx', 'scripts/sway-spotify-current-route.behavior.test.mjs'],
  ['--import', 'tsx', 'scripts/sway-spotify-playlist-import.behavior.test.mjs'],
  ['--import', 'tsx', 'scripts/sway-spotify-playlist-store.integration.test.ts'],
  ['--import', 'tsx', 'scripts/sway-request-library-read.behavior.test.ts'],
  ['--import', 'tsx', 'scripts/sway-spotify-sources.browser.test.mjs'],
  ['--import', 'tsx', 'scripts/sway-source-player-setup.behavior.test.ts'],
  ['scripts/sway-source-player-setup.browser.test.mjs'],
  ['scripts/sway-sources-workspace-design.browser.test.mjs']
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 300_000, shell: false });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, 'Sources verification was interrupted.');
  assert.equal(result.status, 0, `Sources verification failed: ${args.join(' ')}`);
}
console.log('SOURCE_PLAYER_SETUP_CONTRACT_PASS');
console.log('Performer Connections contract passed.');
