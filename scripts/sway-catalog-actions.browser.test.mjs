import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = join('artifacts', 'readiness-223', `catalog-actions-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const usage = { workspaceLimitBytes: 20_000_000, workingBytes: 50, sealedWorkingBytes: 50, reservedBytes: 0,
  releaseProtectedBytes: 0, availableWorkspaceBytes: 19_999_950, workingObjectCount: 1, workingObjectLimit: 2000, releaseCountLimit: null };
const files = { assets: [{ id: 'asset-A', title: 'Fixture audio', metadata: { requestable: false } }],
  versions: [{ id: 'version-A', assetId: 'asset-A', versionNumber: 1, originalFilename: 'fixture.wav',
    byteSize: 50, sha256: 'a'.repeat(64), mimeType: 'audio/wav' }] };
const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const results = [];
let vite, browser, base;
const ready = page => page.waitForFunction(() => {
  const input = document.querySelector('input[aria-label="Add audio to Catalog"]');
  return input && !input.disabled;
});
const recovered = page => page.getByRole('status').filter({ hasText: 'Catalog refreshed.' }).waitFor();
const unknown = page => page.getByRole('alert').filter({ hasText: 'The previous action is unconfirmed.' });
const refresh = page => page.getByRole('button', { name: 'Refresh Catalog', exact: true });
const create = page => page.getByRole('button', { name: 'Create', exact: true });
const waitFor = async predicate => {
  for (let n = 0; n < 150; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Catalog mutation fixture did not settle.');
};
async function beginProject(page) {
  await ready(page);
  await page.getByText('Organize projects', { exact: true }).click();
  await page.getByLabel('Project title', { exact: true }).fill('Saved despite lost response');
  await create(page).evaluate(button => { button.click(); button.click(); });
}
async function run(name, viewport, configure, scenario) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const state = { hold: true, held: [], writes: [], projectStatus: 200, fileStatus: 200,
    projects: [{ id: 'A', title: 'Existing project' }], shareStatus: 200, errors: [], unexpected: [] };
  configure(state);
  page.on('pageerror', error => state.errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== base) {
      if (!(url.origin === 'https://fonts.googleapis.com' && request.resourceType() === 'stylesheet')) state.unexpected.push(`${method} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (method === 'GET') {
      if (url.pathname === '/api/talent/audio/projects') return respond(route, { projects: state.projects });
      if (url.pathname === '/api/talent/audio/storage-usage') return respond(route, { storageUsage: usage });
      if (/^\/api\/talent\/audio\/projects\/[^/]+\/assets$/.test(url.pathname)) return respond(route, files, state.fileStatus);
      if (url.pathname === '/api/talent/audio/pairing/connections') return respond(route, { connections: [] });
      if (['/api/talent/audio/files/shared-with-me', '/api/talent/audio/files/shared-by-me'].includes(url.pathname)) return respond(route, { files: [] });
    }
    if (method === 'POST' && url.pathname === '/api/talent/audio/projects') {
      state.writes.push(url.pathname);
      if (state.hold) { state.held.push(route); return; }
      return respond(route, state.projectStatus === 200 ? { project: { id: 'C', title: 'Created project' } } : { error: 'Use another project title.' }, state.projectStatus);
    }
    if (method === 'POST' && url.pathname === '/api/talent/audio/projects/A/uploads') {
      state.writes.push(url.pathname); return respond(route, { uploadSession: { id: 'upload-A' } });
    }
    if (method === 'PUT' && url.pathname === '/api/talent/audio/uploads/upload-A/parts/1') {
      state.writes.push(url.pathname); state.held.push(route); return;
    }
    if (method === 'POST' && url.pathname === '/api/talent/audio/versions/version-A/shares') {
      state.writes.push(url.pathname);
      assert.deepEqual(request.postDataJSON(), { maxUses: 1 });
      return respond(route, state.shareStatus === 200 ? { shareToken: 'fixture-share' } : { error: 'Unconfirmed share' }, state.shareStatus);
    }
    state.unexpected.push(`${method} ${url.pathname}`); return respond(route, { error: 'Unexpected fixture request' }, 500);
  });
  try {
    await page.goto(`${base}/scripts/browser-fixtures/sway-catalog-recovery.html`, { waitUntil: 'domcontentloaded' });
    await scenario(page, state);
    assert.deepEqual(state.errors, []); assert.deepEqual(state.unexpected, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Recovery must fit the viewport');
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}.png`), fullPage: true });
    results.push({ name, viewport, passed: true, writes: state.writes.length });
  } catch (error) {
    results.push({ name, viewport, passed: false, error: String(error), pageErrors: state.errors, unexpected: state.unexpected });
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}-failed.png`), fullPage: true }).catch(() => {});
  } finally {
    await context.close(); console.log('CATALOG_ACTION_BROWSER_RESULT', JSON.stringify(results.at(-1)));
  }
}
try {
  vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen(); const address = vite.httpServer.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1366, height: 768 }]) {
    await run('stop-create-requires-successful-read-before-reuse', viewport, () => {}, async (page, state) => {
      await beginProject(page); await waitFor(() => state.held.length === 1);
      await page.getByRole('button', { name: 'Stop waiting', exact: true }).click(); await unknown(page).waitFor();
      assert.equal(state.writes.length, 1); assert.equal(await create(page).isDisabled(), true);
      assert.equal(await page.getByLabel('Project title', { exact: true }).inputValue(), 'Saved despite lost response');
      state.projects.push({ id: 'C', title: 'Saved despite lost response' }); state.fileStatus = 503;
      await refresh(page).click(); await page.getByRole('alert').filter({ hasText: 'Catalog could not refresh.' }).waitFor();
      assert.equal(await create(page).isDisabled(), true);
      state.fileStatus = 200; await refresh(page).click(); await recovered(page); await ready(page);
      assert.equal(state.writes.length, 1);
      await respond(state.held[0], { project: { id: 'OLD', title: 'Late wrong project' } }).catch(() => {});
      assert.equal(await page.getByLabel('Selected project', { exact: true }).inputValue(), 'A');
      assert.equal(await page.getByRole('status').filter({ hasText: 'Project created.' }).count(), 0);
      state.hold = false; await create(page).click();
      await page.getByRole('status').filter({ hasText: 'Project created.' }).waitFor();
      assert.equal(state.writes.length, 2);
    });
    await run('stopped-upload-sends-no-next-part-or-completion', viewport, () => {}, async (page, state) => {
      await ready(page);
      await page.getByLabel('Add audio to Catalog', { exact: true }).setInputFiles({ name: 'two-parts.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 7) });
      await waitFor(() => state.held.length === 1);
      await page.getByRole('button', { name: 'Stop waiting', exact: true }).click(); await unknown(page).waitFor();
      await respond(state.held[0], { ok: true }).catch(() => {});
      await refresh(page).click(); await recovered(page);
      assert.deepEqual(state.writes, ['/api/talent/audio/projects/A/uploads', '/api/talent/audio/uploads/upload-A/parts/1']);
      assert.equal(await page.getByRole('status').filter({ hasText: 'File saved' }).count(), 0);
    });
    await run('uncertain-share-never-auto-repeats', viewport, state => { state.shareStatus = 503; }, async (page, state) => {
      await ready(page); await page.getByText('File details and sharing', { exact: true }).click();
      const share = page.getByRole('button', { name: 'Create one-time link', exact: true });
      await share.click(); await unknown(page).waitFor(); assert.equal(await share.isDisabled(), true);
      await refresh(page).click(); await recovered(page); assert.equal(state.writes.length, 1);
      assert.equal(await page.getByText('fixture-share', { exact: true }).count(), 0);
    });
    await run('cancelled-view-cannot-change-remounted-catalog', viewport, () => {}, async (page, state) => {
      await beginProject(page); await waitFor(() => state.held.length === 1);
      const toggle = page.getByRole('button', { name: 'Toggle fixture mount', exact: true });
      await toggle.click(); await page.getByText('Catalog unmounted', { exact: true }).waitFor();
      await toggle.click(); await ready(page);
      await respond(state.held[0], { project: { id: 'OLD', title: 'Old account result' } }).catch(() => {});
      assert.equal(await page.getByRole('status').filter({ hasText: 'Project created.' }).count(), 0);
      assert.equal(state.writes.length, 1);
    });
    await run('deadline-unlocks-read-only-recovery', viewport, () => {}, async (page, state) => {
      await ready(page); await page.clock.install();
      await beginProject(page); await waitFor(() => state.held.length === 1);
      await page.clock.fastForward(60_001); await unknown(page).waitFor();
      assert.equal(await create(page).isDisabled(), true); assert.equal(await refresh(page).isEnabled(), true);
      assert.equal(state.writes.length, 1);
    });
    await run('known-validation-rejection-keeps-draft-editable', viewport, state => { state.hold = false; state.projectStatus = 422; }, async (page, state) => {
      await beginProject(page); await page.getByRole('status').filter({ hasText: 'Use another project title.' }).waitFor();
      assert.equal(await unknown(page).count(), 0); assert.equal(await create(page).isEnabled(), true);
      assert.equal(await page.getByLabel('Project title', { exact: true }).inputValue(), 'Saved despite lost response');
      assert.equal(state.writes.length, 1);
    });
    await run('denied-write-clears-private-catalog', viewport, state => { state.hold = false; state.projectStatus = 403; }, async (page, state) => {
      await beginProject(page); await page.getByRole('alert').filter({ hasText: 'Your access changed.' }).waitFor();
      assert.equal(await page.locator('section[aria-label="Your Catalog"] article').count(), 0);
      assert.equal(await page.getByLabel('Selected connection', { exact: true }).count(), 0);
      assert.equal(state.writes.length, 1);
    });
  }
} finally {
  await browser?.close(); await vite?.close();
  writeFileSync(join(directory, 'results.json'), JSON.stringify(results, null, 2));
}
const failed = results.filter(result => !result.passed);
console.log('CATALOG_ACTION_BROWSER_SUMMARY', JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length }));
assert.equal(results.length, 21, 'Every Catalog action browser scenario must run.');
assert.equal(failed.length, 0, 'Catalog action browser recovery failed.');
