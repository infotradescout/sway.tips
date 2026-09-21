import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Static, real-shell browser proof only. Never contacts Sway or creates accounts.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.env.SWAY_LANDING_SOURCE || resolve(root, 'shells/public.html'));
const output = resolve(process.env.SWAY_ENTRY_QA_OUTPUT || resolve(root, 'tmp/public-entry-qa'));
const html = readFileSync(source, 'utf8');
const origin = 'https://sway-entry.test';
const creatorPath = '/account/signup?intent=performer';
const viewportSizes = [[280, 568], [320, 568], [390, 844], [568, 320], [844, 390], [900, 600], [1440, 900]];
const cases = viewportSizes.flatMap(([width, height]) => [false, true].map(javaScriptEnabled => ({
  name: `${width}x${height}-${javaScriptEnabled ? 'scripts' : 'no-scripts'}`,
  viewport: { width, height }, javaScriptEnabled
})));
cases.push({ name: '390x844-reduced-motion', viewport: { width: 390, height: 844 }, javaScriptEnabled: true, reducedMotion: 'reduce' });
cases.push({ name: '320x568-double-text', viewport: { width: 320, height: 568 }, javaScriptEnabled: false, doubleText: true });
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.SWAY_CHROMIUM_EXECUTABLE ? { executablePath: process.env.SWAY_CHROMIUM_EXECUTABLE } : {})
});
const results = [];
try {
  for (const scenario of cases) {
    const { name, doubleText, ...options } = scenario;
    const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
    // Inject the enlarged-text stylesheet before parsing, so this fixture does
    // not depend on addStyleTag's script execution in a no-JavaScript context.
    const fixtureHtml = doubleText ? html.replace('</head>', '<style>.cta-stack a, footer a { font-size: 32px !important; letter-spacing: 0 !important; }</style></head>') : html;
    await context.route('**/*', route => route.request().url() === `${origin}/`
      ? route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml })
      : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    console.log('PUBLIC_ENTRY_BROWSER_BEGIN ' + name);
    try {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      const initial = await page.locator('.cta-stack a').evaluateAll(links => links.map(link => ({
        href: link.getAttribute('href'), opacity: getComputedStyle(link).opacity,
        pointerEvents: getComputedStyle(link).pointerEvents
      })));
      assert.equal(initial[0]?.href, creatorPath, 'First action must go straight to performer setup.');
      assert.equal(initial.filter(link => link.href === creatorPath).length, 1);
      for (const href of ['/home', '/discover', '/account/signup', '/account/login', '/about']) {
        assert(initial.some(link => link.href === href), `Preserve ${href}`);
      }
      assert(initial.every(link => Number(link.opacity) === 1 && link.pointerEvents !== 'none'),
        'Entry links must work before the background reveal and without scripts.');
      await page.keyboard.press('Tab');
      assert.equal(await page.locator(':focus').getAttribute('href'), creatorPath, 'Keyboard starts at creator entry.');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow.');
      for (const link of await page.locator('.cta-stack a, footer a').all()) {
        await link.scrollIntoViewIfNeeded();
        assert(await link.evaluate(el => {
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          const style = getComputedStyle(el);
          return Number(style.opacity) === 1 && style.pointerEvents !== 'none'
            && rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= innerWidth + 1
            && Boolean(hit && (hit === el || el.contains(hit)));
        }), `Reachable, unclipped link: ${await link.textContent()}`);
        await link.click({ trial: true, timeout: 1000 });
      }
      assert.deepEqual(errors, [], 'No inline script exceptions.');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
      results.push({ name, status: 'PASS' });
      console.log('PUBLIC_ENTRY_BROWSER_PASS ' + name);
    } catch (error) {
      const blocked = /ERR_BLOCKED_BY_ADMINISTRATOR/.test(error.message);
      results.push({ name, status: blocked ? 'BLOCKED' : 'FAIL', error: error.message });
      console.error('PUBLIC_ENTRY_BROWSER_FAILURE ' + JSON.stringify(results.at(-1)));
      if (blocked) break;
    } finally {
      await context.close();
    }
  }
} finally {
  const report = {
    sourceSha256: createHash('sha256').update(html).digest('hex'),
    browser: browser.version(), node: process.version,
    scope: 'Real static public shell; all assets and external requests blocked. No account, server, email, payment, artwork or physical-device proof.',
    results, passed: results.filter(row => row.status === 'PASS').length,
    failed: results.filter(row => row.status === 'FAIL').length,
    blocked: results.filter(row => row.status === 'BLOCKED').length,
    notRun: cases.length - results.length
  };
  writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('PUBLIC_ENTRY_BROWSER_SUMMARY ' + JSON.stringify(report));
  await browser.close();
  if (report.failed || report.blocked || report.notRun) process.exitCode = 1;
}
