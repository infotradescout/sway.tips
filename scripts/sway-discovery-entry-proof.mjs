import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const candidate='e7207426ef30f0cdd05475d5680f3176528ff97f',base='8ac9e03c242212f43fdfe882bbf70ad0a02cece8';
const beforePrivateRouteCorrection='21f1dbd4a7b1cf9b6c45b9ba538f4de5bc538092';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sway-discovery-entry-')),checkout=path.join(temp,'candidate'),baseline=path.join(temp,'baseline'),output=path.resolve('.validation-public');
fs.mkdirSync(output,{recursive:true});
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{CI:'true',NODE_OPTIONS:'--max-old-space-size=3072'});
const report={candidate,base,beforePrivateRouteCorrection,startedAt:new Date().toISOString(),steps:[],result:'fail',productionChanged:false,customerDataUsed:false};
async function run(label,command,args,cwd=checkout,expectedExit=0){
 console.log('ENTRY_STEP_START '+label);let out='',err='';const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),1200000);child.stdout.on('data',b=>{out+=b;process.stdout.write(b);});child.stderr.on('data',b=>{err+=b;process.stderr.write(b);});
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
 fs.writeFileSync(path.join(output,label+'.log'),out+err);report.steps.push({label,exit,expectedExit,at:new Date().toISOString()});console.log('ENTRY_STEP_END '+JSON.stringify(report.steps.at(-1)));assert.equal(exit,expectedExit,label);return out.trim();
}
try{
 for(const k of ['DATABASE_URL','TEST_DATABASE_URL','SWAY_REAL_POSTGRES_PROOF_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','BREVO_API_KEY','SENDGRID_API_KEY','SMTP_PASS'])assert(!process.env[k],'No inherited production credentials');
 await run('clone','git',['clone','--no-hardlinks','--no-checkout',process.cwd(),checkout],temp);
 await run('fetch','git',['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',candidate]);
 await run('checkout','git',['checkout','--detach',candidate]);assert.equal(await run('identity','git',['rev-parse','HEAD']),candidate);
 assert.equal(await run('initial-clean','git',['status','--porcelain']),'');
 assert.deepEqual((await run('bounded-delta','git',['diff','--name-only',base,candidate])).split('\n').sort(),['scripts/sway-discovery-entry-ingestion.test.mjs','scripts/sway-discovery-entry.browser.test.mjs','scripts/sway-telemetry.contract.test.mjs','src/shells/SwayInstallPrompt.tsx','src/shells/frictionClient.ts']);
 await run('npm-ci','npm',['ci','--include=dev','--no-audit','--no-fund']);
 await run('telemetry-browser-ingestion',process.execPath,['scripts/sway-telemetry.contract.test.mjs']);
 report.browser=JSON.parse(fs.readFileSync(path.join(checkout,'tmp/public-entry-qa/discovery-entry/results.json'),'utf8'));assert.equal(report.browser.results.length,8);assert(report.browser.results.every(r=>r.passed));
 report.ingestion=JSON.parse(fs.readFileSync(path.join(checkout,'tmp/public-entry-qa/discovery-ingestion/results.json'),'utf8'));assert.equal(report.ingestion.result,'pass');assert.equal(report.ingestion.cases.length,2);
 await run('baseline-clone','git',['clone','--no-hardlinks','--no-checkout',checkout,baseline],temp);
 await run('baseline-checkout','git',['checkout','--detach',beforePrivateRouteCorrection],baseline);
 fs.symlinkSync(path.join(checkout,'node_modules'),path.join(baseline,'node_modules'),'dir');
 fs.copyFileSync(path.join(checkout,'scripts/sway-discovery-entry-ingestion.test.mjs'),path.join(baseline,'scripts/sway-discovery-entry-ingestion.test.mjs'));
 await run('negative-private-route-baseline',process.execPath,['--import','tsx','scripts/sway-discovery-entry-ingestion.test.mjs'],baseline,1);
 const old=JSON.parse(fs.readFileSync(path.join(baseline,'tmp/public-entry-qa/discovery-ingestion/results.json'),'utf8'));
 assert.equal(old.cases.length,2);assert(old.cases.every(r=>!r.passed&&r.statuses.includes(400)&&r.publicEntries.includes('/talent/gigs')),'Negative control must reproduce the reviewed server rejection, not an unrelated setup failure');
 report.privateRouteBaseline=old;
 report.priorStartupNegativeControl={deploy:'dep-daoo7cgae00c73cap2i0',base,failedCases:8,note:'Already executed on the original unchanged base; not repeated as a substitute for current corrected-candidate evidence.'};
 await run('lint','npm',['run','lint']);await run('build','npm',['run','build']);await run('full-contracts','npm',['run','test:contracts']);
 await run('tracked-clean','git',['diff','--exit-code','HEAD','--']);
 const generated=(await run('generated','git',['ls-files','--others','--exclude-standard'])).split('\n').filter(Boolean);assert(generated.every(p=>p.startsWith('tmp/public-entry-qa/')||p.startsWith('tmp/music-sources-proof/')),'Unexpected generated file');report.generatedCount=generated.length;
 for(const folder of ['tmp/public-entry-qa','tmp/music-sources-proof']){
  assert.equal(await run('tracked-'+path.basename(folder),'git',['ls-files','--',folder]),'');
  if(fs.existsSync(path.join(checkout,folder))){fs.cpSync(path.join(checkout,folder),path.join(output,path.basename(folder)),{recursive:true});fs.rmSync(path.join(checkout,folder),{recursive:true});}
 }
 assert.equal(await run('final-clean','git',['status','--porcelain']),'');report.result='pass';
}catch(error){report.error=String(error.stack||error);console.error('ENTRY_FAILURE '+report.error);process.exitCode=1;}
finally{
 report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'discovery-entry-evidence.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');fs.writeFileSync(path.join(output,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Discovery entry verification</h1><a href="discovery-entry-evidence.json">Exact-source receipt</a>');console.log('ENTRY_SUMMARY '+JSON.stringify(report));fs.rmSync(temp,{recursive:true,force:true});
}
