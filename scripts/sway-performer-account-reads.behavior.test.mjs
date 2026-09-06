import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

// Component-state proof in Node. This does not launch a browser or prove layout,
// server authorization, persistence, or real accounts. All HTTP is synthetic.
const root = process.cwd();
const shell = resolve(root, 'src/shells/TalentApp.tsx');
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
const entry = `import React,{act} from 'react'; import {createRoot} from 'react-dom/client';
import TalentApp from './src/shells/TalentApp.tsx';
window.IS_REACT_ACT_ENVIRONMENT=true;
window.__act=act;window.__reads=[];window.__posts=[];window.__applied=[];window.__errors=[];
// Intentionally ignore abort signals when settling reads: canceled transports
// and response-body work can still finish. The component must reject them.
window.fetch=(url,options={})=>new Promise((resolve,reject)=>window.__reads.push({url,signal:options.signal,resolve,reject}));
window.__post=(url,body)=>{
  if(url==='/api/session/start'||url==='/api/account/logout')return new Promise((resolve,reject)=>window.__posts.push({url,body,resolve,reject}));
  window.__posts.push({url,body});return Promise.resolve({});
};
window.__root=createRoot(document.getElementById('root'));
window.__mount=()=>act(async()=>window.__root.render(React.createElement(React.StrictMode,null,React.createElement(TalentApp))));
window.__reactVersion=React.version;`;
const bundled = await build({
  stdin:{contents:entry,resolveDir:root,sourcefile:'performer-account-test-entry.js',loader:'js'},
  bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',
  define:{'process.env.NODE_ENV':'"development"'},
  plugins:[{name:'isolate-performer-shell',setup(builder){
    builder.onResolve({filter:/.*/},args=>resolve(args.importer)===shell && Object.hasOwn(stubs,args.path)
      ? {path:args.path,namespace:'performer-account-stub'} : undefined);
    builder.onLoad({filter:/.*/,namespace:'performer-account-stub'},args=>({contents:stubs[args.path],loader:'js',resolveDir:root}));
  }}]
});
const profile = (owner='A',name='Performer '+owner) => ({performer_id:'performer-'+owner,owner_user_id:'owner-'+owner,handle:'performer-'+owner.toLowerCase(),display_name:name,roles:['dj'],primary_role:'dj',specialties:[],email_verified_at:'2026-09-06T00:00:00Z'});
const rooms = id => [{gigId:id,performerName:id,talentRole:'DJ',routePath:'/g/'+id,startedAt:null,requestCount:0}];
const cases = [];
const test = (name,run) => cases.push([name,run]);

async function fixture() {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM('<div id="root"></div>', {url:'https://sway.test/talent/gigs',runScripts:'outside-only',virtualConsole});
  const w = dom.window;
  const channels=[];
  w.MessageChannel=class extends MessageChannel { constructor(){super();channels.push(this);} };
  w.eval(bundled.outputFiles[0].text);
  await w.__mount();
  const step = async callback => { await w.__act(async()=>{callback?.();await Promise.resolve();}); };
  const reads = url => w.__reads.filter(read=>read.url===url);
  const latest = url => reads(url).at(-1);
  const answer = (read,payload,status=200) => step(()=>read.resolve({ok:status>=200&&status<300,status,json:async()=>payload}));
  const reject = read => step(()=>read.reject(new Error('Synthetic read failure')));
  const refreshProfile = async () => { await step(()=>w.dispatchEvent(new w.Event('sway:performer-profile-updated'))); return latest('/api/state'); };
  const refreshRooms = async () => {
    await step(()=>{w.__dash.onFulfill('synthetic-request').catch(error=>w.__errors.push(error.message));});
    return latest('/api/talent/active-rooms');
  };
  const select = id => step(()=>w.__dash.onSelectGigId(id));
  const logout = () => step(()=>Array.from(w.document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Log out').click());
  const start = () => step(()=>{w.__dash.onStartSession({gig_id:'new-room',talentName:'New Room',talentRole:'DJ',feeType:'patron',minimumTip:5,paymentsEnabled:false,searchScope:'library'}).catch(error=>w.__errors.push(error.message));});
  const init = async () => {
    await answer(latest('/api/state'),{performerProfile:profile()});
    const pending = latest('/api/talent/active-rooms');
    if(pending) await answer(pending,{rooms:[]});
  };
  const close = async () => { await step(()=>w.__root.unmount());dom.window.close();for(const channel of channels){channel.port1.close();channel.port2.close();} };
  return {w,step,reads,latest,answer,reject,refreshProfile,refreshRooms,select,logout,start,init,close};
}

test('newer-profile-response-wins',async f=>{
  await f.init();const older=await f.refreshProfile();const newer=await f.refreshProfile();
  await f.answer(newer,{performerProfile:profile('A','New name')});
  await f.answer(older,{performerProfile:profile('A','Old name')});
  assert.equal(f.w.__dash.performerProfile.display_name,'New name');
});
test('older-profile-failure-cannot-clear-newer-profile',async f=>{
  await f.init();const older=await f.refreshProfile();const newer=await f.refreshProfile();
  await f.answer(newer,{performerProfile:profile('A','Confirmed name')});await f.reject(older);
  assert.equal(f.w.__dash.performerProfile?.display_name,'Confirmed name');
});
test('profile-ordering-includes-delayed-json-body',async f=>{
  await f.init();const older=await f.refreshProfile();let release;
  await f.step(()=>older.resolve({ok:true,status:200,json:()=>new Promise(resolve=>{release=resolve;})}));
  const newer=await f.refreshProfile();await f.answer(newer,{performerProfile:profile('B')});
  await f.step(()=>release({performerProfile:profile('A')}));
  assert.equal(f.w.__dash.performerProfile.owner_user_id,'owner-B');
});
test('newer-room-list-response-wins',async f=>{
  await f.init();await f.select('selected-room');
  const older=await f.refreshRooms();const newer=await f.refreshRooms();
  await f.answer(newer,{rooms:rooms('current-room')});await f.answer(older,{rooms:rooms('obsolete-room')});
  assert.equal(f.w.__dash.activeRooms[0].gigId,'current-room');
  assert.equal(f.w.__dash.selectedGigId,'selected-room');
});
test('room-list-ordering-includes-delayed-json-body',async f=>{
  await f.init();await f.select('selected-room');const older=await f.refreshRooms();let release;
  await f.step(()=>older.resolve({ok:true,status:200,json:()=>new Promise(resolve=>{release=resolve;})}));
  const newer=await f.refreshRooms();await f.answer(newer,{rooms:rooms('current-room')});
  await f.step(()=>release({rooms:rooms('obsolete-room')}));
  assert.equal(f.w.__dash.activeRooms[0].gigId,'current-room');
});
test('account-change-clears-old-selection-and-room-list',async f=>{
  await f.init();await f.select('room-A');await f.answer(await f.refreshRooms(),{rooms:rooms('room-A')});
  await f.answer(await f.refreshProfile(),{performerProfile:profile('B')});
  assert.equal(f.w.__dash.selectedGigId,null);
  assert.equal(f.w.__dash.activeRooms.length,0);
});
test('old-account-room-response-cannot-enter-new-account',async f=>{
  await f.init();await f.select('room-A');const older=await f.refreshRooms();
  await f.answer(await f.refreshProfile(),{performerProfile:profile('B')});
  const newer=f.latest('/api/talent/active-rooms');
  assert.notEqual(newer,older,'New account must read its own room registry');
  await f.answer(newer,{rooms:rooms('room-B')});await f.answer(older,{rooms:rooms('room-A')});
  assert.equal(f.w.__dash.activeRooms[0].gigId,'room-B');assert.equal(f.w.__dash.selectedGigId,'room-B');
});
test('profile-access-loss-clears-room-selection',async f=>{
  await f.init();await f.select('room-A');await f.answer(await f.refreshRooms(),{rooms:rooms('room-A')});
  await f.answer(await f.refreshProfile(),{},401);
  assert.equal(f.w.__dash.performerProfile,null);assert.equal(f.w.__dash.selectedGigId,null);assert.equal(f.w.__dash.activeRooms.length,0);
});
test('room-registry-access-loss-clears-private-context',async f=>{
  await f.init();await f.select('room-A');await f.answer(await f.refreshRooms(),{},403);
  assert.equal(f.w.__dash.performerProfile,null);assert.equal(f.w.__dash.selectedGigId,null);assert.equal(f.w.__dash.activeRooms.length,0);
});
test('same-account-profile-save-preserves-selection',async f=>{
  await f.init();await f.select('ending-room');await f.answer(await f.refreshProfile(),{performerProfile:profile('A','Updated name')});
  assert.equal(f.w.__dash.selectedGigId,'ending-room');
});
test('empty-registry-preserves-ending-room-selection',async f=>{
  await f.init();await f.select('ending-room');await f.answer(await f.refreshRooms(),{rooms:[]});
  assert.equal(f.w.__dash.selectedGigId,'ending-room');
});
test('logout-intent-rejects-older-profile-and-room-reads',async f=>{
  await f.init();await f.select('room-A');const olderProfile=await f.refreshProfile();const olderRooms=await f.refreshRooms();
  await f.logout();await f.answer(olderProfile,{performerProfile:profile('B')});await f.answer(olderRooms,{rooms:rooms('obsolete-room')});
  assert.equal(f.w.__dash.performerProfile.owner_user_id,'owner-A');assert.equal(f.w.__dash.activeRooms.length,0);
  const count=f.w.__reads.length;await f.refreshProfile();assert.equal(f.w.__reads.length,count,'No refresh may start while logout is pending');
});
test('unmount-cancels-both-read-streams',async f=>{
  await f.init();const profileRead=await f.refreshProfile();const roomRead=await f.refreshRooms();
  await f.step(()=>f.w.__root.unmount());
  assert.equal(profileRead.signal?.aborted,true);assert.equal(roomRead.signal?.aborted,true);
  await f.answer(profileRead,{performerProfile:profile('B')});await f.answer(roomRead,{rooms:rooms('late-room')});
  assert.equal(f.w.document.getElementById('root').textContent,'');
});
test('normal-start-still-selects-confirmed-room',async f=>{
  await f.init();await f.start();const post=f.w.__posts.find(item=>item.url==='/api/session/start');
  await f.step(()=>post.resolve({state:{activeGigId:'new-room',session:{status:'active'},requests:[]}}));
  assert.equal(f.w.__dash.selectedGigId,'new-room');assert.equal(f.w.__applied.length,0);
});
test('account-change-during-start-cannot-restore-old-room',async f=>{
  await f.init();await f.select('room-A');await f.start();
  await f.answer(await f.refreshProfile(),{performerProfile:profile('B')});
  await f.step(()=>f.w.__posts.find(item=>item.url==='/api/session/start').resolve({state:{activeGigId:'new-room'}}));
  assert.equal(f.w.__dash.selectedGigId,null);assert.equal(f.w.__applied.length,0);
});
test('same-account-save-does-not-cancel-start',async f=>{
  await f.init();await f.start();await f.answer(await f.refreshProfile(),{performerProfile:profile('A','Updated name')});
  await f.step(()=>f.w.__posts.find(item=>item.url==='/api/session/start').resolve({state:{activeGigId:'new-room'}}));
  assert.equal(f.w.__dash.selectedGigId,'new-room');
});

test('temporary-profile-failure-preserves-confirmed-room-and-recovers',async f=>{
  await f.init();await f.select('ending-room');await f.reject(await f.refreshProfile());
  assert.equal(f.w.__dash.performerProfile.owner_user_id,'owner-A');assert.equal(f.w.__dash.selectedGigId,'ending-room');
  assert.match(f.w.document.querySelector('[role="alert"]').textContent,/profile could not refresh/i);
  await f.answer(await f.refreshProfile(),{performerProfile:profile()});
  assert.equal(f.w.document.querySelector('[role="alert"]'),null);
});
test('initial-profile-failure-is-visible-on-performer-home',async f=>{
  await f.reject(f.latest('/api/state'));
  assert.match(f.w.document.querySelector('[role="alert"]').textContent,/profile could not refresh/i);
  assert.equal(f.w.__dash.activeRooms.length,0);
});
test('registry-access-loss-invalidates-pending-profile-response',async f=>{
  await f.init();await f.select('room-A');const older=await f.refreshProfile();
  await f.answer(await f.refreshRooms(),{},403);await f.answer(older,{performerProfile:profile()});
  assert.equal(f.w.__dash.performerProfile,null);assert.equal(f.w.__dash.selectedGigId,null);
});
test('obsolete-registry-denial-cannot-clear-newer-success',async f=>{
  await f.init();await f.select('room-A');const older=await f.refreshRooms();const newer=await f.refreshRooms();
  await f.answer(newer,{rooms:rooms('current-room')});await f.answer(older,{},403);
  assert.equal(f.w.__dash.performerProfile.owner_user_id,'owner-A');assert.equal(f.w.__dash.activeRooms[0].gigId,'current-room');
});
test('old-account-action-completion-cannot-cancel-new-account-read',async f=>{
  await f.init();await f.select('room-A');let finish;
  f.w.__post=()=>new Promise(resolve=>{finish=resolve;});
  await f.step(()=>{f.w.__dash.onFulfill('synthetic-request').catch(error=>f.w.__errors.push(error.message));});
  await f.answer(await f.refreshProfile(),{performerProfile:profile('B')});
  const current=f.latest('/api/talent/active-rooms');const count=f.w.__reads.length;
  await f.step(()=>finish({}));
  assert.equal(f.w.__reads.length,count);assert.equal(current.signal.aborted,false);
  await f.answer(current,{rooms:rooms('room-B')});assert.equal(f.w.__dash.selectedGigId,'room-B');
});
test('failed-logout-shows-error-and-restores-refresh',async f=>{
  await f.init();await f.logout();await f.logout();
  assert.equal(f.w.__posts.filter(post=>post.url==='/api/account/logout').length,1);
  await f.step(()=>f.w.__posts.find(post=>post.url==='/api/account/logout').reject(new Error('Synthetic logout failure')));
  assert.match(f.w.document.querySelector('[role="alert"]').textContent,/log out failed/i);
  await f.answer(f.latest('/api/state'),{performerProfile:profile('A','Recovered name')});
  assert.equal(f.w.__dash.performerProfile.display_name,'Recovered name');
});

test('co-batched-account-switch-cannot-auto-select-old-room',async f=>{
  await f.answer(f.latest('/api/state'),{performerProfile:profile()});
  const olderRooms=f.latest('/api/talent/active-rooms');const newProfile=await f.refreshProfile();
  await f.step(()=>{
    olderRooms.resolve({ok:true,status:200,json:async()=>({rooms:rooms('room-A')})});
    newProfile.resolve({ok:true,status:200,json:async()=>({performerProfile:profile('B')})});
  });
  assert.equal(f.w.__dash.performerProfile.owner_user_id,'owner-B');
  assert.equal(f.w.__dash.selectedGigId,null);assert.equal(f.w.__dash.activeRooms.length,0);
});
test('old-registry-denial-cannot-cancel-newer-account-profile',async f=>{
  await f.init();const olderRooms=await f.refreshRooms();const newProfile=await f.refreshProfile();
  await f.step(()=>{
    newProfile.resolve({ok:true,status:200,json:async()=>({performerProfile:profile('B')})});
    olderRooms.resolve({ok:false,status:403,json:async()=>({})});
  });
  assert.equal(f.w.__dash.performerProfile?.owner_user_id,'owner-B');
  assert.equal(newProfile.signal.aborted,false);
});
test('newer-profile-delayed-json-survives-older-registry-denial',async f=>{
  await f.init();await f.select('room-A');
  const olderRooms=await f.refreshRooms();const newerProfile=await f.refreshProfile();let release;
  await f.step(()=>newerProfile.resolve({ok:true,status:200,json:()=>new Promise(resolve=>{release=resolve;})}));
  await f.answer(olderRooms,{},403);
  assert.equal(newerProfile.signal.aborted,false);
  assert.equal(f.w.__dash.performerProfile,null);assert.equal(f.w.__dash.selectedGigId,null);
  await f.step(()=>release({performerProfile:profile('B')}));
  assert.equal(f.w.__dash.performerProfile.owner_user_id,'owner-B');
  await f.answer(f.latest('/api/talent/active-rooms'),{rooms:rooms('room-B')});
  assert.equal(f.w.__dash.selectedGigId,'room-B');
});
test('queued-new-profile-survives-old-registry-denial',async f=>{
  await f.init();const olderRooms=await f.refreshRooms();const newerProfile=await f.refreshProfile();
  await f.w.__act(async()=>{
    newerProfile.resolve({ok:true,status:200,json:async()=>({performerProfile:profile('B')})});
    await Promise.resolve();await Promise.resolve();
    assert.equal(f.w.__dash.performerProfile.owner_user_id,'owner-A','The B update must still be queued, before React commits it');
    olderRooms.resolve({ok:false,status:403,json:async()=>({})});
    await Promise.resolve();
  });
  assert.equal(f.w.__dash.performerProfile.owner_user_id,'owner-B');assert.equal(newerProfile.signal.aborted,false);
});
test('older-profile-delayed-json-is-revoked-by-newer-registry-denial',async f=>{
  await f.init();await f.select('room-A');const olderProfile=await f.refreshProfile();let release;
  await f.step(()=>olderProfile.resolve({ok:true,status:200,json:()=>new Promise(resolve=>{release=resolve;})}));
  await f.answer(await f.refreshRooms(),{},403);
  assert.equal(olderProfile.signal.aborted,true);
  await f.step(()=>release({performerProfile:profile('B')}));
  assert.equal(f.w.__dash.performerProfile,null);assert.equal(f.w.__dash.selectedGigId,null);assert.equal(f.w.__dash.activeRooms.length,0);
});
for(const roundTrip of ['A-B-A','access-loss-and-recovery']) test('expired-action-cannot-cancel-current-read-'+roundTrip,async f=>{
  await f.init();await f.select('room-A');let finish;
  f.w.__post=()=>new Promise(resolve=>{finish=resolve;});
  await f.step(()=>{f.w.__dash.onFulfill('synthetic-request').catch(error=>f.w.__errors.push(error.message));});
  if(roundTrip==='A-B-A') await f.answer(await f.refreshProfile(),{performerProfile:profile('B')});
  else await f.answer(await f.refreshProfile(),{},401);
  await f.answer(await f.refreshProfile(),{performerProfile:profile('A')});
  const current=f.latest('/api/talent/active-rooms');const count=f.w.__reads.length;
  await f.step(()=>finish({}));
  assert.equal(f.w.__reads.length,count);assert.equal(current.signal.aborted,false);
  await f.answer(current,{rooms:rooms('current-room')});assert.equal(f.w.__dash.selectedGigId,'current-room');
});

const results=[];
for (const [name,run] of cases) {
  let f;
  try { f=await fixture();await run(f);results.push({name,status:'PASS'}); }
  catch(error) {results.push({name,status:'FAIL',error:String(error)});}
  finally {if(f)await f.close();}
  console.log(results.at(-1));
}
const evidence=resolve(root,'artifacts/readiness-223',process.env.PROOF_RUN || 'account-reads');
mkdirSync(evidence,{recursive:true});
writeFileSync(join(evidence,'results.json'),JSON.stringify({
  node:process.version,react:JSON.parse(readFileSync(resolve(root,'node_modules/react/package.json'),'utf8')).version,
  shellSha256:createHash('sha256').update(readFileSync(shell)).digest('hex'),
  scope:'Actual performer shell and locked React/ReactDOM in Node JSDOM. Child UI, room-state hook and all HTTP are mocked. No browser/layout, real account, server authorization, persistence or provider proof.',
  results
},null,2)+'\n');
console.log('Performer account read behavior:',results.filter(result=>result.status==='PASS').length+'/'+cases.length,'PASS');
if(results.some(result=>result.status==='FAIL')) process.exit(1);
