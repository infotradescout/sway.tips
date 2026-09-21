import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const candidate = '9b0b80f75e2bb949daaca61d2edb53f62c31cbf0';
const base = '757f92edc45cc7b8b4a17ea161d465697a221c3e';
const metadataRelease = '7c8e3558da82b7d3d7c73ae1ac62c5bead830e70';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(),'sway-attribution-'));
const checkout = path.join(temporary,'repo');
const output = path.resolve('.validation-public');
fs.mkdirSync(output,{recursive:true});
const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{CI:'true',NODE_OPTIONS:'--max-old-space-size=3072'});
const report = {candidate,base,startedAt:new Date().toISOString(),steps:[],browser:[],result:'fail',productionChanged:false,humanTrafficMeasured:false};
let server, browser;
async function run(label, command, args, cwd=checkout, expectedExit=0) {
 console.log('ATTRIBUTION_STEP_START '+label);
 let stdout='',stderr='';
 const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),1200000);
 child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b);});
 child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b);});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
 fs.writeFileSync(path.join(output,label+'.log'),stdout+stderr);
 const step={label,exit:code,expectedExit,at:new Date().toISOString()};report.steps.push(step);
 console.log('ATTRIBUTION_STEP_END '+JSON.stringify(step));
 assert.equal(code,expectedExit,label+' failed');return stdout.trim();
}
try {
 for(const k of ['DATABASE_URL','TEST_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','BREVO_API_KEY','SENDGRID_API_KEY','SMTP_PASS'])assert(!process.env[k],'No production credentials');
 await run('clone','git',['clone','--no-hardlinks','--no-checkout',process.cwd(),checkout],temporary);
 await run('fetch','git',['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',candidate]);
 await run('checkout','git',['checkout','--detach',candidate]);
 assert.equal(await run('head','git',['rev-parse','HEAD']),candidate);
 assert.equal(await run('initial-clean','git',['status','--porcelain']),'');
 for(const [file,sha] of Object.entries({'src/shells/discoveryAttribution.ts':'bbd6fc884ab972592636bb99b423a589a31db4b7','scripts/sway-discovery-attribution.test.mjs':'cd37236a40f9e1aab10d8fde81b7681460740be3','scripts/sway-telemetry.contract.test.mjs':'533b978f3ec65079b01d0fcca85a61ff88232251'}))assert.equal(await run('blob-'+path.basename(file),'git',['hash-object',file]),sha);
 await run('npm-ci','npm',['ci','--include=dev','--no-audit','--no-fund']);
 await run('telemetry-contract',process.execPath,['scripts/sway-telemetry.contract.test.mjs']);
 const baseline=path.join(temporary,'baseline');fs.mkdirSync(path.join(baseline,'src/shells'),{recursive:true});fs.mkdirSync(path.join(baseline,'scripts'));
 fs.writeFileSync(path.join(baseline,'src/shells/discoveryAttribution.ts'),await run('baseline-source','git',['show',base+':src/shells/discoveryAttribution.ts']));
 fs.copyFileSync(path.join(checkout,'scripts/sway-discovery-attribution.test.mjs'),path.join(baseline,'scripts/sway-discovery-attribution.test.mjs'));
 const baselineTap=await run('baseline-regressions',process.execPath,['--import','tsx','--test','--test-reporter=tap',path.join(baseline,'scripts/sway-discovery-attribution.test.mjs')],checkout,1);
 assert.match(baselineTap,/^# tests 9\s*$/m);assert.match(baselineTap,/^# fail [1-9]\d*\s*$/m);
 report.baselineFailingTests=Number(baselineTap.match(/^# fail (\d+)\s*$/m)[1]);
 await run('lint','npm',['run','lint']);await run('build','npm',['run','build']);
 const require=createRequire(path.join(checkout,'package.json'));
 const {buildSync}=require('esbuild');const {chromium}=require('playwright');
 const bundle=buildSync({stdin:{contents:"import * as attribution from './src/shells/discoveryAttribution';import {sendDiscoveryEvent} from './src/shells/frictionClient';window.acquisition={...attribution,sendDiscoveryEvent};",resolveDir:checkout,sourcefile:'attribution-browser-fixture.ts',loader:'ts'},bundle:true,write:false,platform:'browser',format:'iife'}).outputFiles[0].text;
 const received=[];
 server=http.createServer((req,res)=>{
  if(req.method==='POST'&&req.url==='/api/analytics/shell'){
   let body='';req.on('data',b=>{body+=b;if(body.length>16000)req.destroy();});req.on('end',()=>{try{received.push(JSON.parse(body));res.writeHead(202,{'content-type':'application/json'});res.end('{"recorded":"synthetic-local-receiver"}');}catch{res.writeHead(400);res.end();}});return;
  }
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  if(req.url==='/fixture.js'){res.writeHead(200,{'content-type':'application/javascript'});res.end(bundle);return;}
  res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Owned attribution module fixture</title><script src="/fixture.js"></script><p>Local diagnostic only.</p>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const width of [390,1440])for(const mode of ['available','getters-denied','methods-denied']){
  const context=await browser.newContext({viewport:{width,height:844},serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  await context.addInitScript(mode=>{
   if(mode==='getters-denied')for(const key of ['localStorage','sessionStorage'])Object.defineProperty(window,key,{get(){throw new DOMException('Diagnostic storage denial','SecurityError');}});
   if(mode==='methods-denied')for(const key of ['getItem','setItem','removeItem'])Storage.prototype[key]=function(){throw new DOMException('Diagnostic storage denial','SecurityError');};
  },mode);
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/discover?utm_source=google',{waitUntil:'load'});await page.waitForFunction(()=>Boolean(window.acquisition));
  const before=received.length;
  const events=['discovery_landing','discovery_entity_view','discovery_primary_action'];
  const responses=events.map(event=>page.waitForResponse(r=>r.url()===origin+'/api/analytics/shell'&&r.request().postDataJSON()?.event===event,{timeout:10000}));
  await page.evaluate(({events,candidate})=>{
   const a=window.acquisition;a.captureDiscoveryAttribution();
   for(const event of events){
    a.sendDiscoveryEvent(event,{shell:'patron',surface:'public-discover',route_family:'/discover',has_route_context:true,has_session_context:false,build_commit:candidate,attribution_channel:a.getEffectiveDiscoveryChannel()});
    history.replaceState(null,'','/p/diagnostic');
   }
  },{events,candidate});
  for(const response of await Promise.all(responses))assert.equal(response.status(),202);
  const rows=received.slice(before);assert.equal(rows.length,3);assert.equal(new Set(rows.map(r=>r.journey_id)).size,1);
  assert(rows.every(r=>r.attribution_channel==='google'&&r.entry_path==='/discover'));assert.deepEqual(errors,[]);
  const row={width,mode,eventCount:3,uniqueJourneyIds:1,channel:'google',entryPath:'/discover',pageErrors:errors};report.browser.push(row);console.log('ATTRIBUTION_BROWSER '+JSON.stringify(row));
  await context.close();
 }
 await browser.close();browser=null;await new Promise(resolve=>server.close(resolve));server=null;
 await run('full-contracts','npm',['run','test:contracts']);
 await run('tracked-clean','git',['diff','--exit-code','HEAD','--']);
 const artifacts=(await run('generated-output','git',['ls-files','--others','--exclude-standard'])).split('\n').filter(Boolean);
 assert(artifacts.every(p=>p.startsWith('tmp/public-entry-qa/')||p.startsWith('tmp/music-sources-proof/')),'Unexpected untracked outputs');
 report.generatedArtifacts=artifacts.length;report.trackedSourceUnchanged=true;report.result='pass';
 report.scope='Exact source, baseline negative controls, full lint/build/contracts and six real-browser current-client-to-local-HTTP cases. The receiver is synthetic: production ingestion, human traffic classification and increased acquisition are NOT established.';
} catch(error){report.error=String(error.stack||error);console.error('ATTRIBUTION_FAILURE '+report.error);process.exitCode=1;}
finally{
 await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
 // Independent read-only acceptance of the already merged metadata release.
 try{
  const require=createRequire(path.join(checkout,'package.json'));
  const pages=require(path.join(checkout,'scripts/sway-dj-beta-about-preload.cjs'));
  const observation={expected:metadataRelease,pages:[],passed:false};
  const healthResponse=await fetch('https://app.sway.tips/api/release-health',{signal:AbortSignal.timeout(15000)});
  const health=await healthResponse.json();observation.health={status:healthResponse.status,commit:health.commit,releaseActive:health.releaseActive,migrationsCompatible:health.migrations?.compatible};
  assert.equal(healthResponse.status,200);assert.equal(health.commit,metadataRelease);assert.equal(health.releaseActive,true);
  for(const [pathname,html]of [['/about',pages.ABOUT_PAGE_HTML],['/faq',pages.FAQ_PAGE_HTML]])for(const agent of ['sway-runtime-proof/3.0','Googlebot/2.1','OAI-SearchBot/1.3','ChatGPT-User/1.0']){
   const r=await fetch('https://app.sway.tips'+pathname,{headers:{'user-agent':agent,accept:'text/html'},redirect:'manual',signal:AbortSignal.timeout(15000)});
   const item={path:pathname,agent,status:r.status,commit:r.headers.get('x-commit-sha'),exactHtml:(await r.text())===html,noindex:/noindex/i.test(r.headers.get('x-robots-tag')||'')};observation.pages.push(item);
   assert.equal(item.status,200);assert.equal(item.commit,metadataRelease);assert.equal(item.exactHtml,true);assert.equal(item.noindex,false);
  }
  observation.passed=true;report.metadataProductionObservation=observation;
 }catch(error){report.metadataProductionObservation={expected:metadataRelease,passed:false,error:String(error)};}
 console.log('METADATA_DEPLOY_OBSERVATION '+JSON.stringify(report.metadataProductionObservation));
 report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'attribution-evidence.json'),JSON.stringify(report,null,2));
 fs.writeFileSync(path.join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');fs.writeFileSync(path.join(output,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Acquisition repair execution</h1><a href="attribution-evidence.json">Exact-source receipt</a>');
 console.log('ATTRIBUTION_SUMMARY '+JSON.stringify(report));fs.rmSync(temporary,{recursive:true,force:true});
}
