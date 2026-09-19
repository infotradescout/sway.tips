/** Optional, pinned phone relay; no app credentials or player files are build inputs. */
import {execFileSync} from 'node:child_process';
import {existsSync,mkdirSync} from 'node:fs';
import path from 'node:path';
export const sourceSha='2687e475d628c2be2d0abf66df96dcd5c6fd9ca9';
if(process.env.GRINDZONE_PHONE_ENABLED==='true'){
  const target=path.resolve('node_modules/.grindzone-phone',sourceSha);
  const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','USERPROFILE','SYSTEMROOT','TMP','TEMP','TMPDIR','LANG','LC_ALL'].includes(key)));
  const run=(command,args)=>execFileSync(command,args,{cwd:target,env:{...cleanEnv,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'},stdio:'inherit',timeout:180000});
  if(!existsSync(target)){mkdirSync(target,{recursive:true});run('git',['init','--quiet']);run('git',['fetch','--quiet','--depth','1','https://github.com/infotradescout/cotw-field-companion.git',sourceSha]);run('git',['checkout','--quiet','--detach','FETCH_HEAD']);}
  const actual=execFileSync('git',['rev-parse','HEAD'],{cwd:target,encoding:'utf8'}).trim();if(actual!==sourceSha)throw Error('GrindZone source mismatch');
  run('git',['diff','--exit-code','HEAD','--']);
  run(process.platform==='win32'?'npm.cmd':'npm',['ci','--prefix','cloud','--ignore-scripts','--no-audit','--no-fund']);
  console.log('Pinned GrindZone phone host prepared: '+sourceSha);
}
