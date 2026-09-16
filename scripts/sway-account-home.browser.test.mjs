import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const vite = await createServer({ root: process.cwd(), publicDir: 'public', logLevel: 'error',
  cacheDir: path.resolve('node_modules/.vite-account-home'), server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.SWAY_BROWSER_EXECUTABLE ? { executablePath: process.env.SWAY_BROWSER_EXECUTABLE } : {}),
  ...(process.env.SWAY_BROWSER_ARGS ? { args: JSON.parse(process.env.SWAY_BROWSER_ARGS) } : {}) });
const results = [];
const artifactDir = path.resolve('artifacts/account-home-browser');
mkdirSync(artifactDir, { recursive: true });
const account = { account: { id: 'synthetic-account', displayName: 'Synthetic Account', email: 'synthetic@example.test',
  emailVerifiedAt: '2026-01-01T00:00:00Z', proModeStatus: 'disabled' }, performer: null, pendingRightsReviewCount: 0 };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function test(name, width, run) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.route('**/api/account/affiliate', route => json(route, { enrolled: true, rateBps: 500, tier: 'standard', shareUrl: '', profileShareUrl: null, referralCount: 0, commissions: [], payoutMessage: '' }));
  const page = await context.newPage();
  page.setDefaultTimeout(3500);
  page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await run(page, context);
    assert.deepEqual(errors, [], 'No uncaught application errors');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    results.push({ name, width, passed: true });
  } catch (error) { results.push({ name, width, passed: false, error: error.message }); }
  finally { await context.close(); console.log('ACCOUNT_HOME_CASE ' + JSON.stringify(results.at(-1))); }
}
const open = (page, search = '') => page.goto(`${base}/scripts/browser-fixtures/sway-account-home.html${search}`);

try {
  for (const width of [390, 1440]) {
    await test('failed-session-hides-account-actions-and-retries', width, async (page, context) => {
      let reads = 0;
      await context.route('**/api/account/session', route => ++reads === 1 ? json(route, { error: 'Account temporarily unavailable' }, 503) : json(route, account));
      await open(page);
      await page.getByText('Account temporarily unavailable', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Activate Pro Mode', exact: true }).count(), 0, 'Unknown session must not offer activation');
      assert.equal(await page.getByRole('button', { name: 'Log out', exact: true }).count(), 0, 'Unknown session must not offer private account actions');
      await page.screenshot({ path: path.join(artifactDir, `account-load-recovery-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Retry loading account', exact: true }).click();
      await page.getByRole('heading', { name: 'Synthetic Account', exact: true }).waitFor();
      assert.equal(reads, 2);
    });
    await test('malformed-session-is-recoverable', width, async (page, context) => {
      await context.route('**/api/account/session', route => json(route, {}));
      await open(page);
      await page.getByRole('button', { name: 'Retry loading account', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Activate Pro Mode', exact: true }).count(), 0);
    });
    await test('nullable-account-name-and-email-still-load', width, async (page, context) => {
      await context.route('**/api/account/session', route => json(route, { ...account, account: { ...account.account, displayName: null, email: null } }));
      await open(page);
      await page.getByRole('heading', { name: 'Account', exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Performer name' }).inputValue(), '');
      assert.equal(await page.getByRole('button', { name: 'Activate Pro Mode', exact: true }).isEnabled(), true);
    });
    await test('malformed-display-value-recovers-without-crashing', width, async (page, context) => {
      await context.route('**/api/account/session', route => json(route, { ...account, account: { ...account.account, email: { malformed: true } } }));
      await open(page);
      await page.getByRole('button', { name: 'Retry loading account', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Activate Pro Mode', exact: true }).count(), 0);
    });
    await test('session-timeout-retry-ignores-late-identity', width, async (page, context) => {
      await page.clock.install();
      let oldRoute;
      let reads = 0;
      let started;
      const requestStarted = new Promise(resolve => { started = resolve; });
      await context.route('**/api/account/session', route => {
        if (++reads === 1) { oldRoute = route; started(); return; }
        return json(route, account);
      });
      await open(page); await requestStarted;
      await page.clock.fastForward(15_001);
      await page.getByText('Your account is taking too long to load. Try again.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Retry loading account' }).click();
      await page.getByRole('heading', { name: 'Synthetic Account', exact: true }).waitFor();
      await json(oldRoute, { ...account, account: { ...account.account, displayName: 'Old identity' } });
      await page.waitForTimeout(50);
      assert.equal(reads, 2);
      assert.equal(await page.getByText('Old identity', { exact: true }).count(), 0);
    });
    await test('strict-mode-session-remains-usable', width, async (page, context) => {
      await context.route('**/api/account/session', route => json(route, account));
      await open(page, '?strict=1');
      await page.getByRole('heading', { name: 'Synthetic Account', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Log out', exact: true }).isEnabled(), true);
    });
    await test('expired-session-retains-claim-and-performer-intent-at-login', width, async (page, context) => {
      await context.route('**/api/account/session', route => json(route, { error: 'Session expired' }, 401));
      await context.route('**/account/login?*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Login destination</h1>' }));
      await open(page, '?claim=synthetic-code&intent=performer');
      await page.getByRole('heading', { name: 'Login destination' }).waitFor();
      const destination = new URL(page.url());
      assert.equal(destination.searchParams.get('claim'), 'synthetic-code');
      assert.equal(destination.searchParams.get('next'), '/account?intent=performer');
    });
    await test('claim-attach-error-is-visible-and-retryable', width, async (page, context) => {
      await context.route('**/api/account/session', route => json(route, account));
      await context.route('**/api/account/claim/peek', route => json(route, { displayName: 'Synthetic Performer', handle: 'synthetic-performer' }));
      let claims = 0;
      await context.route('**/api/account/claim/attach', route => { claims++; return json(route, { error: 'Claim could not be confirmed' }, 503); });
      await open(page, '?claim=synthetic-code');
      const button = page.getByRole('button', { name: 'Claim profile on this account', exact: true });
      await button.click();
      await page.getByText('Claim could not be confirmed', { exact: true }).waitFor();
      assert.equal(claims, 1, 'Claim failures never automatically repeat writes');
      assert.equal(await button.isEnabled(), true);
      await page.screenshot({ path: path.join(artifactDir, `claim-recovery-${width}.png`), fullPage: true });
    });
    await test('claim-preview-failure-has-an-explicit-read-retry', width, async (page, context) => {
      await context.route('**/api/account/session', route => json(route, account));
      let reads = 0;
      await context.route('**/api/account/claim/peek', route => ++reads === 1 ? json(route, { error: 'Claim lookup unavailable' }, 503) : json(route, { displayName: 'Synthetic Performer', handle: 'synthetic-performer' }));
      await open(page, '?claim=synthetic-code');
      await page.getByText('Claim lookup unavailable', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Retry claim check', exact: true }).click();
      const button = page.getByRole('button', { name: 'Claim profile on this account', exact: true });
      await button.waitFor();
      assert.equal(await button.isEnabled(), true);
      assert.equal(reads, 2);
    });
    await test('claim-preview-deadline-allows-a-fresh-read', width, async (page, context) => {
      await page.clock.install();
      await context.route('**/api/account/session', route => json(route, account));
      let oldRoute;
      let reads = 0;
      let started;
      const requestStarted = new Promise(resolve => { started = resolve; });
      await context.route('**/api/account/claim/peek', route => {
        if (++reads === 1) { oldRoute = route; started(); return; }
        return json(route, { displayName: 'Current Performer', handle: 'current-performer' });
      });
      await open(page, '?claim=synthetic-code'); await requestStarted;
      await page.clock.fastForward(15_001);
      await page.getByText('The claim check is taking too long. Try again.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Retry claim check' }).click();
      await page.getByText('Current Performer', { exact: true }).waitFor();
      await json(oldRoute, { displayName: 'Old Performer', handle: 'old-performer' });
      await page.waitForTimeout(50);
      assert.equal(reads, 2);
      assert.equal(await page.getByText('Old Performer', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Claim profile on this account' }).isEnabled(), true);
    });
    await test('confirmed-claim-with-failed-session-refresh-never-repeats-claim', width, async (page, context) => {
      let reads = 0;
      let claims = 0;
      const claimedAccount = { ...account, performer: { id: 'synthetic-performer', displayName: 'Synthetic Performer', handle: 'synthetic-performer', payoutsEnabled: false } };
      await context.route('**/api/account/session', route => {
        reads++;
        return reads === 2 ? json(route, { error: 'Account refresh unavailable' }, 503) : json(route, reads === 1 ? account : claimedAccount);
      });
      await context.route('**/api/account/claim/peek', route => json(route, { displayName: 'Synthetic Performer', handle: 'synthetic-performer' }));
      await context.route('**/api/account/claim/attach', route => { claims++; return json(route, { message: 'Profile claimed.', redirectPath: '/talent' }); });
      await open(page, '?claim=synthetic-code');
      await page.getByRole('button', { name: 'Claim profile on this account' }).click();
      await page.getByText('Account refresh unavailable', { exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/account', 'A failed session refresh cannot authorize navigation');
      assert.equal(new URL(page.url()).search, '', 'The confirmed claim token is removed');
      await page.getByRole('button', { name: 'Retry loading account' }).click();
      await page.getByRole('link', { name: 'Open performer console' }).waitFor();
      assert.equal(claims, 1, 'Read recovery cannot resend a confirmed claim');
      assert.equal(reads, 3);
      assert.equal(await page.getByRole('button', { name: 'Claim profile on this account' }).count(), 0);
    });
    await test('confirmed-claim-refreshes-before-opening-console', width, async (page, context) => {
      let reads = 0;
      await context.route('**/api/account/session', route => { reads++; return json(route, account); });
      await context.route('**/api/account/claim/peek', route => json(route, { displayName: 'Synthetic Performer', handle: 'synthetic-performer' }));
      await context.route('**/api/account/claim/attach', route => json(route, { message: 'Profile claimed.', redirectPath: '/talent' }));
      await context.route('**/talent', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Performer destination</h1>' }));
      await open(page, '?claim=synthetic-code');
      await page.getByRole('button', { name: 'Claim profile on this account' }).click();
      await page.getByRole('heading', { name: 'Performer destination' }).waitFor();
      assert.equal(reads, 2, 'Successful attach is followed by a fresh account read');
    });
    await test('forbidden-account-mutation-clears-private-view', width, async (page, context) => {
      await context.route('**/api/account/session', route => json(route, account));
      await context.route('**/api/account/pro-mode/activate', route => json(route, { error: 'Account access no longer available' }, 403));
      await open(page);
      await page.getByRole('textbox', { name: 'Public handle' }).fill('synthetic-artist');
      await page.getByRole('button', { name: 'Activate Pro Mode', exact: true }).click();
      await page.getByRole('alert').getByText('Account access no longer available', { exact: true }).waitFor();
      assert.equal(await page.getByText('synthetic@example.test', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Activate Pro Mode', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Log out', exact: true }).count(), 0);
    });
    await test('logout-prevents-competing-claim-and-activation', width, async (page, context) => {
      const writes = [];
      let logoutRoute;
      let started;
      const requestStarted = new Promise(resolve => { started = resolve; });
      await context.route('**/api/account/session', route => json(route, account));
      await context.route('**/api/account/claim/peek', route => json(route, { displayName: 'Synthetic Performer', handle: 'synthetic-performer' }));
      await context.route('**/api/account/claim/attach', route => { writes.push('claim'); return json(route, {}); });
      await context.route('**/api/account/pro-mode/activate', route => { writes.push('activate'); return json(route, {}); });
      await context.route('**/api/account/logout', route => { writes.push('logout'); logoutRoute = route; started(); });
      await open(page, '?claim=synthetic-code');
      await page.getByRole('button', { name: 'Claim profile on this account' }).waitFor();
      await page.getByRole('button', { name: 'Log out', exact: true }).click(); await requestStarted;
      assert.equal(await page.getByRole('button', { name: 'Claim profile on this account' }).isEnabled(), false);
      assert.equal(await page.getByRole('button', { name: 'Activate Pro Mode', exact: true }).isEnabled(), false);
      await page.locator('form').dispatchEvent('submit');
      await page.getByRole('button', { name: 'Log out', exact: true }).dispatchEvent('click');
      await json(logoutRoute, { error: 'Sign out temporarily unavailable' }, 503);
      await page.getByText('Sign out temporarily unavailable', { exact: true }).waitFor();
      assert.deepEqual(writes, ['logout']);
    });
    for (const action of ['logout', 'activate']) await test(`unmounted-${action}-cannot-navigate`, width, async (page, context) => {
      let pendingRoute;
      let started;
      const requestStarted = new Promise(resolve => { started = resolve; });
      await context.route('**/api/account/session', route => json(route, account));
      await context.route(action === 'logout' ? '**/api/account/logout' : '**/api/account/pro-mode/activate', route => { pendingRoute = route; started(); });
      await open(page);
      if (action === 'activate') await page.getByRole('textbox', { name: 'Public handle' }).fill('synthetic-artist');
      await page.getByRole('button', { name: action === 'logout' ? 'Log out' : 'Activate Pro Mode', exact: true }).click(); await requestStarted;
      const currentUrl = page.url();
      await page.evaluate(() => window.unmountAccountHomeProof());
      await json(pendingRoute, { redirectPath: '/talent' });
      await page.waitForTimeout(50);
      assert.equal(page.url(), currentUrl, 'A response from an abandoned account view cannot redirect the next view');
      assert.equal(await page.locator('#root').textContent(), '');
    });
    await test('logout-failure-is-visible-and-can-retry', width, async (page, context) => {
      await context.route('**/api/account/session', route => json(route, account));
      let writes = 0;
      await context.route('**/api/account/logout', route => { writes++; return json(route, { error: 'Sign out temporarily unavailable' }, 503); });
      await open(page);
      await page.getByRole('button', { name: 'Log out', exact: true }).click();
      await page.getByText('Sign out temporarily unavailable', { exact: true }).waitFor();
      assert.equal(writes, 1);
      await page.getByRole('button', { name: 'Log out', exact: true }).click();
      await page.waitForTimeout(100);
      assert.equal(writes, 2);
    });
  }
} finally {
  await browser.close(); await vite.close();
  writeFileSync(path.join(artifactDir, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(`ACCOUNT_HOME_SUMMARY ${results.filter(r => r.passed).length}/${results.length} passed; actual Chromium/React, synthetic HTTP only.`);
process.exitCode = results.some(r => !r.passed) ? 1 : 0;
