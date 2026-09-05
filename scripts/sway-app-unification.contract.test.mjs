import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const failures = [];

const language = read('src/live-room-language.ts');
const surfaces = {
  patron: read('src/components/PatronView.tsx'),
  patronShell: read('src/shells/PatronApp.tsx'),
  performer: read('src/components/TalentDashboard.tsx'),
  performerShell: read('src/shells/TalentApp.tsx'),
  controls: read('src/components/PerformerRoomControls.tsx'),
  share: read('src/components/PerformerRoomShare.tsx'),
  audience: read('src/components/PerformerAudienceScreen.tsx'),
  overlay: read('src/shells/OverlayApp.tsx')
};
const server = read('server.ts');
const demoFixture = JSON.parse(read('fixtures/demo/sway-demo-fixtures.json'));

for (const term of [
  "liveRoom: 'Live Room'",
  "request: 'Request'",
  "tip: 'Tip'",
  "boost: 'Boost'",
  "pending: 'Pending'",
  "approved: 'Approved'",
  "nowPlaying: 'Now Playing'",
  "upNext: 'Up Next'",
  "paused: 'Paused'",
  "ended: 'Ended'",
  "requestSource: 'Request source'",
  "directTip: 'Direct Tip'",
  "audienceRoom: 'Audience Room'",
  "roomScreen: 'Room Screen'",
  "shareRoom: 'Share Room'",
  "pauseRequests: 'Pause Requests'",
  "resumeRequests: 'Resume Requests'",
  "endRoom: 'End Room'"
]) {
  if (!language.includes(term)) failures.push(`Shared Live Room language is missing: ${term}`);
}

for (const [label, source] of Object.entries(surfaces)) {
  if (!source.includes('live-room-language')) {
    failures.push(`${label} surface must consume the shared Live Room language.`);
  }
}

for (const [label, source, term] of [
  ['patron shell', surfaces.patronShell, 'LIVE_ROOM_ACTION_LIST'],
  ['audience screen', surfaces.audience, 'LIVE_ROOM_ACTION_SLASH'],
  ['overlay', surfaces.overlay, 'LIVE_ROOM_ACTION_SLASH'],
  ['performer', surfaces.performer, 'LIVE_ROOM_LANGUAGE.pending'],
  ['performer', surfaces.performer, 'LIVE_ROOM_LANGUAGE.approved'],
  ['patron', surfaces.patron, 'LIVE_ROOM_LANGUAGE.directTip'],
  ['patron', surfaces.patron, 'LIVE_ROOM_LANGUAGE.paused'],
  ['patron', surfaces.patron, 'LIVE_ROOM_LANGUAGE.ended'],
  ['controls', surfaces.controls, 'LIVE_ROOM_LANGUAGE.requestSource'],
  ['audience screen', surfaces.audience, 'resolveLiveRoomModeCopy(session.operatingMode)'],
  ['overlay', surfaces.overlay, 'resolveLiveRoomModeCopy(bState.session.operatingMode)'],
  ['share', surfaces.share, 'LIVE_ROOM_LANGUAGE.audienceRoom']
]) {
  if (!source.includes(term)) failures.push(`${label} surface must use ${term}.`);
}

const visibleSurfaceSource = Object.values(surfaces)
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

for (const staleTerm of [
  'LIVE GIG FEED',
  'Crowd Controls Next',
  'Customer Screen',
  'Room Control</h3>',
  'Boost Queue',
  'Classic Straight Tip',
  'Straight tip supporting',
  'Direct Cash Tip',
  'Crowd route',
  'Request scope',
  'No live records yet',
  'Empty-state inspector remains visible.',
  'Open a room link or sign in as the performer',
  'Choose one workspace at a time',
  'Veto Pending',
  'Customer room',
  'Bigger screen',
  'QR route',
  'gig ID'
]) {
  if (visibleSurfaceSource.includes(staleTerm)) {
    failures.push(`Core surfaces still expose fragmented copy: ${staleTerm}`);
  }
}

for (const accessibleAction of [
  'aria-label={`Approve ${request.title}`}',
  'aria-label={`Deny ${request.title}`}',
  'aria-label={`Mark ${request.title} played`}',
  'aria-label={`Hide ${request.title}`}'
]) {
  const occurrenceCount = surfaces.performer.split(accessibleAction).length - 1;
  if (occurrenceCount !== 1 || !surfaces.performer.includes('className="sway-live-queues"')) {
    failures.push(`The shared responsive request queue needs this accessible label exactly once: ${accessibleAction}`);
  }
}

if (!surfaces.performer.includes('nowPlayingRequest={nowPlayingRequest}')) {
  failures.push('Performer cockpit must pass fulfilled-history truth to the Audience Screen.');
}
if (!surfaces.audience.includes('upNext: approvedQueue[0] ?? null')) {
  failures.push('Audience Screen must map the approved leader to Up Next.');
}
if (!surfaces.patron.includes('resolvePausedRequestToast(session.tipsEnabled)')) {
  failures.push('Paused-request guidance must respect whether tips are enabled.');
}
if (!server.includes('title: isStraightTip ? LIVE_ROOM_LANGUAGE.directTip : (title || LIVE_ROOM_LANGUAGE.request)')) {
  failures.push('Server request creation must persist the shared Direct Tip label.');
}
const fixtureTip = demoFixture?.surfaces?.requests?.find?.((request) => request?.targetType === 'straight_tip');
if (fixtureTip?.title !== 'Direct Tip') {
  failures.push('Demo fixture must render Direct Tip consistently.');
}

const behaviorResult = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'scripts/sway-app-unification.behavior.test.tsx'],
  { cwd: root, encoding: 'utf8' }
);
if (behaviorResult.status !== 0) {
  failures.push(`Behavior proof failed: ${(behaviorResult.stderr || behaviorResult.stdout).trim()}`);
} else if (behaviorResult.stdout) {
  process.stdout.write(behaviorResult.stdout);
}

if (failures.length) {
  console.error('Sway app unification contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway app unification contract passed.');
