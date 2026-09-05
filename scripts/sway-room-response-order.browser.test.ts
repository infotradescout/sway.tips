import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

const scenarios = ['newer-read', '401', '403', '404', '410', '503', 'offline',
  'closed-current', 'wrong-room-pending', 'same-room-current',
  'access-headers-before-body', 'expired-body-response', 'recovered-before-old-action'] as const;
type Scenario = typeof scenarios[number];

const snapshot = (title = 'old', room = 'room-A', status = 'active') => ({
  activeGigId: room, room_lookup: 'active',
  session: { status, talentName: 'Synthetic test', paymentsEnabled: false, requestsOpen: true, totals: {} },
  requests: [{ id: 'synthetic-request', title, status: 'approved' }], performers: []
});
const read = async (page: Page) => JSON.parse((await page.getByTestId('response-view').textContent()) || '{}');
const apply = (page: Page, state: ReturnType<typeof snapshot>, delayed = true) => page.evaluate(
  detail => window.dispatchEvent(new CustomEvent('sway:test:response', { detail })), { state, delayed }
);
const refresh = (page: Page) => page.getByRole('button', { name: 'Refresh', exact: true }).click();
const respond = (route: Route, body: unknown, status = 200) => route.fulfill({
  status, contentType: 'application/json', body: JSON.stringify(body)
});

async function reservePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function main() {
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  const results: { scenario: Scenario; status: 'PASS' | 'FAIL'; error?: string }[] = [];
  const sourceHash = createHash('sha256').update(readFileSync('src/shells/shared.tsx')).digest('hex');
  const directory = join('artifacts', 'readiness-223', `response-order-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  try {
    const port = await reservePort();
    vite = await createViteServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true } });
    await vite.listen();
    const base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const scenario of scenarios) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(5000);
      page.setDefaultNavigationTimeout(30000);
      let phase: Scenario | 'initial' = 'initial';
      const held: Route[] = [];
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        if (url.pathname !== '/api/state/room-A') throw new Error(`Unexpected API call: ${url.pathname}`);
        if (phase === 'initial') return respond(route, snapshot());
        if (phase === 'newer-read') return respond(route, snapshot('new'));
        if (phase === 'offline') return route.abort('failed');
        if (/^\d+$/.test(phase)) return respond(route, { error: 'Synthetic failure', room_lookup: phase === '410' ? 'ended' : 'missing' }, Number(phase));
        if (phase === 'wrong-room-pending') { held.push(route); return; }
        return respond(route, snapshot('new'));
      });
      try {
        await page.goto(`${base}/scripts/browser-fixtures/sway-room-response-order.html`);
        await page.waitForFunction(() => document.querySelector('[data-testid="response-view"]')?.textContent?.includes('"shown":"room-A"'));
        await page.getByRole('button', { name: 'Start delayed action', exact: true }).click();
        if (scenario === 'access-headers-before-body' || scenario === 'expired-body-response') {
          await page.clock.install();
          await page.evaluate(kind => {
            // Deliberately ignore abort in the body: acceptance must also reject an expired reply.
            window.fetch = async () => ({
              ok: kind !== 'access-headers-before-body', status: kind === 'access-headers-before-body' ? 403 : 200,
              headers: new Headers(), json: () => new Promise(resolve => {
                const receive = (event: Event) => resolve((event as CustomEvent).detail);
                window.addEventListener('sway:test:body', receive, { once: true });
              })
            } as Response);
            window.dispatchEvent(new Event('re-fetch-state'));
          }, scenario);
          await page.waitForTimeout(100);
          if (scenario === 'expired-body-response') {
            await page.clock.fastForward(15001);
            assert.equal((await read(page)).status, 'error');
            await page.evaluate(data => window.dispatchEvent(new CustomEvent('sway:test:body', { detail: data })), snapshot('expired'));
            await page.waitForTimeout(100);
            assert.equal((await read(page)).status, 'error', 'A late body must not revive a timed-out response');
          } else assert.equal((await read(page)).shown, null, 'Access loss clears before the body finishes');
          assert.equal((await read(page)).blocked, true);
        } else if (scenario === 'recovered-before-old-action') {
          phase = '503'; await refresh(page);
          await page.waitForFunction(() => document.querySelector('[data-testid="response-view"]')?.textContent?.includes('"status":"error"'));
          phase = 'newer-read'; await refresh(page);
          await page.waitForFunction(() => document.querySelector('[data-testid="response-view"]')?.textContent?.includes('"title":"new"'));
          await apply(page, snapshot('old')); await page.waitForTimeout(100);
          assert.equal((await read(page)).title, 'new', 'Recovered state outranks an earlier action response');
        } else if (scenario === 'closed-current' || scenario === 'same-room-current') {
          await apply(page, snapshot('confirmed', 'room-A', scenario === 'closed-current' ? 'closed' : 'active'));
          await page.waitForTimeout(100);
          assert.equal((await read(page)).title, 'confirmed', 'A current confirmed action remains usable');
          assert.equal((await read(page)).blocked, scenario === 'closed-current', 'Closed-room data cannot enable live actions');
        } else if (scenario === 'wrong-room-pending') {
          phase = scenario; await refresh(page); await page.waitForTimeout(100);
          assert.ok(held.length, 'Expected an outstanding read for the selected room');
          await apply(page, snapshot('wrong', 'room-B'), false);
          await respond(held[0], snapshot('new')).catch(() => undefined);
          await page.waitForTimeout(100);
          assert.equal((await read(page)).title, 'new', 'Wrong-room data must not abort the valid outstanding read');
        } else {
          phase = scenario; await refresh(page);
          const expected = scenario === 'newer-read' ? 'active' : scenario === 'offline' || scenario === '503' ? 'error' : scenario === '410' ? 'ended' : 'missing';
          await page.waitForFunction(expected => JSON.parse(document.querySelector('[data-testid="response-view"]')!.textContent!).status === expected, expected);
          if (scenario === 'newer-read') await page.waitForFunction(() => document.querySelector('[data-testid="response-view"]')?.textContent?.includes('"title":"new"'));
          await apply(page, snapshot('old')); await page.waitForTimeout(100);
          const actual = await read(page);
          if (scenario === 'newer-read') assert.equal(actual.title, 'new', 'A newer read outranks an old action snapshot');
          else {
            assert.equal(actual.status, expected, 'A late action cannot change the newer availability decision');
            assert.equal(actual.blocked, true, 'A late action cannot re-enable room controls');
            if (!['503', 'offline'].includes(scenario)) assert.equal(actual.shown, null, 'Private queue stays cleared');
          }
        }
        assert.deepEqual(errors, []);
        results.push({ scenario, status: 'PASS' });
      } catch (error) {
        results.push({ scenario, status: 'FAIL', error: error instanceof Error ? error.message : String(error) });
        await page.screenshot({ path: join(directory, `${scenario}.png`), fullPage: true }).catch(() => undefined);
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await vite?.close().catch(() => undefined);
    writeFileSync(join(directory, 'results.json'), JSON.stringify({ sourceHash, limits: 'Synthetic API responses; not backend, provider, or production proof.', results }, null, 2));
  }
  console.log(JSON.stringify(results, null, 2));
  assert.equal(results.length, scenarios.length, 'Every response-order scenario must run');
  assert.equal(results.filter(result => result.status === 'FAIL').length, 0, 'Response-order browser failures');
  console.log(`Room response-order browser checks passed (${results.length}).`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
