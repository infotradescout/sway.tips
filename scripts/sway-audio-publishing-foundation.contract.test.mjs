import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');
const dashboard = read('src/components/TalentDashboard.tsx');
const talentApp = read('src/shells/TalentApp.tsx');
const server = read('server.ts');
const doctrine = read('docs/VIBE_ENGINEERING_DOCTRINE.md');
const render = read('render.yaml');

for (const path of [
  'src/components/PerformerAudioFiles.tsx',
  'src/components/PerformerFilePairing.tsx',
  'src/components/TalentFileConnectCard.tsx',
  'docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md',
  'src/server/audio-object-storage.ts',
  'src/server/audio-object-storage-r2.ts',
  'src/server/audio-publishing-service.ts',
  'src/server/audio-file-pairing-service.ts',
  'src/server/audio-file-collaboration-service.ts'
]) {
  if (existsSync(join(root, path))) failures.push(`Retired product surface still exists: ${path}`);
}

for (const term of [
  "{ id: 'catalog', label: 'Catalog'",
  "inactiveWorkspace === 'catalog'",
  'data-sway-audio-catalog=',
  '<PerformerAudioFiles',
  '<PerformerFilePairing',
  'Open my Catalog'
]) {
  if (dashboard.includes(term)) failures.push(`Performer UI exposes retired audio scope: ${term}`);
}

for (const term of ['TalentFileConnectCard', "pathname === '/talent/connect/files'"]) {
  if (talentApp.includes(term)) failures.push(`Performer routing exposes retired file collaboration: ${term}`);
}

if (!server.includes("app.all(/^\\/api\\/talent\\/audio(?:\\/|$)/")) {
  failures.push('Server must tombstone every historical talent audio route before legacy handlers.');
}
if (!server.includes("status(410)")) failures.push('Retired audio API must return 410 Gone.');
for (const retiredHandler of [
  "app.get('/api/talent/audio/projects'",
  "app.post('/api/talent/audio/projects'",
  "app.post('/api/talent/audio/pairing/tokens'",
  "app.get('/api/talent/audio/files/shared-with-me'"
]) {
  if (server.includes(retiredHandler)) failures.push(`Retired audio handler remains in server.ts: ${retiredHandler}`);
}
if (server.includes('await audioObjectStore.verifyReady()')) {
  failures.push('Sway startup must not depend on retired audio object storage.');
}
for (const term of ['SWAY_AUDIO_STORAGE_PROVIDER', 'SWAY_AUDIO_R2_BUCKET', 'SWAY_AUDIO_R2_ACCOUNT_ID']) {
  if (render.includes(term)) failures.push(`Render still requires retired audio infrastructure: ${term}`);
}
for (const term of ['Sway is one simple two-sided live product', 'Historical audio-distribution schema may remain dormant']) {
  if (!doctrine.includes(term)) failures.push(`Product doctrine missing scope lock: ${term}`);
}

if (failures.length) {
  console.error('Sway retired-audio scope contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway retired-audio scope contract passed.');
