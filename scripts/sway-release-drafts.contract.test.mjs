import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const failures = [];
const service = read('src/server/audio-publishing-service.ts');
const server = read('server.ts');
const surface = read('src/components/PerformerReleaseDrafts.tsx');
const dashboard = read('src/components/TalentDashboard.tsx');
const integration = read('scripts/sway-audio-file-collaboration.integration.test.mjs');
const readiness = read('config/sway-complete-product-readiness.json');

for (const term of [
  'listReleaseWorkspace',
  'createReleaseDraft',
  'needManageRelease: true',
  "distributionMode: 'private'",
  "status: 'draft'",
  '.onConflictDoNothing({ target: musicReleases.id })',
  "eventType: 'music_release.draft_create'",
  "eventType: 'music_recording.create'",
  "eq(audioProjectAssetVersions.integrityStatus, 'verified')",
  "sql`${audioProjectAssetVersions.mimeType} like 'audio/%'`"
]) {
  if (!service.includes(term)) failures.push(`Release draft service is missing: ${term}`);
}

for (const route of [
  "app.get('/api/talent/audio/releases'",
  "app.post('/api/talent/audio/releases'"
]) {
  if (!server.includes(route)) failures.push(`Release draft route is missing: ${route}`);
}
for (const term of [
  'requireTalentAccess(req)',
  'loadOwnedPerformerByActorUserId(talentAccess.actor.actorId)',
  'clientReleaseId',
  'masterAssetVersionId'
]) {
  if (!server.includes(term)) failures.push(`Release route access/input boundary is missing: ${term}`);
}

for (const term of [
  'data-sway-release-drafts="true"',
  'Prepare a release from your Catalog',
  'Create private release draft',
  'Drafts stay private and are not sent to stores.',
  'Rights review and delivery remain separate required steps.',
  "crypto.randomUUID()",
  "fetch('/api/talent/audio/releases'"
]) {
  if (!surface.includes(term)) failures.push(`Release draft surface is missing: ${term}`);
}
if (!dashboard.includes('<PerformerReleaseDrafts />')) {
  failures.push('Catalog workspace must render the release draft surface.');
}

for (const term of [
  'Release creation must be idempotent by client release UUID.',
  'Release management permission required',
  "'music_release.draft_create'",
  "'music_recording.create'"
]) {
  if (!integration.includes(term)) failures.push(`Disposable release persistence proof is missing: ${term}`);
}

if (!readiness.includes('"id": "release_metadata_identifiers"')
  || !readiness.includes('scripts/sway-audio-file-collaboration.integration.test.mjs')) {
  failures.push('Readiness ledger must cite the durable release draft proof without claiming store delivery.');
}

for (const forbidden of [
  'Release delivered to stores',
  'Distribution is live',
  'Royalties are active'
]) {
  if (surface.includes(forbidden)) failures.push(`Release draft UI makes an unsupported claim: ${forbidden}`);
}

if (failures.length) {
  console.error('Release draft contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Release draft contract passed.');
