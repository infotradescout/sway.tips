import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { NativePlayerHub } from './lib/native-player-hub.mjs';
import { newNativePlayerJournal } from './lib/native-player-session.mjs';
import { startNativePlayerHost } from './lib/native-player-host.mjs';
import { NativePlayerClient, parseNativeConnection } from '../src/native-player-client.mjs';
import { boundedPlayerJson } from '../src/bounded-player-json.mjs';

const origin = 'https://app.sway.tips';
async function setup(t) {
  let playing = false, lost = false; const commands = [];
  const player = http.createServer((req, res) => {
    const command = new URL(req.url, 'http://127.0.0.1').searchParams.get('command');
    if (command) {
      commands.push(command);
      if (command === 'pl_forceresume' || command === 'pl_play') playing = true;
      if (command === 'pl_forcepause' || command === 'pl_stop') playing = false;
      if (lost) { lost = false; res.destroy(); return; }
    }
    res.end(JSON.stringify({ state: playing ? 'playing' : 'paused', time: 1, length: 60, information: { category: { meta: { title: 'Test' } } } }));
  });
  player.listen(0, '127.0.0.1'); await once(player, 'listening');
  const token = randomBytes(32).toString('base64url'), id = randomUUID();
  const journal = newNativePlayerJournal('test-operator');
  const hub = new NativePlayerHub({ actorId: 'test-operator', store: { journal, persist: () => {} }, configs: [
    { id, program: 'vlc', baseUrl: `http://127.0.0.1:${player.address().port}`, password: 'downstream-private' },
  ] });
  let now = Date.now(); const expiresAt = now + 30000;
  const host = await startNativePlayerHost({ hub, token, port: 0, expiresAt, now: () => now });
  const base = `http://127.0.0.1:${host.port}`;
  t.after(async () => { await host.close(); player.closeAllConnections(); await new Promise(resolve => player.close(resolve)); });
  const client = new NativePlayerClient({ pairingKey: token, port: host.port,
    fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin } }) });
  return { base, token, client, commands, lose: () => { lost = true; }, expire: () => { now = expiresAt; } };
}
test('unpaired origins, missing keys, expired keys and query-string keys cannot control a player', async t => {
  const f = await setup(t);
  for (const headers of [{}, { origin }, { origin: 'https://other.invalid', authorization: 'Bearer ' + f.token }, { origin, authorization: 'Bearer wrong' }]) {
    assert.ok([401, 403].includes((await fetch(f.base + '/v1/connections', { headers })).status));
  }
  assert.equal((await fetch(f.base + '/v1/connections?token=' + f.token, { headers: { origin } })).status, 401);
  f.expire(); await assert.rejects(f.client.list(), /expired/); assert.equal(f.commands.length, 0);
});
test('CORS preflight permits only the explicit app origin and bounded methods/headers', async t => {
  const f = await setup(t);
  const response = await fetch(f.base + '/v1/command', { method: 'OPTIONS', headers: { origin,
    'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type', 'access-control-request-private-network': 'true' } });
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  const denied = await fetch(f.base + '/v1/command', { method: 'OPTIONS', headers: { origin,
    'access-control-request-method': 'DELETE', 'access-control-request-headers': 'authorization' } });
  assert.equal(denied.status, 403); assert.equal(f.commands.length, 0);
});
test('actual browser client and native host distinguish observed state from accepted commands', async t => {
  const f = await setup(t);
  const [connection] = await f.client.list(); assert.equal(f.commands.length, 0);
  assert.equal(connection.label, 'VLC'); assert.equal(connection.actions.includes('load'), false);
  assert.equal((await f.client.state(connection)).playing, false);
  const id = randomUUID();
  assert.equal((await f.client.command(connection, { id, action: 'play' })).accepted, true);
  assert.equal((await f.client.state(connection)).playing, true);
  assert.equal((await f.client.command(connection, { id, action: 'play' })).replay, true);
  assert.deepEqual(f.commands, ['pl_forceresume']);
  await f.client.command(connection, { id: randomUUID(), action: 'pause' });
  assert.equal((await f.client.state(connection)).playing, false);
});
test('lost original-player response stays held across host/client reconnect until exact review', async t => {
  const f = await setup(t); let [connection] = await f.client.list(); f.lose();
  const id = randomUUID(); const result = await f.client.command(connection, { id, action: 'next' });
  assert.equal(result.uncertain, true); assert.equal(f.commands.length, 1);
  [connection] = await f.client.list(); assert.equal(connection.pendingReview[0].id, id);
  connection = await f.client.reconnect(connection); assert.equal(connection.uncertain, true);
  await assert.rejects(f.client.command(connection, { id: randomUUID(), action: 'play' }), /reviewing/);
  assert.equal((await f.client.review(connection, id)).replayed, false); assert.equal(f.commands.length, 1);
  [connection] = await f.client.list();
  await f.client.command(connection, { id: randomUUID(), action: 'pause' }); assert.equal(f.commands.length, 2);
});
test('browser deadline and owner teardown never retry a command or accept a late response', { timeout: 3000 }, async () => {
  for (const mode of ['deadline', 'abort']) {
    let calls = 0, finish; const controller = new AbortController();
    const client = new NativePlayerClient({ pairingKey: 'x'.repeat(43), signal: controller.signal, timeoutMs: 50,
      fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
    const request = client.list(); if (mode === 'abort') controller.abort();
    await assert.rejects(request, /interrupted/); assert.equal(calls, 1);
    finish(new Response(JSON.stringify({ connections: [], expiresAt: new Date(Date.now() + 10000).toISOString() })));
    await assert.rejects(request, /interrupted/); assert.equal(calls, 1);
  }
});
test('malformed capabilities, wrong target receipts and stale observed state fail closed', async t => {
  const f = await setup(t); const [connection] = await f.client.list();
  const bad = { ...connection, capabilities: { actions: ['load'] }, uncertain: false, pendingReview: [] };
  assert.throws(() => parseNativeConnection(bad));
  for (const field of ['connectionId', 'revision', 'targetKey', 'sourceKey', 'deck', 'observedAt']) {
    const state = { connectionId: connection.id, revision: connection.revision, targetKey: connection.targetKey,
      sourceKey: connection.program, deck: 1, playing: false, connectionStatus: 'connected', observedAt: new Date().toISOString(),
      trackTitle: null, trackArtist: null, positionMs: null, durationMs: null };
    state[field] = field === 'deck' ? 2 : field === 'observedAt' ? '2000-01-01' : 'wrong';
    const client = new NativePlayerClient({ pairingKey: 'x'.repeat(43), fetchImpl: async () => new Response(JSON.stringify({ state })) });
    await assert.rejects(client.state(connection));
  }
});
test('native HTTP bodies are size-bounded while streaming and cannot grant unknown programs', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedPlayerJson(new Response(body), 2048), /exceeds/); assert.equal(cancelled, true);
  const value = { connections: [{ id: randomUUID(), revision: randomUUID(), targetKey: '0'.repeat(64), program: 'serato', deck: 1,
    capabilities: { actions: ['play'] }, uncertain: false, pendingReview: [] }], expiresAt: new Date(Date.now() + 10000).toISOString() };
  await assert.rejects(new NativePlayerClient({ pairingKey: 'x'.repeat(43), fetchImpl: async () => new Response(JSON.stringify(value)) }).list(), /No implemented/);
});
test('default native browser fetch retains its global receiver and sends pairing only once', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', function (url, init) {
    assert.equal(this, globalThis, 'Window.fetch must not be invoked with the NativePlayerClient as its receiver.');
    calls++;
    assert.equal(url, 'http://127.0.0.1:4316/v1/connections');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    return Promise.resolve(new Response(JSON.stringify({ connections: [], expiresAt: new Date(Date.now() + 10000).toISOString() })));
  });
  const client = new NativePlayerClient({ pairingKey: 'x'.repeat(43) });
  assert.deepEqual(await client.list(), []);
  assert.equal(calls, 1);
});

test('native host serializes only browser fields and scrubs private metadata and errors', async t => {
  const secret = 'C:\\private\\music\\secret.mp3';
  const item = { id: randomUUID(), revision: randomUUID(), targetKey: 'a'.repeat(64), program: 'vlc', deck: 1,
    capabilities: { actions: ['play'], password: secret }, uncertain: false, pendingReview: [], config: secret };
  const hub = { list: () => [item], readState: async () => ({ connectionId: item.id, revision: item.revision,
    targetKey: item.targetKey, sourceKey: 'vlc', deck: 1, playing: false, connectionStatus: 'connected',
    trackTitle: secret, trackArtist: 'file:///private/artist', trackPath: secret, raw: secret,
    positionMs: 0, durationMs: 10, observedAt: new Date().toISOString() }),
    execute: async (_, body) => ({ id: body.id, connectionId: item.id, revision: item.revision,
      targetKey: item.targetKey, program: 'vlc', deck: 1, replay: false, success: true,
      finishedAt: new Date().toISOString(), error: secret, raw: secret,
      result: { executionStatus: 'accepted', action: 'pause', program: 'vlc', deck: 1, raw: secret } }),
    reconnect: () => { throw new Error(secret); } };
  const token = 'x'.repeat(43);
  const host = await startNativePlayerHost({ hub, token, expiresAt: Date.now() + 10000, port: 0 });
  t.after(() => host.close());
  const client = new NativePlayerClient({ pairingKey: token, port: host.port,
    fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin } }) });
  const [connection] = await client.list();
  const observed = await client.state(connection);
  assert.equal(observed.trackTitle, null); assert.equal(observed.trackArtist, null);
  const result = await client.command(connection, { id: randomUUID(), action: 'play' });
  assert.equal(result.uncertain, true);
  const headers = { origin, authorization: 'Bearer ' + token };
  const raw = await (await fetch(`http://127.0.0.1:${host.port}/v1/state?connectionId=${item.id}&revision=${item.revision}`, { headers })).text();
  assert.equal(raw.includes('private'), false); assert.equal(raw.includes('trackPath'), false);
  await assert.rejects(client.reconnect(connection), error => !error.message.includes('private'));
});

test('browser rejects missing or mismatched accepted action/program/deck acknowledgement', async () => {
  const connection = { id: randomUUID(), revision: randomUUID(), targetKey: 'a'.repeat(64), program: 'vlc', deck: 1,
    actions: ['play'], uncertain: false };
  const id = randomUUID();
  for (const patch of [{ action: undefined }, { action: 'pause' }, { program: 'mpv' }, { deck: 2 }, { executionStatus: undefined, executed: true }]) {
    const receipt = { id, connectionId: connection.id, revision: connection.revision, targetKey: connection.targetKey,
      program: connection.program, deck: 1, success: true, replay: false, finishedAt: new Date().toISOString(),
      result: { executionStatus: 'accepted', action: 'play', program: 'vlc', deck: 1, ...patch } };
    const client = new NativePlayerClient({ pairingKey: 'x'.repeat(43), fetchImpl: async () => new Response(JSON.stringify({ receipt })) });
    await assert.rejects(client.command(connection, { id, action: 'play' }), /acknowledgement/);
  }
});

test('relative and rooted Windows metadata paths are hidden by both browser boundaries', async t => {
  const item = { id: randomUUID(), revision: randomUUID(), targetKey: 'a'.repeat(64), program: 'vlc', deck: 1,
    capabilities: { actions: ['play'] }, uncertain: false, pendingReview: [] };
  let title, artist;
  const observed = () => ({ connectionId: item.id, revision: item.revision, targetKey: item.targetKey,
    sourceKey: 'vlc', deck: 1, playing: false, connectionStatus: 'connected', trackTitle: title,
    trackArtist: artist, positionMs: 0, durationMs: 10, observedAt: new Date().toISOString() });
  const token = 'x'.repeat(43);
  const host = await startNativePlayerHost({ hub: { list: () => [item], readState: async () => observed() },
    token, expiresAt: Date.now() + 10000, port: 0 });
  t.after(() => host.close());
  const viaHost = new NativePlayerClient({ pairingKey: token, port: host.port,
    fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin } }) });
  const [connection] = await viaHost.list();
  const viaClient = new NativePlayerClient({ pairingKey: token,
    fetchImpl: async () => new Response(JSON.stringify({ state: observed() })) });
  for (const path of ['private\\music\\secret.mp3', '\\private\\music\\secret.mp3', 'C:\\private\\music\\secret.mp3', '/private/music/secret.mp3', 'C:secret.mp3', 'Displayed from C:private.mp3']) {
    title = artist = path;
    const raw = await (await fetch(`http://127.0.0.1:${host.port}/v1/state?connectionId=${item.id}&revision=${item.revision}`,
      { headers: { origin, authorization: 'Bearer ' + token } })).json();
    assert.equal(raw.state.trackTitle, null); assert.equal(raw.state.trackArtist, null);
    for (const client of [viaHost, viaClient]) {
      const value = await client.state(connection);
      assert.equal(value.trackTitle, null); assert.equal(value.trackArtist, null);
    }
  }
  title = 'Live: A public track title'; artist = 'A public artist';
  for (const client of [viaHost, viaClient]) {
    const value = await client.state(connection);
    assert.equal(value.trackTitle, title); assert.equal(value.trackArtist, artist);
  }
});
