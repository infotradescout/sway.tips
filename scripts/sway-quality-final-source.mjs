import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const candidate='b65d92ae016ff5c18b08feab704c3e4375dfddd3';
assert.equal(process.env.SWAY_QUALITY_DASHBOARD_SHA,candidate);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sway-quality-final-')),checkout=path.join(temp,'source');
const out=path.join(process.cwd(),'.validation-public');fs.mkdirSync(out,{recursive:true});
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
const report={candidate,startedAt:new Date().toISOString(),result:'fail',scope:'Final immutable source verification only; existing executed application evidence is referenced, not rerun or relabeled.',inherited:{fullContracts:{deploy:'dep-daou4q6gekts73f2u5i0',candidate,exit:0,finishedAt:'2026-09-22T02:11:32.283Z',trackedChanges:0,postRunUntracked:['tmp/music-sources-proof/','tmp/public-entry-qa/'],wrapperResult:'fail',wrapperFailure:'Generated report directories were untracked; the finally block removed the entire owned temporary checkout.'},unchangedRuntime:{candidate:'4106ace4bcc95e42146ed4008ca9ef475af9f810',deploy:'dep-daotti00cd8s73b146d0',passed:['lint','build','15 module/HTTP tests','390/1440 browser cases','ingress/SQL integration']}},steps:[],productionWrites:0};
function git(args,cwd=checkout){const r=spawnSync('git',args,{cwd,env,encoding:'utf8',timeout:120000});report.steps.push({command:args.slice(0,2).join(' '),exit:r.status});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
try{
 git(['clone','--no-hardlinks','--no-checkout',process.cwd(),checkout],temp);
 git(['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',candidate]);git(['checkout','--detach',candidate]);assert.equal(git(['rev-parse','HEAD']),candidate);
 assert.equal(git(['status','--porcelain']),'');
 assert.deepEqual(git(['diff','--name-only','4106ace4bcc95e42146ed4008ca9ef475af9f810',candidate]).split('\n').sort(),['scripts/sway-discovery-observatory.contract.test.mjs','scripts/sway-discovery-observatory.legacy.contract.test.mjs'].sort());
 for(const dir of report.inherited.fullContracts.postRunUntracked)assert.equal(git(['ls-tree','-r','--name-only',candidate,'--',dir]),'', 'Generated report location must have no committed source');
 assert.equal(git(['diff','--exit-code']),'');assert.equal(git(['status','--porcelain']),'');report.result='pass';
}catch(error){report.error=String(error.stack||error);}
finally{fs.rmSync(temp,{recursive:true,force:true});report.ownedCheckoutRemoved=!fs.existsSync(temp);report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'quality-final-source.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(out,'index.html'),'<meta name="robots" content="noindex,nofollow"><a href="quality-final-source.json">Final source and prior execution references</a>');console.log('SWAY_QUALITY_FINAL_SOURCE '+JSON.stringify(report));if(report.result!=='pass')process.exitCode=1;}
