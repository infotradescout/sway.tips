/** Pinned GrindZone build and acceptance on existing compute. No player or host credentials enter tests. */
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readdirSync,readFileSync,copyFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {build} from 'esbuild';
import {bindPhoneSource} from './grindzone-build-binding.mjs';
export const sourceSha='5a57207234567a28b56e78ac678ecd52b0b3146b';
export const downloadSourceSha='5a57207234567a28b56e78ac678ecd52b0b3146b';
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','USERPROFILE','SYSTEMROOT','TMP','TEMP','TMPDIR','LANG','LC_ALL','PLAYWRIGHT_BROWSERS_PATH'].includes(key)));
const run=(cwd,command,args)=>execFileSync(command,args,{cwd,env:{...cleanEnv,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'},stdio:'inherit',timeout:240000});
function prepare(directory,sha){
  const target=path.resolve('node_modules',directory,sha);
  if(!existsSync(target)){mkdirSync(target,{recursive:true});run(target,'git',['init','--quiet']);run(target,'git',['fetch','--quiet','--depth','1','https://github.com/infotradescout/cotw-field-companion.git',sha]);run(target,'git',['checkout','--quiet','--detach','FETCH_HEAD']);}
  const actual=execFileSync('git',['rev-parse','HEAD'],{cwd:target,env:cleanEnv,encoding:'utf8'}).trim();if(actual!==sha)throw Error('GrindZone source mismatch');
  run(target,'git',['diff','--exit-code','HEAD','--']);
  run(target,process.platform==='win32'?'npm.cmd':'npm',['ci','--prefix','cloud','--ignore-scripts','--no-audit','--no-fund']);
  return target;
}
if(process.env.GRINDZONE_PHONE_ENABLED==='true'){
  const hostRoot=process.cwd();
  run(hostRoot,process.execPath,['--test','scripts/grindzone-build-binding.test.mjs','scripts/grindzone-host.contract.test.mjs','scripts/grindzone-download.contract.test.mjs']);
  const relay=prepare('.grindzone-phone',sourceSha);
  const target=sourceSha===downloadSourceSha?relay:prepare('.grindzone-download',downloadSourceSha);
  const tests=readdirSync(path.join(target,'tests')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name);
  if(tests.length<20)throw Error('GrindZone source tests missing');
  run(target,process.execPath,['--test','--test-reporter=tap',...tests]);
  console.log('GRINDZONE_NATIVE_TESTS_PASSED '+downloadSourceSha);
  run(hostRoot,process.execPath,['node_modules/playwright/cli.js','install','chromium']);
  const evidence=path.join(target,'phone-acceptance');
  run(target,process.execPath,['tools/verify-phone-connection.mjs',hostRoot,'local',evidence]);
  run(target,process.execPath,['tools/verify-zone-workspace.mjs',hostRoot,'local',evidence]);
  run(target,process.execPath,['tools/verify-hidden-zones.mjs',hostRoot,'local',evidence]);
  run(target,process.execPath,['tools/verify-phone-cache.mjs',hostRoot,'local',evidence]);
  run(target,process.execPath,['tools/verify-studio-screenshots.mjs',hostRoot,'local',evidence]);
  let live=null;
  try{const response=await fetch('https://sway.tips/api/release-health',{signal:AbortSignal.timeout(10000)});if(response.ok)live=await response.json();}catch{}
  // A same-source redeploy performs the public-network check only after this host revision is live.
  if(live?.commit===process.env.RENDER_GIT_COMMIT&&live?.status==='ok'){
    run(target,process.execPath,['tools/verify-phone-connection.mjs',hostRoot,'live',evidence]);
    run(target,process.execPath,['tools/verify-zone-workspace.mjs',hostRoot,'live',evidence]);
    run(target,process.execPath,['tools/verify-hidden-zones.mjs',hostRoot,'live',evidence]);
    run(target,process.execPath,['tools/verify-phone-cache.mjs',hostRoot,'live',evidence]);
    run(target,process.execPath,['tools/verify-studio-screenshots.mjs',hostRoot,'live',evidence]);
  }else console.log('GRINDZONE_PHONE_LIVE_PENDING: this source has not reached the public host yet.');
  // Compile the reviewed version into the existing host without rewriting the large canonical server source.
  // All application code is unchanged by this binding except the one exact relay dependency argument.
  const source=bindPhoneSource(readFileSync(path.join(hostRoot,'server.ts'),'utf8'),sourceSha);
  await build({stdin:{contents:source,loader:'ts',sourcefile:'server.ts',resolveDir:hostRoot},bundle:true,platform:'node',format:'cjs',packages:'external',sourcemap:true,outfile:'dist/server.cjs'});
  console.log('GRINDZONE_HOST_SOURCE_BOUND '+sourceSha);
  const download=path.join(target,'downloads');
  if(!existsSync(download))run(target,process.execPath,['tools/build-windows-download.mjs']);
  const manifest=JSON.parse(readFileSync(path.join(download,'release.json'),'utf8'));
  if(manifest.sourceRevision!==downloadSourceSha||manifest.filename!=='GrindZone-Windows-x64.zip'||manifest.playerDataIncluded!==false||manifest.privateEnrollmentIncluded!==false||manifest.runtimeVersion!=='24.21.0')throw Error('Wrong GrindZone download manifest');
  const archive=path.join(download,manifest.filename),bytes=readFileSync(archive);
  if(bytes.length!==manifest.bytes||createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw Error('GrindZone download integrity failed');
  const published=path.resolve('dist/grindzone-download');mkdirSync(published,{recursive:true});
  copyFileSync(archive,path.join(published,manifest.filename));copyFileSync(path.join(download,'release.json'),path.join(published,'release.json'));
  for(const mode of ['local','live'])for(const kind of ['phone','zones','discovery','cache','studio']){
    const report=path.join(evidence,mode+'-'+kind+'.json');if(!existsSync(report))continue;
    const result=JSON.parse(readFileSync(report,'utf8'));if(result.passed!==true||result.source!==downloadSourceSha)throw Error('Phone acceptance is incomplete or stale');
    copyFileSync(report,path.join(published,mode+'-'+kind+'.json'));copyFileSync(path.join(evidence,mode+'-'+kind+'.png'),path.join(published,mode+'-'+kind+'.png'));
  }
  writeFileSync(path.join(published,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>GrindZone for Windows</title><style>body{margin:0;padding:28px;background:#101711;color:#eef0e9;font:18px/1.6 system-ui}main{max-width:700px;margin:5vh auto}h1{font-size:42px;line-height:1.1}a{color:#ffae65}.download{display:inline-block;padding:14px 22px;background:#ec8c39;color:#111;border-radius:8px;font-weight:700;text-decoration:none}small{display:block;overflow-wrap:anywhere;color:#b8c1b5}.note{border-left:3px solid #ec8c39;padding-left:18px;margin-top:26px}</style><main><small>WINDOWS X64 PREVIEW</small><h1>GrindZone</h1><p>Download the complete app, extract the folder, and open <strong>START.cmd</strong>. Its runtime is included.</p><a class="download" href="GrindZone-Windows-x64.zip?v=${downloadSourceSha}" download>Download GrindZone for Windows</a><h2>Connect your phone</h2><ol><li>Open the new GrindZone copy on your PC.</li><li>Go to <strong>Settings → Connect my phone</strong> and approve private access.</li><li>Scan the QR with your phone camera, then tap <strong>Connect this phone</strong>.</li></ol><p>No activation key, remote-control software, separate Node.js installation, or browser extension is needed.</p><div class="note"><strong>Keep GrindZone running on your PC while using the live phone view.</strong><p>Use the new download, not an older running copy. Close the older app before starting this version; this download does not stop or replace it automatically.</p></div><p>Your game saves stay on your machine. Only the paired phone can see its permitted live view; turn off phone access in Settings to disconnect it. Optional private copies in the phone browser are managed and deleted separately in phone Settings.</p><p><a href="release.json">Download verification</a> · <a href="local-phone.json">Browser acceptance record</a></p><small>Source ${downloadSourceSha}<br>Archive SHA-256 ${manifest.sha256}<br>Browser tests use a disposable Linux app and synthetic saves. Your Windows launch and physical-phone scan are not claimed by those tests.</small></main></html>`,{encoding:'utf8'});
  console.log('GRINDZONE_WINDOWS_DOWNLOAD '+JSON.stringify(manifest));
}
