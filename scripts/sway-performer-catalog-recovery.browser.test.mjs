import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
const directory = join('artifacts', 'readiness-223', `catalog-recovery-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const projects = [{ id: 'A', title: 'Project A' }, { id: 'B', title: 'Project B' }];
const usage = { workspaceLimitBytes: 1_000_000, workingBytes: 50, sealedWorkingBytes: 50, reservedBytes: 0,
  releaseProtectedBytes: 0, availableWorkspaceBytes: 999_950, workingObjectCount: 1, workingObjectLimit: 2000, releaseCountLimit: null };
const files = (project, count = 1, long = false) => ({
  assets: Array.from({ length: count }, (_, index) => ({ id: `${project}-asset-${index}`, title: `Track ${index}`, metadata: { requestable: false } })),
  versions: Array.from({ length: count }, (_, index) => ({ id: `${project}-version-${index}`, assetId: `${project}-asset-${index}`, versionNumber: 1,
    originalFilename: `${project}-${String(index).padStart(4, '0')}${long ? '-long'.repeat(40) : ''}.wav`, byteSize: 50, sha256: 'a'.repeat(64), mimeType: 'audio/wav' }))
});
const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const results = [];
let vite, browser, base;
const spin = async check => { for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } assert.fail('Fixture condition did not settle'); };
const refresh = page => page.getByRole('button', { name: 'Refresh Catalog', exact: true });
const fileRows = page => page.locator('section[aria-label="Your Catalog"] article[aria-label]');
const firstFile = page => fileRows(page).first();
const idle = page => page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Refresh Catalog' && !button.disabled));
async function run(name, viewport, configure, scenario) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const state = { projects, fileCount: 1, long: false, projectStatus: 200, fileStatus: 200, storageStatus: 200,
    projectPayload: null, filePayload: null, holdStorage: false, heldStorage: [], holdFiles: null, heldFiles: [],
    allowWrite: false, holdWrite: false, heldWrites: [], failAfterWrite: false, calls: [], writes: [], errors: [], unexpected: [], blockedFonts: [] };
  configure(state);
  page.on('pageerror', error => state.errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== base) {
      // The production stylesheet imports Google Fonts. Keep that request blocked
      // and report it; all other external requests still fail this fixture.
      if (url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2' && request.resourceType() === 'stylesheet') state.blockedFonts.push(url.href);
      else state.unexpected.push(`${method} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    state.calls.push({ method, path: url.pathname });
    if (method === 'GET') {
      if (url.pathname === '/api/talent/audio/projects') return respond(route, state.projectPayload ?? { projects: state.projects }, state.projectStatus);
      if (url.pathname === '/api/talent/audio/storage-usage') {
        if (state.holdStorage) { state.heldStorage.push(route); return; }
        return respond(route, { storageUsage: usage }, state.storageStatus);
      }
      const match = /^\/api\/talent\/audio\/projects\/([^/]+)\/assets$/.exec(url.pathname);
      if (match) {
        if (state.holdFiles === match[1]) { state.heldFiles.push(route); return; }
        return respond(route, state.filePayload ?? files(match[1], state.fileCount, state.long), state.fileStatus);
      }
      if (url.pathname === '/api/talent/audio/pairing/connections') return respond(route, { connections: [{ connectionId: 'connection-1', counterparty: { displayName: 'Fixture collaborator', handle: 'fixture' } }] });
      if (['/api/talent/audio/files/shared-with-me', '/api/talent/audio/files/shared-by-me'].includes(url.pathname)) return respond(route, { files: [] });
    }
    if (state.allowWrite && method === 'POST' && url.pathname === '/api/talent/audio/projects') {
      state.writes.push({ path: url.pathname, body: request.postDataJSON() });
      if (state.holdWrite) { state.heldWrites.push(route); return; }
      return respond(route, { project: { id: 'C', title: 'Created project' } });
    }
    if (state.allowWrite && method === 'POST' && url.pathname.endsWith('/requestable')) {
      state.writes.push({ path: url.pathname, body: request.postDataJSON() });
      if (state.failAfterWrite) state.fileStatus = 503;
      return respond(route, { ok: true });
    }
    if (state.allowWrite && method === 'POST' && url.pathname === '/api/talent/audio/projects/A/uploads') {
      state.writes.push({ path: url.pathname, body: request.postDataJSON() }); return respond(route, { uploadSession: { id: 'fixture-upload' } });
    }
    if (state.allowWrite && method === 'PUT' && url.pathname === '/api/talent/audio/uploads/fixture-upload/parts/1') {
      state.writes.push({ path: url.pathname, size: request.postDataBuffer().length }); return respond(route, { ok: true });
    }
    if (state.allowWrite && method === 'POST' && url.pathname === '/api/talent/audio/uploads/fixture-upload/complete') {
      state.writes.push({ path: url.pathname }); if (state.failAfterWrite) state.fileStatus = 503;
      return respond(route, { version: { versionNumber: 2 } });
    }
    state.unexpected.push(`${method} ${url.pathname}`); return respond(route, { error: 'Unexpected fixture request' }, 500);
  });
  try {
    await page.goto(`${base}/scripts/browser-fixtures/sway-catalog-recovery.html`, { waitUntil: 'domcontentloaded' });
    await scenario(page, state);
    assert.deepEqual(state.errors, []); assert.deepEqual(state.unexpected, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Catalog must fit the viewport');
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}x${viewport.height}.png`), fullPage: true });
    results.push({ name, viewport, status: 'PASS', requests: state.calls.length, writes: state.writes.length, blockedFontRequests: state.blockedFonts.length });
  } catch (error) {
    results.push({ name, viewport, status: 'FAIL', error: String(error), pageErrors: state.errors, unexpected: state.unexpected });
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}x${viewport.height}-failure.png`), fullPage: true }).catch(() => {});
  } finally { await context.close(); console.log('CATALOG_BROWSER_RESULT', JSON.stringify(results.at(-1))); }
}
try {
  vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen(); const address = vite.httpServer.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1366, height: 768 }]) {
    await run('storage-stall-does-not-hide-files', viewport, state => { state.holdStorage = true; }, async (page, state) => {
      await firstFile(page).waitFor(); assert.equal(await page.getByLabel('Add audio to Catalog', { exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Allow requests', exact: true }).isEnabled(), true);
      assert.equal(state.writes.length, 0);
    });
    await run('project-switch-clears-old-files-and-ignores-late-response', viewport, () => {}, async (page, state) => {
      await firstFile(page).waitFor(); await page.getByText('Organize projects', { exact: true }).click();
      state.holdFiles = 'B'; await page.getByLabel('Selected project', { exact: true }).selectOption('B');
      await spin(() => state.heldFiles.length > 0);
      assert.equal(await fileRows(page).count(), 0);
      await page.getByLabel('Selected project', { exact: true }).selectOption('A'); await firstFile(page).waitFor();
      for (const route of state.heldFiles) await respond(route, files('B')).catch(() => {});
      assert.match(await firstFile(page).getAttribute('aria-label'), /^A-/); assert.equal(state.writes.length, 0);
    });
    await run('failed-refresh-retains-files-and-project-draft', viewport, () => {}, async (page, state) => {
      await firstFile(page).waitFor(); await page.getByText('Organize projects', { exact: true }).click();
      await page.getByLabel('Project title', { exact: true }).fill('Unsaved project title'); state.fileStatus = 503;
      await refresh(page).click(); await page.getByRole('alert').waitFor();
      assert.equal(await fileRows(page).count(), 1);
      assert.equal(await page.getByRole('button', { name: 'Allow requests', exact: true }).isDisabled(), true);
      assert.equal(await page.getByLabel('Project title', { exact: true }).inputValue(), 'Unsaved project title');
      state.fileStatus = 200; await refresh(page).click(); await page.getByRole('alert').waitFor({ state: 'hidden' });
      assert.equal(state.writes.length, 0);
    });
    await run('malformed-files-do-not-become-empty', viewport, () => {}, async (page, state) => {
      await firstFile(page).waitFor(); state.filePayload = { assets: [], versions: null }; await refresh(page).click();
      await page.getByRole('alert').waitFor(); assert.equal(await fileRows(page).count(), 1);
      assert.equal(await page.getByText('No saved files in this project yet.', { exact: true }).count(), 0);
    });
    await run('empty-projects-clear-old-files', viewport, () => {}, async (page, state) => {
      await firstFile(page).waitFor(); state.projects = []; await refresh(page).click();
      await page.getByText('No saved files in this project yet.', { exact: true }).waitFor(); assert.equal(await fileRows(page).count(), 0);
    });
    await run('access-loss-clears-private-files-and-reloads', viewport, () => {}, async (page, state) => {
      await firstFile(page).waitFor(); state.storageStatus = 403; await refresh(page).click();
      await page.getByRole('alert').filter({ hasText: 'Your access changed' }).waitFor();
      assert.equal(await fileRows(page).count(), 0); assert.equal(await page.getByLabel('Selected connection', { exact: true }).count(), 0);
      state.storageStatus = 200; await page.getByRole('button', { name: 'Reload Catalog', exact: true }).click();
      await firstFile(page).waitFor(); assert.equal(state.writes.length, 0);
    });
    await run('long-files-search-and-paging', viewport, state => { state.fileCount = 1001; state.long = true; }, async page => {
      await firstFile(page).waitFor(); assert.equal(await fileRows(page).count(), 30);
      await page.getByRole('button', { name: 'Next files', exact: true }).click();
      assert.match(await firstFile(page).getAttribute('aria-label'), /^A-0030/);
      assert.equal(await page.getByRole('heading', { name: 'Catalog files', exact: true }).evaluate(element => element === document.activeElement), true);
      await page.getByLabel('Search Catalog files', { exact: true }).fill('A-1000');
      assert.equal(await fileRows(page).count(), 1); assert.match(await firstFile(page).getAttribute('aria-label'), /^A-1000/);
      await firstFile(page).getByText('File details and sharing', { exact: true }).click();
      await firstFile(page).getByRole('button', { name: 'Create one-time link', exact: true }).scrollIntoViewIfNeeded();
    });
  }
  const phone = { width: 390, height: 844 };
  for (const count of [0, 1, 30, 31]) await run(`file-boundary-${count}`, phone, state => { state.fileCount = count; }, async page => {
    if (count === 0) await page.getByText('No saved files in this project yet.', { exact: true }).waitFor();
    else await firstFile(page).waitFor();
    assert.equal(await fileRows(page).count(), Math.min(30, count));
    assert.equal(await page.getByRole('button', { name: 'Next files', exact: true }).count(), count > 30 ? 1 : 0);
  });
  await run('double-create-submits-once-and-retains-confirmation', phone, state => { state.allowWrite = true; state.holdWrite = true; }, async (page, state) => {
    await firstFile(page).waitFor(); await page.getByText('Organize projects', { exact: true }).click();
    await page.getByLabel('Project title', { exact: true }).fill('Created project');
    await page.getByRole('button', { name: 'Create', exact: true }).evaluate(button => { button.click(); button.click(); });
    await spin(() => state.heldWrites.length === 1); assert.equal(state.writes.length, 1);
    assert.equal(await page.getByLabel('Selected project', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Project title', { exact: true }).isDisabled(), true);
    await respond(state.heldWrites[0], { project: { id: 'C', title: 'Created project' } });
    await page.getByRole('status').filter({ hasText: 'Project created.' }).waitFor();
    await page.getByRole('article', { name: 'C-0000.wav', exact: true }).waitFor(); assert.equal(state.writes.length, 1);
  });
  await run('accepted-request-change-is-not-repeated-after-refresh-failure', phone, state => { state.allowWrite = true; state.failAfterWrite = true; }, async (page, state) => {
    await firstFile(page).waitFor(); await page.getByRole('button', { name: 'Allow requests', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'This track is now available in Library.' }).waitFor();
    await page.getByRole('alert').waitFor(); assert.equal(state.writes.length, 1);
    state.fileStatus = 200; await refresh(page).click(); await page.getByRole('alert').waitFor({ state: 'hidden' }); assert.equal(state.writes.length, 1);
  });
  await run('upload-confirmed-even-when-followup-read-fails', phone, state => { state.allowWrite = true; state.failAfterWrite = true; }, async (page, state) => {
    await firstFile(page).waitFor(); const buffer = Buffer.from('synthetic audio file fixture only');
    await page.getByLabel('Add audio to Catalog', { exact: true }).setInputFiles({ name: 'fixture.wav', mimeType: 'audio/wav', buffer });
    await page.getByRole('status').filter({ hasText: 'File saved · version 2.' }).waitFor();
    assert.equal(state.writes.length, 3); assert.equal(state.writes[0].body.idempotencyKey, `upload:A:${createHash('sha256').update(buffer).digest('hex')}:${buffer.length}`);
    assert.equal(state.writes[1].size, buffer.length);
    state.fileStatus = 200; await refresh(page).click(); await page.getByRole('alert').waitFor({ state: 'hidden' }); assert.equal(state.writes.length, 3);
  });
  await run('unmount-stops-client-continuation-after-accepted-create', phone, state => { state.allowWrite = true; state.holdWrite = true; }, async (page, state) => {
    await firstFile(page).waitFor(); await page.getByText('Organize projects', { exact: true }).click(); await page.getByRole('button', { name: 'Create', exact: true }).click();
    await spin(() => state.heldWrites.length === 1); await page.getByRole('button', { name: 'Toggle fixture mount', exact: true }).click();
    await respond(state.heldWrites[0], { project: { id: 'C', title: 'Created after leaving' } });
    await page.getByText('Catalog unmounted', { exact: true }).waitFor(); assert.equal(state.calls.some(call => call.path.endsWith('/C/assets')), false);
  });
  await run('real-read-deadline-has-explicit-recovery', phone, () => {}, async (page, state) => {
    await firstFile(page).waitFor(); await idle(page); state.holdFiles = 'A'; await refresh(page).click();
    await page.getByRole('alert').filter({ hasText: 'too long' }).waitFor({ timeout: 22_000 });
    assert.equal(await fileRows(page).count(), 1); state.holdFiles = null; await refresh(page).click();
    await page.getByRole('alert').waitFor({ state: 'hidden' }); assert.equal(state.writes.length, 0);
  });
} finally {
  await browser?.close(); await vite?.close();
  writeFileSync(join(directory, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(result => result.status !== 'PASS');
  console.log('CATALOG_BROWSER_SUMMARY', JSON.stringify({ total: results.length, passed: results.length - failed.length, failed }));
  if (failed.length) process.exitCode = 1;
}
