import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');
const servicePath = 'src/server/audio-file-collaboration-service.ts';

if (!existsSync(join(root, servicePath))) failures.push('Missing selected-file collaboration service.');
const service = existsSync(join(root, servicePath)) ? read(servicePath) : '';
const publishingService = read('src/server/audio-publishing-service.ts');
const pairing = read('src/server/audio-file-pairing-service.ts');
const schema = read('src/db/schema.ts');
const server = read('server.ts');
const filesSurface = read('src/components/PerformerAudioFiles.tsx');
const migration = read('drizzle/0024_heavy_spectrum.sql');
const packageJson = read('package.json');
const workflow = read('.github/workflows/ci.yml');

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
  "/api/talent/audio/pairing/connections/:connectionId/shares",
  "/api/talent/audio/files/shared-with-me",
  "/api/talent/audio/files/shared-by-me",
  "/api/talent/audio/file-grants/:grantId/download",
  "/api/talent/audio/file-grants/:grantId/reviews",
  "/api/talent/audio/file-grants/:grantId/revoke"
]) {
  if (!server.includes(route)) failures.push(`Server is missing collaboration route: ${route}`);
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
  'Share with connection',
  'Shared with me',
  'Shared by me',
  'Download source file',
  'Request changes',
  'Approve',
  'Review history',
  'Selected-file access revoked. Download and review replay are now denied.'
]) {
  if (!filesSurface.includes(term)) failures.push(`Files surface is missing collaboration action: ${term}`);
}

if (failures.length) {
  console.error('Audio file collaboration contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Audio file collaboration contract passed.');
