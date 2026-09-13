import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const vite = await createServer({ root: process.cwd(), publicDir: 'public', logLevel: 'error', cacheDir: 'node_modules/.vite-collaborator-listening', server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.SWAY_BROWSER_EXECUTABLE ? { executablePath: process.env.SWAY_BROWSER_EXECUTABLE } : {}),
  ...(process.env.SWAY_BROWSER_ARGS ? { args: JSON.parse(process.env.SWAY_BROWSER_ARGS) } : {}) });
const file = { grantId: 'audio-grant', connectionId: 'connection', projectTitle: 'Song review', versionId: 'version', originalFilename: 'take-one.wav', mimeType: 'audio/wav', byteSize: 8044, sha256: 'a'.repeat(64), canDownloadOriginal: true, canComment: true, canApprove: true };
const wav = Buffer.alloc(8044, 128);
wav.write('RIFF'); wav.writeUInt32LE(8036, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    let listeningAllowed = true;
    let grantPresent = true;
    let audioRequests = 0;
    await context.route('**/api/talent/audio/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path.endsWith('/connections')) return json({ connections: [{ connectionId: 'connection', counterparty: { displayName: 'Creator', handle: 'creator' } }] });
      if (path.endsWith('/shared-with-me')) return json({ files: grantPresent ? [file, { ...file, grantId: 'review-only', originalFilename: 'review-only.wav', canDownloadOriginal: false }, { ...file, grantId: 'image', originalFilename: 'artwork.png', mimeType: 'image/png' }] : [] });
      if (path.endsWith('/shared-by-me')) return json({ files: [] });
      if (path.endsWith('/listen')) {
        audioRequests += 1;
        if (!listeningAllowed) return route.fulfill({ status: 410, body: 'Access ended' });
        const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
        return route.fulfill({ status: range ? 206 : 200, headers: { 'content-type': 'audio/wav', 'content-length': String(end - start + 1), 'accept-ranges': 'bytes', 'cache-control': 'private, no-store', ...(range ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}) }, body: wav.subarray(start, end + 1) });
      }
      return json({ events: [] });
    });
    await page.goto(`${base}/scripts/browser-fixtures/sway-collaborator-listening.html`);
    const audio = page.getByLabel('Listen to take-one.wav');
    await audio.waitFor();
    assert.equal(await page.locator('audio').count(), 1, 'Only downloadable audio receives a player.');
    assert.equal(audioRequests, 0, 'Opening inbox must not prefetch private masters.');
    await audio.evaluate(async element => { element.muted = true; await element.play(); element.pause(); });
    assert.ok(audioRequests > 0);
    assert.equal(await audio.evaluate(element => element.duration), 1);
    await audio.evaluate(element => { element.currentTime = 0.5; });
    assert.equal(await audio.evaluate(element => element.currentTime), 0.5);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    listeningAllowed = false;
    await audio.evaluate(element => element.load());
    await audio.evaluate(element => { void element.play().catch(() => {}); });
    await page.getByText('Audio could not play.', { exact: false }).waitFor();
    listeningAllowed = true;
    await page.getByRole('button', { name: 'Refresh Collaborator Inbox' }).click();
    await page.waitForFunction(() => !document.body.textContent.includes('Audio could not play.'));
    await audio.evaluate(async element => { element.muted = true; await element.play(); element.pause(); });
    grantPresent = false;
    await page.getByRole('button', { name: 'Refresh Collaborator Inbox' }).click();
    await page.getByText('No files have been shared with you.').waitFor();
    assert.equal(await page.locator('audio').count(), 0, 'Refreshing an ended grant must remove its player.');
    await context.close();
    console.log(`Collaborator listening browser passed ${width}px: audio decode/play/seek, no prefetch, permission visibility, error recovery and ended grant.`);
  }
} finally {
  await browser.close();
  await vite.close();
}
