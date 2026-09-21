import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Real component, StrictMode and application CSS. All equipment and API replies
// are synthetic; this does not prove server authorization or physical playback.
const directory = join('artifacts', 'readiness-223', `playback-recovery-${Date.now()}`);
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'fixture.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Playback recovery proof</title><body class="bg-slate-950 text-white"><div id="root"></div><script type="module" src="/${directory}/fixture.tsx"></script></body></html>`);
writeFileSync(join(directory, 'fixture.tsx'), `import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import Controller from '/src/components/PerformerPlaybackController';
import '/src/index.css';
function Harness(){
 const [room,setRoom]=useState('room-a'); const [preview,setPreview]=useState(false); const [shown,setShown]=useState(true);
 return <main className="min-h-screen p-2 sm:p-4"><div className="mb-3 flex flex-wrap gap-2">
 <button onClick={()=>setRoom(r=>r==='room-a'?'room-b':'room-a')}>Switch fixture room</button>
 <button onClick={()=>setPreview(p=>!p)}>Toggle fixture preview</button>
 <button onClick={()=>setShown(s=>!s)}>Toggle fixture controller</button></div>
 {shown&&<Controller gigId={room} previewMode={preview} approvedRequests={[{id:'request-one',title:'Approved crowd pick',subtitle:'Fixture artist',sourceTrackId:'track-one'} as any]}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness/></React.StrictMode>);`);

function installFixture(options) {
  const originalFetch = window.fetch.bind(window);
  const f = window.__playback = {
    config: { mode: 'ready', status: 200, title: null, payload: undefined, postMode: 'ready', postStatus: 200, midiHold: false, ...options },
    calls: [], held: [], heldPosts: [], heldMidi: [], sends: [], midiRequests: 0, unexpected: [],
    access: { outputs: new Map(), onstatechange: null }
  };
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const output = (id, name) => ({ id, name, manufacturer: 'Synthetic', state: 'connected', connection: 'open',
    send(data) { f.sends.push({ id, data: Array.from(data) }); } });
  f.access.outputs.set('output-a', output('output-a', 'Booth output A'));
  f.access.outputs.set('output-b', output('output-b', 'Booth output B'));
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => {
    f.midiRequests += 1;
    if (f.config.midiHold) return new Promise(resolve => f.heldMidi.push(() => resolve(f.access)));
    return Promise.resolve(f.access);
  } });
  if (options.storageDenied) {
    Storage.prototype.getItem = () => { throw new DOMException('Fixture storage denied', 'SecurityError'); };
    Storage.prototype.setItem = () => { throw new DOMException('Fixture storage denied', 'SecurityError'); };
  }
  f.snapshot = (room, title) => ({ state: {
    gigId: room, sourceKey: 'virtualdj', connectionStatus: 'connected',
    trackTitle: title || `Track ${room}`, trackArtist: 'Fixture artist',
    bpmTimes100: 12800, observedAt: new Date(Date.now()).toISOString(), fresh: true
  }, commands: [] });
  window.fetch = (input, init = {}) => {
    const url = new URL(String(input), location.href);
    if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
    const method = init.method || 'GET';
    const call = { path: url.pathname, method, body: init.body ? JSON.parse(init.body) : null, aborted: false };
    f.calls.push(call);
    init.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    if (method === 'GET' && url.pathname.startsWith('/api/talent/playback/snapshot/')) {
      const room = decodeURIComponent(url.pathname.split('/').at(-1));
      const body = f.config.payload === undefined ? f.snapshot(room, f.config.title) : f.config.payload;
      const status = f.config.status;
      if (f.config.mode === 'reject') return Promise.reject(new TypeError('Synthetic network failure'));
      if (f.config.mode === 'hold') return new Promise(resolve => f.held.push({ call, release: () => resolve(response(body, status)) }));
      if (f.config.mode === 'body-hold') return Promise.resolve({ ok: true, status: 200,
        json: () => new Promise(resolve => f.held.push({ call, release: () => resolve(body) })) });
      return Promise.resolve(response(body, status));
    }
    if (method === 'POST' && url.pathname === '/api/talent/playback/commands') {
      if (f.config.postMode === 'reject') return Promise.reject(new TypeError('Synthetic response lost'));
      const body = { command: { id: `command-${f.calls.length}`, ...call.body, status: 'queued' } };
      if (f.config.postMode === 'hold') return new Promise(resolve => f.heldPosts.push({ call, release: () => resolve(response(body, f.config.postStatus)) }));
      return Promise.resolve(response(body, f.config.postStatus));
    }
    f.unexpected.push(`${method} ${url.pathname}`);
    return Promise.resolve(response({ error: 'Unexpected fixture endpoint' }, 500));
  };
}

let browser;
let vite;
let base;
const results = [];
const play = (page, deck = 1) => page.getByRole('button', { name: `Play deck ${deck}`, exact: true });
const refresh = page => page.getByRole('button', { name: 'Refresh playback status', exact: true });
const posts = page => page.evaluate(() => window.__playback.calls.filter(call => call.method === 'POST'));
const ready = page => page.getByRole('status').filter({ hasText: /^VirtualDJ linked$/ }).waitFor({ state: 'visible' });
const hardware = (page, actions) => page.evaluate(actions => {
  for (const action of actions) window.dispatchEvent(new CustomEvent('sway:playback-action', { detail: action }));
}, actions);
async function disabled(page, value = true) {
  await page.waitForFunction(value => document.querySelector('button[aria-label="Play deck 1"]')?.disabled === value, value);
}
async function run(name, viewport, options, scenario) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  await context.addInitScript(installFixture, options);
  const page = await context.newPage();
  page.setDefaultTimeout(22_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort('blockedbyclient'));
  try {
    await page.goto(`${base}/${directory}/fixture.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-sway-playback-controller="true"]').waitFor({ state: 'visible' });
    await scenario(page);
    assert.deepEqual(errors, [], 'No uncaught screen errors');
    assert.deepEqual(await page.evaluate(() => window.__playback.unexpected), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No horizontal overflow');
    const proof = await page.evaluate(() => ({ requests: window.__playback.calls.length, commands: window.__playback.calls.filter(c => c.method === 'POST').length, midiPackets: window.__playback.sends.length }));
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}.png`), fullPage: true });
    results.push({ name, viewport, status: 'PASS', ...proof });
  } catch (error) {
    results.push({ name, viewport, status: 'FAIL', error: String(error), pageErrors: errors });
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}-failure.png`), fullPage: true }).catch(() => {});
  } finally {
    console.log('PLAYBACK_RECOVERY_BROWSER_RESULT', JSON.stringify(results.at(-1)));
    await context.close();
  }
}

try {
  vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  console.log('PLAYBACK_RECOVERY_BROWSER', browser.version());
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1366, height: 768 }]) {
    await run('failed-status-closes-controls-read-only-retry', viewport, {}, async page => {
      await ready(page);
      await page.evaluate(() => { window.__playback.config.mode = 'reject'; });
      await refresh(page).click();
      await page.getByRole('status').filter({ hasText: 'Playback status could not be confirmed' }).waitFor();
      await disabled(page);
      assert.equal(await page.getByText('Fixture artist — Track room-a', { exact: true }).count(), 0);
      await hardware(page, ['play', 'next', 'load']);
      assert.equal((await posts(page)).length, 0);
      await page.evaluate(() => { window.__playback.config.mode = 'ready'; });
      await refresh(page).click();
      await ready(page);
      await disabled(page, false);
      assert.equal((await posts(page)).length, 0);
    });
    await run('malformed-and-cross-room-status-cannot-enable', viewport, {}, async page => {
      await ready(page);
      for (const kind of ['missing', 'wrong-room', 'bad-command', 'bad-time', 'future-time']) {
        await page.evaluate(kind => {
          const f = window.__playback;
          const body = f.snapshot('room-a');
          if (kind === 'missing') { f.config.payload = {}; return; }
          if (kind === 'wrong-room') body.state.gigId = 'room-b';
          if (kind === 'bad-command') body.commands = [null];
          if (kind === 'bad-time') body.state.observedAt = 'bad-date';
          if (kind === 'future-time') body.state.observedAt = new Date(Date.now() + 60_000).toISOString();
          f.config.payload = body;
        }, kind);
        await refresh(page).click();
        await disabled(page);
        await hardware(page, ['play']);
      }
      assert.equal((await posts(page)).length, 0);
    });
    await run('blocked-storage-does-not-break-controls', viewport, { storageDenied: true }, async page => {
      await ready(page);
      await page.getByLabel('Target deck', { exact: true }).selectOption('2');
      assert.equal(await play(page, 2).isEnabled(), true);
      await page.getByLabel('Playback source', { exact: true }).selectOption('generic_midi');
      await page.getByRole('button', { name: 'Choose MIDI output', exact: true }).click();
      await page.getByLabel('Virtual MIDI output', { exact: true }).selectOption('output-a');
      await play(page).click();
      assert.equal(await page.evaluate(() => window.__playback.sends.length), 2);
      assert.equal((await posts(page)).length, 0);
    });
    await run('status-expires-without-another-response', viewport, {}, async page => {
      await ready(page);
      await page.evaluate(() => {
        const f = window.__playback;
        f.config.mode = 'hold';
        const realNow = Date.now.bind(Date);
        Date.now = () => realNow() + 20_000;
      });
      await hardware(page, ['next']);
      assert.equal((await posts(page)).length, 0, 'The handler rechecks freshness without waiting for a render');
      await disabled(page);
      assert.equal(await page.getByText('Fixture artist — Track room-a', { exact: true }).count(), 0);
    });
    await run('rapid-commands-share-one-in-flight-intent', viewport, { postMode: 'hold' }, async page => {
      await ready(page);
      await hardware(page, ['load', 'load', 'next']);
      await page.waitForFunction(() => window.__playback.heldPosts.length === 1);
      const sent = await posts(page);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].body.gig_id, 'room-a');
      assert.equal(sent[0].body.action, 'load');
      assert.equal(sent[0].body.payload.track.requestId, 'request-one');
      assert.equal(sent[0].body.payload.deck, 1);
      assert.match(sent[0].body.clientCommandId, /^[0-9a-f-]{36}$/);
      assert.equal(await page.getByLabel('Target deck', { exact: true }).isDisabled(), true);
      await refresh(page).click();
      assert.equal((await posts(page)).length, 1);
      await page.evaluate(() => window.__playback.heldPosts[0].release());
      await disabled(page, false);
      assert.equal((await posts(page)).length, 1);
    });
    await run('lost-command-response-never-auto-replays', viewport, { postMode: 'reject' }, async page => {
      await ready(page);
      await play(page).click();
      await page.getByRole('alert').filter({ hasText: 'It may have reached your deck' }).waitFor();
      await refresh(page).click();
      await ready(page);
      await page.waitForTimeout(2_200);
      assert.equal((await posts(page)).length, 1);
      const alert = page.getByRole('alert');
      assert.equal(await alert.evaluate(el => getComputedStyle(el).whiteSpace), 'normal');
      assert.equal(await alert.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    });
    await run('old-room-response-cannot-populate-new-room', viewport, {}, async page => {
      await ready(page);
      await page.evaluate(() => { window.__playback.config.mode = 'hold'; window.__playback.config.title = 'Old private track'; });
      await refresh(page).click();
      await page.waitForFunction(() => window.__playback.held.length > 0);
      await page.getByRole('button', { name: 'Switch fixture room', exact: true }).click();
      await page.waitForFunction(() => window.__playback.held.some(item => item.call.path.endsWith('room-b')));
      await disabled(page);
      await page.evaluate(() => {
        for (const item of window.__playback.held.filter(item => item.call.path.endsWith('room-a'))) item.release();
      });
      await page.waitForTimeout(100);
      assert.equal(await page.getByText('Fixture artist — Old private track', { exact: true }).count(), 0);
      await disabled(page);
      await page.evaluate(() => { window.__playback.config.mode = 'ready'; window.__playback.config.title = 'Current room B'; });
      await refresh(page).click();
      await ready(page);
      await page.getByText('Fixture artist — Current room B', { exact: true }).waitFor();
      await page.evaluate(() => { for (const item of window.__playback.held) item.release(); });
      await page.waitForTimeout(100);
      await page.getByText('Fixture artist — Current room B', { exact: true }).waitFor();
      assert.equal((await posts(page)).length, 0);
    });
    await run('source-and-preview-switch-invalidate-reads', viewport, {}, async page => {
      await ready(page);
      await page.evaluate(() => { window.__playback.config.mode = 'hold'; });
      await refresh(page).click();
      await page.waitForFunction(() => window.__playback.held.length > 0);
      await page.getByLabel('Playback source', { exact: true }).selectOption('generic_midi');
      await page.evaluate(() => { for (const item of window.__playback.held) item.release(); });
      assert.equal(await page.getByText('VirtualDJ linked', { exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Toggle fixture preview', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Choose MIDI output', exact: true }).isDisabled(), true);
      await hardware(page, ['play', 'load']);
      await page.getByLabel('Playback source', { exact: true }).selectOption('virtualdj');
      await page.getByRole('status').filter({ hasText: 'Preview only' }).waitFor();
      const count = await page.evaluate(() => window.__playback.calls.length);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.__playback.calls.length), count);
      assert.equal(await page.evaluate(() => window.__playback.midiRequests), 0);
      assert.equal((await posts(page)).length, 0);
    });
    await run('access-loss-clears-status-until-explicit-recheck', viewport, {}, async page => {
      await ready(page);
      await page.evaluate(() => { window.__playback.config.status = 403; });
      await refresh(page).click();
      await page.getByRole('status').filter({ hasText: 'Your room access changed' }).waitFor();
      await disabled(page);
      const count = await page.evaluate(() => window.__playback.calls.length);
      await page.waitForTimeout(2_200);
      assert.equal(await page.evaluate(() => window.__playback.calls.length), count, 'No automatic polling after access is revoked');
      await hardware(page, ['play']);
      assert.equal((await posts(page)).length, 0);
      await page.evaluate(() => { window.__playback.config.status = 200; });
      await refresh(page).click();
      await ready(page);
      await disabled(page, false);
    });
    await run('midi-unplug-does-not-reroute-and-listener-cleans-up', viewport, {}, async page => {
      await ready(page);
      await page.getByLabel('Playback source', { exact: true }).selectOption('generic_midi');
      await page.getByRole('button', { name: 'Choose MIDI output', exact: true }).click();
      const outputs = page.getByLabel('Virtual MIDI output', { exact: true });
      await outputs.waitFor();
      assert.equal(await outputs.inputValue(), '');
      await disabled(page);
      await outputs.selectOption('output-a');
      await hardware(page, ['play', 'play']);
      assert.equal(await page.evaluate(() => window.__playback.sends.length), 2, 'One note-on/note-off pair');
      await hardware(page, ['load']);
      assert.equal(await page.evaluate(() => window.__playback.sends.length), 2);
      await page.evaluate(() => {
        const f = window.__playback;
        f.access.outputs.get('output-a').state = 'disconnected';
        f.access.onstatechange?.({});
      });
      await page.waitForFunction(() => document.querySelector('select[aria-label="Virtual MIDI output"]').value === '');
      await disabled(page);
      await hardware(page, ['next']);
      assert.equal(await page.evaluate(() => window.__playback.sends.length), 2);
      assert.equal(await outputs.locator('option[value="output-b"]').count(), 1);
      await page.getByRole('button', { name: 'Toggle fixture controller', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__playback.access.onstatechange), null);
      await hardware(page, ['play']);
      assert.equal(await page.evaluate(() => window.__playback.sends.length), 2);
    });
    await run('late-midi-permission-cannot-attach-after-leaving', viewport, { midiHold: true }, async page => {
      await ready(page);
      await page.getByLabel('Playback source', { exact: true }).selectOption('generic_midi');
      await page.getByRole('button', { name: 'Choose MIDI output', exact: true }).click();
      await page.waitForFunction(() => window.__playback.heldMidi.length === 1);
      await page.getByLabel('Playback source', { exact: true }).selectOption('virtualdj');
      await page.evaluate(() => window.__playback.heldMidi[0]());
      await ready(page);
      assert.equal(await page.evaluate(() => window.__playback.access.onstatechange), null);
      assert.equal(await page.getByLabel('Virtual MIDI output', { exact: true }).count(), 0);
    });
    await run('old-command-cannot-unlock-new-room-command', viewport, { postMode: 'hold' }, async page => {
      await ready(page);
      await play(page).click();
      await page.waitForFunction(() => window.__playback.heldPosts.length === 1);
      await page.getByRole('button', { name: 'Switch fixture room', exact: true }).click();
      await ready(page);
      await page.getByRole('button', { name: 'Pause deck 1', exact: true }).click();
      await page.waitForFunction(() => window.__playback.heldPosts.length === 2);
      await page.evaluate(() => window.__playback.heldPosts[0].release());
      await page.waitForTimeout(100);
      await disabled(page);
      await page.getByRole('status').filter({ hasText: 'Sending pause to VirtualDJ' }).waitFor();
      await hardware(page, ['next']);
      assert.equal((await posts(page)).length, 2);
      await page.evaluate(() => window.__playback.heldPosts[1].release());
      await disabled(page, false);
      const sent = await posts(page);
      assert.equal(sent[0].body.gig_id, 'room-a');
      assert.equal(sent[1].body.gig_id, 'room-b');
    });
  }
  const desktop = { width: 1366, height: 768 };
  for (const mode of ['hold', 'body-hold']) {
    await run(`${mode}-deadline-and-nonoverlapping-poll`, desktop, { mode }, async page => {
      await page.waitForFunction(() => window.__playback.held.length > 0);
      const count = await page.evaluate(() => window.__playback.calls.length);
      await page.waitForTimeout(2_300);
      assert.equal(await page.evaluate(() => window.__playback.calls.length), count, 'Automatic reads do not overlap a pending read');
      await page.getByRole('status').filter({ hasText: 'Playback status could not be confirmed' }).waitFor();
      await disabled(page);
      await page.evaluate(() => { window.__playback.config.mode = 'ready'; });
      await refresh(page).click();
      await ready(page);
      await disabled(page, false);
      assert.equal((await posts(page)).length, 0);
    });
  }
} finally {
  await browser?.close();
  await vite?.close();
  writeFileSync(join(directory, 'results.json'), JSON.stringify({
    sourceSha256: createHash('sha256').update(readFileSync('src/components/PerformerPlaybackController.tsx')).digest('hex'),
    results
  }, null, 2));
}
console.log('PLAYBACK_RECOVERY_BROWSER_SUMMARY', JSON.stringify({ passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status !== 'PASS').length, total: results.length }));
assert.equal(results.length, 38, 'Every planned scenario must execute');
assert.ok(results.every(result => result.status === 'PASS'), 'Playback recovery browser proof failed');
