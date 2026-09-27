import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
const root=path.join(process.env.TEMP,'sway-sources-flow-20260916');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const head=git('rev-parse','HEAD');assert.equal(head,process.argv[2]);
assert.equal(git('diff','--name-only','HEAD'),'');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|NUMBER_OF_PROCESSORS)$/i.test(k)));
Object.assign(env,{NODE_ENV:'test',CI:'true',TZ:'UTC',DISABLE_HMR:'true',SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED:'false',SWAY_NATIVE_TICKETS_ENABLED:'false',SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED:'false',SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED:'false',SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED:'false'});
const report={head,tree:git('rev-parse','HEAD^{tree}'),startedAt:new Date().toISOString(),steps:[],passed:false,productionWrites:false,realProviderCalls:false};
const save=()=>fs.writeFileSync(path.join(process.env.TEMP,'sway-direct-fixed-20260917-gates.json'),JSON.stringify(report,null,2));save();
const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
for(const name of ['lint','build','test:contracts']) {
 const file=path.join(process.env.TEMP,'sway-direct-fixed-20260917-'+name.replaceAll(':','-')+'.log'),fd=fs.openSync(file,'w');
 console.log('SOURCE_FINAL_BEGIN '+name);
 const start=Date.now();const child=spawn(process.execPath,[npm,'run',name],{cwd:root,env,stdio:['ignore',fd,fd]});
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},1200000);
 const result=await new Promise(resolve=>{child.once('error',error=>resolve({code:null,error:error.message}));child.once('close',(code,signal)=>resolve({code,signal}));});
 clearTimeout(timer);fs.closeSync(fd);const row={name,...result,timedOut,durationMs:Date.now()-start,passed:result.code===0&&!timedOut};report.steps.push(row);save();console.log('SOURCE_FINAL_RESULT '+JSON.stringify(row));
 if(!row.passed){console.log(fs.readFileSync(file,'utf8').replace(/\[SWAY_EMAIL_MOCK\].*/g,'[TEST VERIFICATION LINK REDACTED]').slice(-10000));break;}
}
report.sourceUnchanged=git('rev-parse','HEAD')===head&&git('diff','--name-only','HEAD')==='';
report.finishedAt=new Date().toISOString();report.passed=report.steps.length===3&&report.steps.every(s=>s.passed)&&report.sourceUnchanged;
fs.writeFileSync(path.join(process.env.TEMP,'sway-direct-fixed-20260917-gates.json'),JSON.stringify(report,null,2));
console.log('SOURCE_FINAL_SUMMARY '+JSON.stringify(report));process.exitCode=report.passed?0:1;
