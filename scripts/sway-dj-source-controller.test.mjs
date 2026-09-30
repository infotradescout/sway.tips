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
  'playbackControlStore.getCommandReplay',
  'playbackControlStore.replaceConnectionGeneration',
  'callerIntentFingerprint',
  'This track has no synced booth path. Load it manually in VirtualDJ.'
]) assert.equal(server.includes(required), true, `missing corrected route behavior: ${required}`);
assert.ok(server.indexOf('playbackControlStore.getCommandReplay') < server.indexOf('playbackControlStore.requireCommandTarget'),
  'same-id recovery must run before current target validation');
const tokenRoute = server.slice(server.indexOf("app.post('/api/talent/control-bridge/token'"), server.indexOf("app.post('/api/talent/playback/commands'"));
assert.ok(tokenRoute.indexOf('revokeActiveSessionsForActorUser') < tokenRoute.indexOf('replaceConnectionGeneration'));
assert.ok(tokenRoute.indexOf('replaceConnectionGeneration') < tokenRoute.indexOf('issueSession'),
  'connection invalidation and token generation replacement must share the issuance transaction');
assert.equal(server.includes('command: created.command'), false, 'POST playback responses must not return the persisted payload');
assert.equal(server.includes('command: completion.command'), false, 'bridge completion responses must not return the persisted payload');
assert.equal(server.includes('projectPlaybackCommandReceipt(created.command)'), true, 'POST playback responses must use the safe receipt projection');
assert.equal(server.includes('projectPlaybackCommandReceipt(completion.command)'), true, 'completion responses must use the safe receipt projection');

for (const required of [
  'flushCompletions',
  'executeClaimedCommand',
  'saveLedger',
  'pendingCompletionIds',
  'publicCommandResult',
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
  'VirtualDJ · Network Control',
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
assert.equal(calls.find(call => String(call.url).endsWith('/execute')).body, 'deck 2 load "C:/Music/Test.mp3"');
assert.equal(loadResult.acknowledgement, 'accepted');
assert.equal(loadResult.confirmationStatus, 'exact_track_confirmed');
assert.equal(loadResult.observation.deck, 2);

const executeCallsBeforeMissingPath = calls.filter(call => String(call.url).endsWith('/execute')).length;
await assert.rejects(
  () => adapter.executeCommand({ action: 'load', payload: { deck: 2, track: { title: 'Test Track', artist: 'Test Artist' } } }),
  /exact synced booth path/
);
assert.equal(calls.filter(call => String(call.url).endsWith('/execute')).length, executeCallsBeforeMissingPath,
  'metadata-only load must not send a mutating first-result search');
const wrongExactTrack = await adapter.executeCommand({
  action: 'load', payload: { deck: 2, track: { path: 'C:/Music/Different.mp3', title: 'Test Track', artist: 'Test Artist' } }
});
assert.equal(wrongExactTrack.confirmationStatus, 'source_acknowledged', 'matching metadata cannot replace exact path proof');
const nextResult = await adapter.executeCommand({ action: 'next', payload: { deck: 2 } });
assert.equal(nextResult.confirmationStatus, 'source_acknowledged', 'next has no exact attributable state proof');

const stoppedStateAdapter = new VirtualDjNetworkControl({ fetchImpl: async (url, init) => {
  if (String(url).endsWith('/execute')) return new Response('true', { status: 200 });
  const script = String(init?.body || '');
  if (script.endsWith(' play')) return new Response('false');
  return new Response('', { status: 200 });
}, deck: 2 });
assert.equal((await stoppedStateAdapter.executeCommand({ action: 'pause', payload: { deck: 2 } })).confirmationStatus, 'source_state_confirmed');
assert.equal((await stoppedStateAdapter.executeCommand({ action: 'stop', payload: { deck: 2 } })).confirmationStatus, 'source_acknowledged');
assert.equal((await stoppedStateAdapter.executeCommand({ action: 'cue', payload: { deck: 2 } })).confirmationStatus, 'source_acknowledged');

const acceptedWithoutObservation = new VirtualDjNetworkControl({ fetchImpl: async (url) => {
  if (String(url).endsWith('/execute')) return new Response('true', { status: 200 });
  throw new TypeError('synthetic state connection loss');
}});
const acceptedResult = await acceptedWithoutObservation.executeCommand({ action: 'play', payload: { deck: 1 } });
assert.equal(acceptedResult.acknowledgement, 'accepted');
assert.equal(acceptedResult.confirmationStatus, 'source_acknowledged');
assert.equal(acceptedResult.observation, null, 'lost observation must not erase the real execute acknowledgement');

const uncertainExecute = new VirtualDjNetworkControl({ fetchImpl: async () => { throw new TypeError('synthetic execute response loss'); } });
await assert.rejects(
  () => uncertainExecute.executeCommand({ action: 'next', payload: { deck: 1 } }),
  /command outcome is uncertain/
);

const failedQuery = new VirtualDjNetworkControl({ fetchImpl: async () => { throw new TypeError('synthetic query connection loss'); } });
await assert.rejects(
  () => failedQuery.readState(1),
  error => error instanceof Error && error.message === 'VirtualDJ state request failed.',
  'a read-only state failure must not imply that a command ran'
);

const privatePath = 'C:/Users/performer/private-library/secret-track.mp3';
for (const rejectedFetch of [
  async () => new Response(privatePath, { status: 500 }),
  async () => new Response('false', { status: 200 })
]) {
  const rejected = new VirtualDjNetworkControl({ fetchImpl: rejectedFetch });
  await assert.rejects(
    () => rejected.executeCommand({ action: 'load', payload: { deck: 1, track: { path: privatePath } } }),
    error => error instanceof Error && !error.message.includes(privatePath),
    'VirtualDJ rejection errors must not expose the submitted booth-local path'
  );
}

const state = await adapter.readState(2);
assert.equal(state.connectionStatus, 'connected');
assert.equal(state.trackTitle, 'Test Track');
assert.equal(state.bpmTimes100, 12800);

assert.throws(
  () => new VirtualDjNetworkControl({ baseUrl: 'http://192.168.1.50:8088' }),
  /must stay on this machine/
);

console.log('Sway DJ source controller tests passed.');
