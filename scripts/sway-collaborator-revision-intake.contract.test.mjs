import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');
const requireText = (source, text, label) => {
  if (!source.includes(text)) failures.push(`Missing ${label}: ${text}`);
};
const rejectText = (source, text, label) => {
  if (source.includes(text)) failures.push(`Forbidden ${label}: ${text}`);
};
const between = (source, start, end) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  return startIndex >= 0 && endIndex > startIndex ? source.slice(startIndex, endIndex) : '';
};

const schema = read('src/db/schema.ts');
const migration = read('drizzle/0040_new_maria_hill.sql');
const cleanupMigration = read('drizzle/0041_majestic_otto_octavius.sql');
const hardeningMigration = read('drizzle/0042_bizarre_sersi.sql');
const contract = read('src/server/audio-publishing-contract.ts');
const publishing = read('src/server/audio-publishing-service.ts');
const collaboration = read('src/server/audio-file-collaboration-service.ts');
const storage = read('src/server/audio-storage-policy.ts');
const transport = read('src/server/audio-upload-transport.ts');
const server = read('server.ts');
const creatorUi = read('src/components/PerformerAudioFiles.tsx');
const inboxUi = read('src/components/CollaboratorInbox.tsx');
const uploadClient = read('src/audio-upload-client.ts');
const environment = read('.env.example');
const environmentContract = read('docs/SWAY_ENVIRONMENT_CONTRACT.md');
const foundation = read('docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md');
const runbook = read('docs/runbooks/audio-master-vault.md');
const browserProof = read('scripts/sway-collaborator-candidate.browser.test.ts');
const browserHarness = read('scripts/browser-fixtures/sway-collaborator-candidate-harness.tsx');
const httpProof = read('scripts/sway-collaborator-revision-http.integration.test.mjs');
const migrationUpgradeProof = read('scripts/sway-audio-candidate-migration-upgrade.integration.test.mjs');
const concurrencyProof = read('scripts/sway-audio-candidate-grant-concurrency.integration.test.mjs');
const lifecycleProof = read('scripts/sway-audio-candidate-revisions.integration.test.mjs');
const packageJson = read('package.json');
const packageScripts = JSON.parse(packageJson).scripts;

for (const [text, label] of [
  ["COLLABORATOR_REVISION_UPLOAD_ENV = 'SWAY_AUDIO_COLLABORATOR_REVISION_UPLOAD_ENABLED'", 'canonical feature-flag name'],
  ["env[COLLABORATOR_REVISION_UPLOAD_ENV] === 'true'", 'exact opt-in semantics'],
  ['SWAY_AUDIO_COLLABORATOR_REVISION_UPLOAD_ENABLED="false"', 'disabled example configuration']
]) requireText(`${contract}\n${environment}`, text, label);

for (const [text, label] of [
  ["export const audioCandidateRevisions = pgTable('audio_candidate_revisions'", 'separate candidate table'],
  ["intakeStatus: text('intake_status').notNull().default('private_review')", 'private-only intake status'],
  ["uniqueIndex('audio_candidate_revisions_grant_idx')", 'one candidate per grant'],
  ["uniqueIndex('audio_candidate_revisions_upload_session_idx')", 'one candidate per upload session'],
  ["export const audioObjectCleanupReceipts = pgTable('audio_object_cleanup_receipts'", 'durable provider-cleanup receipt'],
  ["cleanupStatus: text('cleanup_status').notNull().default('pending')", 'pending cleanup state'],
  ["maxCandidateBytes: bigint('max_candidate_bytes'", 'creator-approved candidate byte ceiling'],
  ["check('audio_object_cleanup_receipts_session_identity_complete'", 'complete session cleanup identity']
]) requireText(schema, text, label);

const ordinaryVersionTable = between(
  schema,
  "export const audioProjectAssetVersions = pgTable('audio_project_asset_versions'",
  "export const audioAssetDerivatives"
);
for (const forbidden of ['fileAccessGrantId', 'candidate', 'intakeStatus']) {
  rejectText(ordinaryVersionTable, forbidden, 'candidate authority in ordinary asset versions');
}

for (const [text, label] of [
  ['sway_require_active_collaborator_revision_grant', 'database grant recheck'],
  ["'private_collaboration'::performer_capability", 'current performer capability gate'],
  ["grant_record.grant_purpose <> 'collaborator_revision_upload'", 'exact grant purpose'],
  ['audio_project_asset_versions_00_no_candidate_session', 'ordinary-version insertion denial'],
  ['audio_candidate_revisions_validate', 'candidate identity validation trigger'],
  ['audio_candidate_revisions_append_only', 'append-only candidate trigger']
]) requireText(`${migration}\n${hardeningMigration}`, text, label);

const candidateValidation = between(
  migration,
  'CREATE FUNCTION "sway_validate_audio_candidate_revision"',
  'CREATE TRIGGER "audio_project_asset_versions_00_no_candidate_session"'
);
if (candidateValidation.indexOf('sway_require_active_collaborator_revision_grant')
  > candidateValidation.indexOf('FOR UPDATE')) {
  failures.push('Candidate insertion must lock capability/connection/grant before the upload session.');
}
for (const [text, label] of [
  ['CREATE TABLE "audio_object_cleanup_receipts"', 'cleanup receipt migration'],
  ['audio_object_cleanup_receipts_storage_object_idx', 'cleanup identity uniqueness'],
  ['audio_object_cleanup_receipts_completion_coherent', 'cleanup terminal-state coherence'],
  ['sway_enforce_audio_cleanup_receipt_state', 'immutable cleanup receipt authority'],
  ['audio_object_cleanup_receipts_upload_session_object_fk', 'session-bound cleanup object identity'],
  ['cleanup receipt preflight failed', 'populated cleanup identity preflight'],
  ['must begin pending at attempt one', 'pending-only cleanup receipt insertion']
]) requireText(`${cleanupMigration}\n${hardeningMigration}`, text, label);

for (const [text, label] of [
  ['from audio_candidate_revisions', 'candidate working-storage accounting'],
  ['releaseCountLimit: null', 'unlimited release count'],
  ['Private candidates are protected too.', 'sealed candidate cleanup protection']
]) requireText(`${storage}\n${publishing}`, text, label);

const candidateInitiation = between(
  publishing,
  'async function initiateCollaboratorRevisionUpload',
  'async function initiateUpload'
);
for (const [text, label] of [
  ['requireActiveCollaboratorRevisionGrant', 'initiation grant recheck'],
  ["uploadPurpose: 'collaborator_revision'", 'purpose-bound upload session'],
  ['requestFingerprint', 'material upload intent binding'],
  ['assertAudioStorageReservationAvailable', 'working-byte quota gate'],
  ['assertAudioWorkingObjectAvailable', 'working-object count gate'],
  ['scope.maxCandidateBytes', 'creator-approved byte-ceiling gate'],
  ["cleanupReason: 'orphaned_candidate_initiation'", 'orphan cleanup receipt']
]) requireText(candidateInitiation, text, label);
const candidateStorageLockIndex = candidateInitiation.indexOf('lockAudioStorageForPerformer');
const candidateExistingSessionLookupIndex = candidateInitiation.indexOf('.from(audioUploadSessions)');
if (candidateStorageLockIndex < 0
  || candidateExistingSessionLookupIndex < 0
  || candidateStorageLockIndex > candidateExistingSessionLookupIndex) {
  failures.push('Candidate initiation must take the performer storage lock before checking an existing session.');
}

const partWriter = between(publishing, 'async function writeUploadPart', 'async function expireStaleUploadSessions');
for (const [text, label] of [
  ['requireActiveCollaboratorRevisionGrant', 'per-part grant recheck'],
  ['scope.collaboratorFileGrantId !== input.grantId', 'pre-lock exact route-grant binding'],
  ['session.collaboratorFileGrantId !== input.grantId', 'locked-session exact route-grant binding'],
  ["code: 'upload_part_replay_conflict'", 'changed-byte replay denial'],
  ['existingPart.providerChecksum !== checksum', 'exact-byte part replay'],
  ["Upload part 1 must pass file-signature validation", 'first-part ordering and signature gate']
]) requireText(partWriter, text, label);

const candidateCompletion = between(
  publishing,
  'async function completeAndSealCollaboratorRevision',
  'async function completeAndSealUpload'
);
for (const [text, label] of [
  ['requireActiveCollaboratorRevisionGrant', 'completion grant recheck'],
  ['validatePlayableAudioOriginal', 'full playable-media parse'],
  ['audioCandidateRevisions', 'separate candidate seal'],
  ["intakeStatus: 'private_review'", 'private candidate seal state'],
  ["eventType: 'audio_candidate_revision.sealed_private'", 'durable candidate audit'],
  ["cleanupReason: 'candidate_technical_validation_failed'", 'failed-validation cleanup receipt']
]) requireText(candidateCompletion, text, label);
rejectText(candidateCompletion, 'audioProjectAssetVersions).values', 'candidate promotion to ordinary version');

for (const [text, label] of [
  ['grantCandidateRevisionUpload', 'creator candidate grant service'],
  ["grantPurpose: 'collaborator_revision_upload'", 'upload-only grant purpose'],
  ['canUploadNewVersion: true', 'internal upload permission'],
  ['canDownloadOriginal: false', 'least-privilege original denial'],
  ['openCandidateRevision', 'private candidate reader'],
  ['maxCandidateBytes', 'candidate grant byte ceiling'],
  ['currentProjectManager', 'creator current-access recheck'],
  ['Active candidate grant required.', 'collaborator active-grant recheck'],
  ['active_candidate_grant_idempotency_conflict', 'different-key active-scope conflict'],
  ['requireActiveReviewGrantForUser', 'review-purpose isolation']
]) requireText(collaboration, text, label);
requireText(
  lifecycleProof,
  'Candidate grants must not enter ordinary review threads.',
  'candidate grant ordinary-review denial proof'
);

for (const route of [
  '/api/talent/audio/pairing/connections/:connectionId/candidate-revision-grants',
  '/api/talent/audio/file-grants/:grantId/candidate-uploads',
  '/api/talent/audio/file-grants/:grantId/candidate-uploads/:uploadSessionId/parts/:partNumber',
  '/api/talent/audio/file-grants/:grantId/candidate-uploads/:uploadSessionId/complete',
  '/api/talent/audio/file-grants/:grantId/candidates/:candidateId/content'
]) requireText(server, route, `candidate route ${route}`);
const candidatePartRoute = between(
  server,
  'const requireCandidateUploadPartAuthority',
  "app.post('/api/talent/audio/file-grants/:grantId/candidate-uploads/:uploadSessionId/complete'"
);
requireText(candidatePartRoute, "grantId: String(req.params.grantId || '')", 'route grant forwarded to part writer');
requireText(candidatePartRoute, 'authorizeCollaboratorRevisionUploadPart', 'pre-parser exact authority check');
requireText(candidatePartRoute, 'createAudioUploadPartBodyParser()', 'route-local bounded raw parser');
if (candidatePartRoute.indexOf('authorizeCollaboratorRevisionUploadPart')
  > candidatePartRoute.indexOf('createAudioUploadPartBodyParser()')) {
  failures.push('Candidate route must authorize the exact actor/grant/session before parsing binary bytes.');
}
rejectText(server, 'app.use(CANDIDATE_AUDIO_UPLOAD_PART_PATH_PATTERN', 'global pre-auth candidate raw parser');

const candidateInitiationRoute = between(
  server,
  "app.post('/api/talent/audio/file-grants/:grantId/candidate-uploads'",
  'const requireCandidateUploadPartAuthority'
);
rejectText(candidateInitiationRoute, 'uploadSession: session', 'raw upload-session DTO response');
for (const forbidden of ['storageProvider:', 'storageBucket:', 'storageKey:', 'providerUploadId:', 'requestFingerprint:', 'idempotencyKey: session']) {
  rejectText(candidateInitiationRoute, forbidden, 'candidate initiation response internal field');
}
const candidateCompletionRoute = between(
  server,
  "app.post('/api/talent/audio/file-grants/:grantId/candidate-uploads/:uploadSessionId/complete'",
  "app.get('/api/talent/audio/file-grants/:grantId/candidates/:candidateId/content'"
);
rejectText(candidateCompletionRoute, 'res.json({ candidate })', 'raw candidate DTO response');
for (const forbidden of ['storageProvider:', 'storageBucket:', 'storageKey:', 'providerVersionId:', 'integrityEvidence:', 'integrityVerifierKey:']) {
  rejectText(candidateCompletionRoute, forbidden, 'candidate completion response internal field');
}
for (const [text, label] of [
  ['requireCollaboratorRevisionRuntime(res)', 'server fail-closed runtime gate'],
  ["code: 'candidate_uploads_disabled'", 'disabled route response'],
  ['createAudioUploadPartBodyParser()', 'bounded route-local raw-body parser'],
  ["requireAuthenticatedAccountAccess(req)", 'universal account upload authorization'],
  ["requireTalentAccess(req)", 'creator grant authority']
]) requireText(`${server}\n${transport}`, text, label);

for (const [text, label] of [
  ['Request private candidate', 'creator request action'],
  ['it does not replace this file, become requestable, or enter a release.', 'creator truth copy'],
  ['Upload private candidate', 'collaborator upload action'],
  ['It does not replace the current file, become requestable, or enter a release.', 'collaborator truth copy'],
  ["Kept separate from Catalog versions, requests, releases, and delivery.", 'candidate isolation copy'],
  ['AUDIO_UPLOAD_PART_SIZE_BYTES', 'shared upload geometry'],
  ['sha256FileHex', 'client digest helper']
]) requireText(`${creatorUi}\n${inboxUi}\n${uploadClient}`, text, label);

for (const [text, label] of [
  ['defaults to disabled', 'environment fail-closed documentation'],
  ['No candidate ID is accepted by request, release-manifest, delivery, public playback, royalty, or payment paths.', 'no-promotion documentation'],
  ['release count remains unlimited without turning collaboration into free general storage', 'bounded-storage product truth'],
  ['audio_object_cleanup_receipts', 'cleanup recovery documentation']
]) requireText(`${environmentContract}\n${foundation}`, text, label);

requireText(packageJson, 'node scripts/sway-collaborator-revision-intake.contract.test.mjs', 'hard contract registration');
requireText(packageJson, 'test:integration:audio-candidate-revisions', 'disposable integration command');
requireText(packageJson, 'test:browser:audio-candidate-revisions', 'rendered browser proof command');
for (const scriptName of [
  'test:integration:collaborator-revision-http',
  'test:integration:audio-candidate-revisions:migration-upgrade:real-postgres',
  'test:integration:audio-candidate-grant-concurrency:real-postgres'
]) {
  if (typeof packageScripts[scriptName] !== 'string' || !packageScripts[scriptName]) {
    failures.push(`Missing Wave 5A evidence script: ${scriptName}`);
  }
}
if (!packageScripts['test:wave5a']?.includes('test:integration:collaborator-revision-http')) {
  failures.push('Wave 5A aggregate must execute the real Express trust-boundary proof.');
}
if (!packageScripts['test:wave5a']?.includes('test:integration:audio-file-collaboration')) {
  failures.push('Wave 5A aggregate must protect the existing ordinary file-collaboration integration.');
}
for (const [source, text, label] of [
  [httpProof, 'wrong-session binary request must not reach the raw parser', 'wrong-session pre-parser HTTP denial'],
  [httpProof, 'provider etag must be persisted even though it is not returned', 'durable-but-allowlisted HTTP part proof'],
  [httpProof, 'Outsiders must receive the same message for existing and missing private candidates.', 'private candidate existence-oracle denial'],
  [httpProof, 'Capability revocation must remove the candidate grant from the collaborator list.', 'post-seal collaborator list revocation'],
  [httpProof, 'A current project manager must retain the sealed candidate after upload authority ends.', 'post-seal creator retention'],
  [httpProof, 'Unknown provider logs must not expose private storage details.', 'sanitized provider-failure logs'],
  [migrationUpgradeProof, '--strict-real-postgres', 'strict populated migration-upgrade mode'],
  [migrationUpgradeProof, 'SWAY_ALLOW_DISPOSABLE_DATABASE_RESET', 'migration reset approval gate'],
  [migrationUpgradeProof, 'cleanup receipt preflight failed', 'invalid populated cleanup migration rejection'],
  [migrationUpgradeProof, 'Completed insertion must be rejected by the append-only receipt trigger.', 'completed cleanup insert rejection'],
  [concurrencyProof, 'waitForBothAdvisoryWaiters', 'two-backend advisory-lock race barrier'],
  [concurrencyProof, 'waitForBothLockWaiters', 'candidate initiation mixed-lock race barrier'],
  [concurrencyProof, "code'), 'candidate_grant_intent_conflict'", 'controlled conflicting-intent race result'],
  [concurrencyProof, "[false, true]", 'one-create one-reuse exact-intent race result'],
  [concurrencyProof, 'active_candidate_grant_idempotency_conflict', 'different-key active-scope conflict result'],
  [concurrencyProof, 'exactCandidateInitiationRace', 'same-key candidate initiation race result'],
  [concurrencyProof, 'providerBeginCount: candidateProviderBeginCount', 'single provider begin proof'],
  [concurrencyProof, 'SWAY_REAL_POSTGRES_PROOF_DATABASE_URL', 'dedicated concurrency database URL'],
  [runbook, 'test:integration:audio-candidate-grant-concurrency:real-postgres', 'operator concurrency proof command']
]) requireText(source, text, label);
rejectText(concurrencyProof, 'process.env.DATABASE_URL ||', 'generic database fallback in strict concurrency proof');
for (const [text, label] of [
  ['<CollaboratorInbox refreshKey={refreshKey} />', 'refreshable real Collaborator Inbox browser harness'],
  ['<PerformerAudioFiles />', 'real creator Catalog browser harness'],
  ['The creator action must issue exactly one private-candidate grant request.', 'browser creator-request proof'],
  ['A missing capability signal must remove the candidate file input.', 'browser fail-closed capability proof'],
  ['A failed upload start must clear the picker so the same file can be retried.', 'browser same-file retry proof'],
  ['An older failed refresh must not overwrite the newer successful state.', 'stale refresh ordering proof'],
  ['A slower prior-project response must not overwrite the newly selected project.', 'stale Catalog project response proof'],
  ['The labeled Catalog project selector must accept keyboard focus.', 'Catalog selector accessibility proof'],
  ['Catalog status updates must use one polite live region.', 'Catalog live-status accessibility proof'],
  ['The browser must send the exact selected bytes in the bounded part route.', 'browser multipart-byte proof'],
  ['The creator must retain a playable candidate after upload authority ends.', 'browser creator-retention proof'],
  ['The rendered candidate flow contains broken images:', 'browser image-integrity proof'],
  ['consoleErrors', 'browser console proof']
]) requireText(`${browserHarness}\n${browserProof}`, text, label);

if (failures.length) {
  console.error('Collaborator revision intake contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Collaborator revision intake contract passed.');
