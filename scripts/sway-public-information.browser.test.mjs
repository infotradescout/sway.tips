import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import express from 'express';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const surface = require('./sway-dj-beta-about-preload.cjs');
const { inspectPublicInformation } = require('./sway-dj-beta-about-proof.cjs');
assert.notEqual(surface.ABOUT_PAGE_HTML, surface.FAQ_PAGE_HTML, 'FAQ must answer questions, not repeat About.');
assert.match(surface.ABOUT_PAGE_HTML, /sway\.dio/);
assert.match(surface.FAQ_PAGE_HTML, /<summary>/);
const installedGet = express.application.get;
surface.installDjBetaAboutSurface();
assert.equal(express.application.get, installedGet, 'Repeated installation must not stack wrappers.');
const app = express();
app.set('test-setting', 'preserved');
assert.equal(app.get('test-setting'), 'preserved', 'Express settings remain untouched.');
app.use((_req, res, next) => { res.set('x-commit-sha', 'fixture-build'); next(); });
app.get('/about', (_req, res) => res.send('outdated about'));
app.get('/faq', (_req, res) => res.send('outdated faq'));
app.get('/unrelated', (_req, res) => res.send('original unrelated route'));
app.post('/about', (_req, res) => res.send('original POST route'));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const output = resolve('tmp/public-entry-qa/information');
mkdirSync(output, { recursive: true });
const results = [];
let browser;
try {
  const runtime = await inspectPublicInformation(origin, 'fixture-build');
  assert.equal(runtime.passed, true, 'Real Express output must match the current route-specific content.');
  assert.equal((await inspectPublicInformation(origin, 'wrong-build')).passed, false, 'A stale deployment cannot pass.');
  assert.equal(await (await fetch(`${origin}/unrelated`)).text(), 'original unrelated route');
  assert.equal(await (await fetch(`${origin}/about`, { method: 'POST' })).text(), 'original POST route');
  assert.equal((await fetch(`${origin}/faq`)).headers.get('cache-control'), 'no-store');
  const stale = await inspectPublicInformation(origin, null, async () => new Response('outdated DJ beta', { headers: { 'content-type': 'text/html' } }));
  assert.equal(stale.passed, false, 'Old or duplicate content cannot pass the runtime check.');
  console.log('PUBLIC_INFORMATION_RUNTIME_PASS route separation, identity, unchanged routes, settings, repeated installation and stale-content rejection');
  browser = await chromium.launch({ headless: true });
  const scenarios = [[320,568],[390,844],[844,390],[768,1024],[1366,768]].flatMap(([width,height]) => [false,true].map(javaScriptEnabled => ({ viewport:{width,height}, javaScriptEnabled })));
  scenarios.push({ viewport:{width:320,height:568}, javaScriptEnabled:false, doubleText:true });
  for (const scenario of scenarios) {
    const { doubleText, ...contextOptions } = scenario;
    const context = await browser.newContext({ ...contextOptions, serviceWorkers:'block' });
    await context.route('**/*', async route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/') || request.method() !== 'GET') return route.abort();
      if (doubleText && ['/about','/faq'].includes(new URL(request.url()).pathname)) {
        const response = await route.fetch();
        const body = (await response.text()).replace('</head>', '<style>body{font-size:32px}p,a,summary{font-size:32px!important;line-height:1.5!important}</style></head>');
        return route.fulfill({ response, body });
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    // Local Chromium navigation can stall under Windows test-runner load.
    // Keep control assertions at5s and reachability trials at2s below.
    page.setDefaultNavigationTimeout(90000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      for (const path of ['/about','/faq']) {
        const name = `${path.slice(1)}-${scenario.viewport.width}x${scenario.viewport.height}-${scenario.javaScriptEnabled?'scripts':'no-scripts'}${doubleText?'-double-text':''}`;
        await page.goto(origin + path, { waitUntil:'domcontentloaded' });
        assert.match(await page.title(), path === '/faq' ? /^Sway FAQ/ : /^About Sway/);
        assert.equal(await page.locator('h1').count(), 1);
        assert.equal(await page.locator('a[href="/account/signup?intent=performer"]').count(), 1);
        await page.keyboard.press('Tab');
        assert.equal(await page.locator(':focus').getAttribute('href'), '#main', 'Keyboard users get a working skip link.');
        await page.keyboard.press('Enter');
        if (path === '/faq') {
          assert.equal(await page.locator('details').count(), 11);
          for (const summary of await page.locator('summary').all()) {
            await summary.focus();
            await page.keyboard.press('Enter');
            assert.equal(await summary.evaluate(el => el.parentElement.open), true);
            assert(await summary.locator('..').locator('p').isVisible());
            await page.keyboard.press('Space');
            assert.equal(await summary.evaluate(el => el.parentElement.open), false);
          }
          for (const summary of await page.locator('summary').all()) await summary.click();
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ': no horizontal overflow');
        for (const link of await page.locator('nav a, main a, footer a').all()) {
          await link.scrollIntoViewIfNeeded();
          assert(await link.evaluate(el => {
            const bounds=el.getBoundingClientRect();
            const r=[...el.getClientRects()].find(rect => rect.width>0 && rect.height>0 && rect.top>=0 && rect.bottom<=innerHeight) || bounds;
            const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
            return bounds.width>0 && bounds.height>0 && bounds.left>=-1 && bounds.right<=innerWidth+1 && Boolean(hit && (hit===el || el.contains(hit)));
          }), name + ': links remain reachable and unclipped');
          await link.click({ trial:true, timeout:2000 });
        }
        assert.deepEqual(errors, []);
        await page.evaluate(() => window.scrollTo(0,0));
        await page.screenshot({ path:resolve(output,name+'.png'), fullPage:true });
        results.push({ name, passed:true });
        console.log('PUBLIC_INFORMATION_BROWSER_PASS ' + name);
      }
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
  writeFileSync(resolve(output,'results.json'), JSON.stringify({ scope:'Actual Express route override and real Chromium; no customer accounts or payment execution.', results },null,2));
}
assert.equal(results.length,22);
console.log('PUBLIC_INFORMATION_BROWSER_SUMMARY ' + JSON.stringify({ passed:results.length, failed:0 }));
