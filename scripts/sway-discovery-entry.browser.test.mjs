import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright';

const output=path.resolve('tmp/public-entry-qa/discovery-entry');
fs.mkdirSync(output,{recursive:true});
// Import the shipped entry point, including PatronAppShell and PatronApp, not
// a direct directory mount that bypasses their startup hooks and campaign reads.
const compiled=buildSync({stdin:{contents:"import './src/entries/patron'; import {sendDiscoveryEvent} from './src/shells/frictionClient'; import {captureCampaignCode} from './src/shells/campaignAttribution'; window.discoveryEntryTest={sendDiscoveryEvent,captureCampaignCode};",resolveDir:process.cwd(),sourcefile:'discovery-entry-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{"MODE":"production","PROD":true,"DEV":false,"BASE_URL":"/","VITE_SWAY_DEMO_MODE":"false"}'}}).outputFiles[0].text;
const received=[];
const server=http.createServer((req,res)=>{
 if(req.method==='POST'&&req.url==='/api/analytics/shell'){
  let text='';req.on('data',chunk=>{text+=chunk;if(text.length>16384)req.destroy();});req.on('end',()=>{try{received.push(JSON.parse(text));res.writeHead(202,{'content-type':'application/json'});res.end('{"syntheticReceiver":true}');}catch{res.writeHead(400);res.end();}});return;
 }
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'application/javascript'});res.end(compiled);return;}
 if(req.url.startsWith('/api/public/feed')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({rooms:[],events:[],releases:[],performerDirectory:{performers:[],hasMore:false}}));return;}
 if(req.url==='/sw.js'){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owned full patron entry check</title><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const results=[];let browser;
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const width of [390,1440])for(const storage of ['available','getters-denied','methods-denied','write-quota']){
  const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addInitScript(storage=>{
   if(storage==='getters-denied')for(const key of ['localStorage','sessionStorage'])Object.defineProperty(window,key,{get(){throw new DOMException('Diagnostic storage denial','SecurityError');}});
   if(storage==='methods-denied')for(const key of ['getItem','setItem','removeItem'])Storage.prototype[key]=function(){throw new DOMException('Diagnostic storage denial','SecurityError');};
   if(storage==='write-quota')Storage.prototype.setItem=function(){throw new DOMException('Diagnostic quota limit','QuotaExceededError');};
  },storage);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.stack||e.message));page.setDefaultTimeout(5000);
  const row={width,storage,passed:false},start=received.length;
  try{
   await page.goto(origin+'/discover?utm_source=google',{waitUntil:'domcontentloaded'});
   await page.locator('#sway-discover-search').waitFor({state:'visible'});
   if(storage==='write-quota'){
    await page.evaluate(()=>{const event=new Event('beforeinstallprompt',{cancelable:true});Object.assign(event,{prompt:async()=>{},userChoice:Promise.resolve({outcome:'dismissed',platform:'test'})});window.dispatchEvent(event);});
    await page.getByRole('dialog',{name:'Install Sway'}).waitFor({state:'visible'});
    await page.getByRole('button',{name:'Dismiss install prompt',exact:true}).click();
    await page.getByRole('dialog',{name:'Install Sway'}).waitFor({state:'hidden'});row.dismissalSurvivesQuota=true;
   }
   await page.locator('#sway-discover-search').fill('owned-no-match');
   await page.locator('form[role="search"] button').click();await page.getByRole('heading',{name:'No current matches',exact:true}).waitFor();
   for(let i=0;i<50&&!received.slice(start).some(r=>r.event==='internal_search_zero_result');i++)await page.waitForTimeout(50);
   const rows=received.slice(start),landing=rows.find(r=>r.event==='discovery_landing'),search=rows.find(r=>r.event==='internal_search_zero_result');
   assert(landing&&search,'Actual directory must emit landing and deliberate search events');
   assert.equal(landing.attribution_channel,'google','Omitted source must retain the captured first touch');assert.equal(search.attribution_channel,'google');
   assert.equal(search.journey_id,landing.journey_id);assert.equal(landing.entry_path,'/discover');assert.equal(search.entry_path,'/discover');
   const campaign=await page.evaluate(()=>{
    history.replaceState(null,'','/discover?utm_source=google&camp=owned-test-campaign');
    const fromQuery=window.discoveryEntryTest.captureCampaignCode();
    history.replaceState(null,'','/discover?utm_source=google');
    return {fromQuery,afterQuery:window.discoveryEntryTest.captureCampaignCode()};
   });
   assert.equal(campaign.fromQuery,'owned-test-campaign','Current campaign hint survives an unavailable storage write');
   assert.equal(campaign.afterQuery,storage==='available'?'owned-test-campaign':null,'No unavailable campaign persistence may be invented');
   row.campaignStorageOptional=true;
   const prior=received.length;
   await page.evaluate(()=>{const payload={shell:'patron',surface:'public-discover',route_family:'public-discover',has_route_context:true,has_session_context:false,build_commit:'owned-fixture'};
    window.discoveryEntryTest.sendDiscoveryEvent('discovery_primary_action',{...payload,attribution_channel:'referral'});
    window.discoveryEntryTest.sendDiscoveryEvent('discovery_landing',{...payload,email:'not-sent@example.invalid'});
    window.discoveryEntryTest.sendDiscoveryEvent('discovery_landing',{...payload,attribution_channel:'bad?source'});
   });
   for(let i=0;i<50&&received.length===prior;i++)await page.waitForTimeout(50);await page.waitForTimeout(50);
   assert.equal(received.length-prior,1,'Invalid payloads must remain rejected');assert.equal(received.at(-1).attribution_channel,'referral','Explicit valid source remains unchanged');
   assert.deepEqual(errors,[]);row.joinedDirectoryEvents=2;row.defaultSource='google';row.explicitSourcePreserved=true;row.invalidEventsSent=0;row.passed=true;
  }catch(error){row.error=String(error.stack||error);}
  finally{row.pageErrors=errors;results.push(row);console.log('DISCOVERY_ENTRY_BROWSER '+JSON.stringify(row));await context.close();}
 }
}finally{
 await browser?.close();await new Promise(resolve=>server.close(resolve));
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({scope:'Full shipped patron entry, PatronAppShell, PatronApp, directory, mount, install prompt and telemetry client in Chromium. Public environment, feed and telemetry are isolated fixtures; CSS omitted. Not a visual, production-ingestion, commission or payment proof.',results},null,2));
}
assert.equal(results.length,8);assert(results.every(r=>r.passed),'Full patron entry browser checks failed: '+JSON.stringify(results.filter(r=>!r.passed)));
console.log('DISCOVERY_ENTRY_BROWSER_SUMMARY '+JSON.stringify({passed:results.length,failed:0}));
