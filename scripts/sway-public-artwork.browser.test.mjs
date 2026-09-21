import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { chromium } from 'playwright';

// Render the unchanged approved artwork with the actual candidate landing shell.
// Static loopback only: no accounts, production access or payment providers.
const app = express();
app.get('/', (_req,res) => res.type('html').send(readFileSync('shells/public.html','utf8')));
app.use(express.static(resolve('public')));
const server = app.listen(0,'127.0.0.1');
await once(server,'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const output = resolve('tmp/public-entry-qa/artwork');
mkdirSync(output,{recursive:true});
const results=[];
let browser;
try {
  browser = await chromium.launch({headless:true});
  for (const [width,height] of [[320,568],[390,844],[844,390],[1366,768]]) {
    const context = await browser.newContext({viewport:{width,height},serviceWorkers:'block'});
    await context.route('**/*', route => {
      const request=route.request();
      return request.url().startsWith(origin+'/') && request.method()==='GET' ? route.continue() : route.abort();
    });
    const page=await context.newPage();
    page.setDefaultTimeout(5000);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    try {
      await page.goto(origin+'/',{waitUntil:'networkidle',timeout:15000});
      const image=page.locator('img[src="/assets/sway-neon-background.png"]');
      assert.equal(await image.count(),1);
      assert.deepEqual(await image.evaluate(el=>({complete:el.complete,width:el.naturalWidth,height:el.naturalHeight})),{complete:true,width:1080,height:1620});
      assert.equal(await page.locator('.cta-stack a').first().getAttribute('href'),'/account/signup?intent=performer');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      for (const link of await page.locator('.cta-stack a, footer a').all()) {
        await link.scrollIntoViewIfNeeded();
        await link.click({trial:true,timeout:2000});
      }
      assert.deepEqual(errors,[]);
      await page.evaluate(()=>window.scrollTo(0,0));
      const name=`${width}x${height}`;
      await page.screenshot({path:resolve(output,name+'.png'),fullPage:true});
      results.push({name,passed:true});
      console.log('PUBLIC_ARTWORK_BROWSER_PASS '+name);
    } finally {await context.close();}
  }
} finally {
  await browser?.close();
  await new Promise(resolveClose=>server.close(resolveClose));
  writeFileSync(resolve(output,'results.json'),JSON.stringify({scope:'Actual static shell and approved local artwork; no signed-in, production, physical-device or payment proof.',results},null,2));
}
assert.equal(results.length,4);
console.log('PUBLIC_ARTWORK_BROWSER_SUMMARY '+JSON.stringify({passed:4,failed:0}));
