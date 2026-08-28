import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const dashboard = read('src/components/TalentDashboard.tsx');
const shareKit = read('src/components/PerformerShareKit.tsx');
const routing = read('src/performer-workspace-routing.ts');
const safeNext = read('src/file-collaboration-routing.ts');
const packageJson = JSON.parse(read('package.json'));
const failures = [];

for (const term of [
  "| 'connections'",
  "connections: '/talent/connections'",
  "if (normalizedPath === '/talent/connections') return 'connections'"
]) {
  if (!routing.includes(term)) failures.push(`Connections routing missing term: ${term}`);
}

for (const term of [
  "{ id: 'connections', label: 'Connections'",
  'data-sway-performer-connections-workspace="true"',
  'data-sway-open-connections="true"',
  '<PerformerShareKit activeGigId={roomActive ? activeGigId : null} />',
  'Room, stream & booth setup',
  'data-sway-dj-software-truth="true"',
  'OBS / Streamlabs',
  'Stream Deck / Companion',
  'Serato · rekordbox · VirtualDJ · Traktor · djay',
  'No native link',
  'Sway does not load decks or control playback.',
  'Open advanced music-library connections'
]) {
  if (!dashboard.includes(term)) failures.push(`Connections workspace missing term: ${term}`);
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
