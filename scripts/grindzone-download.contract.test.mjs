import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const script=new URL('./prepare-grindzone-host.mjs',import.meta.url);
test('phone relay and managed download keep separate reviewed source pins and only public artifacts',()=>{
 const source=readFileSync(script,'utf8'),relay=source.match(/sourceSha='([a-f0-9]{40})'/)?.[1],download=source.match(/downloadSourceSha='([a-f0-9]{40})'/)?.[1];
 assert.ok(relay);assert.ok(download);assert.notEqual(relay,download);assert.notEqual(relay,'58ceb46de0ab10463dcdd7187985d91d8b4bf45a');
 assert.match(source,/const relay=prepare\('\.grindzone-phone',sourceSha\)/);
 assert.match(source,/const target=sourceSha===downloadSourceSha\?relay:prepare\('\.grindzone-download',downloadSourceSha\)/);
 assert.match(source,/bindPhoneSource\(readFileSync\(path\.join\(hostRoot,'server\.ts'\),'utf8'\),sourceSha\)/);
 assert.match(source,/git.*diff.*--exit-code/s);assert.match(source,/--test-reporter=tap/);assert.match(source,/verify-phone-connection\.mjs/);assert.match(source,/dist\/grindzone-download/);
 assert.match(source,/manifest\.privateEnrollmentIncluded!==false/);assert.match(source,/manifest\.playerDataIncluded!==false/);assert.match(source,/checksum|integrity/i);
 assert.doesNotMatch(source,/process\.env\.(DATABASE_URL|GRINDZONE_PHONE_KEY|STRIPE_SECRET_KEY)/);
});
test('disabled shared-phone feature performs no build or disk writes',async()=>{
 const cwd=process.cwd(),previous=process.env.GRINDZONE_PHONE_ENABLED,dir=mkdtempSync(path.join(tmpdir(),'grindzone-disabled-build-'));
 try{process.chdir(dir);delete process.env.GRINDZONE_PHONE_ENABLED;const module=await import(script.href+'?disabled-test');assert.match(module.sourceSha,/^[a-f0-9]{40}$/);assert.match(module.downloadSourceSha,/^[a-f0-9]{40}$/);assert.notEqual(module.sourceSha,module.downloadSourceSha);assert.deepEqual(readdirSync(dir),[]);}
 finally{process.chdir(cwd);if(previous===undefined)delete process.env.GRINDZONE_PHONE_ENABLED;else process.env.GRINDZONE_PHONE_ENABLED=previous;rmSync(dir,{recursive:true,force:true});}
});
test('saved-game workflow runs before packaging and includes public-network verification',()=>{
 const source=readFileSync(script,'utf8');
 const local="run(target,process.execPath,['tools/verify-save-data.mjs',hostRoot,'local',evidence]);";
 const live="run(target,process.execPath,['tools/verify-save-data.mjs',hostRoot,'live',evidence]);";
 assert.equal(source.split(local).length,2);assert.equal(source.split(live).length,2);
 assert.ok(source.indexOf(local)<source.indexOf("const download=path.join(target,'downloads')"));
 assert.ok(source.indexOf(live)>source.indexOf('live?.commit===process.env.RENDER_GIT_COMMIT'));
 assert.match(source,/\['phone','zones','discovery','cache','studio','save-data','locations','herds','browser-play'\]/);
 assert.match(source,/Required local acceptance report missing/);
 assert.match(source,/result\.passed!==true\|\|result\.source!==downloadSourceSha/);
 assert.doesNotMatch(source,/writeFileSync\([^\n]*stat-definitions\.json/);
});
test('event locations preserve every prior local and live workflow and require their own matching reports',()=>{
 const source=readFileSync(script,'utf8');
 for(const name of ['hunt-locations','save-data','phone-connection','zone-workspace','hidden-zones','phone-cache','studio-screenshots'])for(const mode of ['local','live']){
  const call=`run(target,process.execPath,['tools/verify-${name}.mjs',hostRoot,'${mode}',evidence]);`;
  assert.equal(source.split(call).length,2,name+' '+mode);
  assert.ok(source.indexOf(call)<source.indexOf("const download=path.join(target,'downloads')"));
 }
 assert.match(source,/mode\+'-locations\.json'/);assert.match(source,/report\.source!==downloadSourceSha/);
 assert.match(source,/report\.automaticExactKillGpsVerified!==false/);assert.match(source,/bytes\.length>65536/);
 assert.match(source,/mode\+'-locations\.png'/);
});
test('herd reference generation precedes native acceptance and both herd browser modes are required',()=>{
 const source=readFileSync(script,'utf8');
 const generate="run(target,process.execPath,['tools/build-herd-reference.mjs']);";
 assert.equal(source.split(generate).length,2);
 assert.ok(source.indexOf(generate)<source.indexOf("run(target,process.execPath,['--test','--test-reporter=tap',...tests])"));
 for(const mode of ['local','live']){
  const call=`run(target,process.execPath,['tools/verify-herds.mjs',hostRoot,'${mode}',evidence]);`;
  assert.equal(source.split(call).length,2);
  assert.ok(source.indexOf(call)<source.indexOf("const download=path.join(target,'downloads')"));
 }
 assert.match(source,/mode\+'-herds\.json'/);assert.match(source,/report\.realPlayerSaveVerified!==false/);
 assert.match(source,/mode\+'-herds\.png'/);assert.match(source,/Required local acceptance report missing/);
});
test('no-PC browser journey is required in both modes without claiming account synchronization',()=>{
 const source=readFileSync(script,'utf8');
 for(const mode of ['local','live']){
  const call=`run(target,process.execPath,['tools/verify-browser-play.mjs',hostRoot,'${mode}',evidence]);`;
  assert.equal(source.split(call).length,2);
  assert.ok(source.indexOf(call)<source.indexOf("const download=path.join(target,'downloads')"));
  if(mode==='live')assert.ok(source.indexOf(call)>source.indexOf('live?.commit===process.env.RENDER_GIT_COMMIT'));
 }
 assert.match(source,/report\.pcProcessesCreated!==0/);assert.match(source,/report\.accountSyncVerified!==false/);
 assert.match(source,/mode\+'-browser-play\.json'/);assert.match(source,/mode\+'-browser-play\.png'/);
 assert.match(source,/Browser-only progress is not account sync/);
});
