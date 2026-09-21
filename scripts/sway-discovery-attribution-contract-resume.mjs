import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const candidate='803450d5262a5f5e1de3e046f10399df0def9dc9';
const previouslyTested='9b0b80f75e2bb949daaca61d2edb53f62c31cbf0';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sway-attribution-contract-'));
const checkout=path.join(temp,'repo'),output=path.resolve('.validation-public');
fs.mkdirSync(output,{recursive:true});
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{CI:'true',NODE_OPTIONS:'--max-old-space-size=3072'});
const report={candidate,previouslyTested,startedAt:new Date().toISOString(),steps:[],result:'fail',productionChanged:false,inheritedEvidence:{deploy:'dep-daonr23bc2fs7386e5eg',runtimeSource:'bbd6fc884ab972592636bb99b423a589a31db4b7',lint:true,build:true,behaviorTests:9,unchangedBaselineFailures:6,browserTransportCases:6,scope:'Real modules to a synthetic local HTTP receiver; not production ingestion or human traffic.'}};
async function run(label,command,args,cwd=checkout){
 console.log('ATTRIBUTION_RESUME_START '+label);let stdout='',stderr='';
 const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>child.kill('SIGKILL'),1200000);
 child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b);});child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b);});
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
 fs.writeFileSync(path.join(output,label+'.log'),stdout+stderr);report.steps.push({label,exit,at:new Date().toISOString()});
 console.log('ATTRIBUTION_RESUME_STEP '+JSON.stringify(report.steps.at(-1)));assert.equal(exit,0,label);return stdout.trim();
}
try{
 for(const key of ['DATABASE_URL','TEST_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','BREVO_API_KEY','SENDGRID_API_KEY','SMTP_PASS'])assert(!process.env[key],'No inherited production credentials');
 await run('clone','git',['clone','--no-hardlinks','--no-checkout',process.cwd(),checkout],temp);
 await run('fetch','git',['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',candidate]);
 await run('checkout','git',['checkout','--detach',candidate]);assert.equal(await run('head','git',['rev-parse','HEAD']),candidate);
 assert.equal(await run('initial-clean','git',['status','--porcelain']),'');
 const delta=(await run('test-only-delta','git',['diff','--name-only',previouslyTested,candidate])).split('\n').sort();
 assert.deepEqual(delta,['scripts/sway-discovery-attribution.test.mjs','scripts/sway-discovery-observatory.contract.test.mjs']);
 assert.equal(await run('unchanged-runtime','git',['hash-object','src/shells/discoveryAttribution.ts']),report.inheritedEvidence.runtimeSource);
 await run('npm-ci','npm',['ci','--include=dev','--no-audit','--no-fund']);
 await run('observatory-contract',process.execPath,['scripts/sway-discovery-observatory.contract.test.mjs']);
 await run('full-contracts','npm',['run','test:contracts']);
 await run('tracked-source-unchanged','git',['diff','--exit-code','HEAD','--']);
 const artifacts=(await run('generated-artifacts','git',['ls-files','--others','--exclude-standard'])).split('\n').filter(Boolean);
 assert(artifacts.every(p=>p.startsWith('tmp/public-entry-qa/')||p.startsWith('tmp/music-sources-proof/')),'Unexpected untracked output');
 report.generatedArtifactCount=artifacts.length;report.generatedArtifactPaths=artifacts;
 // Known generated evidence is not source. Check no tracked path lives in the
 // directories before moving only these owned temporary outputs out of source.
 for(const folder of ['tmp/public-entry-qa','tmp/music-sources-proof']){
  assert.equal(await run('tracked-'+path.basename(folder),'git',['ls-files','--',folder]),'');
  if(fs.existsSync(path.join(checkout,folder))){fs.cpSync(path.join(checkout,folder),path.join(output,path.basename(folder)),{recursive:true});fs.rmSync(path.join(checkout,folder),{recursive:true});}
 }
 assert.equal(await run('final-clean','git',['status','--porcelain']),'');report.result='pass';
}catch(error){report.error=String(error.stack||error);console.error('ATTRIBUTION_RESUME_FAILURE '+report.error);process.exitCode=1;}
finally{
 report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'attribution-contract-resume.json'),JSON.stringify(report,null,2));
 fs.writeFileSync(path.join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');fs.writeFileSync(path.join(output,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Attribution release contract</h1><a href="attribution-contract-resume.json">Exact-source execution</a>');
 console.log('ATTRIBUTION_RESUME_SUMMARY '+JSON.stringify(report));fs.rmSync(temp,{recursive:true,force:true});
}
