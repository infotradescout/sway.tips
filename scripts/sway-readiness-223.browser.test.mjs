import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const artifacts = path.resolve('artifacts/readiness-223', process.env.PROOF_RUN || 'latest');
fs.mkdirSync(artifacts, { recursive: true });
const results = [];
const sourceHashes = Object.fromEntries(['src/shells/shared.tsx','src/shells/TalentApp.tsx','src/components/TalentDashboard.tsx','src/components/PerformerRoomShare.tsx','src/index.css', 'scripts/sway-readiness-223.browser.test.mjs'].map(file=>[file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const session = { status:'active', startedAt:new Date().toISOString(), autoCloseoutAt:null, closedAt:null, talentName:'Readiness Test', talentRole:'DJ', feeType:'patron', minimumTip:5, endGigTimerStartedAt:null, isFeatured:false, featuredExpiresAt:null, featuredCost:0, featuredDurationHours:0, requestsOpen:true, requestWindowMode:'manual', requestWindowExpiresAt:null, requestWindowDuration:null, requestWindowLabel:null, requestPresets:[], operatingMode:'manual', searchScope:'library', paymentsEnabled:true, tipsEnabled:true, settlementMode:'platform_test_balance', paymentEnvironment:'test', totals:{totalTips:5,accumulatedFees:1,totalCount:1,topRequest:'Shoutout'} };
const request = {id:'22222222-2222-4222-8222-222222222222',type:'request',targetType:'custom',title:'Shoutout',subtitle:'Test request',senderName:'Synthetic Patron',amount:5,holdAmount:5,platformFee:1,sponsorCount:1,status:'approved',shadowBanned:false,createdAt:new Date().toISOString(),paymentStatus:'captured',boosts:[]};
const profile = {performer_id:'33333333-3333-4333-8333-333333333333',display_name:'Readiness Test',handle:'readiness-test',stage_name:null,primary_role:'dj',roles:['dj'],specialties:[],owner_user_id:'44444444-4444-4444-8444-444444444444',email_verified_at:new Date().toISOString(),charges_enabled:true,payouts_enabled:false,money_actions_ready:true,test_mode_platform_balance_allowed:true};
const A='11111111-1111-4111-8111-111111111111';
const state=(id,title='Shoutout')=>({session,activeGigId:id,requests:[{...request,title}],performers:[],room_lookup:'active',performerProfile:profile});
const json=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
const read=page=>page.locator('[data-testid="room-state"]').textContent().then(JSON.parse);
const shown=(page,id)=>page.waitForFunction(id=>JSON.parse(document.querySelector('[data-testid="room-state"]').textContent).shown===id,id);
const vite=await createServer({root:process.cwd(),logLevel:'error',cacheDir:path.resolve('node_modules/.vite-readiness-223'),server:{host:'127.0.0.1',port:0,strictPort:false,watch:null}});
await vite.listen();
const base='http://127.0.0.1:'+vite.httpServer.address().port;
const browser=await chromium.launch({channel:'chrome',headless:true});
const browserVersion=browser.version();
console.log('Installed Chrome:',browser.version(),'Fixture:',base);
async function test(name,run,viewport={width:390,height:844}){
  const context=await browser.newContext({viewport,serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(30000);
  try{await run(page,context); assert.deepEqual(errors,[]); results.push({name,status:'PASS'});}
  catch(e){results.push({name,status:'FAIL',error:e.message}); await page.screenshot({path:path.join(artifacts,name+'.png'),fullPage:true}).catch(()=>{});}
  finally{await context.close(); console.log(results.at(-1));}
}
try {
await test('late-room-response',async(page,context)=>{
  let delayed; await context.route('**/api/state/*',route=>new URL(route.request().url()).pathname.endsWith('room-A')?(delayed=route,undefined):json(route,state('room-B')));
  await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html'); await page.waitForTimeout(100);
  assert.ok(delayed,'The old room request must be in flight'); await page.getByRole('button',{name:'Room B',exact:true}).click(); await shown(page,'room-B');
  if(delayed) await json(delayed,state('room-A')).catch(()=>{}); await page.waitForTimeout(100);
  assert.equal((await read(page)).shown,'room-B','Room A must not overwrite room B');
});
await test('out-of-order-refresh',async(page,context)=>{
  let count=0,delayed; await context.route('**/api/state/*',route=>{count++; if(count===2){delayed=route;return;} return json(route,state('room-A',count===1?'old':'new'));});
  await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html'); await shown(page,'room-A');
  await page.getByRole('button',{name:'Refresh',exact:true}).click(); await page.waitForTimeout(100);
  await page.getByRole('button',{name:'Refresh',exact:true}).click(); await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-testid="room-state"]').textContent).requests[0]?.title==='new');
  if(delayed) await json(delayed,state('room-A','old')).catch(()=>{}); await page.waitForTimeout(100);
  assert.equal((await read(page)).requests[0]?.title,'new','Older refresh must not replace newer status');
});
for(const failure of ['network','503']) await test('recover-'+failure,async(page,context)=>{
  let fail=false; await context.route('**/api/state/*',route=>fail?(failure==='network'?route.abort('failed'):json(route,{error:'Temporarily unavailable'},503)):json(route,state('room-A')));
  await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html'); await shown(page,'room-A'); fail=true;
  await page.getByRole('button',{name:'Refresh',exact:true}).click(); await page.waitForTimeout(200);
  const current=await read(page); assert.equal(current.status,'error','Temporary failure must not become missing'); assert.equal(current.shown,'room-A','Retain last confirmed room during temporary failure');
  fail=false; await page.getByRole('button',{name:'Refresh',exact:true}).click(); await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-testid="room-state"]').textContent).status==='active');
});
await test('clear-room-with-pending-response',async(page,context)=>{
  let delayed; await context.route('**/api/state/*',route=>{delayed=route;}); await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html'); await page.waitForTimeout(100);
  await page.getByRole('button',{name:'Clear room',exact:true}).click(); await shown(page,null); if(delayed) await json(delayed,state('room-A')).catch(()=>{}); await page.waitForTimeout(100);
  assert.equal((await read(page)).shown,null,'Clearing room must invalidate pending responses');
});
async function appRoutes(context,{library=false,count=31,queueCount=1}={}){
  await context.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;
    if(p==='/api/talent/active-rooms') return json(route,{rooms:library?[]:[{gigId:A,performerName:'Readiness Test',talentRole:'DJ',routePath:'/g/'+A,startedAt:session.startedAt,requestCount:1}]});
    if(p==='/api/state'||p.startsWith('/api/state/')) {
      const response = state(A);
      if(queueCount > 1) response.requests = ['hold', 'approved'].flatMap(status => Array.from({length:queueCount}, (_,i)=>({...request, id:status+'-'+i, status, title:(status==='hold'?'Pending':'Approved')+' Track '+(i+1)})));
      return json(route,response);
    }
    if(p==='/api/payment/config') return json(route,{mode:'test',liveRoomMoneyEnabled:true,testModePlatformBalanceEnabled:true,payoutDestinationCapabilities:{}});
    if(p==='/api/moderation/remove') return json(route,{error:'Synthetic removal failure'},503);
    if(p==='/api/talent/library/tracks'){const tracks=prefix=>Array.from({length:count},(_,i)=>({id:prefix+i,title:prefix+' Track '+(i+1),artist:'Synthetic Artist',album:null,artworkUrl:null,sourceLabel:prefix,sourceKey:prefix})); return json(route,{catalog:{tracks:tracks('Catalog')},external:{tracks:tracks('External')}});}
    if(p.endsWith('/sources')) return json(route,{sources:[]}); return json(route,{});
  });
}
await test('visible-remove-failure',async(page,context)=>{
  await appRoutes(context); await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html?mode=talent');
  const trigger=page.getByRole('button',{name:'Remove Shoutout and reverse payment'}).filter({visible:true}); await trigger.click();
  await page.locator('[data-sway-confirm-remove="true"]').click();
  await page.getByText('That queue action failed. Please try again.',{exact:true}).filter({visible:true}).waitFor();
});
for(const count of [31,1001]) await test('library-last-track-'+count,async(page,context)=>{
  await appRoutes(context,{library:true,count}); await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html?mode=library');
  await page.locator('[data-sway-library-workspace="true"]').waitFor();
  const search=page.getByRole('searchbox',{name:'Search request library'}); await search.fill('External Track '+count);
  await page.getByText('External Track '+count,{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'No horizontal page overflow');
});
await test('slow-poll-completes',async(page,context)=>{
  let count=0; await context.route('**/api/state/*',async route=>{count++;await new Promise(resolve=>setTimeout(resolve,5500));await json(route,state('room-A')).catch(()=>{});});
  await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html');
  await page.waitForFunction(()=>JSON.parse(document.querySelector('[data-testid="room-state"]').textContent).shown==='room-A',null,{timeout:9000});
  assert.equal(count,1,'Periodic polls must not continually cancel a slow valid request');
});
for(const status of [401,403,404]) await test('clear-on-'+status,async(page,context)=>{
  let fail=false;await context.route('**/api/state/*',route=>fail?json(route,{error:'No access'},status):json(route,state('room-A')));
  await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html');await shown(page,'room-A');fail=true;
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await shown(page,null);
  assert.equal((await read(page)).requests.length,0,'No retained private queue after access loss');
});
await test('performer-stale-readonly-and-retry',async(page,context)=>{
  await appRoutes(context);let fail=false;await context.route('**/api/state/'+A,route=>fail?json(route,{error:'Temporary failure'},503):json(route,state(A)));
  await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html?mode=talent');await page.getByRole('button',{name:'Remove Shoutout and reverse payment'}).filter({visible:true}).waitFor();fail=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('re-fetch-state')));await page.getByRole('button',{name:'Retry connection',exact:true}).waitFor();
  assert.ok(await page.locator('[inert]').count(),'Live controls must be inert while stale');assert.ok((await page.locator('[inert]').innerText()).includes('Shoutout'),'Last confirmed queue remains visible');
  fail=false;await page.getByRole('button',{name:'Retry connection',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[inert]'));
});
for(const viewport of [{width:320,height:568},{width:844,height:390},{width:1366,height:768}]) for(const count of [0,1,30,31,200,1001]) await test('library-'+viewport.width+'x'+viewport.height+'-'+count,async(page,context)=>{
  await appRoutes(context,{library:true,count}); await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html?mode=library');
  const library=page.locator('[data-sway-library-workspace="true"]');await library.waitFor();
  await library.getByText((count*2)+' tracks',{exact:true}).waitFor();
  const search=page.getByRole('searchbox',{name:'Search request library'});
  if(count>30){const pages=page.getByRole('navigation',{name:'Catalog pages',exact:true});await pages.getByRole('button',{name:'Next',exact:true}).click();await page.getByText('Catalog Track 31',{exact:true}).waitFor();await pages.getByRole('button',{name:'Previous',exact:true}).click();}
  if(count>0){await search.fill('External Track '+count);const last=page.getByText('External Track '+count,{exact:true});await last.waitFor();await last.scrollIntoViewIfNeeded();const box=await last.boundingBox();assert.ok(box && box.y>=0 && box.y+box.height<=viewport.height+1,'Last matching track must be reachable');}
  else await page.getByText('Your request library is empty',{exact:true}).waitFor();
  await search.fill('no-such-test-track');if(count>0)await page.getByText('No matching tracks. Try another song, artist, or source.',{exact:true}).waitFor();
  await search.fill('');await search.focus();assert.equal(await search.evaluate(node=>document.activeElement===node),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'No horizontal page overflow');
  if(count===31)await page.screenshot({path:path.join(artifacts,'library-'+viewport.width+'.png'),fullPage:true});
},viewport);
for(const viewport of [{width:320,height:568},{width:844,height:390},{width:1366,height:768}]) for(const expanded of [false,true]) await test('room-tools-'+viewport.width+'-'+(expanded?'expanded':'collapsed'),async(page,context)=>{
  await appRoutes(context);await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html?mode=talent');
  const trigger=page.getByRole('button',{name:'Room tools',exact:true});await trigger.click();
  const dialog=page.getByRole('dialog',{name:'Room tools',exact:true});const close=dialog.getByRole('button',{name:'Close room tools',exact:true});
  if(expanded)await dialog.locator('summary').filter({hasText:'Keyboard, MIDI, Stream Deck, and other DJ software'}).click();
  await close.focus();await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.evaluate(node=>node.contains(document.activeElement)),true,'Reverse Tab must stay in the dialog');
  await page.keyboard.press('Tab');assert.equal(await close.evaluate(node=>document.activeElement===node),true,'Tab must wrap to Close');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==='Room tools');
  assert.equal(await page.locator('[data-sway-performer-live-cockpit="true"] > div[inert]').count(),0,'Closing tools must restore live controls');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'No horizontal page overflow');
  if(!expanded)await page.screenshot({path:path.join(artifacts,'cockpit-'+viewport.width+'.png'),fullPage:true});
},viewport);
// Width-only tests miss controls clipped by fixed-height ancestors. Verify the actual
// controls after ordinary scrolling, including each clipping ancestor and the viewport.
async function reachable(locator, label) {
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate(node => {
    const rect=node.getBoundingClientRect();
    let left=0,top=0,right=innerWidth,bottom=innerHeight;
    for(let parent=node.parentElement;parent;parent=parent.parentElement){
      const style=getComputedStyle(parent), bounds=parent.getBoundingClientRect();
      if(/hidden|clip|auto|scroll/.test(style.overflowX)){left=Math.max(left,bounds.left);right=Math.min(right,bounds.right);}
      if(/hidden|clip|auto|scroll/.test(style.overflowY)){top=Math.max(top,bounds.top);bottom=Math.min(bottom,bounds.bottom);}
    }
    return {width:rect.width,height:rect.height,fullyVisible:rect.left>=left-1&&rect.right<=right+1&&rect.top>=top-1&&rect.bottom<=bottom+1};
  });
  assert.ok(result.width>0&&result.height>0&&result.fullyVisible,label+' must be reachable without clipping: '+JSON.stringify(result));
}
for(const viewport of [{width:320,height:568},{width:390,height:844},{width:844,height:390},{width:320,height:360}]) {
  await test('share-controls-reachable-'+viewport.width+'x'+viewport.height,async(page,context)=>{
    await appRoutes(context);await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html?mode=talent');
    await page.getByRole('button',{name:'Share Room',exact:true}).click();
    const share=page.locator('[data-sway-performer-room-share="true"]');
    const qr=share.locator('canvas');await reachable(qr,'Room QR');
    assert.ok((await qr.boundingBox()).width>=100,'QR must remain large enough to scan');
    for(const name of ['Copy Room Link','Copy Room Screen']) await reachable(share.getByRole('button',{name,exact:true}),name);
    for(const name of ['Open Room','Open Room Screen']) await reachable(share.getByRole('link',{name,exact:true}),name);
    await reachable(page.getByRole('button',{name:'Room tools',exact:true}),'Room tools');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'No page-wide horizontal scroll');
    await page.screenshot({path:path.join(artifacts,'share-'+viewport.width+'x'+viewport.height+'.png'),fullPage:true});
  },viewport);
  await test('playback-controls-reachable-'+viewport.width+'x'+viewport.height,async(page,context)=>{
    await appRoutes(context);await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html?mode=talent');
    await page.getByRole('button',{name:'Controls',exact:true}).click();
    await reachable(page.getByRole('combobox',{name:'Playback source',exact:true}),'Playback source');
    await reachable(page.getByRole('button',{name:'Play deck 1',exact:true}),'Play');
    await reachable(page.getByRole('button',{name:'Next deck 1',exact:true}),'Next');
    await reachable(page.locator('[data-sway-performer-room-controls="true"]').getByRole('button',{name:'End Room',exact:true}),'End room within controls');
  },viewport);
}
for(const viewport of [{width:320,height:568},{width:844,height:390},{width:1366,height:768}]) await test('queue-last-page-'+viewport.width,async(page,context)=>{
  await appRoutes(context,{queueCount:1001});await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html?mode=talent');
  const pending=page.getByRole('region',{name:'Pending requests',exact:true});
  const approved=page.getByRole('region',{name:'Approved requests',exact:true});
  await pending.locator('article').first().waitFor();
  assert.equal(await pending.locator('article').count(),5,'Queue must render a bounded page');
  await approved.getByRole('combobox',{name:'Approved request page',exact:true}).selectOption('200');
  const last=approved.getByRole('button',{name:'Remove Approved Track 1001 and reverse payment',exact:true});
  await reachable(last,'Last request removal');
  assert.equal(await pending.locator('article').count(),5,'Paging approved requests must preserve pending requests');
  await last.click();
  const dialog=page.locator('[data-sway-remove-confirmation="true"]');
  await reachable(dialog.getByRole('button',{name:'Cancel',exact:true}),'Confirmation cancel');
  assert.equal(await page.locator('.sway-live-layout[inert]').count(),1,'A confirmation must block background room controls');
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  assert.equal(await page.locator('.sway-live-layout[inert]').count(),0,'Cancel must release the room controls');
  await page.screenshot({path:path.join(artifacts,'queue-'+viewport.width+'.png'),fullPage:true});
},viewport);
await test('clipboard-failure-visible',async(page,context)=>{
  await context.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('Clipboard denied');}}});});
  await appRoutes(context);await page.goto(base+'/scripts/browser-fixtures/sway-readiness-223.html?mode=talent');
  await page.getByRole('button',{name:'Share Room',exact:true}).click();
  const share=page.locator('[data-sway-performer-room-share="true"]');await share.getByRole('button',{name:'Copy Room Link',exact:true}).click();
  await share.getByRole('alert').waitFor();
  assert.equal(await share.getByRole('button',{name:'Copied',exact:true}).count(),0,'Failed copy must never show success');
});
} finally { await browser.close(); await vite.close(); }
fs.writeFileSync(path.join(artifacts,'results.json'),JSON.stringify({browserVersion,backend:'Mocked API only; no production or provider calls',sourceHashes,results},null,2));
console.log('TOTAL',results.length,'PASS',results.filter(x=>x.status==='PASS').length,'FAIL',results.filter(x=>x.status==='FAIL').length);
process.exitCode=results.some(x=>x.status==='FAIL')?1:0;
