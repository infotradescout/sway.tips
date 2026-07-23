import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(path) {
  const absolutePath = join(root, path);
  if (!existsSync(absolutePath)) {
    failures.push(`Missing multi-track release contract file: ${path}`);
    return '';
  }
  return readFileSync(absolutePath, 'utf8');
}

function requireIncludes(source, label, terms) {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${label} is missing: ${term}`);
  }
}

const builder = read('src/components/PerformerReleaseTrackBuilder.tsx');
const releaseSurface = read('src/components/PerformerReleaseDrafts.tsx');
const publicRelease = read('src/components/PublicReleasePage.tsx');
const service = read('src/server/audio-publishing-service.ts');
const server = read('server.ts');
const packageJson = read('package.json');

requireIncludes(builder, 'Release track builder', [
  'export default function PerformerReleaseTrackBuilder',
  'data-sway-release-track-builder="true"',
  'Release track list',
  'availableMasters',
  'master.projectId === release.projectId',
  '!used.has(master.versionId)',
  "release.releaseType === 'single'",
  'Change the release type to EP, Album, Comedy special, Spoken word, or Other before adding another track.',
  'crypto.randomUUID()',
  'expectedUpdatedAt: release.updatedAt',
  "method: 'POST'",
  "method: 'PATCH'",
  "method: 'PUT'",
  "method: 'DELETE'",
  'Add track to release',
  'Save track',
  'Move up',
  'Move down',
  'Remove',
  'recordings.map((recording, index)',
  '{index + 1}. {recording.title}'
]);

requireIncludes(releaseSurface, 'Release workspace', [
  "import PerformerReleaseTrackBuilder from './PerformerReleaseTrackBuilder'",
  '<PerformerReleaseTrackBuilder release={release} masters={masters} onSaved={onSaved} />',
  'RECORDING_SCOPED_RIGHTS.has(rights.declarationType)',
  'Choose the recording this evidence covers',
  'recordingId: RECORDING_SCOPED_RIGHTS.has(rights.declarationType) ? rights.recordingId : null',
  'Track {recording.trackNumber} · {recording.title}'
]);

const routeContracts = [
  {
    start: "app.post('/api/talent/audio/releases/:releaseId/recordings'",
    end: "app.patch('/api/talent/audio/releases/:releaseId/recordings/:recordingId'",
    serviceMethod: 'audioPublishingService.addReleaseRecording',
    ownerBoundary: 'Only the performer owner can add release tracks.'
  },
  {
    start: "app.patch('/api/talent/audio/releases/:releaseId/recordings/:recordingId'",
    end: "app.put('/api/talent/audio/releases/:releaseId/recordings/order'",
    serviceMethod: 'audioPublishingService.updateReleaseRecording',
    ownerBoundary: 'Only the performer owner can edit release tracks.'
  },
  {
    start: "app.put('/api/talent/audio/releases/:releaseId/recordings/order'",
    end: "app.delete('/api/talent/audio/releases/:releaseId/recordings/:recordingId'",
    serviceMethod: 'audioPublishingService.reorderReleaseRecordings',
    ownerBoundary: 'Only the performer owner can reorder release tracks.'
  },
  {
    start: "app.delete('/api/talent/audio/releases/:releaseId/recordings/:recordingId'",
    end: "app.post('/api/talent/audio/releases/:releaseId/rights'",
    serviceMethod: 'audioPublishingService.removeReleaseRecording',
    ownerBoundary: 'Only the performer owner can remove release tracks.'
  }
];

for (const route of routeContracts) {
  const start = server.indexOf(route.start);
  const end = server.indexOf(route.end, start + 1);
  if (start < 0 || end < 0 || end <= start) {
    failures.push(`Multi-track release route is missing or out of order: ${route.start}`);
    continue;
  }
  const block = server.slice(start, end);
  requireIncludes(block, route.start, [
    'requireTalentAccess(req)',
    'loadOwnedPerformerByActorUserId(talentAccess.actor.actorId)',
    route.ownerBoundary,
    'expectedUpdatedAt',
    route.serviceMethod
  ]);
}

requireIncludes(service, 'Multi-track release service', [
  'async function addReleaseRecording',
  'async function updateReleaseRecording',
  'async function reorderReleaseRecordings',
  'async function removeReleaseRecording',
  'addReleaseRecording,',
  'updateReleaseRecording,',
  'reorderReleaseRecordings,',
  'removeReleaseRecording,',
  'assertExpectedReleaseVersion(release.updatedAt, input.expectedUpdatedAt)',
  'needManageRelease: true',
  "if (release.releaseType === 'single') throw new Error('Change the release type from Single before adding another track.')",
  'eq(audioProjectAssetVersions.projectId, release.projectId)',
  'eq(audioProjectAssetVersions.performerId, input.performerId)',
  "eq(audioProjectAssetVersions.integrityStatus, 'verified')",
  'This verified master is already part of the release.',
  'Track order cannot contain duplicate recordings.',
  'Track order must contain every recording in this release exactly once.',
  'A release must keep at least one recording.',
  'A recording with sealed rights evidence cannot be removed.',
  "eventType: 'music_release.recording_add'",
  "eventType: 'music_release.recording_update'",
  "eventType: 'music_release.recordings_reorder'",
  "eventType: 'music_release.recording_remove'"
]);

requireIncludes(service, 'Recording-scoped rights readiness', [
  "const REQUIRED_RECORDING_RIGHTS = ['master_control', 'composition_control'] as const",
  "const REQUIRED_RELEASE_RIGHTS = ['artwork_control', 'distribution_authorization'] as const",
  'const RECORDING_SCOPED_RIGHTS = new Set([',
  "const scopeKey = `${declaration.recordingId ?? 'release'}:${declaration.declarationType}`",
  'latestDeclarationByScope.get(`${recording.recordingId}:${declarationType}`)',
  'latestDeclarationByScope.get(`release:${declarationType}`)',
  'REQUIRED_RECORDING_RIGHTS.map((type) => `${recording.recordingId}:${type}`)',
  'REQUIRED_RELEASE_RIGHTS.map((type) => `release:${type}`)',
  'if (RECORDING_SCOPED_RIGHTS.has(declarationType) && !requestedRecordingId)',
  'const recordingId = RECORDING_SCOPED_RIGHTS.has(declarationType) ? requestedRecordingId : null'
]);

requireIncludes(publicRelease, 'Public multi-track presentation', [
  'release.recordings.map((recording)',
  '{recording.trackNumber}',
  'recording.credits.map((credit)'
]);

for (const [label, source] of [
  ['release workspace', releaseSurface],
  ['release track builder', builder],
  ['public release page', publicRelease]
]) {
  if (/recordings\s*\[\s*0\s*\]/.test(source)) {
    failures.push(`${label} must not present a release through a hard-coded recordings[0].`);
  }
  if (/Track\s+1\s*[·:]/.test(source)) {
    failures.push(`${label} must not present every recording as a fixed Track 1.`);
  }
}

let parsedPackage = null;
try {
  parsedPackage = JSON.parse(packageJson);
} catch {
  failures.push('package.json must remain valid JSON.');
}
if (!(parsedPackage?.scripts?.['test:contracts'] ?? '').includes('node scripts/sway-multitrack-releases.contract.test.mjs')) {
  failures.push('package.json must register the multi-track release contract in test:contracts.');
}

if (failures.length) {
  console.error('Multi-track release contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Multi-track release contract passed.');
