import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const bridge = readFileSync(join(root, 'scripts/sway-control-bridge.mjs'), 'utf8');
const adapter = readFileSync(join(root, 'scripts/lib/virtualdj-network-control.mjs'), 'utf8');
const docs = readFileSync(join(root, 'docs/SWAY_CONTROL_BRIDGE.md'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
const failures = [];

for (const term of [
  'Sway DJ Control Bridge',
  '--gig-id <id>',
  '--auth-token <token>',
  '--virtualdj-url <url>',
  '--local-token <token>',
  'SWAY_CONTROL_AUTH_TOKEN',
  'authorization: `Bearer ${authToken}`',
  "bridge: 'sway-dj-control-bridge'",
  "requestUrl.pathname === '/health'",
  "requestUrl.pathname === '/state'",
  "['/preset/actions', '/preset/companion', '/preset/stream-deck'].includes(requestUrl.pathname)",
  "requestUrl.pathname === '/top/text'",
  "requestUrl.pathname.match(/^\\/action\\/([a-z-]+)$/)",
  "requestUrl.pathname.match(/^\\/playback\\/([a-z-]+)$/)",
  '/playback/load-top',
  '/playback/play',
  '/playback/pause',
  '/playback/stop',
  '/playback/cue',
  '/playback/next',
  '/playback/previous',
  '/api/talent/playback/bridge/claim',
  '/api/talent/playback/bridge/complete',
  '/api/talent/playback/bridge/state',
  'sway-control-bridge-preset.v2',
  'flushCompletions',
  'executeClaimedCommand',
  'pendingCompletionIds',
  'Local bridge token required.',
  'Browser cross-origin requests are disabled.'
]) {
  if (!bridge.includes(term)) failures.push(`Control bridge missing required term: ${term}`);
}

for (const term of [
  "this.request('query', script)",
  "this.request('execute', script)",
  "case 'load'",
  'exact_library_path',
  'virtualdj_search_first_result',
  "case 'play'",
  "case 'pause'",
  "case 'stop'",
  "case 'cue'",
  "case 'next'",
  "case 'previous'",
  'Network Control',
  "minimumVersion: '2023'",
  "license: 'Pro'"
]) {
  if (!adapter.includes(term)) failures.push(`VirtualDJ adapter missing required term: ${term}`);
}

for (const term of [
  'Sway is the room controller. The audio stays in the DJ\'s playback source.',
  'VirtualDJ 2023 or newer',
  'official **Network Control** extension',
  'one-way Web MIDI',
  'Spotify is metadata/import/open-only',
  'TIDAL does not have a direct Sway connector',
  'durably queues a room-scoped command',
  'writes the outcome to a bounded local ledger',
  'Cloud bridge tokens expire after 6 hours',
  'Browser library imports cannot persist executable local paths'
]) {
  if (!docs.includes(term)) failures.push(`Control bridge docs missing truth/security term: ${term}`);
}

for (const term of [
  '"control:bridge": "node scripts/sway-control-bridge.mjs"',
  'node scripts/sway-control-bridge.contract.test.mjs'
]) {
  if (!packageJson.includes(term)) failures.push(`Package scripts missing control bridge term: ${term}`);
}

for (const forbidden of [
  'SWAY_CONTROL_AUTH_COOKIE',
  "'access-control-allow-origin': '*'",
  'automatically plays Spotify',
  'directly controls Spotify playback',
  'stores performer cookie'
]) {
  if (bridge.includes(forbidden) || docs.includes(forbidden)) failures.push(`Control bridge contains forbidden claim/pattern: ${forbidden}`);
}

if (failures.length) {
  console.error('Sway control bridge contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway control bridge contract passed.');
