import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const dashboard = read('src/components/TalentDashboard.tsx');
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
  'DJ software library',
  'Spotify playlist',
  'Music uploaded to Sway',
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

for (const forbidden of ['PerformerShareKit', 'HardwareMappingPanel', 'Room tools', 'Current room only']) {
  if (sourcesWorkspace.includes(forbidden)) failures.push(`Account-level Sources screen must not contain room-only control: ${forbidden}`);
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

console.log('Performer Connections contract passed.');
