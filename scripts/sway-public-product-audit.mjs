import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Anonymous, read-only production inspection. Never submits forms, creates
// accounts, sends telemetry, changes records, or enables paid actions.
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
const origin = 'https://app.sway.tips';
const output = resolve('tmp/public-product-audit');
mkdirSync(output, { recursive: true });
const server = readFileSync('server.ts', 'utf8');
for (const term of ['const aboutPageHtml =', 'const faqPageHtml =']) {
  const start = server.indexOf(term);
  console.log('SWAY_PUBLIC_SOURCE ' + JSON.stringify({ term, line: start < 0 ? null : server.slice(0, start).split('\n').length, excerpt: start < 0 ? null : server.slice(start, start + 1200) }));
}
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const [name, path, width, height] of [
    ['home-mobile', '/', 390, 844], ['home-desktop', '/', 1366, 768],
    ['join-mobile', '/home', 390, 844], ['discover-mobile', '/discover', 390, 844],
    ['signup-mobile', '/account/signup', 390, 844],
    ['performer-signup-mobile', '/account/signup?intent=performer', 390, 844],
    ['login-mobile', '/account/login', 390, 844],
    ['about-mobile', '/about', 390, 844], ['faq-mobile', '/faq', 390, 844],
    ['support-mobile', '/support', 390, 844]
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', extraHTTPHeaders: { 'X-Sway-QA': 'read-only-public-audit' } });
    await context.route('**/*', route => {
      const request = route.request();
      let target;
      try { target = new URL(request.url()); } catch { return route.abort(); }
      if (target.origin !== origin || !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message.slice(0, 300)));
    try {
      const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1800);
      const facts = await page.evaluate(() => ({
        title: document.title,
        text: document.body.innerText.replace(/\n{3,}/g, '\n\n').slice(0, 4200),
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        links: [...document.querySelectorAll('a[href]')].slice(0, 36).map(a => ({ text: a.textContent.trim().slice(0, 90), href: a.getAttribute('href'), visible: Number(getComputedStyle(a).opacity) > 0 && a.getBoundingClientRect().height > 0 })),
        buttons: [...document.querySelectorAll('button')].slice(0, 24).map(b => ({ text: b.textContent.trim().slice(0, 100), disabled: b.disabled })),
        fields: [...document.querySelectorAll('input,select,textarea')].slice(0, 24).map(el => ({ type: el.type, name: el.name, label: el.getAttribute('aria-label') || el.labels?.[0]?.textContent?.trim() || '' })),
        brokenImages: [...document.images].filter(image => image.complete && !image.naturalWidth).map(image => new URL(image.src).pathname).slice(0, 10)
      }));
      await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true });
      const result = { name, path, status: response?.status(), errors, ...facts };
      results.push(result);
      console.log('SWAY_PUBLIC_OBSERVATION ' + JSON.stringify(result));
    } catch (error) {
      const result = { name, path, inspectionError: error.message.slice(0, 500) };
      results.push(result);
      console.log('SWAY_PUBLIC_OBSERVATION ' + JSON.stringify(result));
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
const report = { scope: 'Anonymous read-only production observation; findings are not passing tests or whole-product readiness.', observedAt: new Date().toISOString(), results };
writeFileSync(resolve(output, 'observations.json'), JSON.stringify(report, null, 2));
console.log('SWAY_PUBLIC_AUDIT_COMPLETE ' + JSON.stringify({ observations: results.length, inspectionErrors: results.filter(result => result.inspectionError).length, scope: report.scope }));
