import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const out = 'tmp/music-sources-proof';
mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), checks: [], passed: false, providerCalls: 0, productionWrites: false };
let proof, browser, child, baseUrl, serverTail = '', currentStage = 'initialization';
const record = name => { report.checks.push(name); console.log('SWAY_SOURCE_BROWSER_PASS ' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const p = socket.address().port; await new Promise(resolve => socket.close(resolve)); return p;
}
async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
async function startServer(listenPort) {
  baseUrl = `http://127.0.0.1:${listenPort}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(listenPort), DATABASE_URL: proof.databaseUrl,
      SWAY_APP_BASE_URL: baseUrl, APP_URL: baseUrl, APP_BASE_URL: baseUrl, VITE_SWAY_DEMO_MODE: 'false',
      SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED: 'false', DISABLE_HMR: 'true',
      STRIPE_SECRET_KEY: '', STRIPE_PUBLISHABLE_KEY: '', VITE_STRIPE_PUBLISHABLE_KEY: '', STRIPE_WEBHOOK_SECRET: '',
      SWAY_EMAIL_PROVIDER: '', SWAY_EMAIL_API_KEY: '', SWAY_EMAIL_FROM: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const consume = data => { serverTail = (serverTail + data.toString()).slice(-12000); };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Local Sway server exited before readiness.');
    try { if ((await fetch(baseUrl + '/api/health/network-probe', { signal: AbortSignal.timeout(1000) })).status === 204) return; } catch {}
    await delay(100);
  }
  throw new Error('Local Sway server did not become ready.');
}
async function newAccount(label) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const email = `sources-${suffix}@example.test`, password = `SwaySources!2026-${suffix}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(baseUrl + '/') || /^(data|blob):/.test(url)) return route.continue();
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  currentStage = label + ' signup';
  await page.goto(baseUrl + '/account/signup?intent=performer');
  await page.getByRole('heading', { name: 'Create your Sway account' }).waitFor();
  await page.getByLabel('Your name').fill('Sources ' + label);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByLabel('I accept the Sway Terms.').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  const link = page.getByRole('link', { name: 'Open local verification link' });
  await link.waitFor();
  assert.equal(new URL(await link.getAttribute('href'), baseUrl).origin, new URL(baseUrl).origin);
  await Promise.all([page.waitForURL(url => url.pathname === '/account/login' && url.searchParams.get('verified') === '1'), link.click()]);
  await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password);
  await Promise.all([page.waitForURL(url => url.pathname === '/account'), page.getByRole('button', { name: 'Log in' }).click()]);
  await page.getByRole('heading', { name: 'Activate Pro Mode' }).waitFor();
  await page.getByLabel('Performer name').fill('Sources ' + label);
  await page.getByLabel('Public handle').fill('sources-' + suffix);
  await Promise.all([page.waitForURL(url => url.pathname === '/talent'), page.getByRole('button', { name: 'Activate Pro Mode' }).click()]);
  await page.goto(baseUrl + '/talent/connections');
  await page.locator('[data-sway-source-import-choices]').waitFor();
  return { page, context, errors };
}
async function api(context, path) {
  const response = await context.request.get(baseUrl + path); assert.equal(response.status(), 200); return response.json();
}
async function importFile(page, inputName, fileName, content, { consent = true, replace = false } = {}) {
  currentStage = 'import ' + fileName;
  const confirmation = new Promise((resolve, reject) => page.once('dialog', async dialog => {
    try {
      assert.equal(dialog.type(), 'confirm');
      assert.match(dialog.message(), replace ? /^Replace the tracks/ : /^Add /);
      if (consent) await dialog.accept(); else await dialog.dismiss();
      resolve();
    } catch (error) { await dialog.dismiss().catch(() => {}); reject(error); }
  }));
  const responsePromise = consent ? page.waitForResponse(response => response.url().endsWith('/api/talent/library/import') && response.request().method() === 'POST') : null;
  await page.getByLabel(inputName, { exact: true }).setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from(content) });
  await confirmation;
  if (responsePromise) { const response = await responsePromise; assert.equal(response.status(), 202); }
  await page.locator('[data-sway-source-import-choices] [role="status"]').filter({ hasText: consent ? /^(Saved|Updated) / : /^Import canceled/ }).waitFor();
}
try {
  proof = await startEmbeddedPostgresProof('music_sources_browser');
  report.databaseKind = proof.kind;
  const listenPort = await port(); await startServer(listenPort);
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const a = await newAccount('First');
  const uploads = [];
  a.page.on('request', request => {
    if (request.url().endsWith('/api/talent/library/import') && request.method() === 'POST') uploads.push(request.postDataJSON());
  });
  const chooser = a.page.locator('[data-sway-source-import-choices]');
  assert.equal(await chooser.locator('input[type=file]').count(), 9);
  for (const name of ['Apple Music / iTunes', 'Serato', 'rekordbox', 'Traktor', 'VirtualDJ', 'Mixxx', 'Local / USB playlists', 'Song list / setlist']) {
    assert.equal(await a.page.getByLabel(`Import ${name} file`, { exact: true }).count(), 1);
  }
  record('Eight named file choices are mounted in the real performer Sources page');
  await importFile(a.page, 'Import Serato file', 'Friday.csv', 'song,artist\nFriday Original,Example Performer');
  await importFile(a.page, 'Import Serato file', 'Saturday.csv', 'song,artist\nSaturday Original,Example Performer');
  let sources = await api(a.context, '/api/talent/library/sources');
  assert.equal(sources.sources.length, 2); assert.notEqual(sources.sources[0].sourceKey, sources.sources[1].sourceKey);
  const owner = (await api(a.context, '/api/talent/library/tracks')).performerId;
  record('Two CSV exports save as separate sources through the actual API');
  await importFile(a.page, 'Import Serato file', 'Friday.csv', 'song,artist\nFriday Replacement,Example Performer', { consent: false, replace: true });
  let tracks = (await api(a.context, '/api/talent/library/tracks')).external.tracks;
  assert(tracks.some(track => track.title === 'Friday Original')); assert(!tracks.some(track => track.title === 'Friday Replacement')); assert.equal(uploads.length, 2);
  record('Canceling a replacement performs no write and preserves both existing lists');
  await importFile(a.page, 'Import Serato file', 'Friday.csv', 'song,artist\nFriday Replacement,Example Performer', { replace: true });
  tracks = (await api(a.context, '/api/talent/library/tracks')).external.tracks;
  assert(tracks.some(track => track.title === 'Friday Replacement')); assert(tracks.some(track => track.title === 'Saturday Original')); assert(!tracks.some(track => track.title === 'Friday Original'));
  record('Confirmed replacement updates only the matching saved export');
  const fixtures = [
    ['Import Apple Music / iTunes file', 'Apple.xml', '<plist><dict><key>Tracks</key><dict><key>1</key><dict><key>Name</key><string>Apple Original</string><key>Artist</key><string>Original Artist</string><key>Location</key><string>file:///Users/private/secret.mp3</string></dict></dict></dict></plist>', 'Apple Original'],
    ['Import rekordbox file', 'rekordbox.xml', '<DJ_PLAYLISTS><COLLECTION><TRACK TrackID="1" Name="Rekordbox Original" Artist="Original Artist" Location="file:///private/record.mp3" /></COLLECTION></DJ_PLAYLISTS>', 'Rekordbox Original'],
    ['Import Traktor file', 'Traktor.nml', '<NML><COLLECTION><ENTRY TITLE="Traktor Original" ARTIST="Original Artist"><LOCATION DIR="/:private/:" FILE="song.mp3" /></ENTRY></COLLECTION></NML>', 'Traktor Original'],
    ['Import VirtualDJ file', 'VirtualDJ.xml', '<VirtualDJ_Database><Song FilePath="C:\\private\\song.mp3"><Tags Title="VirtualDJ Original" Author="Original Artist" /></Song></VirtualDJ_Database>', 'VirtualDJ Original'],
    ['Import Local / USB playlists file', 'USB.m3u', '#EXTM3U\n#EXTINF:60,Original Artist - USB Original\nC:\\private\\song.mp3', 'USB Original'],
    ['Import Mixxx file', 'Mixxx.pls', '[playlist]\nFile1=C:\\private\\song.mp3\nTitle1=Original Artist - Mixxx Original\nLength1=60', 'Mixxx Original'],
    ['Import Local / USB playlists file', 'Portable.xspf', '<playlist><trackList><track><title>Portable Original</title><creator>Original Artist</creator><location>file:///private/song.mp3</location></track></trackList></playlist>', 'Portable Original'],
    ['Import Song list / setlist file', 'Setlist.txt', 'Original Artist - Setlist Original', 'Setlist Original'],
    ['Import Song list / setlist file', 'Table.tsv', 'Title\tArtist\nTable Original\tOriginal Artist', 'Table Original']
  ];
  for (const [input, name, content, title] of fixtures) {
    await importFile(a.page, input, name, content);
    assert((await api(a.context, '/api/talent/library/tracks')).external.tracks.some(track => track.title === title));
  }
  record('Apple, rekordbox, Traktor, VirtualDJ, M3U, PLS, XSPF, TXT and TSV each persist through real browser imports');
  assert(!JSON.stringify(uploads).includes('/private')); assert(!JSON.stringify(uploads).includes('C:\\private')); assert(!JSON.stringify(uploads).includes('file:///'));
  record('Browser POST bodies contain song metadata, not local file paths or audio');
  const beforeInvalid = uploads.length;
  await a.page.getByLabel('Import Song list / setlist file', { exact: true }).setInputFiles({ name: 'Empty.txt', mimeType: 'text/plain', buffer: Buffer.from('') });
  await chooser.getByRole('alert').filter({ hasText: /No song titles/ }).waitFor();
  assert.equal(uploads.length, beforeInvalid);
  assert.equal((await api(a.context, '/api/talent/library/sources')).sources.length, 11);
  record('Invalid file is rejected before POST and does not erase prior sources');
  await a.page.reload(); await chooser.waitFor();
  await a.page.locator('[data-sway-linked-sources]').getByText('11 tracks', { exact: true }).waitFor();
  await a.page.goto(baseUrl + '/talent/library');
  await a.page.getByLabel('Search request library').fill('Saturday Original');
  await a.page.getByText('Saturday Original', { exact: true }).waitFor();
  record('Saved imports survive reload and are found in the actual Requests library');
  const b = await newAccount('Second');
  assert.equal((await api(b.context, '/api/talent/library/sources')).sources.length, 0);
  assert.equal((await api(b.context, '/api/talent/library/tracks')).external.tracks.length, 0);
  record('A separately signed-up performer cannot read the first performer sources');
  await stopServer(); await startServer(listenPort);
  await a.page.goto(baseUrl + '/talent/connections'); await chooser.waitFor();
  sources = await api(a.context, '/api/talent/library/sources'); assert.equal(sources.sources.length, 11);
  const db = await proof.query('select count(*)::int as records from performer_library_tracks where performer_id = $1 and is_active = true', [owner]);
  assert.equal(db.rows[0].records, 11);
  record('Server restart preserves all eleven sources and database-backed active tracks');
  await chooser.locator('summary').filter({ hasText: 'Other music services and DJ apps' }).click();
  await chooser.getByText(/These services are not directly connected here/).waitFor();
  for (const width of [1440, 390, 320]) {
    await a.page.setViewportSize({ width, height: width > 1000 ? 1000 : 844 });
    await a.page.screenshot({ path: `${out}/sources-${width}.png`, fullPage: true });
    const sizes = await a.page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert(sizes.scrollWidth <= sizes.width + 1, 'Sources page must not overflow horizontally at ' + width);
  }
  record('Desktop, 390px and 320px Sources layouts stay within the viewport');
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
  record('Both real account journeys complete without browser page errors');
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error); report.stage = currentStage;
  console.error('SWAY_SOURCE_BROWSER_ERROR ' + JSON.stringify({ stage: currentStage, error: report.error }));
  // Only owned loopback processes are inspected. Do not persist verification
  // URLs, account cookies, passwords, or raw private application logs.
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    report.page = await page.evaluate(() => ({ path: location.pathname, headings: [...document.querySelectorAll('h1,h2,h3')].map(x => x.textContent), alerts: [...document.querySelectorAll('[role=alert]')].map(x => x.textContent) })).catch(() => null);
    await page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
    console.error('SWAY_SOURCE_BROWSER_PAGE ' + JSON.stringify(report.page));
  }
  if (!browser) console.error(serverTail.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[OWNED_DATABASE]').slice(-4000));
  process.exitCode = 1;
} finally {
  await browser?.close(); await stopServer(); await proof?.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(`${out}/results.json`, JSON.stringify(report, null, 2));
  console.log('SWAY_SOURCE_BROWSER_SUMMARY ' + JSON.stringify(report));
}
