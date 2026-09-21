import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const expected=process.env.SWAY_ATTRIBUTION_DEPLOYED_SHA;
assert.match(expected||'',/^[a-f0-9]{40}$/);
const origin='https://app.sway.tips',output=path.resolve('.validation-public');
fs.mkdirSync(output,{recursive:true});
const report={expected,startedAt:new Date().toISOString(),result:'fail',pages:[],customerWrites:0,analyticsWrites:0,humanTrafficMeasured:false};
let browser;
async function health(){
 const r=await fetch(origin+'/api/release-health',{headers:{'user-agent':'Sway-Owner-Release-QA/1.0'},signal:AbortSignal.timeout(20000)});
 const h=await r.json();assert.equal(r.status,200);assert.equal(h.commit,expected);assert.equal(h.releaseActive,true);assert.equal(h.migrations?.compatible,true);
 return {status:r.status,commit:h.commit,releaseActive:h.releaseActive,migrationsCompatible:h.migrations.compatible};
}
try{
 report.healthBefore=await health();
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const width of [390,1440])for(const denied of [false,true]){
  const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});
  const payloads=[],blocked=[];
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());
   if(request.method()==='POST'&&url.origin===origin&&url.pathname==='/api/analytics/shell'){
    try{payloads.push(request.postDataJSON());}catch{}
    return route.fulfill({status:202,contentType:'application/json',body:'{"qa_intercepted":true}'});
   }
   if(!['GET','HEAD'].includes(request.method())){blocked.push({method:request.method(),path:url.pathname});return route.abort('blockedbyclient');}
   if(url.origin!==origin)return route.abort('blockedbyclient');
   return route.continue();
  });
  if(denied)await context.addInitScript(()=>{
   for(const key of ['localStorage','sessionStorage'])Object.defineProperty(window,key,{get(){throw new DOMException('Owned verification storage denial','SecurityError');}});
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
  const row={width,storage:denied?'denied':'available',passed:false};report.pages.push(row);
  try{
   const response=await page.goto(origin+'/discover?utm_source=google&sway_qa=1',{waitUntil:'domcontentloaded',timeout:40000});
   assert.equal(response.status(),200);assert.equal(response.headers()['x-commit-sha'],expected);
   await page.locator('#sway-discover-search').waitFor({state:'visible'});
   for(let attempt=0;attempt<100&&!payloads.some(p=>p.event==='discovery_landing');attempt++)await page.waitForTimeout(100);
   assert(payloads.some(p=>p.event==='discovery_landing'),'The actual directory did not emit its landing event');
   await page.locator('#sway-discover-search').fill('sway-owned-qa-no-match-803450d5262a');
   await page.locator('form[role="search"] button').click();
   await page.getByRole('heading',{name:'No current matches',exact:true}).waitFor();
   for(let attempt=0;attempt<100&&!payloads.some(p=>p.event==='internal_search_zero_result');attempt++)await page.waitForTimeout(100);
   const landing=payloads.find(p=>p.event==='discovery_landing'),search=payloads.find(p=>p.event==='internal_search_zero_result');
   assert(search,'The actual directory did not emit its deliberate zero-result event');
   assert.match(landing.journey_id,/^[0-9a-f-]{36}$/);assert.equal(search.journey_id,landing.journey_id);
   assert.equal(landing.entry_path,'/discover');assert.equal(search.entry_path,'/discover');assert.deepEqual(errors,[]);
   row.channelLabels=[landing.attribution_channel??null,search.attribution_channel??null];
   assert.deepEqual(row.channelLabels,['google','google'],'Both actual directory events must carry the existing captured source');
   row.joinedEvents=2;row.entryPath='/discover';row.errors=errors;row.blockedWrites=blocked;
   row.horizontalOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(row.horizontalOverflow,false);
   row.interceptedAnalytics=payloads.length;row.passed=true;
   await page.screenshot({path:path.join(output,`discovery-${width}-${row.storage}.png`),fullPage:true});
  }catch(error){row.error=String(error.stack||error);row.errors=errors;row.interceptedEventNames=payloads.map(p=>p.event);throw error;}
  finally{console.log('ATTRIBUTION_PRODUCTION_PAGE '+JSON.stringify(row));await context.close();}
 }
 report.healthAfter=await health();assert.equal(report.pages.length,4);assert(report.pages.every(p=>p.passed));report.result='pass';
 report.scope='Actual deployed public directory in four fresh browser contexts. Deliberate search and emitted payload continuity/source verified. Analytics POSTs intercepted locally and all other writes blocked; database ingestion, bot classification and organic acquisition NOT established.';
}catch(error){report.error=String(error.stack||error);console.error('ATTRIBUTION_PRODUCTION_FAILURE '+report.error);process.exitCode=1;}
finally{
 await browser?.close();report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'attribution-production.json'),JSON.stringify(report,null,2));
 fs.writeFileSync(path.join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');fs.writeFileSync(path.join(output,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Production discovery behavior</h1><a href="attribution-production.json">Read-only browser receipt</a>');
 console.log('ATTRIBUTION_PRODUCTION_SUMMARY '+JSON.stringify(report));
}
