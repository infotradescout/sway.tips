import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../public/mixxx/Sway-Mixxx.js',import.meta.url),'utf8');
function setup(samples=48000){const calls=[];const context={engine:{getValue:()=>samples,setValue:(...args)=>calls.push(args)}};vm.createContext(context);vm.runInContext(source,context);return{mapping:context.SwayMixxx,calls};}
for(let channel=0;channel<4;channel++)test(`deck ${channel+1}: explicit Play/Pause target only this deck`,()=>{const{mapping,calls}=setup();const group=`[Channel${channel+1}]`;mapping.transport(channel,37,127,0x90|channel,group);mapping.transport(channel,38,127,0x90|channel,group);assert.deepEqual(calls,[[group,'play',1],[group,'play',0]]);});
test('connection and reconnect lifecycle never acts on any deck',()=>{const{mapping,calls}=setup();mapping.init();mapping.shutdown();mapping.init();assert.deepEqual(calls,[]);});
test('Note Off and zero-velocity release do not repeat the action',()=>{const{mapping,calls}=setup();mapping.transport(1,37,127,0x91,'[Channel2]');mapping.transport(1,37,0,0x81,'[Channel2]');mapping.transport(1,37,0,0x91,'[Channel2]');assert.deepEqual(calls,[['[Channel2]','play',1]]);});
test('a repeated Play is explicit play-on, not a play/pause toggle',()=>{const{mapping,calls}=setup();mapping.transport(0,37,127,0x90,'[Channel1]');mapping.transport(0,37,127,0x90,'[Channel1]');assert.deepEqual(calls,[['[Channel1]','play',1],['[Channel1]','play',1]]);});
test('Stop pauses before returning to the start',()=>{const{mapping,calls}=setup();mapping.transport(1,39,127,0x91,'[Channel2]');assert.deepEqual(calls,[['[Channel2]','play',0],['[Channel2]','playposition',0]]);});
test('Cue emits one press and release to cue-goto-and-stop',()=>{const{mapping,calls}=setup();mapping.transport(1,40,127,0x91,'[Channel2]');assert.deepEqual(calls,[['[Channel2]','cue_gotoandstop',1],['[Channel2]','cue_gotoandstop',0]]);});
test('Play does not arm an unloaded deck',()=>{const{mapping,calls}=setup(0);mapping.transport(0,37,127,0x90,'[Channel1]');assert.deepEqual(calls,[]);});
test('wrong group, invalid channel and non-note messages are rejected',()=>{const{mapping,calls}=setup();mapping.transport(0,37,127,0x90,'[Channel2]');mapping.transport(4,37,127,0x94,'[Channel5]');mapping.transport(-1,37,127,0x90,'[Channel0]');mapping.transport(0,37,127,0xb0,'[Channel1]');assert.deepEqual(calls,[]);});
test('Load, Next and Previous are not misrepresented as supported',()=>{const{mapping,calls}=setup();for(const control of [36,41,42])mapping.transport(0,control,127,0x90,'[Channel1]');assert.deepEqual(calls,[]);});
