import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Read-only post-deployment verification from the isolated validation service.
// Never creates accounts, submits forms, touches provider data or changes money.
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
assert.equal(process.env.SWAY_POST_RELEASE_READ_ONLY_PROOF, 'true');
for (const name of ['SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED','SWAY_NATIVE_TICKETS_ENABLED','SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED','SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED','SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED']) assert.equal(process.env[name],'false');
assert.deepEqual(Object.keys(process.env).filter(name => /DATABASE_URL$/.test(name) || /^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SWAY_EMAIL_API_KEY)$/.test(name) || /PAYPAL.*(?:SECRET|TOKEN)$/.test(name)).filter(name => Boolean(process.env[name]?.trim())), []);
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(head,process.env.SWAY_VALIDATION_EXPECTED_SHA);
assert.equal(head,process.env.RENDER_GIT_COMMIT);
assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),'');
const expectedProduction='b84ad1814dca1fc40861468c65ff6ac3a72519db';
const differences=execFileSync('git',['diff','--name-only',expectedProduction,head],{encoding:'utf8'}).trim().split('\n').filter(Boolean).sort();
assert.deepEqual(differences,['scripts/sway-public-release-delivery-proof.mjs','scripts/sway-release-validation-suite.mjs','scripts/sway-release-validation.mjs'].sort(),'All inspected application files must match production exactly.');
const require=createRequire(import.meta.url);
const {ABOUT_PAGE_HTML,FAQ_PAGE_HTML}=require('./sway-dj-beta-about-preload.cjs');
const output=resolve('.validation-public');
rmSync(output,{recursive:true,force:true});
mkdirSync(output,{recursive:true});
const results=[];
console.log('POST_RELEASE_DELIVERY_BEGIN '+JSON.stringify({diagnosticHead:head,expectedProduction,scope:'Anonymous read-only live-host verification, not full release validation or whole-product acceptance.'}));
for (const origin of ['https://app.sway.tips','https://sway.tips']) {
  for (const [path,expected] of [['/',null],['/about',ABOUT_PAGE_HTML],['/faq',FAQ_PAGE_HTML]]) {
    const response=await fetch(origin+path,{cache:'no-store',redirect:'follow',headers:{'Cache-Control':'no-cache','X-Sway-QA':'read-only-delivery-proof'},signal:AbortSignal.timeout(15000)});
    const html=await response.text();
    const result={kind:'http',origin,path,status:response.status,build:response.headers.get('x-commit-sha'),finalUrl:response.url};
    assert.equal(result.status,200);
    assert.equal(result.build,expectedProduction,'Customer-facing host must serve the released build.');
    if (expected) assert.equal(html,expected,'Customer-facing HTML must match the tested route-specific page.');
    else assert.match(html,/<a[^>]*href="\/account\/signup\?intent=performer"[^>]*>\s*Create your performer page\s*<\/a>/);
    results.push({...result,passed:true});
    console.log('POST_RELEASE_DELIVERY_PASS '+JSON.stringify(results.at(-1)));
  }
}
const browser=await chromium.launch({headless:true});
try {
  for (const [width,height] of [[390,844],[1366,768]]) {
    const origin='https://app.sway.tips';
    const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});
    await context.route('**/*',route=>{
      const req=route.request();
      let url; try {url=new URL(req.url());} catch {return route.abort();}
      return url.origin===origin && ['GET','HEAD','OPTIONS'].includes(req.method()) ? route.continue() : route.abort();
    });
    const page=await context.newPage();
    page.setDefaultTimeout(5000);
    page.setDefaultNavigationTimeout(20000);
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    try {
      for (const path of ['/','/about','/faq']) {
        const response=await page.goto(origin+path,{waitUntil:'domcontentloaded'});
        assert.equal(response.status(),200);
        assert.equal(response.headers()['x-commit-sha'],expectedProduction);
        await page.waitForTimeout(500);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow on the real public host.');
        if(path==='/') {
          const entry=page.getByRole('link',{name:'Create your performer page',exact:true});
          assert(await entry.isVisible());
          await entry.click({trial:true});
          assert(await page.locator('img[src="/assets/sway-neon-background.png"]').evaluate(el=>el.complete && el.naturalWidth>0),'Approved production artwork loads.');
        } else if(path==='/about') {
          assert.equal(await page.locator('h1').innerText(),'About Sway');
          assert.match(await page.locator('main').innerText(),/sway\.dio/);
        } else {
          assert.equal(await page.locator('h1').innerText(),'Sway FAQ');
          assert.equal(await page.locator('details').count(),11);
          const question=page.locator('summary').first();
          await question.focus();
          await page.keyboard.press('Enter');
          assert(await question.evaluate(el=>el.parentElement.open));
          await page.keyboard.press('Space');
          assert.equal(await question.evaluate(el=>el.parentElement.open),false);
        }
        assert.deepEqual(errors,[]);
        const name=`${path==='/'?'home':path.slice(1)}-${width}x${height}`;
        await page.screenshot({path:resolve(output,name+'.png'),fullPage:true});
        const result={kind:'browser',name,status:response.status(),build:response.headers()['x-commit-sha'],passed:true};
        results.push(result);
        console.log('POST_RELEASE_DELIVERY_PASS '+JSON.stringify(result));
      }
      await page.goto(origin+'/',{waitUntil:'domcontentloaded'});
      await page.getByRole('link',{name:'Create your performer page',exact:true}).click();
      await page.waitForURL('**/account/signup?intent=performer');
      await page.locator('input[type="email"]').waitFor({state:'visible'});
      await page.locator('input[type="password"]').first().waitFor({state:'visible'});
      assert.deepEqual(errors,[]);
      const result={kind:'navigation',name:`performer-entry-${width}x${height}`,url:page.url(),passed:true};
      results.push(result);
      console.log('POST_RELEASE_DELIVERY_PASS '+JSON.stringify(result));
    } finally {await context.close();}
  }
} finally {await browser.close();}
assert.equal(results.length,14);
const report={diagnosticHead:head,expectedProduction,observedAt:new Date().toISOString(),passed:results.length,failed:0,scope:'14 anonymous post-release HTTP/browser/navigation checks; no signed-in flows, writes, payments, physical-device or visual-approval proof.',results};
writeFileSync(resolve(output,'delivery.json'),JSON.stringify(report,null,2));
writeFileSync(resolve(output,'robots.txt'),'User-agent: *\nDisallow: /\n');
writeFileSync(resolve(output,'index.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Sway public delivery check</title><p>Anonymous public delivery checks passed. This is not a full test-suite result or whole-Sway readiness approval.</p></html>');
console.log('POST_RELEASE_DELIVERY_SUMMARY '+JSON.stringify(report));
