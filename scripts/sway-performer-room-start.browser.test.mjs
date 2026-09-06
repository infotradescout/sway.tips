import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Isolate the actual performer shell's async selection behavior. Child UI,
// room-state reads and HTTP are stubbed; this is NOT a full-app/provider test.
const root = process.cwd();
const shell = resolve(root, 'src/shells/TalentApp.tsx');
const evidence = resolve(root, 'artifacts/readiness-223/room-start');
mkdirSync(evidence, { recursive: true });
const stubs = {
  'lucide-react': 'export const LogOut=()=>null; export const Users=()=>null;',
  'motion/react': 'export const motion={div:({children})=>children};',
  '../components/SplitViewShell': 'export default ({primary})=>primary;',
  '../components/TalentDashboard': `import React from 'react'; export default function Dashboard(props) { window.__dash=props; return React.createElement('output', {'data-testid':'selected'}, props.selectedGigId || 'none'); }`,
  '../demo-mode': 'export const isDemoModeEnabled=()=>false; export const DemoModeBanner=()=>null;',
  '../server/public-profile': `export const resolvePublicProfileHeroName=()=> 'Synthetic Performer'; export const resolvePublicProfilePageKindLabel=()=> 'DJ';`,
  '../live-room-language': 'export const LIVE_ROOM_LANGUAGE={};',
  '../file-collaboration-routing': `export const FILE_COLLABORATION_PATHS={}; export const buildFileConnectLoginHref=()=>''; export const normalizeSafeAccountNextPath=x=>x; export const readFilePairingTokenFromHash=()=>null; export const resolveLegacyFileConnectTarget=()=>'';`,
  '../performer-workspace-routing': `export const resolveInactivePerformerWorkspace=()=> 'room'; export const resolvePerformerLoginWorkspaceRedirect=x=>x; export const shouldRenderPerformerLiveRoom=status=>status!=='inactive';`,
  './shared': `import React,{useMemo,useCallback} from 'react';
    export const LoadingState=()=>React.createElement('p',null,'Loading');
    export const postJson=(url,body)=>window.__post(url,body);
    export function useSwayState({statePath}) {
      const bState=useMemo(()=>({activeGigId:statePath?.split('/').at(-1)||null,session:{status:statePath?'active':'inactive',searchScope:'library'},requests:[]}),[statePath]);
      const setBState=useCallback(value=>window.__applied.push(value),[]);
      return {bState,setBState,isLoading:false,roomActionsBlocked:false};
    }`
};
for (const name of ['TalentInviteAcceptCard','PerformerRightsReviewQueue','PerformerEventDoorPage','VictoryScreen']) {
  stubs['../components/'+name]='export default ()=>null;';
}
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
import TalentApp from './src/shells/TalentApp.tsx';
window.__posts=[]; window.__applied=[]; window.__errors=[]; window.__rooms=[]; window.__reads=0;
window.__profile={performer_id:'performer-A',owner_user_id:'owner-A',handle:'performer-a',display_name:'Synthetic Performer',roles:['dj'],primary_role:'dj',specialties:[],email_verified_at:'2026-09-05T00:00:00Z'};
window.fetch=async url=>{
  if(url==='/api/state')return {ok:true,json:async()=>({performerProfile:window.__profile})};
  if(url==='/api/talent/active-rooms'){window.__reads++;return {ok:true,json:async()=>({rooms:window.__rooms})};}
  throw Error('Unexpected test fetch '+url);
};
window.__post=(url,body)=>new Promise((resolve,reject)=>window.__posts.push({url,body,resolve,reject}));
window.__root=createRoot(document.getElementById('root'));
window.__root.render(React.createElement(React.StrictMode,null,React.createElement(TalentApp)));
window.__start=()=>{
  const task=window.__dash.onStartSession({gig_id:'new-room',talentName:'New Room',talentRole:'DJ',feeType:'patron',minimumTip:5,paymentsEnabled:false,searchScope:'library'});
  task.catch(error=>window.__errors.push(error.message));
};
window.__resolveStart=(index=0,id)=>{
  const post=window.__posts.filter(p=>p.url==='/api/session/start')[index];
  post.resolve({state:{activeGigId:id===undefined?post.body.gig_id:id,session:{status:'active'},requests:[]}});
};
window.__reactVersion=React.version;`;
const bundled = await build({
  stdin:{contents:entry,resolveDir:root,sourcefile:'room-start-test-entry.js',loader:'js'},
  bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"development"'},
  plugins:[{name:'isolate-performer-shell',setup(builder){
    builder.onResolve({filter:/.*/},args=>{
      if(resolve(args.importer)===shell && Object.hasOwn(stubs,args.path)) return {path:args.path,namespace:'room-start-stub'};
    });
    builder.onLoad({filter:/.*/,namespace:'room-start-stub'},args=>({contents:stubs[args.path],loader:'js',resolveDir:root}));
  }}]
});
const settle=page=>page.waitForTimeout(60);
const wait=(page,expression)=>page.waitForFunction(expression,null,{timeout:5000});
const select=async(page,id)=>{await page.evaluate(id=>window.__dash.onSelectGigId(id),id);await wait(page,'window.__dash.selectedGigId==='+JSON.stringify(id));};
const start=page=>page.evaluate(()=>window.__start());
const complete=async(page,id)=>{await page.evaluate(id=>window.__resolveStart(0,id),id);await settle(page);};
const selected=page=>page.evaluate(()=>window.__dash.selectedGigId);
const cases=[
  ['normal-create',async page=>{await start(page);await complete(page);assert.equal(await selected(page),'new-room');}],
  ['fresh-room-read-not-old-snapshot',async page=>{await start(page);await complete(page);assert.equal(await selected(page),'new-room');assert.equal(await page.evaluate(()=>window.__applied.length),0);}],
  ['switch-during-create',async page=>{await select(page,'room-A');await start(page);await select(page,'room-B');await complete(page);assert.equal(await selected(page),'room-B');}],
  ['A-B-A-during-create',async page=>{await select(page,'room-A');await start(page);await page.evaluate(()=>{window.__dash.onSelectGigId('room-B');window.__dash.onSelectGigId('room-A');});await settle(page);await complete(page);assert.equal(await selected(page),'room-A');}],
  ['repeated-start',async page=>{await page.evaluate(()=>{window.__start();window.__start();window.__start();});await settle(page);assert.equal(await page.evaluate(()=>window.__posts.filter(p=>p.url==='/api/session/start').length),1);await complete(page);assert.equal(await selected(page),'new-room');}],
  ['mismatched-response',async page=>{await select(page,'room-A');await start(page);await complete(page,'different-room');assert.equal(await selected(page),'room-A');assert.equal(await page.evaluate(()=>window.__errors.length),1);}],
  ['missing-room-response',async page=>{await start(page);await page.evaluate(()=>window.__posts[0].resolve({state:{}}));await settle(page);assert.equal(await selected(page),null);assert.equal(await page.evaluate(()=>window.__errors.length),1);}],
  ['explicit-retry-same-room-id',async page=>{await start(page);await page.evaluate(()=>window.__posts[0].reject(new Error('Synthetic failure')));await wait(page,'window.__errors.length===1');await start(page);await wait(page,'window.__posts.length===2');await page.evaluate(()=>window.__resolveStart(1));await wait(page,"window.__dash.selectedGigId==='new-room'");assert.equal(await page.evaluate(()=>window.__posts[0].body.gig_id===window.__posts[1].body.gig_id),true);}],
  ['no-automatic-write-retry',async page=>{await start(page);await page.evaluate(()=>window.__posts[0].reject(new Error('Synthetic failure')));await wait(page,'window.__errors.length===1');await settle(page);assert.equal(await page.evaluate(()=>window.__posts.length),1);}],
  ['account-change-during-create',async page=>{await select(page,'room-A');await start(page);await page.evaluate(()=>{window.__profile={...window.__profile,owner_user_id:'owner-B',performer_id:'performer-B'};dispatchEvent(new Event('sway:performer-profile-updated'));});await wait(page,"window.__dash.performerProfile?.owner_user_id==='owner-B'");await complete(page);assert.equal(await selected(page),null,'The previous account room must be cleared');assert.equal(await page.evaluate(()=>window.__applied.length),0);}],
  ['logout-during-create',async page=>{await start(page);await page.getByRole('button',{name:'Log out',exact:true}).click();await wait(page,"window.__posts.some(p=>p.url==='/api/account/logout')");await complete(page);assert.equal(await selected(page),null);}],
  ['unmount-during-create',async page=>{await start(page);const reads=await page.evaluate(()=>window.__reads);await page.evaluate(()=>window.__root.unmount());await complete(page);assert.equal(await page.evaluate(()=>window.__reads),reads);assert.equal(await page.evaluate(()=>window.__applied.length),0);}],
  ['same-account-profile-refresh',async page=>{await start(page);await page.evaluate(()=>{window.__profile={...window.__profile,display_name:'Updated Name'};dispatchEvent(new Event('sway:performer-profile-updated'));});await wait(page,"window.__dash.performerProfile?.display_name==='Updated Name'");await complete(page);assert.equal(await selected(page),'new-room');}]
];
const browser = await chromium.launch({headless:true});
const results=[];
let reactVersion;
try {
  for(const [name,run] of cases){
    const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
    await context.route('**/*',route=>route.abort());
    const page=await context.newPage(); const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({content:bundled.outputFiles[0].text});
      await wait(page,'window.__dash?.performerEmailVerified===true');
      reactVersion=await page.evaluate(()=>window.__reactVersion);
      await settle(page);await run(page);assert.deepEqual(errors,[]);
      results.push({name,status:'PASS'});
    } catch(error){results.push({name,status:'FAIL',error:String(error)});}
    finally {await context.close();console.log(results.at(-1));}
  }
} finally {
  writeFileSync(join(evidence,'results.json'),JSON.stringify({
    browser:browser.version(),react:reactVersion,
    shellSha256:createHash('sha256').update(readFileSync(shell)).digest('hex'),
    scope:'Actual performer shell with mocked children, state hook and HTTP; no network, real account, backend or payment-provider proof.',results
  },null,2)+'\n');
  await browser.close();
}
assert.equal(results.filter(r=>r.status==='FAIL').length,0,'Performer room-start isolation checks failed.');
console.log('Performer room-start isolation: '+results.length+'/'+cases.length+' PASS.');
