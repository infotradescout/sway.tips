import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Actual Sources chooser, setup component, controller, React StrictMode and CSS.
// API and device replies are synthetic. No provider or production host is used.
const directory = join('artifacts', 'readiness-223', `sources-player-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const roomA = '11111111-1111-4111-8111-111111111111';
const roomB = '22222222-2222-4222-8222-222222222222';
const fixtureText = '@echo off\r\necho synthetic booth fixture\r\n';
const fixtureBytes = Buffer.from(fixtureText);
const template = { contentType: 'application/x-msdos-program', contentBase64: fixtureBytes.toString('base64'), sha256: createHash('sha256').update(fixtureBytes).digest('hex') };
writeFileSync(join(directory, 'fixture.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sources setup proof</title><body><div id="root"></div><script type="module" src="/${directory}/fixture.tsx"></script></body></html>`);
writeFileSync(join(directory, 'fixture.tsx'), `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import Choices from '/src/components/PerformerSourceImportChoices';
import {SourcePlayerContext} from '/src/source-player-context';
import '/src/index.css';
const rooms=[{gigId:'${roomA}',performerName:'Fixture performer A'},{gigId:'${roomB}',performerName:'Fixture performer B'}];
function Harness(){const [account,setAccount]=useState('account-a');const [room,setRoom]=useState('${roomA}');const [ready,setReady]=useState(true);const [preview,setPreview]=useState(false);const [url,setUrl]=useState('');
return <main className="mx-auto max-w-3xl bg-slate-950 p-3 text-white"><nav className="mb-4 flex flex-wrap gap-3"><button onClick={()=>setAccount(a=>a==='account-a'?'account-b':'account-a')}>Switch fixture account</button><button onClick={()=>setRoom(r=>r==='${roomA}'?'${roomB}':'${roomA}')}>Switch fixture room</button><button onClick={()=>setReady(r=>!r)}>Toggle fixture ready</button><button onClick={()=>setPreview(r=>!r)}>Toggle fixture preview</button></nav>
<SourcePlayerContext.Provider value={{accountId:account,performerId:account, gigId:room,ready:ready&&!preview,previewMode:preview,rooms:rooms as any,onSelectRoom:setRoom as any,approvedRequests:[]}}>
<Choices spotifyPlaylistUrl={url} spotifyImportStatus="idle" spotifyImportMessage={null} djLibraryImportStatus="idle" djLibraryImportMessage={null} previewMode={preview} onSpotifyPlaylistUrlChange={setUrl} onSpotifyPlaylistImport={e=>{e.preventDefault();window.__sources.imports.push('spotify');}} onDjLibraryFileImport={e=>window.__sources.imports.push(e.currentTarget.getAttribute('data-sway-source-label'))} onOpenCatalog={()=>window.__sources.imports.push('uploads')}/></SourcePlayerContext.Provider></main>};
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness/></React.StrictMode>);`);

function installFixture({ template, options }) {
  const original = window.fetch.bind(window);
  const f = window.__sources = { options: { mode: 'ready', status: 200, badHash: false, offline: false, stale: false, expiryMs: 60_000, ...options }, calls: [], held: [], imports: [], unexpected: [] };
  window.fetch = (input, init = {}) => {
    const url = new URL(String(input), location.href);
    if (!url.pathname.startsWith('/api/')) return original(input, init);
    const call = { path: url.pathname, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, aborted: false };
    f.calls.push(call); init.signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
    const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
    if (call.path === '/api/talent/control-bridge/token' && call.method === 'POST') {
      const data = { gigId: call.body.gig_id, command: 'node synthetic-bridge --synthetic-room-only', windowsLauncher: { ...template, filename: `sway-booth-${call.body.gig_id.slice(0,8)}.cmd`, expiresAt: new Date(Date.now() + f.options.expiryMs).toISOString(), ...(f.options.badHash ? { sha256: '0'.repeat(64) } : {}) } };
      if (f.options.mode === 'hold') return new Promise(resolve => f.held.push(() => resolve(response(data, f.options.status))));
      return Promise.resolve(response(data, f.options.status));
    }
    if (call.path.startsWith('/api/talent/playback/snapshot/') && call.method === 'GET') {
      const gigId = call.path.split('/').at(-1);
      return Promise.resolve(response({ state: { gigId, sourceKey: 'virtualdj', connectionStatus: f.options.offline ? 'disconnected' : 'connected', observedAt: new Date(Date.now() - (f.options.stale ? 120_000 : 0)).toISOString(), fresh: !f.options.stale, trackTitle: 'Synthetic source track', trackArtist: 'Fixture artist', bpmTimes100: 12000 }, commands: [] }));
    }
    if (call.path === '/api/talent/playback/commands' && call.method === 'POST') return Promise.resolve(response({ command: { id: 'synthetic-command', status: 'queued' } }));
    f.unexpected.push(call.path); return Promise.resolve(response({}, 500));
  };
}
let browser, vite, base;
const results = [];
const setup = page => page.getByRole('button', { name: 'Set up VirtualDJ connection', exact: true });
const confirm = page => page.getByRole('button', { name: 'Confirm and prepare room file', exact: true });
const download = page => page.getByRole('button', { name: 'Download Windows room file', exact: true });
const posts = page => page.evaluate(() => window.__sources.calls.filter(call => call.method === 'POST'));
async function run(name, viewport, options, scenario) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', acceptDownloads: true });
  await context.addInitScript(installFixture, { template, options });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort('blockedbyclient'));
  try {
    await page.goto(`${base}/${directory}/fixture.html`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-sway-source-player-setup="true"]').waitFor();
    await scenario(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__sources.unexpected), []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}.png`), fullPage: true });
    results.push({ name, width: viewport.width, status: 'PASS', posts: (await posts(page)).length });
  } catch (error) {
    results.push({ name, width: viewport.width, status: 'FAIL', error: String(error), errors });
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}-failure.png`), fullPage: true }).catch(() => {});
  } finally { console.log('SOURCE_PLAYER_BROWSER_RESULT', JSON.stringify(results.at(-1))); await context.close(); }
}
try {
  vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen(); const address = vite.httpServer.address(); assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`; browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390, 320]) {
    const viewport = { width, height: 900 };
    await run('confirmed-setup-download-and-control', viewport, {}, async page => {
      assert.equal((await posts(page)).length, 0);
      await setup(page).click(); assert.equal((await posts(page)).length, 0);
      await confirm(page).click(); await download(page).waitFor();
      const calls = await posts(page); assert.equal(calls.length, 1); assert.equal(calls[0].body.gig_id, roomA);
      await page.getByText('Room file prepared — player connection is not confirmed yet.', { exact: true }).waitFor();
      const event = page.waitForEvent('download'); await download(page).click(); const file = await event;
      assert.equal(file.suggestedFilename(), 'sway-booth-11111111.cmd');
      assert.equal(readFileSync(await file.path(), 'utf8'), fixtureText);
      await page.getByRole('button', { name: 'Open playback controls', exact: true }).click();
      await page.getByRole('status').filter({ hasText: /^VirtualDJ linked$/ }).waitFor();
      await page.getByRole('button', { name: 'Play deck 1', exact: true }).click();
      const commands = (await posts(page)).filter(call => call.path.endsWith('/commands'));
      assert.equal(commands.length, 1); assert.equal(commands[0].body.gig_id, roomA); assert.equal(commands[0].body.action, 'play');
      const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
      assert(!stored.includes('synthetic-room-only')); assert(!stored.includes('contentBase64'));
    });
    await run('cancel-and-readiness-guards', viewport, {}, async page => {
      await setup(page).click(); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(await confirm(page).count(), 0); assert.equal((await posts(page)).length, 0);
      await page.getByRole('button', { name: 'Toggle fixture ready', exact: true }).click(); assert.equal(await setup(page).isDisabled(), true);
      await page.getByRole('button', { name: 'Toggle fixture ready', exact: true }).click();
      await page.getByRole('button', { name: 'Toggle fixture preview', exact: true }).click(); assert.equal(await setup(page).isDisabled(), true);
      assert.equal((await posts(page)).length, 0);
    });
    await run('preserved-source-import-actions', viewport, {}, async page => {
      await page.getByLabel('Import Serato file', { exact: true }).setInputFiles({ name: 'songs.csv', mimeType: 'text/csv', buffer: Buffer.from('Title,Artist\nTest,Fixture\n') });
      await page.getByRole('button', { name: /Music uploaded to Sway/ }).click();
      await page.locator('summary').filter({ hasText: 'Spotify playlist' }).click();
      await page.getByLabel('Spotify playlist link', { exact: true }).fill('https://open.spotify.com/playlist/synthetic');
      await page.getByRole('button', { name: 'Add playlist', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__sources.imports), ['Serato', 'uploads', 'spotify']);
      assert.equal(await page.locator('input[data-sway-source-label]').count(), 8);
      assert.equal((await posts(page)).length, 0);
    });
    for (const kind of ['account', 'room']) await run(`late-result-${kind}-isolation`, viewport, { mode: 'hold' }, async page => {
      await setup(page).click(); await confirm(page).click();
      await page.waitForFunction(() => window.__sources.held.length === 1);
      await page.getByRole('button', { name: `Switch fixture ${kind}`, exact: true }).click();
      await page.evaluate(() => window.__sources.held.splice(0).forEach(release => release()));
      await page.waitForTimeout(100);
      assert.equal(await download(page).count(), 0);
      assert.equal(await page.getByLabel('Private room bridge command', { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.__sources.calls[0].aborted), true);
      assert.equal((await posts(page)).length, 1);
    });
    await run('integrity-failure-no-download', viewport, { badHash: true }, async page => {
      await setup(page).click(); await confirm(page).click(); await page.getByRole('alert').filter({ hasText: 'integrity check' }).waitFor();
      assert.equal(await download(page).count(), 0); assert.equal((await posts(page)).length, 1);
    });
    await run('access-loss-clears-controls', viewport, { status: 403 }, async page => {
      await setup(page).click(); await confirm(page).click(); await page.getByRole('alert').filter({ hasText: 'access changed' }).waitFor();
      assert.equal(await setup(page).isDisabled(), true); assert.equal(await download(page).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Open playback controls', exact: true }).isDisabled(), true);
    });
    await run('expired-file-cleared', viewport, { expiryMs: 3000 }, async page => {
      await setup(page).click(); await confirm(page).click(); await download(page).waitFor();
      await page.getByRole('alert').filter({ hasText: 'expired' }).waitFor(); assert.equal(await download(page).count(), 0);
    });
    await run('stale-playback-remains-disabled', viewport, { stale: true }, async page => {
      await page.getByRole('button', { name: 'Open playback controls', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Bridge offline or status expired' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Play deck 1', exact: true }).isDisabled(), true);
      assert.equal((await posts(page)).length, 0);
    });
  }
} finally {
  await browser?.close(); await vite?.close();
  rmSync(join(directory, 'fixture.html'), { force: true }); rmSync(join(directory, 'fixture.tsx'), { force: true });
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ sourceSha256: createHash('sha256').update(readFileSync('src/components/PerformerSourcePlayerSetup.tsx')).digest('hex'), passed: results.length === 27 && results.every(result => result.status === 'PASS'), results }, null, 2));
  // Export only this run's synthetic evidence, then remove its exact owned root.
  if (process.env.SWAY_SOURCE_PLAYER_PROOF_OUTPUT) cpSync(directory, process.env.SWAY_SOURCE_PLAYER_PROOF_OUTPUT, { recursive: true });
  rmSync(directory, { recursive: true, force: true });
}
assert.equal(results.length, 27, 'Every declared browser scenario must execute');
assert.equal(results.filter(result => result.status !== 'PASS').length, 0, 'All Sources player scenarios must pass');
console.log('SOURCE_PLAYER_BROWSER_COMPLETE', results.length, directory);
