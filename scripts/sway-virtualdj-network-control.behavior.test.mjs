import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { VirtualDjNetworkControl } from './lib/virtualdj-network-control.mjs';

// Synthetic Network Control responses exercise the real adapter. These tests
// do not establish physical deck operation or a successful live performance.
function stateFetch(playing) {
  const values = new Map([
    ['get_title', 'Fixture track'], ['get_artist', 'Fixture artist'],
    ['get_filepath', 'C:/Music/Fixture.mp3'], ['play', playing],
    ['get_position', '0.25'], ['get_bpm', '128']
  ]);
  return async (_url, init) => new Response(values.get(init.body.split(' ').at(-1)));
}

test('observed true and false playback state remain distinct', async () => {
  for (const [body, expected] of [['true', true], ['1', true], ['false', false], ['0', false]]) {
    const adapter = new VirtualDjNetworkControl({ fetchImpl: stateFetch(body), deck: 2 });
    const state = await adapter.readState();
    assert.equal(state.playing, expected);
    assert.equal(state.connectionStatus, 'connected');
    assert.equal(state.deck, 2);
    assert.equal(state.trackPath, 'C:/Music/Fixture.mp3');
    assert.equal(state.bpmTimes100, 12800);
  }
});

test('unknown playback responses never manufacture a connected paused deck', async () => {
  for (const body of ['', 'unknown', 'ERROR: extension unavailable', '<html>Login</html>']) {
    const adapter = new VirtualDjNetworkControl({ fetchImpl: stateFetch(body) });
    await assert.rejects(adapter.readState(), /unreadable playback state/);
  }
});

test('a non-cooperative fetch times out without replaying the deck command', { timeout: 5_000 }, async () => {
  let attempts = 0;
  let signal;
  let finish;
  const adapter = new VirtualDjNetworkControl({
    requestTimeoutMs: 1_000,
    fetchImpl: (_url, init) => {
      attempts += 1;
      signal = init.signal;
      return new Promise(resolve => { finish = resolve; });
    }
  });
  const command = adapter.executeCommand({ action: 'next', payload: { deck: 2 } });
  await assert.rejects(command, /command response timed out.*may have reached your deck/);
  assert.equal(signal.aborted, true);
  assert.equal(attempts, 1);
  finish(new Response('true'));
  await nextTurn();
  await assert.rejects(command, /command response timed out/);
  assert.equal(attempts, 1, 'Late acknowledgement does not trigger a replay');

  // The timeout releases the caller so a later, explicitly requested command
  // can proceed when the endpoint recovers.
  adapter.fetchImpl = async () => { attempts += 1; return new Response('true'); };
  const result = await adapter.executeCommand({ action: 'pause', payload: { deck: 2 } });
  assert.equal(result.executed, true);
  assert.equal(result.action, 'pause');
  assert.equal(attempts, 2);
});

test('the deadline also bounds a response body that ignores cancellation', { timeout: 5_000 }, async () => {
  let signal;
  let failBody;
  const adapter = new VirtualDjNetworkControl({
    requestTimeoutMs: 1_000,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return { ok: true, status: 200, text: () => new Promise((_resolve, reject) => { failBody = reject; }) };
    }
  });
  await assert.rejects(adapter.query('deck 1 play'), /playback status timed out/);
  assert.equal(signal.aborted, true);
  // The abandoned body still has a rejection handler through Promise.race.
  failBody(new Error('Late transport failure'));
  await nextTurn();
});

test('negative, unreadable and HTTP-error replies never acknowledge execution', async () => {
  for (const [body, status] of [['false', 200], ['unexpected', 200], ['1', 200], ['on', 200], ['yes', 200], ['unauthorized', 401]]) {
    let attempts = 0;
    const adapter = new VirtualDjNetworkControl({ fetchImpl: async () => {
      attempts += 1;
      return new Response(body, { status });
    } });
    await assert.rejects(adapter.executeCommand({ action: 'play' }), /VirtualDJ/);
    assert.equal(attempts, 1);
  }
});

test('exact-path loading keeps its source command and acknowledged result', async () => {
  const calls = [];
  const adapter = new VirtualDjNetworkControl({ password: 'fixture-token', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response('true');
  } });
  const result = await adapter.executeCommand({ action: 'load', payload: { deck: 2, track: { path: 'C:/Music/Fixture.mp3' } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8088/execute');
  assert.equal(calls[0].init.body, 'deck 2 load "C:/Music/Fixture.mp3"');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-token');
  assert.equal(result.loadMatchMode, 'exact_library_path');
  assert.equal(result.executed, true);
});

// Actual Node HTTP transports and separate owned processes below. The servers
// implement protocol fixtures, not VirtualDJ: no physical-player pass is claimed.
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function httpFixture(t, handle) {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = { method: req.method, path: req.url, body, authorization: req.headers.authorization };
      requests.push(request);
      await handle(request, res, req);
    } catch (error) {
      errors.push(error);
      res.destroy();
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(errors, [], 'Fixture errors must not be mistaken for expected transport rejection');
    assert.equal(server.listening, false, 'Owned HTTP listener must be closed');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`HTTP ${status} cannot forward a command or accept a redirected acknowledgement`, { timeout: 5_000 }, async t => {
    const fixture = await httpFixture(t, (request, res) => {
      if (request.path === '/execute') res.writeHead(status, { location: '/unexpected-player' }).end();
      else res.end('true');
    });
    const adapter = new VirtualDjNetworkControl({ baseUrl: fixture.url, deck: 2, password: 'fixture-secret' });
    await assert.rejects(adapter.executeCommand({ action: 'next' }));
    assert.equal(fixture.requests.length, 1, 'Redirect must not produce another HTTP request');
    assert.equal(fixture.requests[0].path, '/execute');
    assert.equal(fixture.requests[0].body, 'deck 2 load_next');
  });
}

for (const status of [307, 308]) {
  test(`HTTP ${status} cannot move execution to a different loopback player`, { timeout: 5_000 }, async t => {
    const otherPlayer = await httpFixture(t, (_request, res) => res.end('true'));
    const selectedPlayer = await httpFixture(t, (_request, res) => {
      res.writeHead(status, { location: `${otherPlayer.url}/execute` }).end();
    });
    const adapter = new VirtualDjNetworkControl({ baseUrl: selectedPlayer.url, deck: 2 });
    await assert.rejects(adapter.executeCommand({ action: 'play' }));
    assert.equal(selectedPlayer.requests.length, 1);
    assert.equal(otherPlayer.requests.length, 0, 'Unselected player must receive no command');
  });
}

test('query redirects cannot project another endpoint as the selected player', { timeout: 5_000 }, async t => {
  const fixture = await httpFixture(t, (request, res) => {
    if (request.path === '/query') res.writeHead(307, { location: '/other-state' }).end();
    else res.end('false');
  });
  const adapter = new VirtualDjNetworkControl({ baseUrl: fixture.url });
  await assert.rejects(adapter.query('deck 2 play'));
  assert.equal(fixture.requests.length, 1);
});

test('an explicit direct play and pause retain the configured endpoint and deck', { timeout: 5_000 }, async t => {
  let playing = false;
  const fixture = await httpFixture(t, (request, res) => {
    if (request.path === '/execute') {
      assert.equal(request.method, 'POST');
      assert.equal(request.authorization, 'Bearer fixture-secret');
      if (request.body === 'deck 2 play on') playing = true;
      else if (request.body === 'deck 2 pause') playing = false;
      else throw new Error('Unexpected deck/action');
      res.end('true');
    } else {
      const values = { get_title: 'Fixture', get_artist: 'Fixture artist', get_filepath: 'fixture.mp3',
        play: String(playing), get_position: '0.25', get_bpm: '128' };
      res.end(values[request.body.split(' ').at(-1)]);
    }
  });
  const adapter = new VirtualDjNetworkControl({ baseUrl: fixture.url, deck: 2, password: 'fixture-secret' });
  assert.equal(fixture.requests.length, 0, 'Constructing a connection must not start playback');
  assert.equal((await adapter.executeCommand({ action: 'play' })).executed, true);
  assert.equal((await adapter.readState()).playing, true);
  await adapter.executeCommand({ action: 'pause' });
  assert.equal((await adapter.readState()).playing, false);
  assert.deepEqual(fixture.requests.filter(request => request.path === '/execute').map(request => request.body),
    ['deck 2 play on', 'deck 2 pause']);
});

async function runLedgerChild(url, ledgerFile) {
  const script = `
    import assert from 'node:assert/strict';
    import { existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
    const [adapterUrl, executionUrl, url, file] = process.argv.slice(1);
    const { VirtualDjNetworkControl } = await import(adapterUrl);
    const { executeClaimedOnce, executeClaimedBatch, validateExecutionLedger } = await import(executionUrl);
    const ledger = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))
      : {version:1,bridgeInstanceId:'fixture-stable-bridge',outcomes:{},pendingCompletionIds:[]};
    validateExecutionLedger(ledger);
    const persist = () => {
      const temp = file + '.' + process.pid + '.tmp';
      const fd = openSync(temp, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(ledger)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, file);
    };
    const adapter = new VirtualDjNetworkControl({baseUrl:url,deck:2,requestTimeoutMs:1000});
    await executeClaimedBatch([
      {id:'uncertain-next',action:'next'}, {id:'later-play',action:'play'}
    ], command => executeClaimedOnce({command,ledger,persist,execute:c=>adapter.executeCommand(c)}));
    console.log(JSON.stringify(ledger));
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'].includes(key)));
  const child = spawn(process.execPath, ['--input-type=module', '-e', script,
    new URL('./lib/virtualdj-network-control.mjs', import.meta.url).href,
    new URL('./lib/control-bridge-execution.mjs', import.meta.url).href, url, ledgerFile],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errorOutput = '', timedOut = false, timer, spawnError;
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errorOutput += data; });
  const completion = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5_000);
  const { code, signal } = await completion;
  clearTimeout(timer);
  assert.equal(spawnError, undefined);
  assert.equal(timedOut, false, 'Owned child timed out');
  assert.equal(signal, null);
  assert.equal(code, 0, errorOutput);
  return JSON.parse(output.trim());
}

for (const response of ['redirect', 'lost-response']) {
  test(`${response}: restart preserves uncertainty without replay or later-batch play`, { timeout: 15_000 }, async t => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sway-target-check-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const ledgerFile = path.join(directory, 'ledger.json');
    let recovered = false;
    const fixture = await httpFixture(t, (request, res, req) => {
      const durable = JSON.parse(readFileSync(ledgerFile, 'utf8'));
      assert.equal(durable.outcomes['uncertain-next'].result.executionStatus, 'unknown',
        'Uncertainty must already be on disk before the first player request');
      if (recovered) throw new Error('Restart must not contact the player for the old command');
      if (response === 'lost-response') req.socket.destroy();
      else if (request.path === '/execute') res.writeHead(307, { location: '/unexpected-player' }).end();
      else res.end('true');
    });
    const first = await runLedgerChild(fixture.url, ledgerFile);
    assert.equal(first.outcomes['uncertain-next'].success, false);
    assert.equal(first.outcomes['uncertain-next'].result.executionStatus, 'unknown');
    assert.equal(Object.hasOwn(first.outcomes, 'later-play'), false);
    assert.equal(fixture.requests.length, 1, 'Exactly one request before ambiguity');
    recovered = true;
    const restarted = await runLedgerChild(fixture.url, ledgerFile);
    assert.deepEqual(restarted, first, 'Restart must retain the same command and bridge identity');
    assert.equal(fixture.requests.length, 1, 'Recovered connection must not replay the old command');
    assert.equal(Object.hasOwn(restarted.outcomes, 'later-play'), false);
  });
}
