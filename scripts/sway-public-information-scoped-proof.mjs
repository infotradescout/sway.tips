import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
const candidate='940337b312352c38578f13b839d2dab4eb0c61f5';
const base='8186649c586a570a9c4efbd8ed2b8307fde58501';
const directory=mkdtempSync(join(tmpdir(),'sway-information-supplement-'));
const checkout=join(directory,'repo');
const output=resolve('.validation-public');
mkdirSync(output,{recursive:true});
const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(env,{CI:'true',NODE_OPTIONS:'--max-old-space-size=3072'});
const report={candidate,base,startedAt:new Date().toISOString(),steps:[],result:'fail',fullReleasePassed:false,productionChanged:false};
function execute(label,command,args,cwd=checkout,expect=0){
 console.log('SCOPED_INFORMATION_START '+label);
 const result=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:900000,maxBuffer:32*1024*1024});
 writeFileSync(join(output,label+'.log'),(result.stdout||'')+(result.stderr||''));
 console.log((result.stdout||'').slice(-16000)); console.log((result.stderr||'').slice(-8000));
 report.steps.push({label,exit:result.status,expectedExit:expect,at:new Date().toISOString()});
 console.log('SCOPED_INFORMATION_STEP '+JSON.stringify(report.steps.at(-1)));
 assert.equal(result.status,expect,label+': '+String(result.error||'unexpected exit'));
 return (result.stdout||'')+(result.stderr||'');
}
try{
 for(const key of ['DATABASE_URL','TEST_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','BREVO_API_KEY','SENDGRID_API_KEY','SMTP_PASS'])assert(!process.env[key],'Forbidden production configuration: '+key);
 execute('clone','git',['clone','--no-hardlinks','--no-checkout',process.cwd(),checkout],directory);
 execute('fetch','git',['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',candidate]);
 execute('candidate','git',['checkout','--detach',candidate]);
 assert.equal(execute('identity','git',['rev-parse','HEAD']).trim(),candidate);
 execute('npm-ci','npm',['ci','--include=dev','--no-audit','--no-fund']);
 execute('browser-install',process.execPath,['node_modules/playwright/cli.js','install','chromium']);
 execute('public-page-contract',process.execPath,['scripts/sway-faq-surface.contract.test.mjs']);
 const currentFailure=execute('candidate-registry-failure',process.execPath,['scripts/sway-contract-gate-normalization.contract.test.mjs'],checkout,1);
 execute('base','git',['checkout','--detach',base]);
 const baseFailure=execute('base-registry-failure',process.execPath,['scripts/sway-contract-gate-normalization.contract.test.mjs'],checkout,1);
 assert.equal(currentFailure,baseFailure,'An introduced failure cannot be relabeled as baseline');
 const failures=baseFailure.trim().split('\n').filter(line=>line.startsWith('- '));
 assert.deepEqual(failures,[
  '- Hard contract script is not wired into test:contracts: scripts/grindzone-download.contract.test.mjs',
  '- Hard contract script is not wired into test:contracts: scripts/grindzone-host.contract.test.mjs'
 ]);
 report.baselineFailures=failures;
 execute('restore-candidate','git',['checkout','--detach',candidate]);
 assert.equal(execute('final-clean','git',['status','--porcelain']).trim(),'');
 report.result='scoped-pass-full-release-blocked';
 report.scope='Actual existing About/FAQ Express and Chromium acceptance plus metadata tests. Full-release failure preserved and reproduced on unchanged base. No repeated lint/build and no production merge.';
}catch(error){report.error=String(error.stack||error);console.error('SCOPED_INFORMATION_FAILURE '+report.error);process.exitCode=1;}
finally{
 report.finishedAt=new Date().toISOString();
 writeFileSync(join(output,'public-information-scoped.json'),JSON.stringify(report,null,2));
 writeFileSync(join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');
 writeFileSync(join(output,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Scoped Sway information proof</h1><p>Not a full release approval.</p><a href="public-information-scoped.json">Receipt</a>');
 console.log('SCOPED_INFORMATION_SUMMARY '+JSON.stringify(report));
 rmSync(directory,{recursive:true,force:true});
}
