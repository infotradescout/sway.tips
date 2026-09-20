/** Optional pinned relay and public application download. No player or host credentials are build inputs. */
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readdirSync,readFileSync,copyFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
export const sourceSha='58ceb46de0ab10463dcdd7187985d91d8b4bf45a';
export const downloadSourceSha='5974923b6a87666c87af34742df96bbe0bdef18c';
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','USERPROFILE','SYSTEMROOT','TMP','TEMP','TMPDIR','LANG','LC_ALL'].includes(key)));
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
  prepare('.grindzone-phone',sourceSha);
  console.log('Pinned GrindZone phone host prepared: '+sourceSha);
  const target=prepare('.grindzone-download',downloadSourceSha);
  const tests=readdirSync(path.join(target,'tests')).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>'tests/'+name);
  if(tests.length<20)throw Error('GrindZone source tests missing');
  run(target,process.execPath,['--test','--test-reporter=tap',...tests]);
  const download=path.join(target,'downloads');
  if(!existsSync(download))run(target,process.execPath,['tools/build-windows-download.mjs']);
  const manifest=JSON.parse(readFileSync(path.join(download,'release.json'),'utf8'));
  if(manifest.sourceRevision!==downloadSourceSha||manifest.filename!=='GrindZone-Windows-x64.zip'||manifest.playerDataIncluded!==false||manifest.privateEnrollmentIncluded!==false||manifest.runtimeVersion!=='24.21.0')throw Error('Wrong GrindZone download manifest');
  const archive=path.join(download,manifest.filename),bytes=readFileSync(archive);
  if(bytes.length!==manifest.bytes||createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw Error('GrindZone download integrity failed');
  // Only these public files enter the original host's existing static directory.
  const published=path.resolve('dist/grindzone-download');mkdirSync(published,{recursive:true});
  copyFileSync(archive,path.join(published,manifest.filename));copyFileSync(path.join(download,'release.json'),path.join(published,'release.json'));
  writeFileSync(path.join(published,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>GrindZone for Windows</title><style>body{margin:0;padding:28px;background:#101711;color:#eef0e9;font:18px/1.6 system-ui}main{max-width:700px;margin:7vh auto}h1{font-size:42px;line-height:1.1}a{color:#ffae65}.download{display:inline-block;padding:14px 22px;background:#ec8c39;color:#111;border-radius:8px;font-weight:700;text-decoration:none}small{display:block;overflow-wrap:anywhere;color:#b8c1b5}.note{border-left:3px solid #ec8c39;padding-left:18px;margin-top:30px}</style><main><small>WINDOWS X64 PREVIEW</small><h1>GrindZone</h1><p>Download the complete app, extract the folder, and open <strong>START.cmd</strong>. Its runtime is included.</p><a class="download" href="GrindZone-Windows-x64.zip" download>Download GrindZone for Windows</a><p>No remote-control software, separate Node.js installation, or browser extension is required.</p><div class="note"><strong>Phone access is still an enrolled preview.</strong><p>This download does not enroll your PC or connect a phone automatically. The phone service is private until pairing is completed. It also does not replace or stop an older running copy of GrindZone.</p></div><p>Your game saves stay on your machine. The app keeps its journal separately.</p><p><a href="release.json">Download verification record</a></p><small>Source ${downloadSourceSha}<br>Archive SHA-256 ${manifest.sha256}<br>Windows launch and physical-phone acceptance are not claimed by this download.</small></main></html>`,{encoding:'utf8'});
  console.log('GRINDZONE_WINDOWS_DOWNLOAD '+JSON.stringify(manifest));
}
