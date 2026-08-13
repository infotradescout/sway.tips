import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(relativePath) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) {
    failures.push(`Missing bounded audio storage file: ${relativePath}`);
    return '';
  }
  return readFileSync(absolutePath, 'utf8');
}

const policy = read('src/server/audio-storage-policy.ts');
const service = read('src/server/audio-publishing-service.ts');
const server = read('server.ts');
const surface = read('src/components/PerformerAudioFiles.tsx');
const product = read('docs/SWAY_PRODUCT_STRUCTURE.md');
const foundation = read('docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md');
const runbook = read('docs/runbooks/audio-master-vault.md');
const envContract = read('docs/SWAY_ENVIRONMENT_CONTRACT.md');
const envExample = read('.env.example');
const renderBlueprint = read('render.yaml');
const packageJson = read('package.json');
const manifestMigration = read('drizzle/0036_wet_susan_delgado.sql');

for (const term of [
  '5368709120',
  'workspaceLimitBytes',
  'workingBytes',
  'sealedWorkingBytes',
  'reservedBytes',
  'releaseProtectedBytes',
  'availableWorkspaceBytes',
  'workingObjectCount',
  'workingObjectLimit',
  'releaseCountLimit',
  'pg_advisory_xact_lock',
  'sway.audio_storage_performer_transaction',
  'requires an explicit marked database transaction',
  "'initiated'",
  "'uploading'",
  "'uploaded'",
  "'verifying'"
]) {
  if (!policy.includes(term)) failures.push(`Audio storage policy is missing: ${term}`);
}
for (const term of [
  'music_release_storage_manifests',
  'jsonb_array_elements(manifest.assets)',
  "manifest_asset->>'assetVersionId'",
  "version.sha256 = manifest_asset->>'sha256'",
  "version.byte_size = (manifest_asset->>'byteSize')::bigint"
]) {
  if (!policy.includes(term)) failures.push(`Immutable release-package protection is missing: ${term}`);
}
for (const forbiddenStatusShortcut of [
  'RELEASE_PROTECTED_STATUSES',
  'DELIVERY_PROTECTED_STATUSES',
  'protected_releases',
  'music_distribution_deliveries'
]) {
  if (policy.includes(forbiddenStatusShortcut)) {
    failures.push(`Mutable release or delivery state must not protect storage: ${forbiddenStatusShortcut}`);
  }
}

if (!/releaseCountLimit\s*:\s*null/.test(policy)) {
  failures.push('Release count must remain explicitly unlimited (releaseCountLimit: null).');
}
if (/releaseCountLimit\s*:\s*[1-9]/.test(policy) || /maxRelease(?:s|Count)/i.test(policy)) {
  failures.push('Audio storage policy must not introduce a numerical release-count cap.');
}

for (const term of [
  'music_release_storage_manifests',
  'sway_validate_music_release_storage_manifest',
  'music_release_storage_manifests_append_only',
  'sway_reject_immutable_audio_mutation',
  'exact sealed performer-owned versions',
  'recording_master:',
  'rights_document:',
  "('master_control'), ('composition_control')",
  "('artwork_control'), ('distribution_authorization')",
  "source_type = 'readiness_pass'",
  "source_type = 'delivery_submission'"
]) {
  if (!manifestMigration.includes(term)) failures.push(`Release storage manifest migration is missing: ${term}`);
}

for (const term of [
  'getStorageUsage',
  'expireStaleUploadSessions',
  'expectedMimeType',
  'collectReleaseStorageManifestRoles',
  'validateReleasePackageAsset',
  'parseStream',
  'audioContainerMatchesMime',
  'MAX_RELEASE_MASTER_BYTES',
  'MAX_RELEASE_ARTWORK_BYTES',
  'MAX_RELEASE_RIGHTS_DOCUMENT_BYTES',
  'assetValidation',
  'musicReleaseStorageManifests',
  'storagePackageFingerprint',
  "set_config('sway.audio_storage_performer_transaction'",
  'Refusing to discard an object referenced by a sealed preserved asset version.',
  'await store.abortUpload',
  'await store.beginUpload'
]) {
  if (!service.includes(term)) failures.push(`Publishing service storage control is missing: ${term}`);
}
const initiateUpload = service.slice(
  service.indexOf('async function initiateUpload'),
  service.indexOf('async function writeUploadPart')
);
if (initiateUpload.indexOf('beginUpload') < 0
  || initiateUpload.indexOf('workspace') < 0
  || initiateUpload.indexOf('workspace') > initiateUpload.indexOf('beginUpload')) {
  failures.push('Working-storage admission must run before object-store multipart initiation.');
}

const completeUpload = service.slice(
  service.indexOf('async function completeAndSealUpload'),
  service.indexOf('async function createShareGrant')
);
const completionRowLock = completeUpload.indexOf(".for('update')");
const completionAssembly = completeUpload.indexOf('store.assembleParts');
if (completionRowLock < 0 || completionAssembly < 0 || completionRowLock > completionAssembly) {
  failures.push('Upload completion must lock the upload-session row before provider assembly.');
}
if (!completeUpload.includes('discardUnsealedUpload(objectIdentity, tx)')) {
  failures.push('Completion failure cleanup must check sealed-object identity inside the locking transaction.');
}

const staleCleanup = service.slice(
  service.indexOf('async function expireStaleUploadSessions'),
  service.indexOf('async function completeAndSealUpload')
);
if (!staleCleanup.includes(".for('update', { skipLocked: true })")
  || !staleCleanup.includes('discardUnsealedUpload(sessionObjectIdentity(session), tx)')) {
  failures.push('Stale cleanup must share the upload-session row lock and sealed-object transaction guard.');
}

for (const term of [
  "app.get('/api/talent/audio/storage-usage'",
  'audioPublishingService.getStorageUsage',
  'audioPublishingService.expireStaleUploadSessions',
  'createAudioStoragePolicy({ env: process.env })',
  'workingObjectLimit: audioStoragePolicy.workingObjectLimit'
]) {
  if (!server.includes(term)) failures.push(`Server storage boundary is missing: ${term}`);
}

for (const term of [
  "fetch('/api/talent/audio/storage-usage'",
  'Release count is unlimited.',
  'working storage',
  'releaseProtectedBytes',
  'availableWorkspaceBytes',
  'workingObjectCount',
  'workingObjectLimit'
]) {
  if (!surface.includes(term)) failures.push(`Creator storage surface is missing: ${term}`);
}

for (const [label, source] of [
  ['product truth', product],
  ['publishing foundation', foundation],
  ['vault runbook', runbook]
]) {
  if (!source.toLowerCase().includes('release count') || !source.toLowerCase().includes('working-storage')) {
    failures.push(`${label} must separate unlimited releases from bounded working storage.`);
  }
}

for (const [label, source] of [
  ['environment contract', envContract],
  ['environment example', envExample],
  ['Render blueprint', renderBlueprint]
]) {
  if (!source.includes('SWAY_AUDIO_WORKSPACE_LIMIT_BYTES') || !source.includes('5368709120')) {
    failures.push(`${label} must declare the default 5 GiB working-storage limit.`);
  }
  if (!source.includes('SWAY_AUDIO_WORKING_OBJECT_LIMIT') || !source.includes('10000')) {
    failures.push(`${label} must declare the working-file record safeguard.`);
  }
}

if (!packageJson.includes('sway-audio-storage-policy.contract.test.mjs')) {
  failures.push('The hard contract gate must include bounded storage policy checks.');
}
if (!packageJson.includes('test:integration:audio-storage-policy')) {
  failures.push('Package scripts must expose the disposable audio storage policy proof.');
}

if (failures.length) {
  console.error('Audio storage policy contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Audio storage policy contract passed.');
