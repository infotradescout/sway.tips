import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import sharp from 'sharp';
import {runNative as runCore} from './sway-mixxx-native-core.mjs';
export async function runNative(options){
 const {root,out,env,receipt}=options;const fb=join(root,'display');mkdirSync(fb);
 let display=177;while(existsSync('/tmp/.X11-unix/X'+display)||existsSync('/tmp/.X'+display+'-lock'))display++;
 env.DISPLAY=':'+display;env.QT_QPA_PLATFORM='xcb';env.QT_X11_NO_MITSHM='1';
 const child=spawn('Xvfb',[env.DISPLAY,'-screen','0','1280x900x24','-nolisten','tcp','-fbdir',fb],{env,detached:true,stdio:'ignore'});
 let closed=false;const done=new Promise(resolve=>{child.once('error',()=>{closed=true;resolve()});child.once('close',()=>{closed=true;resolve()})});
 let timer,handled=false,dialogError;
 async function capture(name){
  const file=join(fb,'Xvfb_screen0');if(!existsSync(file))return;
  const b=readFileSync(file),h=Array.from({length:25},(_,i)=>b.readUInt32BE(i*4));
  assert.equal(h[1],7);assert.equal(h[11],32);const w=h[4],height=h[5],start=h[0]+h[19]*12;assert(w>0&&height>0&&w<=2048&&height<=2048);const rgb=Buffer.alloc(w*height*3);
  const shifts=h.slice(14,17).map(mask=>{let k=0;while(k<32&&((mask>>>k)&1)===0)k++;return k});
  for(let y=0;y<height;y++)for(let x=0;x<w;x++){const at=start+y*h[12]+x*4;const pixel=h[7]===0?b.readUInt32LE(at):b.readUInt32BE(at);for(let c=0;c<3;c++)rgb[(y*w+x)*3+c]=(pixel>>>shifts[c])&255;}
  await sharp(rgb,{raw:{width:w,height,channels:3}}).png().toFile(join(out,name));
 }
 try{
  for(let i=0;i<40&&!existsSync('/tmp/.X11-unix/X'+display);i++){assert(!closed,'Owned display failed');await sleep(100)}assert(existsSync('/tmp/.X11-unix/X'+display),'Owned display unavailable');
  timer=setInterval(()=>{
   if(handled)return;
   let ids;try{ids=execFileSync('xdotool',['search','--onlyvisible','--name','^Choose music library directory$'],{env,encoding:'utf8',timeout:1000}).trim().split('\n').filter(Boolean)}catch{return}
   if(ids.length!==1){dialogError='Ambiguous first-run dialog';handled=true;return}handled=true;
   try{
    execFileSync('xdotool',['key','--window',ids[0],'Escape'],{env,timeout:1000});
    // Closing the target dialog can swallow its release event. Release on the
    // owned display too; no held key may leak into the following player test.
    execFileSync('xdotool',['keyup','Escape'],{env,timeout:1000});
    receipt.firstRunDialog={title:'Choose music library directory',action:'Cancel on owned display; release key; generated tracks load separately'};console.log('SWAY_MIXXX_FIRST_RUN_DIALOG '+JSON.stringify(receipt.firstRunDialog));
   }catch(e){dialogError=e.message}
  },500);
  await runCore({...options,run:async(name,...args)=>{
   const result=await options.run(name,...args);
   if(name==='audio-playing'||name==='audio-paused'){
    const state=name.slice(6);await capture('mixxx-actual-player-'+state+'.png');
    const data=readFileSync(join(out,'mixxx-'+state+'.f32')),wave=Buffer.alloc(44);wave.write('RIFF');wave.writeUInt32LE(data.length+36,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(3,20);wave.writeUInt16LE(2,22);wave.writeUInt32LE(48000,24);wave.writeUInt32LE(48000*8,28);wave.writeUInt16LE(8,32);wave.writeUInt16LE(32,34);wave.write('data',36);wave.writeUInt32LE(data.length,40);writeFileSync(join(out,'mixxx-actual-'+state+'.wav'),Buffer.concat([wave,data]));
   }return result;
  }});
  assert.equal(dialogError,undefined);assert(handled,'Expected initial music-directory dialog was not observed');
 }finally{
  clearInterval(timer);try{await capture('mixxx-actual-desktop-final.png')}catch(e){receipt.captureError=e.message}
  if(!closed)try{process.kill(-child.pid,'SIGTERM')}catch{}await Promise.race([done,sleep(2000)]);if(!closed)try{process.kill(-child.pid,'SIGKILL')}catch{}await Promise.race([done,sleep(2000)]);receipt.ownedDisplayClosed=closed;assert(closed,'Owned display failed to close');
 }
}
