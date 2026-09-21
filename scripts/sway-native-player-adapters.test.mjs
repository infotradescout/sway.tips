import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { playerCapabilities } from '../src/player-connections.mjs';
import { createNativePlayerAdapter } from './lib/native-player-registry.mjs';
import { NativePlayerSession, newNativePlayerJournal, validateNativePlayerJournal } from './lib/native-player-session.mjs';
import { NativePlayerHub } from './lib/native-player-hub.mjs';
import { openNativePlayerStore } from './lib/native-player-store.mjs';
import { VlcPlayerControl } from './lib/vlc-player-control.mjs';
import { MpvPlayerControl } from './lib/mpv-player-control.mjs';

const owner = 'authorized-test-operator';
async function httpPlayer(t, handler) {
  const calls = [], sockets = new Set();
  const server = http.createServer((req, res) => { calls.push({ url: req.url, authorization: req.headers.authorization }); handler(req, res); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { sockets.forEach(socket => socket.destroy()); await new Promise(resolve => server.close(resolve)); assert.equal(server.listening, false); });
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}
async function ipcPlayer(t, handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sway-mpv-'));
  const socketPath = path.join(directory, 'player.sock'), calls = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = ''; socket.setEncoding('utf8');
    socket.on('data', text => {
      buffer += text;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        const request = JSON.parse(line); calls.push(request); handler(request, socket);
      }
    });
  });
  server.listen(socketPath); await once(server, 'listening');
  t.after(async () => { sockets.forEach(socket => socket.destroy()); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true }); });
  return { socketPath, calls };
}
const status = (res, state = 'paused') => res.end(JSON.stringify({ state, time: 3, length: 90,
  currentplid: 7, information: { category: { meta: { title: 'Owned tone', artist: 'Sway test' } } } }));
const ipcReply = (request, socket, data) => socket.write(JSON.stringify({ request_id: request.request_id, error: 'success', data }) + '\n');
function session(player, journal = newNativePlayerJournal(owner), persist = () => {}) {
  return new NativePlayerSession({ player, actorId: owner, connectionId: randomUUID(), journal, persist });
}

// Protocol servers below are controlled fixtures, not installed VLC/mpv.
test('native factory keeps accounts and MIDI separate and does not invent adapters', () => {
  assert.equal(playerCapabilities('spotify').kind, 'account');
  assert.equal(playerCapabilities('mixxx').playbackFeedback, false);
  for (const program of ['spotify', 'mixxx', 'serato', '__proto__']) assert.throws(() => createNativePlayerAdapter({ program }));
  assert.throws(() => createNativePlayerAdapter({ program: 'vlc', password: 'x', deck: 2 }), /deck/);
  assert.throws(() => playerCapabilities('vlc').actions.push('load'));
});
test('VLC requires local explicit endpoints and keeps authentication out of descriptions', () => {
  for (const baseUrl of ['http://example.com', 'http://localhost:8080', 'http://127.0.0.1:8080/path',
    'http://127.0.0.1:8080/?password=x', 'http://x:y@127.0.0.1:8080', 'file:///tmp/player']) {
    assert.throws(() => new VlcPlayerControl({ baseUrl, password: 'secret' }));
  }
  assert.throws(() => new VlcPlayerControl({ password: '' }));
  const player = createNativePlayerAdapter({ program: 'vlc', password: 'secret' });
  assert.equal(JSON.stringify(session(player).describe()).includes('secret'), false);
  assert.throws(() => { player.adapter.endpoint = 'http://127.0.0.1:9999'; });
});
test('VLC read-only setup and explicit actions use force commands, never a play/pause toggle', async t => {
  const fixture = await httpPlayer(t, (_req, res) => status(res));
  const adapter = new VlcPlayerControl({ baseUrl: fixture.url, password: 'owned' });
  assert.equal(fixture.calls.length, 0);
  const state = await adapter.readState();
  assert.equal(state.playing, false); assert.equal(state.positionMs, 3000); assert.equal(state.trackTitle, 'Owned tone');
  for (const action of ['play', 'pause', 'stop', 'next', 'previous']) assert.equal((await adapter.executeCommand({ action })).executionStatus, 'accepted');
  assert.deepEqual(fixture.calls.map(call => new URL(call.url, fixture.url).searchParams.get('command')).filter(Boolean),
    ['pl_forceresume', 'pl_forcepause', 'pl_stop', 'pl_next', 'pl_previous']);
  assert.equal(fixture.calls[0].authorization, 'Basic ' + Buffer.from(':owned').toString('base64'));
  const count = fixture.calls.length;
  await assert.rejects(adapter.executeCommand({ action: 'load', payload: { track: { path: '/etc/passwd' } } }), /Unsupported/);
  assert.equal(fixture.calls.length, count);
});
for (const redirect of [301, 302, 303, 307, 308]) {
  test(`VLC HTTP ${redirect} cannot retarget or resend a command`, async t => {
    const other = await httpPlayer(t, (_req, res) => status(res, 'playing'));
    const fixture = await httpPlayer(t, (_req, res) => res.writeHead(redirect, { location: other.url + '/requests/status.json' }).end());
    const adapter = new VlcPlayerControl({ baseUrl: fixture.url, password: 'secret' });
    await assert.rejects(adapter.executeCommand({ action: 'next' }));
    assert.equal(fixture.calls.length, 1); assert.equal(other.calls.length, 0);
  });
}
test('VLC unreadable/negative states are not successful execution', async () => {
  for (const body of ['<html>login</html>', '{}', '{"state":"unknown"}', '{"state":"paused","error":"denied"}']) {
    const adapter = new VlcPlayerControl({ password: 'x', fetchImpl: async () => new Response(body) });
    await assert.rejects(adapter.executeCommand({ action: 'play' }));
  }
});
test('VLC deadline bounds a body or fetch that ignores abort without retries', { timeout: 2000 }, async () => {
  for (const bodyStall of [true, false]) {
    let calls = 0, signal;
    const adapter = new VlcPlayerControl({ password: 'x', timeoutMs: 50, fetchImpl: (_url, init) => {
      calls++; signal = init.signal;
      return bodyStall ? Promise.resolve({ ok: true, text: () => new Promise(() => {}) }) : new Promise(() => {});
    } });
    await assert.rejects(adapter.executeCommand({ action: 'play' }), /timed out/);
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
  }
});
test('mpv observes real IPC packets, exact IDs, fragmented replies and no autoplay', async t => {
  let paused = true;
  const fixture = await ipcPlayer(t, (request, socket) => {
    const command = request.command;
    if (command[0] === 'set_property') paused = command[2];
    const values = { 'property-list': ['pause', 'idle-active'], pause: paused, 'idle-active': false,
      'time-pos': 3.5, duration: 90, 'media-title': 'Owned tone' };
    socket.write(JSON.stringify({ request_id: request.request_id + 1, error: 'success', data: 'wrong response' }) + '\n');
    const result = JSON.stringify({ request_id: request.request_id, error: 'success', data: values[command[1]] ?? null }) + '\n';
    socket.write(result.slice(0, 7)); socket.write(result.slice(7));
  });
  const adapter = new MpvPlayerControl({ socketPath: fixture.socketPath });
  assert.equal(fixture.calls.length, 0);
  assert.equal((await adapter.readState()).playing, false);
  await adapter.executeCommand({ action: 'play' }); assert.equal((await adapter.readState()).playing, true);
  await adapter.executeCommand({ action: 'pause' }); assert.equal((await adapter.readState()).playing, false);
  for (const action of ['stop', 'next', 'previous']) await adapter.executeCommand({ action });
  assert.deepEqual(fixture.calls.filter(call => call.command[0] !== 'get_property').map(call => call.command),
    [['set_property', 'pause', false], ['set_property', 'pause', true], ['stop'], ['playlist-next', 'weak'], ['playlist-prev', 'weak']]);
  await assert.rejects(adapter.executeCommand({ action: 'run', payload: { command: 'anything' } }), /Unsupported/);
});
test('mpv missing media values remain null, not fabricated playing progress', async t => {
  const fixture = await ipcPlayer(t, (request, socket) => {
    const prop = request.command[1];
    if (['property-list', 'pause', 'idle-active'].includes(prop)) ipcReply(request, socket, prop === 'property-list' ? ['pause', 'idle-active'] : true);
    else socket.write(JSON.stringify({ request_id: request.request_id, error: 'property unavailable' }) + '\n');
  });
  const state = await new MpvPlayerControl({ socketPath: fixture.socketPath }).readState();
  assert.equal(state.playing, false); assert.equal(state.positionMs, null); assert.equal(state.trackTitle, null);
});
for (const mode of ['lost', 'wrong-id', 'malformed', 'negative']) {
  test(`mpv ${mode} response does not become acceptance or an automatic retry`, async t => {
    const fixture = await ipcPlayer(t, (request, socket) => {
      if (mode === 'lost') socket.destroy();
      if (mode === 'wrong-id') ipcReply({ request_id: request.request_id + 1 }, socket, null);
      if (mode === 'malformed') socket.write('not-json\n');
      if (mode === 'negative') socket.write(JSON.stringify({ request_id: request.request_id, error: 'failure' }) + '\n');
    });
    await assert.rejects(new MpvPlayerControl({ socketPath: fixture.socketPath, timeoutMs: 50 }).executeCommand({ action: 'next' }));
    assert.equal(fixture.calls.length, 1);
  });
}

for (const program of ['vlc', 'mpv']) {
  test(`${program}: shared journal reserves before I/O, preserves uncertainty and blocks reconnect replay`, async t => {
    let disk, recovered = false, connection;
    const journal = newNativePlayerJournal(owner);
    const id = randomUUID();
    const observe = () => {
      assert.equal(disk.execution.outcomes[id].result.executionStatus, 'unknown');
      assert.equal(typeof disk.bindings[id].fingerprint, 'string');
    };
    let fixture, config;
    if (program === 'vlc') {
      fixture = await httpPlayer(t, (_req, res) => { observe(); if (!recovered) res.destroy(); else status(res); });
      config = { program, baseUrl: fixture.url, password: 'x' };
    } else {
      fixture = await ipcPlayer(t, (request, socket) => { observe(); if (!recovered) socket.destroy(); else ipcReply(request, socket, null); });
      config = { program, socketPath: fixture.socketPath };
    }
    const player = createNativePlayerAdapter(config);
    connection = session(player, journal, () => { disk = structuredClone(journal); });
    const originalRevision = connection.revision;
    const first = await connection.execute({ id, revision: originalRevision, action: 'next' });
    assert.equal(first.success, false); assert.equal(first.result.executionStatus, 'unknown'); assert.equal(fixture.calls.length, 1);
    await assert.rejects(connection.execute({ id, revision: originalRevision, action: 'play' }), /different intent/);
    recovered = true;
    const restored = structuredClone(disk);
    connection = new NativePlayerSession({ player, actorId: owner, connectionId: connection.connectionId, journal: restored, persist: () => {} });
    const duplicate = await connection.execute({ id, revision: originalRevision, action: 'next' });
    assert.equal(duplicate.replay, true); assert.equal(fixture.calls.length, 1);
    const fresh = connection.reconnect(originalRevision);
    await assert.rejects(connection.execute({ id, revision: originalRevision, action: 'next' }), /Stale/);
    await assert.rejects(connection.execute({ id: randomUUID(), revision: fresh.revision, action: 'play' }), /explicitly review/);
    assert.equal(fixture.calls.length, 1);
    assert.throws(() => connection.reviewUnknown({ id, revision: fresh.revision, checkedOriginalPlayer: false }));
    const reviewed = connection.reviewUnknown({ id, revision: fresh.revision, checkedOriginalPlayer: true });
    assert.equal(reviewed.replayed, false); assert.equal(fixture.calls.length, 1);
    assert.equal((await connection.execute({ id: randomUUID(), revision: fresh.revision, action: 'pause' })).success, true);
    assert.equal(fixture.calls.length, 2);
    await assert.rejects(connection.execute({ id, revision: fresh.revision, action: 'next' }), /different intent/);
    assert.equal(fixture.calls.length, 2);
  });
}
test('two programs coexist without hidden selection or redirecting a command ID to another target', async t => {
  const vlc = await httpPlayer(t, (_req, res) => status(res));
  const mpv = await ipcPlayer(t, (request, socket) => ipcReply(request, socket, null));
  const journal = newNativePlayerJournal(owner);
  const ids = [randomUUID(), randomUUID()];
  const hub = new NativePlayerHub({ actorId: owner, store: { journal, persist: () => {} }, configs: [
    { id: ids[0], program: 'vlc', baseUrl: vlc.url, password: 'private-vlc-key' },
    { id: ids[1], program: 'mpv', socketPath: mpv.socketPath },
  ] });
  const [left, right] = hub.list();
  assert.equal(vlc.calls.length + mpv.calls.length, 0);
  assert.equal(JSON.stringify(hub.list()).includes('private-vlc-key'), false);
  const id = randomUUID();
  await hub.execute(left.id, { id, revision: left.revision, action: 'pause' });
  await assert.rejects(hub.execute(right.id, { id, revision: right.revision, action: 'pause' }), /different intent/);
  assert.equal(vlc.calls.length, 1); assert.equal(mpv.calls.length, 0);
  await hub.execute(right.id, { id: randomUUID(), revision: right.revision, action: 'pause' });
  assert.equal(mpv.calls.length, 1);
  assert.throws(() => hub.reconnect(randomUUID(), left.revision), /explicitly configured/);
});
test('storage write failure prevents dispatch and poisons later mutations', async t => {
  const fixture = await httpPlayer(t, (_req, res) => status(res));
  let fail = false;
  const connection = session(createNativePlayerAdapter({ program: 'vlc', baseUrl: fixture.url, password: 'x' }), undefined,
    () => { if (fail) throw new Error('Disk unavailable'); });
  fail = true;
  await assert.rejects(connection.execute({ id: randomUUID(), revision: connection.revision, action: 'play' }), /Disk unavailable/);
  assert.equal(fixture.calls.length, 0);
  await assert.rejects(connection.execute({ id: randomUUID(), revision: connection.revision, action: 'pause' }), /storage failed/);
  assert.equal(fixture.calls.length, 0);
});
test('payload target switches, storage corruption and a foreign owner fail before I/O', async t => {
  const fixture = await httpPlayer(t, (_req, res) => status(res));
  const player = createNativePlayerAdapter({ program: 'vlc', baseUrl: fixture.url, password: 'x' });
  const connection = session(player);
  for (const payload of [{ deck: 2 }, { path: 'http://elsewhere' }, { command: 'pl_play' }, []]) {
    await assert.rejects(connection.execute({ id: randomUUID(), revision: connection.revision, action: 'play', payload }));
  }
  assert.throws(() => validateNativePlayerJournal(connection.journal, 'someone-else'));
  const corrupt = structuredClone(connection.journal); corrupt.bindings[randomUUID()] = { fingerprint: '0'.repeat(64) };
  assert.throws(() => validateNativePlayerJournal(corrupt, owner));
  assert.equal(fixture.calls.length, 0);
});
test('same-target aliases cannot bypass an unknown command or steal its connection ID', async t => {
  const fixture = await httpPlayer(t, (_req, res) => res.destroy());
  const journal = newNativePlayerJournal(owner);
  const player = createNativePlayerAdapter({ program: 'vlc', baseUrl: fixture.url, password: 'x' });
  const first = session(player, journal), second = session(player, journal);
  await first.execute({ id: randomUUID(), revision: first.revision, action: 'next' });
  await assert.rejects(second.execute({ id: randomUUID(), revision: second.revision, action: 'play' }), /explicitly review/);
  const changed = createNativePlayerAdapter({ program: 'vlc', baseUrl: 'http://127.0.0.1:49999', password: 'x' });
  assert.throws(() => new NativePlayerSession({ player: changed, actorId: owner, journal, connectionId: first.connectionId, persist: () => {} }), /another player/);
  assert.equal(fixture.calls.length, 1);
});
test('disk journal survives reopen and refuses a competing process while locked', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sway-player-store-'));
  const filename = path.join(directory, 'journal.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = openNativePlayerStore({ filename, actorId: owner });
  first.persist();
  const module = new URL('./lib/native-player-store.mjs', import.meta.url).href;
  const script = `import {openNativePlayerStore} from ${JSON.stringify(module)};try {openNativePlayerStore({filename:process.argv[1],actorId:process.argv[2]});process.exitCode=2;}catch(error){if(error.code!=='EEXIST')throw error;}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, filename, owner], { stdio: 'pipe' });
  const [exit, signal] = await once(child, 'exit');
  assert.equal(exit, 0); assert.equal(signal, null);
  first.close();
  const second = openNativePlayerStore({ filename, actorId: owner });
  assert.equal(second.journal.execution.bridgeInstanceId, first.journal.execution.bridgeInstanceId); second.close();
  assert.equal(fs.existsSync(filename + '.lock'), false);
  fs.writeFileSync(filename, 'corrupt');
  assert.throws(() => openNativePlayerStore({ filename, actorId: owner }));
  assert.equal(fs.existsSync(filename + '.lock'), false);
});

test('a final receipt write failure leaves a durable unknown outcome on restart', async t => {
  const fixture = await httpPlayer(t, (_req, res) => status(res));
  const player = createNativePlayerAdapter({ program: 'vlc', baseUrl: fixture.url, password: 'x' });
  const journal = newNativePlayerJournal(owner);
  let saved, writes = 0;
  const connection = session(player, journal, () => { writes++; if (writes === 3) throw new Error('Final write failed'); saved = structuredClone(journal); });
  const id = randomUUID(), revision = connection.revision;
  await assert.rejects(connection.execute({ id, revision, action: 'next' }), /Final write/);
  assert.equal(fixture.calls.length, 1);
  assert.equal(saved.execution.outcomes[id].result.executionStatus, 'unknown');
  const restored = new NativePlayerSession({ player, actorId: owner, connectionId: connection.connectionId, journal: saved, persist: () => {} });
  assert.equal((await restored.execute({ id, revision, action: 'next' })).replay, true);
  assert.equal(fixture.calls.length, 1);
});
test('concurrent duplicate and later commands cannot race the first acknowledgement', async t => {
  let acknowledge;
  const fixture = await httpPlayer(t, (_req, res) => { acknowledge = () => status(res); });
  const connection = session(createNativePlayerAdapter({ program: 'vlc', baseUrl: fixture.url, password: 'x' }));
  const command = { id: randomUUID(), revision: connection.revision, action: 'next' };
  const first = connection.execute(command);
  const duplicate = await connection.execute(command);
  assert.equal(duplicate.replay, true); assert.equal(duplicate.result.executionStatus, 'unknown');
  await assert.rejects(connection.execute({ ...command, id: randomUUID(), action: 'pause' }), /explicitly review/);
  const deadline = Date.now() + 1000;
  while (!acknowledge && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof acknowledge, 'function'); acknowledge();
  assert.equal((await first).success, true); assert.equal(fixture.calls.length, 1);
});
test('VLC Play resumes a stopped item, resumes pause, and never restarts an already playing item', async t => {
  let state = 'stopped';
  const fixture = await httpPlayer(t, (req, res) => {
    if (new URL(req.url, 'http://127.0.0.1').searchParams.has('command')) state = 'playing';
    status(res, state);
  });
  const adapter = new VlcPlayerControl({ baseUrl: fixture.url, password: 'x' });
  await adapter.executeCommand({ action: 'play' });
  assert.equal(new URL(fixture.calls.at(-1).url, fixture.url).searchParams.get('command'), 'pl_play');
  const before = fixture.calls.length; const result = await adapter.executeCommand({ action: 'play' });
  assert.equal(result.noOp, true); assert.equal(fixture.calls.length, before + 1);
  assert.equal(new URL(fixture.calls.at(-1).url, fixture.url).searchParams.has('command'), false);
});
test('actual native-host entry preserves two targets and an uncertain command across process restart', { timeout: 10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sway-native-entry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let lose = true;
  const vlc = await httpPlayer(t, (req, res) => {
    const command = new URL(req.url, 'http://127.0.0.1').searchParams.get('command');
    if (command === 'pl_next' && lose) res.destroy(); else status(res);
  });
  const mpv = await ipcPlayer(t, (request, socket) => ipcReply(request, socket, null));
  const ids = [randomUUID(), randomUUID()];
  const configFile = path.join(directory, 'config.json'), journalFile = path.join(directory, 'journal.json');
  fs.writeFileSync(configFile, JSON.stringify({ connections: [
    { id: ids[0], program: 'vlc', baseUrl: vlc.url, password: 'private-test-key' },
    { id: ids[1], program: 'mpv', socketPath: mpv.socketPath },
  ] }), { mode: 0o600 });
  async function start() {
    const child = spawn(process.execPath, [new URL('./sway-native-player-session.mjs', import.meta.url).pathname, configFile, journalFile]);
    let pending = '', errorText = ''; const queued = [], readers = [];
    child.stderr.on('data', chunk => { errorText += chunk; });
    child.stdout.on('data', chunk => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const value = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
        if (readers.length) readers.shift()(value); else queued.push(value);
      }
    });
    const next = () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => readers.push(resolve));
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const exited = once(child, 'close');
    const close = async () => { child.stdin.end(); const [code, signal] = await exited; clearTimeout(timer); assert.equal(code, 0, errorText); assert.equal(signal, null); };
    t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); });
    return { initial: await next(), send: async value => { child.stdin.write(JSON.stringify(value) + '\n'); return next(); }, close };
  }
  const first = await start();
  assert.equal(first.initial.connections.length, 2); assert.equal(first.initial.commandSent, false);
  assert.equal(vlc.calls.length + mpv.calls.length, 0);
  const revision = first.initial.connections[0].revision, id = randomUUID();
  const request = { type: 'command', connectionId: ids[0], revision, id, action: 'next' };
  const attempt = await first.send(request);
  assert.equal(attempt.result.result.executionStatus, 'unknown'); assert.equal(vlc.calls.length, 1); assert.equal(mpv.calls.length, 0);
  await first.close(); lose = false;
  const second = await start();
  assert.equal((await second.send(request)).result.replay, true);
  assert.equal(vlc.calls.length, 1);
  const fresh = (await second.send({ type: 'reconnect', connectionId: ids[0], revision })).result;
  const blocked = await second.send({ ...request, revision: fresh.revision, id: randomUUID(), action: 'pause' });
  assert.equal(blocked.ok, false); assert.equal(vlc.calls.length, 1);
  assert.equal((await second.send({ type: 'review', connectionId: ids[0], revision: fresh.revision, id, checkedOriginalPlayer: true })).result.replayed, false);
  assert.equal((await second.send({ ...request, revision: fresh.revision, id: randomUUID(), action: 'pause' })).result.success, true);
  assert.equal(vlc.calls.length, 2); assert.equal(mpv.calls.length, 0);
  const other = second.initial.connections[1];
  assert.equal((await second.send({ type: 'command', connectionId: other.id, revision: other.revision, id: randomUUID(), action: 'pause' })).result.success, true);
  assert.equal(mpv.calls.length, 1);
  await second.close(); assert.equal(fs.existsSync(journalFile + '.lock'), false);
});
