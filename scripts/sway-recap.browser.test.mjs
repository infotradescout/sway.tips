import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = join('artifacts', 'readiness-223', `recap-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const results = [];
let vite;
let browser;
let base;
async function run(viewport, name, query, verify) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  const apiRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    if (url.pathname.startsWith('/api/')) {
      apiRequests.push(`${route.request().method()} ${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    window.__recapWrites = [];
    window.__shareCalls = [];
    window.__rejectClipboard = false;
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async text => {
        window.__recapWrites.push(text);
        if (window.__rejectClipboard) throw new DOMException('Fixture clipboard blocked', 'NotAllowedError');
      }
    } });
  });
  const caseName = `${name}-${viewport.width}x${viewport.height}`;
  try {
    await page.goto(`${base}/scripts/browser-fixtures/sway-recap.html?${query}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Night recap', exact: true }).waitFor();
    await verify(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'The actual recap must not overflow horizontally.');
    assert.deepEqual(apiRequests, [], 'Viewing, searching and sharing a recap must not mutate or fetch account/payment data.');
    assert.deepEqual(errors, []);
    if (name === 'money-and-history') await page.screenshot({ path: join(directory, `${caseName}.png`), fullPage: false });
    results.push({ name: caseName, status: 'PASS' });
  } catch (error) {
    results.push({ name: caseName, status: 'FAIL', error: String(error), errors, apiRequests });
    await page.screenshot({ path: join(directory, `${caseName}-failure.png`), fullPage: true }).catch(() => undefined);
  } finally { await context.close(); }
  console.log('RECAP_BROWSER_RESULT', JSON.stringify(results.at(-1)));
}
try {
  vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  console.log(`RECAP_BROWSER Chromium ${browser.version()}`);
  for (const viewport of [{ width: 320, height: 740 }, { width: 844, height: 390 }, { width: 1366, height: 768 }]) {
    await run(viewport, 'money-and-history', 'count=1001', async page => {
      assert.equal(await page.getByTestId('recap-volume').innerText(), '$1,234,567.89');
      assert.equal(await page.getByTestId('recap-fees').innerText(), '$1.25');
      assert.equal(await page.getByTestId('recap-fulfilled').innerText(), '250', 'Fulfilled requests must not be replaced with captured action count 98765.');
      const history = page.locator('[data-sway-recap-history="true"]');
      assert.equal(await history.locator('li').count(), 25);
      assert.equal(await history.getByText('Request 7', { exact: true }).count(), 0);
      assert.equal(await history.getByText('Request 8', { exact: true }).count(), 0);
      await history.getByRole('button', { name: 'Last page', exact: true }).click();
      await history.getByText(/^Final request /).waitFor();
      assert.equal(await history.locator('li').count(), 24);
      await page.getByLabel('Search request history', { exact: true }).fill('Final request');
      assert.equal(await history.locator('li').count(), 1);
      await page.getByLabel('Request status', { exact: true }).selectOption('hold');
      await history.getByText('No matching requests or tips.', { exact: true }).waitFor();
      await page.getByLabel('Request status', { exact: true }).selectOption('fulfilled');
      assert.equal(await history.locator('li').count(), 1);
      await history.getByText(/^Final request /).waitFor();
      await page.getByRole('button', { name: 'Midnight', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Midnight', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByTestId('fixture-starts').textContent(), '0');
      await page.getByRole('button', { name: 'Start New Room', exact: true }).click();
      assert.equal(await page.getByTestId('fixture-starts').textContent(), '1');
    });
    await run(viewport, 'clipboard-success', 'count=2', async page => {
      await page.getByRole('button', { name: 'Share recap text', exact: true }).click();
      await page.getByText('Recap text copied.', { exact: true }).waitFor();
      const writes = await page.evaluate(() => window.__recapWrites);
      assert.equal(writes.length, 1);
      assert.match(writes[0], /\$1,234,567\.89 in captured room payments/);
      assert.doesNotMatch(writes[0], /PRIVATE_|Artist|Request 0|@fixture/);
      assert.equal(await page.getByText('Share Recap to Instagram & TikTok Stories', { exact: true }).count(), 0);
    });
    await run(viewport, 'clipboard-failure-retry', 'count=2', async page => {
      await page.evaluate(() => { window.__rejectClipboard = true; });
      const share = page.getByRole('button', { name: 'Share recap text', exact: true });
      await share.click();
      await page.getByRole('alert').waitFor();
      assert.match(await page.getByLabel('Recap text', { exact: true }).inputValue(), /captured room payments/);
      assert.equal(await page.getByText('Recap text copied.', { exact: true }).count(), 0);
      await page.waitForTimeout(2600);
      assert.equal(await page.getByRole('alert').isVisible(), true, 'Recovery must not disappear before the user can read or copy it.');
      await page.evaluate(() => { window.__rejectClipboard = false; });
      await share.click();
      await page.getByText('Recap text copied.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
    });
    await run(viewport, 'native-share-cancel', 'count=2', async page => {
      await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
        window.__shareCalls.push(data);
        throw new DOMException('Fixture cancelled', 'AbortError');
      } }));
      const share = page.getByRole('button', { name: 'Share recap text', exact: true });
      await share.click();
      await share.waitFor();
      assert.equal(await share.isEnabled(), true);
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.equal(await page.evaluate(() => window.__recapWrites.length), 0, 'Cancelling native sharing must not silently copy or post.');
    });
    await run(viewport, 'native-pending-room-switch', 'count=1001', async page => {
      await page.getByLabel('Search request history', { exact: true }).fill('Final request');
      await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: data => {
        window.__shareCalls.push(data);
        return new Promise(resolve => { window.__resolveShare = resolve; });
      } }));
      await page.getByRole('button', { name: 'Share recap text', exact: true }).evaluate(button => { button.click(); button.click(); });
      await page.getByRole('button', { name: 'Sharing recap…', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__shareCalls.length), 1);
      await page.getByRole('button', { name: 'Switch fixture night', exact: true }).click();
      assert.equal(await page.getByLabel('Search request history', { exact: true }).inputValue(), '');
      await page.evaluate(() => window.__resolveShare());
      assert.equal(await page.getByText('Recap sent to your sharing app.', { exact: true }).count(), 0, 'An old night cannot update a new recap after sharing completes.');
      assert.equal(await page.getByRole('list', { name: 'Saved room requests', exact: true }).locator('li').count(), 0);
    });
    for (const mode of ['test', 'conflict', 'unavailable', 'invalid']) {
      await run(viewport, `sharing-blocked-${mode}`, `mode=${mode}&count=3`, async page => {
        const share = page.getByRole('button', { name: 'Share recap text', exact: true });
        assert.equal(await share.isDisabled(), true);
        if (mode === 'test' || mode === 'conflict') await page.locator('[data-sway-test-volume="true"]').waitFor();
        if (mode === 'invalid') assert.equal(await page.getByTestId('recap-volume').innerText(), 'Unavailable');
        if (mode === 'unavailable') {
          await page.getByText('Some payments are not confirmed as captured', { exact: true }).waitFor();
          assert.equal(await page.getByText("Payments weren't connected this session", { exact: true }).count(), 0);
        }
        assert.equal(await page.evaluate(() => window.__recapWrites.length + window.__shareCalls.length), 0);
      });
    }
  }
} finally {
  await browser?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
  const hashes = Object.fromEntries(['src/components/VictoryScreen.tsx', 'src/recap-display.ts'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ hashes, limits: 'Actual recap component and stylesheet in Chromium; synthetic records and controlled sharing APIs. Not a signed-in journey, real social post, customer account, or money transaction.', results }, null, 2));
}
assert.equal(results.length, 27);
assert.equal(results.filter(result => result.status !== 'PASS').length, 0, 'Recap browser failures');
console.log(`RECAP_BROWSER_TOTAL ${results.length} PASS ${results.length} FAIL 0`);
