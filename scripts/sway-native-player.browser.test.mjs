// Real Chromium -> exact-origin local host -> actual native adapter. Default
// downstream servers are protocol fixtures; native runner supplies stock players.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { NativePlayerHub } from './lib/native-player-hub.mjs';
import { openNativePlayerStore } from './lib/native-player-store.mjs';
import { startNativePlayerHost } from './lib/native-player-host.mjs';

const ORIGIN = 'https://app.sway.tips';
export async function exerciseNativePlayerBrowser({ configs, out, realPlayers = false, loseNextResponse, observe }) {
  const temp = mkdtempSync(join(tmpdir(), 'sway-native-browser-'));
  mkdirSync(out, { recursive: true });
  const report = { passed: false, scope: realPlayers ? 'Native panel and real local host/adapters with stock players' : 'Native panel and real local host/adapters with protocol fixtures',
    fullSignedInApplication: false, realPlayers, securityBypassFlags: [], checks: [], mutations: [], consoleErrors: [], network: [] };
  const record = name => { report.checks.push(name); console.log('NATIVE_PLAYER_BROWSER_PASS ' + name); };
  const token = randomBytes(32).toString('base64url');
  const store = openNativePlayerStore({ filename: join(temp, 'journal.json'), actorId: 'test-authorized-local-operator' });
  let host, browser, context, page;
  try {
    const hub = new NativePlayerHub({ configs, actorId: 'test-authorized-local-operator', store });
    host = await startNativePlayerHost({ hub, token, port: 4316, expiresAt: Date.now() + 600000 });
    const hostProbe = await fetch('http://127.0.0.1:4316/v1/connections', { headers: { origin: ORIGIN, authorization: 'Bearer ' + token } });
    report.nodeHostProbe = { status: hostProbe.status, connections: (await hostProbe.json()).connections?.length };
    assert.equal(report.nodeHostProbe.status, 200);
    assert.equal(report.nodeHostProbe.connections, configs.length);
    const result = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import Panel from './src/components/NativePlayerConnections.tsx';const root=createRoot(document.getElementById('root'));let actor='operator-a';window.__mount=(next=actor,preview=false)=>{actor=next;root.render(React.createElement(Panel,{key:actor,preview}))};window.__mount();`,
      resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic' });
    const bundle = result.outputFiles[0].text;
    browser = await chromium.launch({ headless: true }); report.browserVersion = browser.version();
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    // A documented permission grant simulates the user's explicit consent; it
    // does not disable mixed-content, CORS, origin or network protections.
    try { await context.grantPermissions(['local-network-access'], { origin: ORIGIN }); report.localNetworkPermission = 'granted_by_browser_automation'; }
    catch (error) { report.localNetworkPermission = 'permission_name_not_supported_by_this_browser'; report.permissionError = String(error.message).slice(0, 200); }
    const productionRequests = [], errors = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === ORIGIN && url.pathname === '/__native-player-check') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/__native-player-check.js"></script>' });
      }
      if (url.origin === ORIGIN && url.pathname === '/__native-player-check.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
      if (url.origin === 'http://127.0.0.1:4316') {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON(); report.mutations.push({ path: url.pathname, ...body });
        }
        return route.continue();
      }
      productionRequests.push(url.origin + url.pathname); return route.abort();
    });
    page = await context.newPage();
    const redact = value => String(value).replaceAll(token, '[redacted]');
    page.on('pageerror', error => { errors.push(redact(error)); report.consoleErrors.push(redact(error)); });
    page.on('console', entry => { if (entry.type() === 'error') report.consoleErrors.push(redact(entry.text())); });
    page.on('requestfailed', request => { const url = new URL(request.url()); report.network.push({ event: 'failed', origin: url.origin, path: url.pathname, error: redact(request.failure()?.errorText) }); });
    page.on('response', response => { const url = new URL(response.url()); if (url.origin === 'http://127.0.0.1:4316') report.network.push({ event: 'response', path: url.pathname, status: response.status() }); });
    const mount = async () => page.goto(ORIGIN + '/__native-player-check');
    const panel = page.locator('[data-sway-native-players]');
    const button = name => panel.getByRole('button', { name, exact: true });
    const until = async (work, message) => {
      const end = Date.now() + 12000;
      while (Date.now() < end) { if (await work()) return; await new Promise(r => setTimeout(r, 100)); }
      throw new Error(message + '; UI: ' + await panel.innerText());
    };
    const pair = async () => { await panel.getByLabel('Private player pairing key').fill(token); await button('Link player computer').click(); await until(() => panel.getByLabel('Configured player target').isVisible(), 'Pairing did not expose the configured players'); };
    const select = async id => { await panel.getByLabel('Configured player target').selectOption(id); await until(() => button('Play selected local player').isEnabled(), 'Selected player did not become ready'); };
    const clickAction = async (action, predicate) => { await button(action + ' selected local player').click(); await until(async () => predicate(await observe()), action + ' did not affect the intended original player'); await until(() => button('Pause selected local player').isEnabled(), 'Action did not finish'); };
    const commands = () => report.mutations.filter(row => row.path === '/v1/command');
    const vlc = configs.find(c => c.program === 'vlc'), mpv = configs.find(c => c.program === 'mpv'); assert(vlc && mpv);
    await mount(); await pair(); assert.equal(await panel.getByLabel('Configured player target').inputValue(), ''); assert.equal(commands().length, 0);
    record('Pairing exposes both configured programs with no default player and no autoplay');
    await select(vlc.id); assert.equal(await button('Cue selected local player').count(), 0);
    await clickAction('Play', state => state.vlc.playing === true && state.mpv.playing === false);
    record('Explicit VLC Play affects VLC only; unsupported Cue is absent');
    await page.screenshot({ path: join(out, 'vlc-playing.png'), fullPage: true });
    await clickAction('Pause', state => state.vlc.playing === false);
    await select(mpv.id); assert.equal(commands().length, 2);
    await clickAction('Play', state => state.mpv.playing === true && state.vlc.playing === false);
    await page.screenshot({ path: join(out, 'mpv-playing.png'), fullPage: true });
    await clickAction('Pause', state => state.mpv.playing === false);
    record('Switching to mpv sends nothing; separate mpv Play/Pause affect mpv only');
    await select(vlc.id); loseNextResponse(); const beforeUnknown = commands().length;
    await button('Next selected local player').click();
    await panel.getByText('Uncertain delivery is held. Reconnect cannot authorize a repeat.', { exact: true }).waitFor();
    assert.equal(commands().length, beforeUnknown + 1); assert.equal(await button('Play selected local player').isDisabled(), true);
    await page.screenshot({ path: join(out, 'uncertain-delivery-held.png'), fullPage: true });
    const unknownId = commands().at(-1).id;
    await until(() => button('Reconnect selected player').isEnabled(), 'Reconnect remained busy');
    await button('Reconnect selected player').click();
    await until(() => button('Reconnect selected player').isEnabled(), 'Reconnect did not finish');
    assert.equal(commands().length, beforeUnknown + 1); assert(hub.list().find(c => c.id === vlc.id).uncertain);
    record('Lost Next acknowledgement is held durably; reconnect rotates revision without repeating it');
    await page.reload(); await pair(); await panel.getByLabel('Configured player target').selectOption(vlc.id);
    await panel.getByText('Uncertain delivery is held. Reconnect cannot authorize a repeat.', { exact: true }).waitFor();
    assert.equal(commands().length, beforeUnknown + 1); assert.equal(await button('Play selected local player').isDisabled(), true);
    assert.equal(hub.list().find(c => c.id === vlc.id).pendingReview[0].id, unknownId);
    record('Browser reload and re-pairing preserve the exact uncertain ID and do not send another command');
    await panel.getByLabel('I checked the original player and understand the old command will not be replayed.').check();
    await button('Save review; allow a new action').click();
    await until(() => button('Pause selected local player').isEnabled(), 'Explicit review did not unlock a new deliberate action');
    assert.equal(commands().length, beforeUnknown + 1);
    await clickAction('Pause', state => state.vlc.playing === false);
    assert.notEqual(commands().at(-1).id, unknownId);
    record('Explicit review never replays; a genuinely new Pause receives a different command identity');
    const safeCount = commands().length;
    await page.evaluate(() => window.__mount('operator-b'));
    await panel.getByLabel('Private player pairing key').waitFor();
    assert.equal(await panel.getByLabel('Private player pairing key').inputValue(), '');
    assert.equal(commands().length, safeCount);
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert(!JSON.stringify(storage).includes(token));
    await page.evaluate(() => window.__mount('operator-preview', true));
    await panel.getByText('Preview mode: pairing and playback are disabled.', { exact: true }).waitFor();
    assert.equal(await button('Link player computer').isDisabled(), true);
    assert.equal(commands().length, safeCount);
    record('Owner remount forgets browser authority; preview cannot pair; pairing key never enters browser storage');
    await page.screenshot({ path: join(out, 'native-player-preview.png'), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(productionRequests, []);
    report.pendingUnknownAfterReview = hub.list().some(c => c.uncertain); assert.equal(report.pendingUnknownAfterReview, false);
    report.passed = true;
  } catch (error) {
    report.error = String(error.stack || error).replaceAll(token, '[redacted]');
    if (page) {
      try { report.failureUi = (await page.locator('body').innerText()).replaceAll(token, '[redacted]').slice(0, 12000); await page.screenshot({ path: join(out, 'native-player-failure.png'), fullPage: true }); }
      catch (captureError) { report.captureError = String(captureError).replaceAll(token, '[redacted]'); }
    }
    throw error;
  }
  finally {
    try { await context?.close(); await browser?.close(); await host?.close(); store.close(); rmSync(temp, { recursive: true, force: true }); report.cleanup = 'owned browser, host, lock and workspace closed'; }
    catch (error) { report.passed = false; report.cleanupError = String(error); throw error; }
    finally { writeFileSync(join(out, 'native-player-browser.json'), JSON.stringify(report, null, 2) + '\n'); }
  }
  return report;
}

export async function runNativePlayerBrowserFixtures(out) {
  const temp = mkdtempSync(join(tmpdir(), 'sway-native-fixtures-')), commands = [];
  let playing = false, mpvPlaying = false, lost = false;
  const player = http.createServer((req, res) => {
    const command = new URL(req.url, 'http://127.0.0.1').searchParams.get('command');
    if (command) { commands.push({ program: 'vlc', command }); if (['pl_forceresume', 'pl_play', 'pl_next'].includes(command)) playing = true; if (['pl_forcepause', 'pl_stop'].includes(command)) playing = false; if (lost) { lost = false; return res.destroy(); } }
    res.end(JSON.stringify({ state: playing ? 'playing' : 'paused', time: 1, length: 60, information: { category: { meta: { title: 'Protocol fixture VLC' } } } }));
  });
  const socketPath = join(temp, 'mpv.sock'), sockets = new Set();
  const ipc = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let pending = '';
    socket.on('data', chunk => { pending += chunk; let split; while ((split = pending.indexOf('\n')) !== -1) {
      const request = JSON.parse(pending.slice(0, split)); pending = pending.slice(split + 1); const [op, key, val] = request.command;
      let data = null;
      if (op === 'get_property') data = key === 'property-list' ? ['pause', 'idle-active', 'time-pos', 'duration', 'media-title'] : key === 'pause' ? !mpvPlaying : key === 'idle-active' ? false : key === 'media-title' ? 'Protocol fixture mpv' : 1;
      else { commands.push({ program: 'mpv', command: request.command }); if (op === 'set_property' && key === 'pause') mpvPlaying = !val; if (op === 'stop') mpvPlaying = false; }
      socket.write(JSON.stringify({ request_id: request.request_id, error: 'success', data }) + '\n');
    } });
  });
  try {
    player.listen(0, '127.0.0.1'); await once(player, 'listening'); ipc.listen(socketPath); await once(ipc, 'listening');
    return await exerciseNativePlayerBrowser({ configs: [
      { id: randomUUID(), program: 'vlc', baseUrl: `http://127.0.0.1:${player.address().port}`, password: 'owned-fixture' },
      { id: randomUUID(), program: 'mpv', socketPath },
    ], out, loseNextResponse: () => { lost = true; }, observe: async () => ({ vlc: { playing }, mpv: { playing: mpvPlaying } }) });
  } finally { for (const socket of sockets) socket.destroy(); player.closeAllConnections(); await Promise.all([new Promise(r => player.close(r)), new Promise(r => ipc.close(r))]); rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runNativePlayerBrowserFixtures(process.env.SWAY_NATIVE_PLAYER_OUTPUT || 'tmp/native-player-browser').catch(error => { console.error(error); process.exitCode = 1; });
}
