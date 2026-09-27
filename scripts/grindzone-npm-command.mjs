import path from 'node:path';

const ciArgs=['ci','--prefix','cloud','--ignore-scripts','--no-audit','--no-fund'];

/** Node cannot spawn a .cmd launcher directly on Windows; invoke npm's JS CLI. */
export function npmCiInvocation(platform=process.platform,nodeExecutable=process.execPath,npmExecPath=process.env.npm_execpath){
  if(platform!=='win32')return {command:'npm',args:ciArgs};
  const fallback=path.win32.join(path.win32.dirname(nodeExecutable),'node_modules','npm','bin','npm-cli.js');
  const cli=path.win32.basename(npmExecPath||'').toLowerCase()==='npm-cli.js'?npmExecPath:fallback;
  return {command:nodeExecutable,args:[cli,...ciArgs]};
}
