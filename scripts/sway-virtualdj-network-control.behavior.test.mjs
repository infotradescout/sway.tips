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

test('exact track confirmation preserves filename whitespace, Unicode and case', async () => {
  const requestedPath = 'C:/Music/A  B.mp3';
  for (const [requested, observed, expected] of [
    [requestedPath, 'C:\\Music\\A  B.mp3', 'exact_track_confirmed'],
    [requestedPath, 'C:/Music/A B.mp3', 'source_acknowledged'],
    ['C:/Music/Ａ.mp3', 'C:/Music/A.mp3', 'source_acknowledged'],
    ['C:/Music/A.mp3', 'C:/Music/a.mp3', 'source_acknowledged']
  ]) {
    let executions = 0;
    const adapter = new VirtualDjNetworkControl({ fetchImpl: async (url, init) => {
      if (String(url).endsWith('/execute')) { executions++; return new Response('true'); }
      const property = init.body.split(' ').at(-1);
      const values = { get_title: 'Fixture', get_artist: 'Synthetic', get_filepath: observed, play: 'false', get_position: '0', get_bpm: '120' };
      return new Response(values[property]);
    } });
    const result = await adapter.executeCommand({ action: 'load', payload: { deck: 2, track: { path: requested } } });
    assert.equal(executions, 1);
    assert.equal(result.confirmationStatus, expected);
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
  const readRecoveredState = stateFetch('false');
  adapter.fetchImpl = async (url, init) => {
    if (String(url).endsWith('/execute')) {
      attempts += 1;
      return new Response('true');
    }
    return readRecoveredState(url, init);
  };
  const result = await adapter.executeCommand({ action: 'pause', payload: { deck: 2 } });
  assert.equal(result.executed, true);
  assert.equal(result.action, 'pause');
  assert.equal(result.confirmationStatus, 'source_state_confirmed');
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
  const readSourceState = stateFetch('false');
  const adapter = new VirtualDjNetworkControl({ password: 'fixture-token', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return String(url).endsWith('/execute') ? new Response('true') : readSourceState(url, init);
  } });
  const result = await adapter.executeCommand({ action: 'load', payload: { deck: 2, track: { path: 'C:/Music/Fixture.mp3' } } });
  assert.equal(calls.filter(call => call.url.endsWith('/execute')).length, 1);
  assert.equal(calls.filter(call => call.url.endsWith('/query')).length, 6);
  assert.ok(calls.filter(call => call.url.endsWith('/query')).every(call => call.init.body.startsWith('deck 2 ')));
  assert.equal(calls[0].url, 'http://127.0.0.1:8088/execute');
  assert.equal(calls[0].init.body, 'deck 2 load "C:/Music/Fixture.mp3"');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-token');
  assert.equal(result.loadMatchMode, 'exact_library_path');
  assert.equal(result.executed, true);
  assert.equal(result.confirmationStatus, 'exact_track_confirmed');
});
