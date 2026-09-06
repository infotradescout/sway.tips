import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = join('artifacts', 'readiness-223', `room-restart-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const results = [];
let vite;
let browser;
const snapshot = status => ({
  activeGigId: 'restart-fixture', room_lookup: 'active',
  session: {
    status, talentName: '@restart-fixture', talentRole: 'Performer',
    paymentsEnabled: false, tipsEnabled: false, requestsOpen: false,
    settlementMode: 'unavailable', paymentEnvironment: 'unavailable',
    startedAt: '2026-09-05T22:00:00.000Z', closedAt: status === 'closed' ? '2026-09-06T00:00:00.000Z' : null,
    feeType: 'patron', minimumTip: 5, searchScope: 'catalog',
    totals: { totalTips: 0, accumulatedFees: 0, totalCount: 0, topRequest: 'None yet' }
  }, requests: [], performers: []
});
const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const view = async page => JSON.parse(await page.getByTestId('restart-state').textContent());
const waitStatus = (page, status) => page.waitForFunction(expected => {
  const text = document.querySelector('[data-testid="restart-state"]')?.textContent;
  return text && JSON.parse(text).status === expected;
}, status);

try {
  vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  console.log(`ROOM_RESTART_BROWSER Chromium ${browser.version()}`);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1366, height: 768 }]) {
    const name = `closed-room-restart-${viewport.width}x${viewport.height}`;
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    const unexpected = [];
    const starts = [];
    let phase = 'active';
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== base) return route.abort('blockedbyclient');
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/state/restart-fixture') {
        return phase === 'offline' ? respond(route, { error: 'Synthetic outage' }, 503) : respond(route, snapshot(phase));
      }
      if (url.pathname === '/api/payment/config') return respond(route, { mode: 'unavailable', liveRoomMoneyEnabled: false, testModePlatformBalanceEnabled: false });
      if (url.pathname === '/api/session/start' && request.method() === 'POST') {
        const data = request.postDataJSON();
        starts.push(data);
        if (starts.length === 1) return respond(route, { error: 'Synthetic start rejected. Retry this same room.' }, 503);
        return respond(route, { state: { ...snapshot('active'), activeGigId: data.gig_id } });
      }
      unexpected.push(`${request.method()} ${url.pathname}`);
      return respond(route, { error: 'Unexpected fixture endpoint' }, 500);
    });
    try {
      await page.goto(`${base}/scripts/browser-fixtures/sway-room-restart.html`, { waitUntil: 'domcontentloaded' });
      await waitStatus(page, 'active');
      phase = 'closed';
      await page.getByRole('button', { name: 'Confirm fixture closeout', exact: true }).click();
      await waitStatus(page, 'ended');
      const closed = await view(page);
      assert.equal(closed.closed, true);
      assert.equal(closed.oldRoomBlocked, true, 'Closed-room live actions remain locked');
      assert.equal(closed.restartBlocked, false, 'Confirmed closeout must allow a different room to be prepared');
      const restart = page.getByRole('button', { name: 'Start New Room', exact: true });
      await restart.click();
      const setup = page.locator('[data-sway-performer-room-setup="true"]');
      await setup.waitFor({ state: 'visible' });
      assert.equal(starts.length, 0, 'Opening setup must not create any room');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-sway-room-restart')), 'true');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await page.getByRole('button', { name: /^Open requests/ }).click();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await setup.getByText('@restart-fixture', { exact: true }).waitFor({ state: 'visible' });
      const review = await setup.innerText();
      await page.getByRole('button', { name: 'Back to night recap', exact: true }).click();
      await restart.waitFor({ state: 'visible' });
      await restart.click();
      assert.equal(await setup.innerText(), review, 'Returning to recap must preserve reviewed setup');

      phase = 'offline';
      await page.evaluate(() => window.dispatchEvent(new Event('re-fetch-state')));
      await waitStatus(page, 'error');
      assert.equal((await view(page)).restartBlocked, true);
      assert.equal(await page.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
      assert.equal(starts.length, 0);
      phase = 'closed';
      await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
      await page.waitForFunction(() => {
        const text = document.querySelector('[data-testid="restart-state"]')?.textContent;
        return text && !JSON.parse(text).restartBlocked;
      });
      assert.equal(await setup.innerText(), review, 'Reconnection must not reset setup');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      const create = page.getByRole('button', { name: 'Create room', exact: true });
      await create.click();
      await setup.getByRole('alert').filter({ hasText: 'Synthetic start rejected' }).waitFor({ state: 'visible' });
      assert.equal(starts.length, 1);
      assert.equal(starts[0].talentName, '@restart-fixture');
      assert.equal(starts[0].talentRole, 'Performer');
      assert.equal(starts[0].paymentsEnabled, false);
      assert.equal(starts[0].searchScope, 'catalog');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Setup must not overflow horizontally');
      await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
      await create.click();
      await page.getByRole('heading', { name: 'New room confirmed', exact: true }).waitFor({ state: 'visible' });
      assert.equal(starts.length, 2);
      assert.deepEqual(starts[1], starts[0], 'Explicit retry must reuse exactly the same room id and reviewed settings');
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
      results.push({ name, status: 'PASS' });
    } catch (error) {
      results.push({ name, status: 'FAIL', error: String(error), pageErrors: errors, unexpected });
      await page.screenshot({ path: join(directory, `${name}-failure.png`), fullPage: true }).catch(() => undefined);
    } finally {
      await context.close();
    }
    console.log('ROOM_RESTART_BROWSER_RESULT', JSON.stringify(results.at(-1)));
  }
} finally {
  await browser?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
  const hashes = Object.fromEntries(['src/components/PerformerRoomRestart.tsx', 'src/components/PerformerRoomSetup.tsx', 'src/components/VictoryScreen.tsx', 'src/shells/shared.tsx', 'src/shells/TalentApp.tsx'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ hashes, limits: 'Real Chromium with actual recap, setup and shared room hook. Synthetic local HTTP and a focused integration harness, not the full signed-in application, database persistence, payments or production.', results }, null, 2));
}
assert.equal(results.length, 3);
assert.equal(results.filter(result => result.status !== 'PASS').length, 0, 'Room-restart browser failures');
console.log(`ROOM_RESTART_BROWSER_TOTAL ${results.length} PASS ${results.length} FAIL 0`);
