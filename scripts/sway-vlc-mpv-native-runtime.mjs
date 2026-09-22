import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const [checkout,deps,out]=process.argv.slice(2);
assert(checkout && deps && out);
const root=path.dirname(checkout), password=randomBytes(24).toString('hex');
const authorization='Basic '+Buffer.from(':'+password).toString('base64');
const socketPath=path.join(root,'mpv.sock');
const children=[], observations=[], forwarded=[];
let proxy, dropNext=false, dropped=0, nativePort;
const receipt={passed:false,scope:'Stock VLC/mpv; independent read-only observations; null audio devices, not physical audio.',observations,forwarded};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function player(name,args) {
 const child=spawn(path.join(deps,'usr/bin',name),args,{env:process.env,stdio:['ignore','pipe','pipe']});
 children.push({name,child}); let log='';
 child.stdout.on('data',b=>{log+=b;}); child.stderr.on('data',b=>{log+=b;});
 child.on('error',e=>{log+='\n'+e.stack;});
 child.on('close',(code,signal)=>{fs.writeFileSync(path.join(out,name+'-player.log'),log.replaceAll(password,'[redacted]')); console.log('NATIVE_PLAYER_CLOSED '+JSON.stringify({name,code,signal}));});
 return child;
}
async function rawVlc() {
 const response=await fetch('http://127.0.0.1:'+nativePort+'/requests/status.json',{headers:{authorization},redirect:'error',signal:AbortSignal.timeout(3000)});
 assert.equal(response.status,200,'Stock VLC observer HTTP status'); return response.json();
}
function rawMpv(property) {
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(socketPath); let pending='',done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(Error('Independent mpv observation timeout')),3000);
  socket.once('connect',()=>socket.write(JSON.stringify({command:['get_property',property],request_id:710})+'\n'));
  socket.on('error',finish); socket.on('end',()=>finish(Error('Independent mpv observation closed')));
  socket.on('data',b=>{pending+=b;for(;;){const end=pending.indexOf('\n');if(end<0)break;const line=pending.slice(0,end);pending=pending.slice(end+1);let value;try{value=JSON.parse(line);}catch(e){return finish(e);}if(value.request_id===710)return value.error==='success'?finish(null,value.data):finish(Error('mpv observation rejected '+property+': '+value.error));}});
 });
}
async function read() {
 const [vlc,paused,idle,time]=await Promise.all([rawVlc(),rawMpv('pause'),rawMpv('idle-active'),rawMpv('time-pos').catch(()=>null)]);
 const result={at:new Date().toISOString(),vlc:{playing:vlc.state==='playing',state:vlc.state,time:vlc.time,position:vlc.position,playlistItemId:vlc.currentplid},mpv:{playing:!paused&&!idle,paused,idle,time}};
 observations.push(result); return result;
}
async function observeAdvancement() {
 const first=await read(); await delay(1100); const second=await read();
 const advanced={vlc:{...second.vlc},mpv:{...second.mpv}};
 if(second.vlc.playing)advanced.vlc.playing=first.vlc.playing&&(second.vlc.time>first.vlc.time||second.vlc.position>first.vlc.position);
 if(second.mpv.playing)advanced.mpv.playing=first.mpv.playing&&typeof second.mpv.time==='number'&&second.mpv.time>first.mpv.time;
 return advanced;
}
async function until(work,label) {
 const end=Date.now()+20000; let last;
 while(Date.now()<end){try{if(await work())return;}catch(e){last=e;}await delay(150);}
 throw Error(label+'; '+(last?.message||'not ready'));
}
try {
 const focused=spawnSync(process.execPath,['--test','--test-reporter=tap','scripts/sway-native-player-adapters.test.mjs','scripts/sway-native-player-host.test.mjs'],{cwd:checkout,env:process.env,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 const focusedLog=(focused.stdout||'')+(focused.stderr||'');
 fs.writeFileSync(path.join(out,'native-focused-regression.log'),focusedLog);process.stdout.write(focusedLog);
 const count=name=>{const match=focusedLog.match(new RegExp('^# '+name+' (\\d+)\\s*$','m'));return match?Number(match[1]):null;};
 receipt.targetedTests={exit:focused.status,signal:focused.signal,error:focused.error?.message||null,tests:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped')};
 assert.equal(focused.status,0,'Exact-source native host/adapter regression failed');
 assert.equal(receipt.targetedTests.failed,0);assert.equal(receipt.targetedTests.skipped,0);
 const sampleRate=8000,seconds=180,samples=sampleRate*seconds;
 const wave=Buffer.alloc(44+samples*2);
 wave.write('RIFF');wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(sampleRate,24);wave.writeUInt32LE(sampleRate*2,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)wave.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/sampleRate)*8000),44+i*2);
 const tracks=[path.join(root,'Sway-native-A.wav'),path.join(root,'Sway-native-B.wav')];for(const track of tracks)fs.writeFileSync(track,wave);
 const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');nativePort=reserve.address().port;await new Promise(r=>reserve.close(r));
 player('vlc',['--no-one-instance','--intf=dummy','--extraintf=http','--http-host=127.0.0.1','--http-port='+nativePort,'--http-password='+password,'--http-src='+path.join(deps,'usr/share/vlc/lua/http'),'--no-video','--aout=dummy','--start-paused','--no-media-library',...tracks]);
 player('mpv',['--no-config','--idle=yes','--pause=yes','--no-video','--ao=null','--input-ipc-server='+socketPath,...tracks]);
 await until(async()=>{const state=await read();return state.vlc.state==='paused'&&state.mpv.paused&&!state.mpv.idle;},'Both real players must be loaded and paused before Sway starts');
 proxy=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname!=='/requests/status.json'||req.method!=='GET'){res.writeHead(404);return res.end();}
  const command=url.searchParams.get('command');
  try {
   const response=await fetch('http://127.0.0.1:'+nativePort+url.pathname+url.search,{headers:{authorization:req.headers.authorization||''},redirect:'error',signal:AbortSignal.timeout(5000)});
   const body=Buffer.from(await response.arrayBuffer());
   if(command){forwarded.push({command,status:response.status,at:new Date().toISOString()});}
   if(command&&dropNext){assert.equal(response.status,200);dropNext=false;dropped++;res.destroy();return;}
   res.writeHead(response.status,{'Content-Type':'application/json'});res.end(body);
  }catch(error){res.writeHead(502);res.end(JSON.stringify({error:'Owned test relay failed'}));}
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 const {exerciseNativePlayerBrowser}=await import(pathToFileURL(path.join(checkout,'scripts/sway-native-player.browser.test.mjs')));
 const result=await exerciseNativePlayerBrowser({configs:[{id:randomUUID(),program:'vlc',baseUrl:'http://127.0.0.1:'+proxy.address().port,password},{id:randomUUID(),program:'mpv',socketPath}],out,realPlayers:true,loseNextResponse:()=>{assert(!dropNext);dropNext=true;},observe:observeAdvancement});
 assert.equal(result.passed,true);assert.equal(dropped,1);assert.equal(forwarded.filter(row=>row.command==='pl_next').length,1,'Lost VLC Next must reach the original player only once');
 assert(observations.some(row=>row.vlc.playing&&!row.mpv.playing),'VLC-only playback was not observed');
 assert(observations.some(row=>row.mpv.playing&&!row.vlc.playing),'mpv-only playback was not observed');
 receipt.browserChecks=result.checks;receipt.lostAcknowledgements=dropped;receipt.passed=true;
}catch(error){receipt.error=String(error.stack||error);console.error(receipt.error);process.exitCode=1;}
finally {
 if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
 for(const {name,child} of children){if(child.exitCode!==null)continue;child.kill('SIGTERM');await Promise.race([once(child,'close').catch(()=>{}),delay(5000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'close');}receipt[name+'Terminated']=child.exitCode!==null||child.signalCode!==null;}
 receipt.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'original-player-observations.json'),JSON.stringify(receipt,null,2)+'\n');console.log('NATIVE_ORIGINAL_PLAYER_SUMMARY '+JSON.stringify(receipt));
}
