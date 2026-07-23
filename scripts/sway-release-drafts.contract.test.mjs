import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const failures = [];
const service = read('src/server/audio-publishing-service.ts');
const server = read('server.ts');
const accessControl = read('src/server/access-control.ts');
const surface = read('src/components/PerformerReleaseDrafts.tsx');
const dashboard = read('src/components/TalentDashboard.tsx');
const profile = read('src/components/PerformerPublicProfilePage.tsx');
const publicRelease = read('src/components/PublicReleasePage.tsx');
const rightsReview = read('src/components/PerformerRightsReviewQueue.tsx');
const integration = read('scripts/sway-audio-file-collaboration.integration.test.mjs');
const readiness = read('config/sway-complete-product-readiness.json');

for (const term of [
  'listReleaseWorkspace',
  'createReleaseDraft',
  'updateReleaseDraft',
  'createRightsDeclaration',
  'openRightsReviewDocument',
  'reviewRightsDeclaration',
  'grantReleaseReviewer',
  'listRightsReviewQueue',
  'getPublicRelease',
  'openPublicReleaseArtwork',
  'buildReleaseReadiness',
  'needManageRelease: true',
  'needApprove?: boolean',
  'input.needApprove && !grant.canApprove',
  "eq(audioProjectAccessGrants.canApprove, true)",
  "revocationReason: 'Replaced by an explicit release-review grant.'",
  "canManageRelease: existing?.canManageRelease ?? false",
  'or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))',
  "distributionMode: 'private'",
  "status: 'draft'",
  '.onConflictDoNothing({ target: musicReleases.id })',
  "eventType: 'music_release.draft_create'",
  "eventType: 'music_recording.create'",
  "eq(audioProjectAssetVersions.integrityStatus, 'verified')",
  "RIGHTS_DECLARATION_TYPES",
  "REQUIRED_RECORDING_RIGHTS",
  "REQUIRED_RELEASE_RIGHTS",
  "RECORDING_SCOPED_RIGHTS",
  'const latestDeclarationByScope = new Map',
  'const metadataIssues = current?.readiness.metadataIssues',
  'Complete release metadata before rights review:',
  "coalesce((${musicReleases.metadata}->>'metadataRevision')::integer, 1) = ${previousMetadataRevision}",
  "Rights evidence requires an independent project reviewer.",
  "eq(audioProjectAssetVersions.id, row.declaration.termsDocumentAssetVersionId)",
  "version.sha256 !== row.declaration.termsHash",
  "eventType: 'music_rights_declaration.evidence_access'",
  "Open the exact sealed rights document before recording a review outcome.",
  "actorType: 'account'"
]) {
  if (!service.includes(term)) failures.push(`Release draft service is missing: ${term}`);
}

for (const route of [
  "app.get('/api/talent/audio/releases'",
  "app.post('/api/talent/audio/releases'",
  "app.patch('/api/talent/audio/releases/:releaseId'",
  "app.post('/api/talent/audio/releases/:releaseId/rights'",
  "app.post('/api/talent/audio/projects/:projectId/release-reviewers'",
  "app.post('/api/talent/audio/rights/:declarationId/review'",
  "app.get('/api/talent/audio/rights/review-queue'",
  "app.get('/api/public/releases/:releaseId'",
  "app.get('/api/public/releases/:releaseId/artwork'"
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

const rightsQueueRoute = server.slice(
  server.indexOf("app.get('/api/talent/audio/rights/review-queue'"),
  server.indexOf("app.post('/api/talent/audio/rights/:declarationId/review'")
);
const rightsReviewRoute = server.slice(
  server.indexOf("app.post('/api/talent/audio/rights/:declarationId/review'"),
  server.indexOf("app.get('/api/talent/audio/projects/:projectId/assets'")
);
for (const [label, routeSource] of [
  ['Rights review queue', rightsQueueRoute],
  ['Rights declaration review', rightsReviewRoute]
]) {
  if (!routeSource.includes('requireAuthenticatedAccountAccess(req)')) {
    failures.push(`${label} must accept an authenticated account before project-scoped authorization.`);
  }
  if (routeSource.includes('requireTalentAccess(req)')) {
    failures.push(`${label} must not require a global talent role.`);
  }
}

const hasTalentRoleSource = accessControl.slice(
  accessControl.indexOf('async function hasTalentRole'),
  accessControl.indexOf('export function createAccessControl')
);
if (hasTalentRoleSource.includes('audioProjectAccessGrants')) {
  failures.push('An audio-project access grant must not elevate an account to the global talent role.');
}

for (const term of [
  'data-sway-release-drafts="true"',
  'Prepare a release from your Catalog',
  'Create private release draft',
  'Drafts stay private and are not sent to stores.',
  'Rights review and provider-confirmed delivery remain separate required steps.',
  '<PerformerReleaseTrackBuilder release={release} masters={masters} onSaved={onSaved} />',
  'Immutable rights evidence',
  'Save audited draft revision',
  'readiness.issues',
  "crypto.randomUUID()",
  "fetch('/api/talent/audio/releases'"
]) {
  if (!surface.includes(term)) failures.push(`Release draft surface is missing: ${term}`);
}
if (!dashboard.includes('<PerformerReleaseDrafts />')) {
  failures.push('Catalog workspace must render the release draft surface.');
}
for (const term of ['Music and releases', 'release.releasePath', 'Official release pages from this performer']) {
  if (!profile.includes(term)) failures.push(`Public profile release surface is missing: ${term}`);
}
for (const term of ['Provider-confirmed release', 'delivery not yet confirmed', 'Track list', 'No destination has reported this release live yet']) {
  if (!publicRelease.includes(term)) failures.push(`Public release truth surface is missing: ${term}`);
}
for (const term of ['Rights evidence queue', 'Verify evidence', 'Reject and block', 'declarationSha256', 'termsHash']) {
  if (!rightsReview.includes(term)) failures.push(`Independent rights review surface is missing: ${term}`);
}

for (const term of [
  'Release creation must be idempotent by client release UUID.',
  'Complete multi-track metadata must not bypass rights readiness.',
  'Incomplete proposed edit',
  'A progressive draft edit must retain fail-closed readiness.',
  'This must not start rights review early.',
  'Rights review must not grant release-management authority.',
  'Replacement must preserve existing permissions.',
  'A blind review must fail before evidence access.',
  'Denied rights-document access must not reach object storage.',
  "streamToBuffer(openedEvidence.stream)",
  "digest('hex'), declaration.termsHash",
  'Each recording- or release-scoped declaration must open its exact sealed evidence once.',
  'must identify the non-Pro reviewer as an account actor.',
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
