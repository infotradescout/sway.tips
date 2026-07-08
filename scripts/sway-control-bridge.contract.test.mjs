import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const bridge = readFileSync(join(root, 'scripts/sway-control-bridge.mjs'), 'utf8');
const docs = readFileSync(join(root, 'docs/SWAY_CONTROL_BRIDGE.md'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
const failures = [];

for (const term of [
  'Sway Control Bridge',
  '127.0.0.1',
  '--gig-id <id>',
  '--auth-cookie <text>',
  "bridge: 'sway-control-bridge'",
  "GET' && req.url === '/health'",
  "GET' && req.url === '/state'",
  "POST' && typeof req.url === 'string'",
  '/action/toggle-requests',
  '/action/fulfill-top',
  '/action/hide-top',
  '/action/approve-pending',
  '/action/veto-pending',
  '/action/open-top-source',
  '/api/session/window/toggle',
  '/api/request/fulfill',
  '/api/moderation/hide',
  '/api/request/triage',
  "cookie: authCookie",
  'topApprovedRequest',
  'topPendingRequest'
]) {
  if (!bridge.includes(term) && !docs.includes(term)) {
    failures.push(`Control bridge missing required term: ${term}`);
  }
}

for (const term of [
  '"control:bridge": "node scripts/sway-control-bridge.mjs"',
  'node scripts/sway-control-bridge.contract.test.mjs'
]) {
  if (!packageJson.includes(term)) {
    failures.push(`Package scripts missing control bridge term: ${term}`);
  }
}

for (const term of [
  'It does not control Spotify, SoundCloud, Serato, rekordbox, or any other music',
  'Do not expose it on public networks.',
  'The `--auth-cookie` value acts like the signed-in performer browser session'
]) {
  if (!docs.includes(term)) {
    failures.push(`Control bridge docs missing truth/security term: ${term}`);
  }
}

for (const forbidden of [
  'new WebSocket',
  'WebSocket-only',
  'automatically plays songs',
  'directly controls Spotify playback',
  'directly controls SoundCloud playback',
  'stores performer cookie'
]) {
  if (bridge.includes(forbidden) || docs.includes(forbidden)) {
    failures.push(`Control bridge contains forbidden claim/pattern: ${forbidden}`);
  }
}

if (failures.length) {
  console.error('Sway control bridge contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway control bridge contract passed.');
