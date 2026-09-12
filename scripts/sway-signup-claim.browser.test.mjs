import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const vite = await createServer({
  root: process.cwd(), logLevel: 'error',
  cacheDir: path.resolve('node_modules/.vite-signup-claim'),
  server: { host: '127.0.0.1', port: 0, watch: null }
});
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.SWAY_BROWSER_EXECUTABLE ? { executablePath: process.env.SWAY_BROWSER_EXECUTABLE } : {}),
  ...(process.env.SWAY_BROWSER_ARGS ? { args: JSON.parse(process.env.SWAY_BROWSER_ARGS) } : {})
});
const results = [];
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function test(name, run) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(60000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try { await run(page, context); assert.deepEqual(pageErrors, []); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.message }); }
  finally { await context.close(); console.log(results.at(-1)); }
}

async function open(page, context) {
  const lookups = [];
  const signups = [];
  await context.route('**/api/account/claim/peek', route => { lookups.push(route); });
  await context.route('**/api/account/signup', route => { signups.push(route.request().postDataJSON()); return json(route, { message: 'Synthetic signup accepted' }); });
  await page.goto(`${base}/scripts/browser-fixtures/sway-signup-claim.html`);
  const field = page.getByRole('textbox', { name: 'Claim code (optional)', exact: true });
  await field.waitFor();
  return { field, lookups, signups };
}

async function lookup(page, field, value, lookups) {
  const count = lookups.length;
  await field.fill(value);
  await field.press('Tab');
  await page.waitForFunction(() => document.querySelector('[name="claimCode"]').getAttribute('aria-busy') === 'true');
  const deadline = Date.now() + 5000;
  while (lookups.length === count && Date.now() < deadline) await page.waitForTimeout(10);
  assert.equal(lookups.length, count + 1);
  return lookups.at(-1);
}

try {
  for (const replacement of ['', 'second-code']) for (const status of [200, 400]) {
    await test(`edited-code-ignores-${status}-${replacement || 'cleared'}`, async (page, context) => {
      const { field, lookups } = await open(page, context);
      const old = await lookup(page, field, 'first-code', lookups);
      await field.fill(replacement);
      await json(old, status === 200 ? { displayName: 'Previous Performer' } : { error: 'Previous code rejected' }, status);
      await page.waitForTimeout(150);
      assert.equal(await field.inputValue(), replacement);
      assert.equal(await page.getByText(/Previous Performer|Previous code rejected/).count(), 0, 'An old lookup must not describe the edited code');
      assert.equal(await field.getAttribute('aria-busy'), 'false', 'Editing ends the old loading state');
    });
  }

  await test('newer-code-wins-out-of-order-lookups', async (page, context) => {
    const { field, lookups } = await open(page, context);
    const old = await lookup(page, field, 'first-code', lookups);
    const current = await lookup(page, field, 'second-code', lookups);
    await json(current, { displayName: 'Current Performer' });
    await page.getByText('Performer profile found: Current Performer', { exact: true }).waitFor();
    await json(old, { displayName: 'Previous Performer' });
    await page.waitForTimeout(150);
    assert.equal(await page.getByText('Performer profile found: Current Performer', { exact: true }).count(), 1);
    assert.equal(await page.getByText(/Previous Performer/).count(), 0);
  });

  await test('submit-checks-current-code-once', async (page, context) => {
    const { field, lookups, signups } = await open(page, context);
    await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Synthetic Account');
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('synthetic@example.test');
    await page.getByLabel('Password', { exact: true }).fill('Synthetic123');
    await page.getByLabel('Confirm password', { exact: true }).fill('Synthetic123');
    await page.getByRole('checkbox').check();
    // Submit by Enter without blurring the claim field first.
    await field.fill('current-code');
    await field.press('Enter');
    await page.waitForTimeout(150);
    assert.equal(lookups.length, 1);
    await json(lookups[0], { displayName: 'Current Performer' });
    await page.waitForTimeout(150);
    assert.equal(lookups.length, 1, 'Submit must not issue a second redundant lookup');
    await page.getByText('Synthetic signup accepted', { exact: true }).waitFor();
    assert.equal(signups.length, 1);
    assert.equal(signups[0].claimCode, 'current-code');
  });
} finally {
  await browser.close();
  await vite.close();
}
console.log(`Signup claim browser: ${results.filter(result => result.status === 'PASS').length}/${results.length} passed. Actual React; synthetic API responses only.`);
process.exitCode = results.some(result => result.status === 'FAIL') ? 1 : 0;
