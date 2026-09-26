import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function waitUntil(check, label, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('close', () => resolve(true)));
  const bounded = async milliseconds => {
    let timer;
    try { return await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  child.kill('SIGTERM');
  if (await bounded(2_500)) return;
  child.kill('SIGKILL');
  assert.equal(await bounded(2_500), true, 'Owned CLI child must close after forced shutdown');
}

test('real bridge CLI retains unknown identity through cloud outage, player reconnect and process restart', { timeout: 35_000 }, async t => {
  const base = path.resolve('.tmp');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'silent-bridge-reconnect-'));
  const gigId = 'synthetic-silent-reconnect';
  const ledgerPath = path.join(directory, '.sway', `control-bridge-${gigId}.json`);
  const seen = { commands: [], claims: [], completions: [], states: [] };
  let acknowledge = false;
  let playerConnected = false;
  let claimedAfterRecovery = false;
  let child;
  let player;
  let cloud;
  let cleanupPromise;
  let childOutput = '';
  const cleanup = () => cleanupPromise ??= (async () => {
    try { await stop(child); }
    finally { await Promise.all([close(cloud?.server), close(player?.server)]); }
  })();
  t.after(cleanup);
  player = await listen(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const script = Buffer.concat(parts).toString();
    if (req.url === '/execute') {
      seen.commands.push(script);
      // Simulated player receives the command but loses its response. No media
      // engine, audio device, user profile or installed VirtualDJ is accessed.
      req.socket.destroy();
      return;
    }
    assert.equal(req.url, '/query');
    if (!playerConnected) { req.socket.destroy(); return; }
    const values = { get_title: 'Synthetic silent fixture', get_artist: 'Fixture',
      get_filepath: 'fixture://silent', play: 'false', get_position: '0', get_bpm: '120' };
    const value = values[script.split(' ').slice(2).join(' ')];
    assert.notEqual(value, undefined, script);
    res.end(value);
  });
  const commands = [{ id: 'ambiguous-next', action: 'next', payload: { deck: 1 } },
    { id: 'must-not-play', action: 'play', payload: { deck: 1 } }];
  cloud = await listen(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-cloud-token');
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts).toString());
    assert.equal(body.gig_id, gigId);
    res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/claim')) {
      seen.claims.push(body);
      const initial = seen.claims.length === 1;
      const repeat = acknowledge && !claimedAfterRecovery;
      if (repeat) claimedAfterRecovery = true;
      res.end(JSON.stringify({ commands: initial || repeat ? commands : [] }));
    } else if (req.url.endsWith('/complete')) {
      seen.completions.push(body);
      if (!acknowledge) res.statusCode = 503;
      res.end(JSON.stringify(acknowledge ? { ok: true } : { error: 'synthetic receipt outage' }));
    } else if (req.url.endsWith('/state')) {
      seen.states.push(body.state);
      res.end('{"ok":true}');
    } else { res.statusCode = 404; res.end('{"error":"unexpected route"}'); }
  });
  async function start() {
    const reservation = await listen((_req, res) => res.end());
    const port = reservation.server.address().port;
    assert.notEqual(port, 47831);
    await close(reservation.server);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP)$/i.test(key)));
    Object.assign(env, { USERPROFILE: directory, HOME: directory, NODE_ENV: 'test' });
    child = spawn(process.execPath, ['scripts/sway-control-bridge.mjs', '--gig-id', gigId,
      '--auth-token', 'synthetic-cloud-token', '--sway-url', cloud.url,
      '--virtualdj-url', player.url, '--port', String(port), '--local-token', 'synthetic-local-token'],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { childOutput += chunk; });
    child.stderr.on('data', chunk => { childOutput += chunk; });
  }
  try {
    await start();
    await waitUntil(() => seen.completions.length > 0 && seen.states.some(s => s.connectionStatus === 'disconnected'), 'recorded unknown outcome and disconnected state');
    const before = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.deepEqual(before.pendingCompletionIds, ['ambiguous-next']);
    assert.equal(before.outcomes['ambiguous-next'].result.executionStatus, 'unknown');
    assert.deepEqual(seen.commands, ['deck 1 load_next']);
    assert.equal(seen.claims.length, 1);
    playerConnected = true;
    await waitUntil(() => seen.states.some(s => s.connectionStatus === 'connected'), 'observed silent player reconnect');
    assert.equal(seen.claims.length, 1, 'Undelivered completion must prevent further claims during reconnect');
    await stop(child);
    acknowledge = true;
    await start();
    await waitUntil(async () => claimedAfterRecovery && seen.completions.length >= 3 &&
      JSON.parse(await readFile(ledgerPath, 'utf8')).pendingCompletionIds.length === 0, 'durable recovery receipt');
    const after = JSON.parse(await readFile(ledgerPath, 'utf8'));
    assert.equal(after.bridgeInstanceId, before.bridgeInstanceId);
    assert.equal(after.outcomes['ambiguous-next'].result.executionStatus, 'unknown');
    assert.equal(Object.hasOwn(after.outcomes, 'must-not-play'), false);
    assert.deepEqual(seen.commands, ['deck 1 load_next'], 'Restart or repeated claims cannot redispatch the ambiguous command or later batch command');
    assert.ok(seen.completions.every(c => c.commandId === 'ambiguous-next' && c.success === false && c.result.executionStatus === 'unknown'));
    assert.ok(seen.states.filter(s => s.connectionStatus === 'connected').every(s => s.playing === false));
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify({ synthetic: true, audiblePlayback: false,
      cloud: cloud.url, player: player.url, ledgerPath, seen, childOutput }, null, 2));
    console.log(`Silent CLI reconnect proof retained at ${directory}`);
  } finally {
    await cleanup();
    // Preserve the synthetic unresolved ledger and receipt for inspection.
  }
});
