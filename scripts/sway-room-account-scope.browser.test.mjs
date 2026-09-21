import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

assert.match(readFileSync(new URL('../src/shells/TalentApp.tsx', import.meta.url), 'utf8'), /useSwayState\(\{[^}]*accessScope:\s*performerIdentity/, 'The actual performer shell must bind the hook to its confirmed account.');
const room = '11111111-1111-4111-8111-111111111111';
const view = async page => JSON.parse(await page.getByTestId('scope-state').textContent());
const settled = (page, name, lookup = 'active') => page.waitForFunction(expected => {
  const text = document.querySelector('[data-testid="scope-state"]')?.textContent;
  if (!text) return false;
  const state = JSON.parse(text);
  return !state.loading && state.name === expected.name && state.lookup === expected.lookup;
}, { name, lookup });
const flush = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const signal = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const plan = (label, { held = false, closed = false, code = 200 } = {}) => {
  const begun = signal();
  const release = signal();
  if (!held) release.resolve();
  return { label, closed, code, begun, release };
};
const snapshot = entry => ({
  activeGigId: room, room_lookup: entry.closed ? 'ended' : 'active',
  ...(entry.closed ? { room_read_only: true } : {}),
  session: { status: entry.closed ? 'closed' : 'active', talentName: `PRIVATE_${entry.label}`,
    paymentsEnabled: false, totals: { totalTips: 0, accumulatedFees: 0, totalCount: 1, topRequest: 'Fixture' } },
  requests: [{ id: `request-${entry.label}`, title: `HISTORY_${entry.label}`, status: 'fulfilled', boosts: [] }],
  performers: []
});
let browser;
let vite;
const results = [];
try {
  vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1366, height: 768 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors = [];
    const unexpected = [];
    const queued = [];
    const releases = [];
    let fallback = plan('A');
    page.on('pageerror', error => pageErrors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort('blockedbyclient');
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (request.method() !== 'GET' || url.pathname !== `/api/state/${room}`) {
        unexpected.push(`${request.method()} ${url.pathname}`);
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      }
      const entry = queued.shift() ?? fallback;
      entry.begun.resolve();
      await entry.release.promise;
      await route.fulfill({ status: entry.code, contentType: 'application/json',
        body: JSON.stringify(entry.code === 200 ? snapshot(entry) : { error: 'Synthetic access revoked' })
      }).catch(() => undefined); // A superseded request is intentionally aborted by the real hook.
    });
    const pass = name => {
      const result = { viewport: `${viewport.width}x${viewport.height}`, name, passed: true };
      results.push(result);
      console.log(`ROOM_ACCOUNT_SCOPE_RESULT ${JSON.stringify(result)}`);
    };
    try {
      await page.goto(`${origin}/scripts/browser-fixtures/sway-room-account-scope.html`, { waitUntil: 'domcontentloaded' });
      await settled(page, 'PRIVATE_A');
      await page.getByRole('button', { name: 'Capture callback', exact: true }).click();
      const heldB = plan('B', { held: true }); queued.push(heldB); releases.push(heldB.release);
      fallback = plan('B');
      await page.getByRole('button', { name: 'Account B', exact: true }).click();
      await Promise.race([heldB.begun.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Account change did not start its own room read')), 5000))]);
      let state = await view(page);
      assert.equal(state.account, 'B');
      assert.equal(state.loading, true);
      assert.equal(state.blocked, true);
      assert.equal(state.name.includes('PRIVATE_A'), false);
      assert.deepEqual(state.titles, []);
      pass('same room under another account clears private history before its response');
      await page.getByRole('button', { name: 'Apply A callback', exact: true }).click();
      await flush(page);
      state = await view(page);
      assert.equal(state.name.includes('STALE'), false);
      assert.equal(state.loading, true);
      heldB.release.resolve();
      await settled(page, 'PRIVATE_B');
      assert.deepEqual((await view(page)).titles, ['HISTORY_B']);
      pass('late action from account A cannot populate account B');

      await page.getByRole('button', { name: 'Capture callback', exact: true }).click();
      const lateB = plan('B', { held: true }); queued.push(lateB); releases.push(lateB.release);
      await page.evaluate(() => window.dispatchEvent(new Event('re-fetch-state')));
      await lateB.begun.promise;
      fallback = plan('A');
      await page.getByRole('button', { name: 'Account A', exact: true }).click();
      await settled(page, 'PRIVATE_A');
      await page.getByRole('button', { name: 'Apply B callback', exact: true }).click();
      lateB.release.resolve();
      await flush(page);
      state = await view(page);
      assert.equal(state.name, 'PRIVATE_A');
      assert.deepEqual(state.titles, ['HISTORY_A']);
      pass('A to B to A rejects the superseded read and action');

      await page.getByRole('button', { name: 'Unrelated render', exact: true }).click();
      state = await view(page);
      assert.equal(state.loading, false);
      assert.equal(state.name, 'PRIVATE_A');
      pass('ordinary rerenders preserve the current confirmed account snapshot');

      fallback = plan('A', { closed: true });
      await page.evaluate(() => window.dispatchEvent(new Event('re-fetch-state')));
      await settled(page, 'PRIVATE_A', 'ended');
      assert.equal((await view(page)).blocked, true);
      assert.deepEqual((await view(page)).titles, ['HISTORY_A']);
      await page.getByRole('button', { name: 'Capture callback', exact: true }).click();
      const deniedB = plan('B', { held: true, code: 403 }); queued.push(deniedB); releases.push(deniedB.release);
      fallback = plan('B', { code: 403 });
      await page.getByRole('button', { name: 'Account B', exact: true }).click();
      await deniedB.begun.promise;
      state = await view(page);
      assert.equal(state.loading, true);
      assert.deepEqual(state.titles, []);
      assert.equal(state.name.includes('PRIVATE_A'), false);
      pass('a private closed recap is cleared on the same-room account change');
      deniedB.release.resolve();
      await page.waitForFunction(() => {
        const state = JSON.parse(document.querySelector('[data-testid="scope-state"]').textContent);
        return !state.loading && state.lookup === 'missing';
      });
      await page.getByRole('button', { name: 'Apply A callback', exact: true }).click();
      await flush(page);
      state = await view(page);
      assert.equal(state.blocked, true);
      assert.deepEqual(state.titles, []);
      assert.equal(/PRIVATE_A|STALE_A/.test(state.name), false);
      pass('denied access cannot be repopulated by an earlier recap callback');
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(unexpected, []);
    } finally {
      releases.forEach(release => release.resolve());
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await vite?.close();
}
assert.equal(results.length, 18);
console.log(`ROOM_ACCOUNT_SCOPE_SUMMARY ${JSON.stringify({ passed: results.length, failed: 0, limits: 'Actual shared React hook in Chromium; synthetic loopback reads and account context, not a real authentication or provider test.' })}`);
