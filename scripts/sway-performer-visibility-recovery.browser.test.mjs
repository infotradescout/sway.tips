import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = join('artifacts', 'readiness-223', `visibility-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const results = [], regressions = [];
// Use the commit that introduced the original component, not an unrelated
// recovery snapshot where the historical path cannot be resolved. Verify the
// exact original blob before running negative controls; never substitute current code.
const baselineRef = '30356d34315a0dab7900cc204f39c55160f7b1f7';
const baselineBlob = 'f6b5536858b563e30e55f281053bdc4a09196b66';
const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const save = page => page.getByRole('button', { name: 'Save visibility', exact: true });
const check = page => page.getByRole('button', { name: 'Check saved visibility', exact: true });
const radios = page => page.getByRole('radiogroup', { name: 'Performer page visibility' });
const ready = page => page.waitForFunction(() => {
  const radio = document.querySelector('input[name="performer-visibility"]'); return radio && !radio.disabled;
});
const waitFor = async predicate => {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Visibility fixture request did not arrive.');
};
let browser;

async function withServer(baseline, callback) {
  if (baseline) {
    assert.equal(execFileSync('git', ['rev-parse', `${baselineRef}:src/components/PerformerVisibilityControl.tsx`], { encoding: 'utf8' }).trim(), baselineBlob, 'Negative controls require the verified original component.');
  }
  const source = baseline ? execFileSync('git', ['show', `${baselineRef}:src/components/PerformerVisibilityControl.tsx`], { encoding: 'utf8' }) : null;
  const component = resolve('src/components/PerformerVisibilityControl.tsx');
  const vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
    plugins: source ? [{ name: 'visibility-original-source-proof', enforce: 'pre', load(id) { if (id.split('?')[0] === component) return source; } }] : [] });
  try {
    await vite.listen(); const address = vite.httpServer.address(); assert.ok(address && typeof address !== 'string');
    await callback(`http://127.0.0.1:${address.port}`);
  } finally { await vite.close(); }
}

async function run(base, name, viewport, configure, scenario, expectedBaselineFailure = null) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const state = { saved: 'draft', getStatus: 200, getMode: 'normal', postStatus: 200, postMode: 'normal', postBody: null,
    writes: [], reads: 0, held: [], errors: [], unexpected: [] };
  configure(state);
  page.on('pageerror', error => state.errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== base) {
      if (!(url.origin === 'https://fonts.googleapis.com' && request.resourceType() === 'stylesheet')) state.unexpected.push(`${method} ${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (method === 'GET' && url.pathname === '/api/talent/profile/public') {
      state.reads++;
      if (state.getMode === 'hold') { state.held.push(route); return; }
      return respond(route, state.getStatus !== 200 ? { error: 'Unavailable by fixture.' }
        : state.getMode === 'malformed' ? {} : { profile: { visibilityState: state.saved } }, state.getStatus);
    }
    if (method === 'POST' && url.pathname === '/api/talent/profile/visibility') {
      const body = request.postDataJSON(); state.writes.push(body);
      assert.deepEqual(Object.keys(body), ['visibilityState']);
      if (state.postStatus === 200) state.saved = body.visibilityState;
      if (state.postMode === 'hold') { state.held.push(route); return; }
      return respond(route, state.postStatus !== 200 ? { error: 'Visibility rejected by fixture.' }
        : state.postMode === 'malformed' ? {} : state.postBody ?? { visibilityState: state.saved }, state.postStatus);
    }
    state.unexpected.push(`${method} ${url.pathname}`); return respond(route, { error: 'Unexpected request' }, 500);
  });
  let record;
  try {
    await page.goto(`${base}/scripts/browser-fixtures/sway-visibility-recovery.html`, { waitUntil: 'domcontentloaded' });
    await scenario(page, state);
    assert.deepEqual(state.errors, []); assert.deepEqual(state.unexpected, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Visibility recovery must fit the viewport.');
    assert.equal(await page.getByLabel('Surrounding unsaved draft', { exact: true }).inputValue(), 'Keep my other profile edits');
    if (expectedBaselineFailure) assert.fail('The original source did not reproduce the expected safety failure.');
    record = { name, viewport, passed: true, writes: state.writes.length };
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}.png`), fullPage: true });
  } catch (error) {
    const reproduced = expectedBaselineFailure && error instanceof assert.AssertionError && error.message.includes(expectedBaselineFailure);
    record = { name, viewport, passed: Boolean(reproduced), ...(reproduced ? { originalSafetyFailureReproduced: true }
      : { error: String(error), pageErrors: state.errors, unexpected: state.unexpected }) };
    await page.screenshot({ path: join(directory, `${expectedBaselineFailure ? 'baseline-' : ''}${name}-${viewport.width}-failed.png`), fullPage: true }).catch(() => {});
  } finally {
    await context.close(); (expectedBaselineFailure ? regressions : results).push(record);
    console.log(expectedBaselineFailure ? 'VISIBILITY_BASELINE_RESULT' : 'VISIBILITY_BROWSER_RESULT', JSON.stringify(record));
  }
}

const failedReadSettled = page => page.waitForFunction(() => {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Save visibility');
  const status = document.querySelector('[role="status"]')?.textContent ?? '';
  return button && (!button.disabled || status.includes('could not be loaded') || status.includes('Unavailable by fixture.'));
});
const basic = [
  ['failed-read-blocks-publication', state => { state.getStatus = 503; }, async page => {
    await failedReadSettled(page); assert.equal(await save(page).isDisabled(), true, 'Failed read must keep publication disabled');
  }, 'Failed read must keep publication disabled'],
  ['malformed-read-is-not-draft', state => { state.getMode = 'malformed'; }, async page => {
    await failedReadSettled(page); assert.equal(await page.locator('input[name="performer-visibility"]:checked').count(), 0, 'Malformed read must not become Draft');
    assert.equal(await save(page).isDisabled(), true);
  }, 'Malformed read must not become Draft'],
  ['malformed-save-is-not-success', state => { state.postMode = 'malformed'; }, async page => {
    await ready(page); await radios(page).getByRole('radio').nth(2).check(); await save(page).click();
    await page.waitForFunction(() => { const text = document.querySelector('[role="status"]')?.textContent ?? ''; return text.includes('Visibility saved.') || text.includes('could not be confirmed'); });
    assert.equal(await page.getByText('Visibility saved.', { exact: true }).count(), 0, 'Malformed save must not claim success');
    assert.equal(await save(page).isDisabled(), true);
  }, 'Malformed save must not claim success']
];

try {
  browser = await chromium.launch({ headless: true });
  await withServer(true, async base => {
    for (const [name, configure, scenario, expected] of basic) await run(base, name, { width: 390, height: 844 }, configure, scenario, expected);
  });
  await withServer(false, async base => {
    for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1366, height: 768 }]) {
      for (const [name, configure, scenario] of basic) await run(base, name, viewport, configure, scenario);
      await run(base, 'recovery-is-read-only-and-keeps-other-edits', viewport, state => { state.getStatus = 503; state.saved = 'unlisted'; }, async (page, state) => {
        await failedReadSettled(page); state.getStatus = 200; await check(page).click(); await ready(page);
        assert.equal(await radios(page).getByRole('radio').nth(1).isChecked(), true); assert.equal(state.writes.length, 0);
        await radios(page).getByRole('radio').nth(2).check(); await save(page).click(); await page.getByText('Visibility saved.', { exact: true }).waitFor();
        assert.deepEqual(state.writes, [{ visibilityState: 'public' }]); assert.equal(await save(page).isDisabled(), true);
      });
      await run(base, 'duplicate-save-and-lost-acknowledgement', viewport, state => { state.postMode = 'hold'; }, async (page, state) => {
        await ready(page); await radios(page).getByRole('radio').nth(2).check();
        await save(page).evaluate(button => { button.click(); button.click(); }); await waitFor(() => state.writes.length > 0);
        assert.equal(state.writes.length, 1); await page.getByRole('button', { name: 'Stop waiting', exact: true }).click();
        await page.getByRole('status').filter({ hasText: 'may already have been saved' }).waitFor(); assert.equal(await save(page).isDisabled(), true);
        await check(page).click(); await ready(page); assert.equal(await radios(page).getByRole('radio').nth(2).isChecked(), true);
        assert.equal(state.writes.length, 1); await respond(state.held[0], { visibilityState: 'unlisted' }).catch(() => {});
        assert.equal(await page.getByText('Visibility saved.', { exact: true }).count(), 0);
        assert.equal(await radios(page).getByRole('radio').nth(2).isChecked(), true);
      });
      await run(base, 'publication-deadline-leaves-reachable-recovery', viewport, state => { state.postMode = 'hold'; }, async (page, state) => {
        await ready(page); await page.clock.install(); await radios(page).getByRole('radio').nth(2).check(); await save(page).click();
        await waitFor(() => state.writes.length === 1); await page.clock.fastForward(15_001);
        await page.getByRole('status').filter({ hasText: 'could not be confirmed' }).waitFor(); assert.equal(await save(page).isDisabled(), true);
        assert.equal(await check(page).isEnabled(), true); assert.equal(state.writes.length, 1);
      });
      await run(base, 'read-deadline-never-enables-a-stale-change', viewport, state => { state.saved = 'public'; }, async (page, state) => {
        await ready(page); state.getMode = 'hold'; await page.clock.install(); await check(page).click(); await waitFor(() => state.held.length > 0);
        await page.clock.fastForward(15_001); await page.getByRole('status').filter({ hasText: 'could not be loaded' }).waitFor();
        assert.equal(await save(page).isDisabled(), true); assert.equal(await check(page).isEnabled(), true); assert.equal(state.writes.length, 0);
        assert.equal(await page.getByText('Last confirmed visibility: Public', { exact: true }).count(), 1);
      });
      await run(base, 'denied-write-clears-the-saved-choice', viewport, state => { state.postStatus = 403; }, async (page, state) => {
        await ready(page); await radios(page).getByRole('radio').nth(2).check(); await save(page).click();
        await page.getByRole('status').filter({ hasText: 'Your access changed.' }).waitFor();
        assert.equal(await page.locator('input[name="performer-visibility"]:checked').count(), 0); assert.equal(await save(page).isDisabled(), true); assert.equal(state.writes.length, 1);
      });
      await run(base, 'rejected-write-requires-an-explicit-check', viewport, state => { state.postStatus = 422; }, async (page, state) => {
        await ready(page); await radios(page).getByRole('radio').nth(2).check(); await save(page).click();
        await page.getByRole('status').filter({ hasText: 'Visibility rejected by fixture.' }).waitFor(); assert.equal(await save(page).isDisabled(), true);
        await check(page).click(); await ready(page); assert.equal(await radios(page).getByRole('radio').nth(0).isChecked(), true); assert.equal(state.writes.length, 1);
      });
      await run(base, 'old-account-response-cannot-update-remounted-view', viewport, state => { state.postMode = 'hold'; }, async (page, state) => {
        await ready(page); await radios(page).getByRole('radio').nth(2).check(); await save(page).click(); await waitFor(() => state.writes.length === 1);
        const toggle = page.getByRole('button', { name: 'Toggle fixture mount', exact: true }); await toggle.click(); await page.getByText('Visibility unmounted', { exact: true }).waitFor();
        state.saved = 'draft'; await toggle.click(); await ready(page); await respond(state.held[0], { visibilityState: 'public' }).catch(() => {});
        assert.equal(await radios(page).getByRole('radio').nth(0).isChecked(), true); assert.equal(await page.getByText('Visibility saved.', { exact: true }).count(), 0);
      });
      await run(base, 'preview-is-not-populated-by-a-late-live-save', viewport, state => { state.postMode = 'hold'; }, async (page, state) => {
        await ready(page); await radios(page).getByRole('radio').nth(2).check(); await save(page).click(); await waitFor(() => state.writes.length === 1);
        await page.getByRole('button', { name: 'Toggle fixture preview', exact: true }).click();
        await page.getByText('Visibility controls are unavailable in preview mode.', { exact: true }).waitFor(); const reads = state.reads;
        await respond(state.held[0], { visibilityState: 'public' }).catch(() => {});
        assert.equal(await page.locator('input[name="performer-visibility"]:checked').count(), 0); assert.equal(await save(page).isDisabled(), true); assert.equal(state.reads, reads); assert.equal(state.writes.length, 1);
      });
      await run(base, 'mismatched-acknowledgement-never-confirms-publication', viewport, state => { state.postBody = { visibilityState: 'draft' }; }, async (page, state) => {
        await ready(page); await radios(page).getByRole('radio').nth(2).check(); await save(page).click();
        await page.getByRole('status').filter({ hasText: 'could not be confirmed' }).waitFor(); assert.equal(await page.getByText('Visibility saved.', { exact: true }).count(), 0);
        await check(page).click(); await ready(page); assert.equal(await radios(page).getByRole('radio').nth(2).isChecked(), true); assert.equal(state.writes.length, 1);
      });
    }
  });
} finally {
  if (browser) await browser.close();
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ baselineRef, regressions, results }, null, 2));
}
const failed = results.filter(result => !result.passed), baselineFailed = regressions.filter(result => !result.passed);
console.log('VISIBILITY_BROWSER_SUMMARY', JSON.stringify({ passed: results.length - failed.length, failed: failed.length, baselineRegressionsReproduced: regressions.length - baselineFailed.length }));
assert.equal(regressions.length, 3); assert.equal(baselineFailed.length, 0, 'Original source safety failures must actually reproduce.');
assert.equal(results.length, 36); assert.equal(failed.length, 0, 'Visibility recovery browser suite must pass every case.');
