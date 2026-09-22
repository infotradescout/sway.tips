import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd(), temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sway-quality-isolation-'));
const out = path.join(root, '.validation-public'); fs.mkdirSync(out, { recursive: true });
const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','PLAYWRIGHT_BROWSERS_PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { CI:'true', TZ:'UTC', NODE_OPTIONS:'--max-old-space-size=3072' });
for (const key of ['DATABASE_URL','TEST_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','SWAY_REAL_POSTGRES_PROOF_DATABASE_URL']) assert(!process.env[key], 'No production credentials');
const report = { startedAt:new Date().toISOString(), results:[], productionWrites:0, providerCalls:0, scope:'Unmodified existing Spotify browser case on exact main and dashboard candidate. Not a substitute for the full contract gate.' };
function run(command,args,cwd,timeout=180000) { return spawnSync(command,args,{cwd,env,encoding:'utf8',timeout,maxBuffer:32*1024*1024}); }
try {
  for (const [label,sha] of [['base','2011efd13cb9d7b068721e5512b32e3c21cd7cfc'],['candidate','b65d92ae016ff5c18b08feab704c3e4375dfddd3']]) {
    const cwd=path.join(temporary,label);
    for (const [command,args,dir] of [['git',['clone','--no-hardlinks','--no-checkout',root,cwd],temporary],['git',['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',sha],cwd],['git',['checkout','--detach',sha],cwd],['npm',['ci','--include=dev','--no-audit','--no-fund'],cwd]]) { const result=run(command,args,dir); assert.equal(result.status,0,result.stderr); }
    assert.equal(run('git',['rev-parse','HEAD'],cwd).stdout.trim(),sha);
    console.log('SWAY_QUALITY_REGRESSION_START '+label);
    const result=run(process.execPath,['--import','tsx','scripts/sway-spotify-sources.browser.test.mjs'],cwd,240000);
    fs.writeFileSync(path.join(out,'quality-regression-'+label+'.log'),result.stdout+result.stderr);
    const receipt={label,sha,exit:result.status,error:result.error?String(result.error):null,finishedAt:new Date().toISOString()}; report.results.push(receipt);
    console.log(result.stdout.slice(-6000));console.log(result.stderr.slice(-5000));console.log('SWAY_QUALITY_REGRESSION_CASE '+JSON.stringify(receipt));
  }
} catch(error) {report.error=String(error.stack||error);} finally {
  report.finishedAt=new Date().toISOString(); fs.writeFileSync(path.join(out,'quality-regression-evidence.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Scoped regression comparison</h1><a href="quality-regression-evidence.json">Results</a>');
  fs.writeFileSync(path.join(out,'robots.txt'),'User-agent: *\nDisallow: /\n');
  console.log('SWAY_QUALITY_REGRESSION_SUMMARY '+JSON.stringify(report));fs.rmSync(temporary,{recursive:true,force:true});
  if(report.error)process.exitCode=1;
}
