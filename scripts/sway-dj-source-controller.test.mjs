import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VirtualDjNetworkControl } from './lib/virtualdj-network-control.mjs';

const root = process.cwd();
const read = (file) => readFileSync(join(root, file), 'utf8');
const schema = read('src/db/schema.ts');
const server = read('server.ts');
const access = read('src/server/access-control.ts');
const bridge = read('scripts/sway-control-bridge.mjs');
const controller = read('src/components/PerformerPlaybackController.tsx');
const midi = read('src/browser-midi-playback.ts');

for (const required of [
  'export const playbackCommands',
  'export const playbackStates',
  'playback_commands_gig_client_command_idx',
  "app.post('/api/talent/playback/commands'",
  "app.post('/api/talent/playback/bridge/claim'",
  "app.post('/api/talent/playback/bridge/complete'",
  "app.post('/api/talent/playback/bridge/state'",
  'allowControlBridge: true',
  "sessionType === 'control_bridge'",
  'Control bridge token is scoped to a different live room.'
]) {
  assert.equal(schema.includes(required) || server.includes(required) || access.includes(required), true, `missing durable/security term: ${required}`);
}

for (const required of [
  'flushCompletions',
  'executeClaimedCommand',
  'saveLedger',
  'pendingCompletionIds',
  "requestUrl.pathname.match(/^\\/playback\\/([a-z-]+)$/)",
  "if (req.method === 'OPTIONS')",
  'Browser cross-origin requests are disabled.',
  'Local bridge token required.'
]) {
  assert.equal(bridge.includes(required), true, `missing bridge reliability/security term: ${required}`);
}

for (const required of [
  'data-sway-playback-controller="true"',
  "fetch('/api/talent/playback/commands'",
  '/api/talent/playback/snapshot/',
  'VirtualDJ · full control',
  'MIDI · one-way',
  "window.addEventListener('sway:playback-action'",
  'Generic MIDI cannot identify a track.'
]) {
  assert.equal(controller.includes(required), true, `missing room controller term: ${required}`);
}

for (const required of [
  'MIDI_PLAYBACK_NOTE_MAP',
  'requestMIDIAccess',
  'software: true',
  'output.send([noteOn, note, 127])',
  'output.send([noteOff, note, 0]'
]) {
  assert.equal(midi.includes(required), true, `missing Web MIDI term: ${required}`);
}

const calls = [];
const fakeFetch = async (url, init) => {
  calls.push({ url, body: init?.body });
  if (String(url).endsWith('/execute')) return new Response('true', { status: 200 });
  const script = String(init?.body || '');
  if (script.includes('get_title')) return new Response('Test Track');
  if (script.includes('get_artist')) return new Response('Test Artist');
  if (script.includes('get_filepath')) return new Response('C:/Music/Test.mp3');
  if (script.endsWith(' play')) return new Response('true');
  if (script.includes('get_position')) return new Response('0.25');
  if (script.includes('get_bpm')) return new Response('128');
  return new Response('', { status: 200 });
};

const adapter = new VirtualDjNetworkControl({ fetchImpl: fakeFetch, deck: 2 });
const loadResult = await adapter.executeCommand({
  action: 'load',
  payload: { deck: 2, track: { path: 'C:/Music/Test.mp3', title: 'Test Track', artist: 'Test Artist' } }
});
assert.equal(loadResult.loadMatchMode, 'exact_library_path');
assert.equal(calls.at(-1).body, 'deck 2 load "C:/Music/Test.mp3"');

const state = await adapter.readState(2);
assert.equal(state.connectionStatus, 'connected');
assert.equal(state.trackTitle, 'Test Track');
assert.equal(state.bpmTimes100, 12800);

assert.throws(
  () => new VirtualDjNetworkControl({ baseUrl: 'http://192.168.1.50:8088' }),
  /must stay on this machine/
);

console.log('Sway DJ source controller tests passed.');
