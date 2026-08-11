import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');
const servicePath = 'src/server/audio-file-collaboration-service.ts';

if (!existsSync(join(root, servicePath))) failures.push('Missing selected-file collaboration service.');
const service = existsSync(join(root, servicePath)) ? read(servicePath) : '';
const publishingService = read('src/server/audio-publishing-service.ts');
const publishingContract = read('src/server/audio-publishing-contract.ts');
const pairing = read('src/server/audio-file-pairing-service.ts');
const pairingCreator = read('src/components/PerformerFilePairing.tsx');
const schema = read('src/db/schema.ts');
const server = read('server.ts');
const filesSurface = read('src/components/PerformerAudioFiles.tsx');
const collaboratorInbox = read('src/components/CollaboratorInbox.tsx');
const integration = read('scripts/sway-audio-file-collaboration.integration.test.mjs');
const migration = read('drizzle/0024_heavy_spectrum.sql');
const packageJson = read('package.json');
const workflow = read('.github/workflows/ci.yml');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

for (const term of [
  'shareVersion',
  'listSharedWithMe',
  'listSharedByMe',
  'downloadGrantedOriginal',
  'listReviewEvents',
  'addReviewEvent',
  'revokeGrant',
  'Project access management permission required.',
  'Denied download must not reach object storage.'
]) {
  if (!service.includes(term) && !read('scripts/sway-audio-file-collaboration.integration.test.mjs').includes(term)) {
    failures.push(`Collaboration runtime is missing: ${term}`);
  }
}
for (const term of [
  "canComment: boolean('can_comment').notNull().default(true)",
  "canApprove: boolean('can_approve').notNull().default(false)"
]) {
  if (!schema.includes(term)) failures.push(`Selected-file grant schema is missing: ${term}`);
}
for (const term of ['ADD COLUMN "can_comment"', 'ADD COLUMN "can_approve"']) {
  if (!migration.includes(term)) failures.push(`Collaboration migration is missing: ${term}`);
}
for (const route of [
  "/api/talent/audio/assets/:assetId/requestable",
  "/api/talent/audio/versions/:versionId/content",
  "/api/talent/audio/pairing/connections",
  "/api/talent/audio/pairing/connections/:connectionId/shares",
  "/api/talent/audio/files/shared-with-me",
  "/api/talent/audio/files/shared-by-me",
  "/api/talent/audio/file-grants/:grantId/download",
  "/api/talent/audio/file-grants/:grantId/reviews",
  "/api/talent/audio/file-grants/:grantId/revoke"
]) {
  if (!server.includes(route)) failures.push(`Server is missing collaboration route: ${route}`);
}

const tokenRoute = sourceBetween(
  server,
  "app.post('/api/talent/audio/pairing/tokens'",
  "app.post('/api/talent/audio/pairing/preview'"
);
const connectionListRoute = sourceBetween(
  server,
  "app.get('/api/talent/audio/pairing/connections'",
  "app.post('/api/talent/audio/pairing/connections/:connectionId/shares'"
);
const shareRoute = sourceBetween(
  server,
  "app.post('/api/talent/audio/pairing/connections/:connectionId/shares'",
  "app.get('/api/talent/audio/files/shared-with-me'"
);
for (const [label, routeSource] of [
  ['Pairing token creation', tokenRoute],
  ['Selected-file sharing', shareRoute]
]) {
  if (!routeSource) failures.push(`Unable to locate ${label.toLowerCase()} route guard.`);
  if (!routeSource.includes('accessControl.requireTalentAccess(req)')) {
    failures.push(`${label} must remain gated by performer authority.`);
  }
}
if (!connectionListRoute) {
  failures.push('Unable to locate the pairing connection-list route guard.');
} else {
  if (!connectionListRoute.includes('accessControl.requireAuthenticatedAccountAccess(req)')) {
    failures.push('Every authenticated account must be able to list its own pairing connections.');
  }
  if (connectionListRoute.includes('accessControl.requireTalentAccess(req)')) {
    failures.push('Connection listing must not require a global talent role.');
  }
  if (!connectionListRoute.includes('listConnections({ userId: accountAccess.actor.actorId })')) {
    failures.push('Connection listing must scope results to the authenticated account actor.');
  }
}

for (const [label, source] of [
  ['Server pairing contract', publishingContract],
  ['Pairing QR fallback', pairingCreator]
]) {
  if (!source.includes("'/account/collaboration/connect'")) {
    failures.push(`${label} must use the universal account collaboration path.`);
  }
  if (source.includes("'/talent/connect/files'")) {
    failures.push(`${label} must not retain the performer-only pairing path.`);
  }
}

const pairingClaim = sourceBetween(pairing, 'async function claimPairingToken', 'async function listConnections');
const pairingRevoke = sourceBetween(pairing, 'async function revokeConnection', 'return {');
const shareVersion = sourceBetween(service, 'async function shareVersion', 'async function listSharedWithMe');
const accountAuditWriter = sourceBetween(service, 'async function writeAudit', 'export function createAudioFileCollaborationService');
if ((pairingClaim.match(/actorType: 'account'/g) ?? []).length < 2) {
  failures.push('Generic-account pairing claims and denials must be audited as account actions.');
}
if (!pairingRevoke.includes("actorType: 'account'")) {
  failures.push('Generic-account connection revocation must be audited as an account action.');
}
if (!accountAuditWriter.includes("actorType: 'account'")) {
  failures.push('The generic-account collaboration audit writer must attribute account actions correctly.');
}
const grantedFileDownload = sourceBetween(service, 'async function downloadGrantedOriginal', 'async function listReviewEvents');
if (!grantedFileDownload.includes('await writeAudit(db, {')
  || !grantedFileDownload.includes("eventType: 'audio_file_access.download'")) {
  failures.push('Granted-file download must emit its durable account-attributed audit event.');
}
const grantRevoke = sourceBetween(service, 'async function revokeGrant', 'return {');
for (const term of [
  'return db.transaction(async (tx) => {',
  'const [revoked] = await tx',
  '.update(audioFileAccessGrants)',
  'await tx.insert(auditEvents).values({',
  "actorType: 'account'",
  "eventType: 'audio_file_access.revoke'"
]) {
  if (!grantRevoke.includes(term)) failures.push(`File-grant revoke transaction is missing: ${term}`);
}
const reviewList = sourceBetween(service, 'async function listReviewEvents', 'async function addReviewEvent');
const fileReview = sourceBetween(service, 'async function addReviewEvent', 'async function revokeGrant');
const reviewAuditBinding = sourceBetween(service, 'function reviewAuditBindingWhere', 'function reviewEventGrantWhere');
for (const term of [
  'return db.transaction(async (tx) => {',
  'await tx.insert(audioReviewEvents).values({',
  'await tx.insert(auditEvents).values({',
  "actorType: 'account'",
  'eventType: `audio_review.${eventType}`',
  'metadata: { grantId: grant.id, versionId: grant.assetVersionId }'
]) {
  if (!fileReview.includes(term)) failures.push(`File review transaction is missing: ${term}`);
}
for (const term of [
  'eq(auditEvents.entityId, audioReviewEvents.id)',
  'eq(auditEvents.actorId, audioReviewEvents.actorUserId)',
  "sql`${auditEvents.metadata}->>'grantId' = ${grant.id}`",
  "sql`${auditEvents.metadata}->>'versionId' = ${grant.assetVersionId}`",
  'reviewEventGrantWhere(grant)'
]) {
  if (!service.includes(term)) failures.push(`Grant-scoped review history is missing: ${term}`);
}
for (const term of [
  '.selectDistinct({',
  '.innerJoin(auditEvents, reviewAuditBindingWhere(grant))',
  '.where(reviewEventGrantWhere(grant))'
]) {
  if (!reviewList.includes(term)) failures.push(`Review history must fail closed through its grant audit binding: ${term}`);
}
if (reviewAuditBinding.includes('actorType')) {
  failures.push('Review history must not reject legacy audits solely because their actor type predates account attribution.');
}
for (const term of [
  'UUID_PATTERN.test(rawSupersedesEventId)',
  'Resolved review events must reference the item they resolve.',
  'Superseded review event must belong to this file grant.',
  'eq(audioReviewEvents.id, supersedesEventId)'
]) {
  if (!fileReview.includes(term)) failures.push(`Review supersession guard is missing: ${term}`);
}
for (const term of [
  'secondReviewConnection',
  'Cross-grant supersede must fail.',
  'Orphan row without a grant audit binding.',
  'forced review audit failure',
  'forced grant revoke audit failure',
  'Failed revoke audit must roll back revokedAt.',
  'Failed revoke audit must leave no durable revoke audit row.',
  'Grant-scoped review history must retain correctly bound legacy performer-attributed audits.',
  'must begin a new empty review thread'
]) {
  if (!integration.includes(term)) failures.push(`Disposable review-isolation proof is missing: ${term}`);
}
if (!shareVersion.includes("actorType: 'performer'")) {
  failures.push('Performer-authorized selected-file sharing must retain performer audit attribution.');
}
if (!shareVersion.includes('or(\n            isNull(audioProjectAccessGrants.expiresAt),\n            gt(audioProjectAccessGrants.expiresAt, new Date())\n          )')) {
  failures.push('Selected-file sharing must reject expired project-management grants.');
}
if (!pairing.includes('cascadedFileGrantRevocation: true') || !pairing.includes('audioFileAccessGrants')) {
  failures.push('Connection revocation must durably cascade to selected-file grants.');
}
if (!packageJson.includes('"test:integration:audio-file-collaboration"')) {
  failures.push('Package scripts must expose the disposable collaboration integration proof.');
}
if (!packageJson.includes('"start": "npm run db:migrate && node dist/server.cjs"')) {
  failures.push('Production startup must apply pending migrations before accepting traffic.');
}
if (!server.includes("return res.status(503).json({ error: 'Shared files are temporarily unavailable.' });")) {
  failures.push('Shared-file list routes must contain database failures instead of crashing the process.');
}
if (!workflow.includes('Run Audio File Collaboration Integration Proof')) {
  failures.push('CI must run the disposable collaboration integration proof.');
}
for (const term of ['openOwnedVersion', 'needDownload: true']) {
  if (!publishingService.includes(term)) failures.push(`Owner Catalog playback service is missing: ${term}`);
}
for (const term of ['Content-Disposition', 'inline; filename=']) {
  if (!server.includes(term)) failures.push(`Owner Catalog playback route is missing: ${term}`);
}
for (const term of [
  '<audio controls preload="metadata"',
  'Add audio to Catalog',
  'Allow requests',
  'Remove from requests',
  'This track is now available in Library.',
  'Share with connection'
]) {
  if (!filesSurface.includes(term)) failures.push(`Files surface is missing owner action: ${term}`);
}
for (const term of [
  'Shared with me',
  'Shared by me',
  'Download source file',
  'Request changes',
  'Approve',
  'Review history',
  'File access revoked. Future download and review attempts are now denied.'
]) {
  if (!collaboratorInbox.includes(term)) failures.push(`Collaborator Inbox is missing collaboration action: ${term}`);
}

if (failures.length) {
  console.error('Audio file collaboration contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Audio file collaboration contract passed.');
