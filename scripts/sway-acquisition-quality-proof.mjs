import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const candidate='1f08512532d4131a5eecfe675243f57983f71b8b';
const base='1ad02955fbf70744f5e2a38cfe8b0ac2feabddf9';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'sway-acquisition-quality-'));
const checkout=path.join(temporary,'candidate'),output=path.resolve('.validation-public');
fs.mkdirSync(output,{recursive:true});
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{CI:'true',NODE_OPTIONS:'--max-old-space-size=3072'});
const report={candidate,base,startedAt:new Date().toISOString(),steps:[],result:'fail',productionChanged:false};
async function run(label,command,args,cwd=checkout,expected=0){
 console.log('QUALITY_STEP_START '+label);let out='',err='';
 const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),900000);
 child.stdout.on('data',b=>{out+=b;process.stdout.write(b);});child.stderr.on('data',b=>{err+=b;process.stderr.write(b);});
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
 fs.writeFileSync(path.join(output,label+'.log'),out+err);report.steps.push({label,exit,expected,at:new Date().toISOString()});
 console.log('QUALITY_STEP_END '+JSON.stringify(report.steps.at(-1)));assert.equal(exit,expected,label);return out.trim();
}
try{
 for(const k of ['DATABASE_URL','TEST_DATABASE_URL','SWAY_REAL_POSTGRES_PROOF_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','BREVO_API_KEY','SENDGRID_API_KEY','SMTP_PASS'])assert(!process.env[k],'No production credentials');
 await run('clone','git',['clone','--no-hardlinks','--no-checkout',process.cwd(),checkout],temporary);
 await run('fetch','git',['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',candidate]);
 await run('checkout','git',['checkout','--detach',candidate]);assert.equal(await run('identity','git',['rev-parse','HEAD']),candidate);
 assert.equal(await run('initial-clean','git',['status','--porcelain']),'');
 const changed=(await run('bounded-delta','git',['diff','--name-only',base,candidate])).split('\n').sort();
 assert.deepEqual(changed,['scripts/report-acquisition-quality.mjs','scripts/sway-acquisition-quality.test.mjs','scripts/sway-telemetry.contract.test.mjs','src/server/affiliate-program.ts','src/server/audit-log.ts','src/server/discovery-traffic.ts']);
 await run('authorization-source-unchanged','git',['diff','--exit-code',base,candidate,'--','src/server/access-control.ts','server.ts']);
 const ingressPath=path.join(checkout,'src/server/affiliate-program.ts'),auditPath=path.join(checkout,'src/server/audit-log.ts');
 const ingress=fs.readFileSync(ingressPath,'utf8'),audit=fs.readFileSync(auditPath,'utf8');
 const oldIngress=await run('base-acquisition-ingress','git',['show',base+':src/server/affiliate-program.ts']);
 const hook="    // This acquisition ingress runs after JSON parsing and before public APIs.\n    // Passive analytics context is independent of affiliate eligibility and fees.\n    if (req.method === 'POST' && /^\\/api\\/analytics\\/shell\\/?$/.test(req.path)) {\n      return runDiscoveryTraffic(req, next);\n    }\n";
 const restored=ingress.replace("import { runDiscoveryTraffic } from './discovery-traffic';\n",'').replace(hook,'');
 // The copied UUID declaration orders equivalent hexadecimal ranges differently;
 // normalize only that exact character class, never an authorization statement.
 assert.equal(restored.replace('[89ab][0-9a-f]{3}','[89ab][a-f0-9]{3}').trimEnd(),oldIngress.trimEnd(),'Affiliate ownership, cookies, rates and access decisions unchanged');
 const oldAudit=await run('base-audit','git',['show',base+':src/server/audit-log.ts']);
 await run('npm-ci','npm',['ci','--include=dev','--no-audit','--no-fund']);
 const focused=await run('actual-ingestion-report',process.execPath,['--import','tsx','scripts/sway-acquisition-quality.test.mjs']);
 report.focused=JSON.parse(focused.split('\n').find(l=>l.startsWith('ACQUISITION_QUALITY_TEST ')).slice('ACQUISITION_QUALITY_TEST '.length));assert.equal(report.focused.passed,true);
 try{
  fs.writeFileSync(ingressPath,oldIngress+'\n');fs.writeFileSync(auditPath,oldAudit+'\n');
  const negative=await run('uninstrumented-negative-control',process.execPath,['--import','tsx','scripts/sway-acquisition-quality.test.mjs'],checkout,1);
  report.negative=JSON.parse(negative.split('\n').find(l=>l.startsWith('ACQUISITION_QUALITY_TEST ')).slice('ACQUISITION_QUALITY_TEST '.length));
  assert.equal(report.negative.passed,false);assert.match(report.negative.error,/Actual request\/audit classification/);
 }finally{fs.writeFileSync(ingressPath,ingress);fs.writeFileSync(auditPath,audit);}
 await run('restored-exact-source','git',['diff','--exit-code','HEAD','--']);
 await run('lint','npm',['run','lint']);await run('build','npm',['run','build']);await run('full-contracts','npm',['run','test:contracts']);
 await run('tracked-clean','git',['diff','--exit-code','HEAD','--']);
 const generated=(await run('generated','git',['ls-files','--others','--exclude-standard'])).split('\n').filter(Boolean);
 assert(generated.every(p=>p.startsWith('tmp/public-entry-qa/')||p.startsWith('tmp/music-sources-proof/')),'Unexpected generated output');
 report.generatedCount=generated.length;
 for(const folder of ['tmp/public-entry-qa','tmp/music-sources-proof']){
  assert.equal(await run('tracked-'+path.basename(folder),'git',['ls-files','--',folder]),'');
  if(fs.existsSync(path.join(checkout,folder))){fs.cpSync(path.join(checkout,folder),path.join(output,path.basename(folder)),{recursive:true});fs.rmSync(path.join(checkout,folder),{recursive:true});}
 }
 assert.equal(await run('final-clean','git',['status','--porcelain']),'');report.result='pass';
}catch(error){report.error=String(error.stack||error);console.error('QUALITY_FAILURE '+report.error);process.exitCode=1;}
finally{
 report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'acquisition-quality-evidence.json'),JSON.stringify(report,null,2));
 fs.writeFileSync(path.join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');fs.writeFileSync(path.join(output,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Acquisition quality verification</h1><a href="acquisition-quality-evidence.json">Receipt</a>');
 console.log('QUALITY_SUMMARY '+JSON.stringify(report));fs.rmSync(temporary,{recursive:true,force:true});
}
