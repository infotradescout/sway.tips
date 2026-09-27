import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import EmbeddedPostgres from './sway-native-pg-flow-20260916/node_modules/embedded-postgres/dist/index.js';
const root=path.join(process.env.TEMP,'sway-sources-flow-20260916');
const directory=fs.mkdtempSync(path.join(process.env.TEMP,'sway-native-direct-music-'));
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|NUMBER_OF_PROCESSORS)$/i.test(k)));
Object.assign(env,{NODE_ENV:'test',CI:'true',TZ:'UTC',DISABLE_HMR:'true',SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED:'false',SWAY_NATIVE_TICKETS_ENABLED:'false',SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED:'false',SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED:'false',SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED:'false'});
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const password=randomBytes(20).toString('hex');
const pg=new EmbeddedPostgres({databaseDir:path.join(directory,'data'),user:'postgres',password,port,persistent:false,onLog:()=>{},onError:()=>{}});
const identity=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();const report={head:identity(),startedAt:new Date().toISOString(),steps:[],passed:false};let result=1;
try {
  await pg.initialise();await pg.start();await pg.createDatabase('sway_direct_music_disposable_test');
  const client=pg.getPgClient();await client.connect();report.database=(await client.query('select version(),pg_backend_pid() as pid,inet_server_port() as port')).rows[0];console.log('NATIVE_DATABASE',JSON.stringify(report.database));await client.end();
  Object.assign(env,{SWAY_REAL_POSTGRES_PROOF_DATABASE_URL:`postgresql://postgres:${password}@127.0.0.1:${port}/sway_direct_music_disposable_test`,SWAY_ALLOW_DISPOSABLE_DATABASE_RESET:'true',SWAY_REQUIRE_REAL_POSTGRES_PROOF:'true'});
  for(const file of ['scripts/sway-direct-music.integration.test.ts','scripts/sway-direct-music.browser.test.mjs']) {
    const log=fs.openSync(path.join(process.env.TEMP,path.basename(file)+'.native-fixed-20260917.log'),'w');
    const child=spawn(process.execPath,['--import','tsx',file],{cwd:root,env,stdio:['ignore',log,log]});const timer=setTimeout(()=>child.kill(),240000);
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});clearTimeout(timer);fs.closeSync(log);
    report.steps.push({file,exitCode:code});console.log('NATIVE_CHECK',file,code);console.log(fs.readFileSync(path.join(process.env.TEMP,path.basename(file)+'.native-fixed-20260917.log'),'utf8').slice(-1600));if(code!==0)throw new Error(file+' failed');
  }
  result=0;
} catch(error) {console.error(String(error));} finally {await pg.stop().catch(error=>{result=1;console.error(String(error));});}
report.finishedAt=new Date().toISOString();report.headAfter=identity();report.passed=result===0&&report.headAfter===report.head;result=report.passed?0:1;fs.writeFileSync(path.join(root,'tmp/direct-music-proof/native-environment.json'),JSON.stringify(report,null,2));process.stdout.write('DIRECT_NATIVE_SUMMARY '+JSON.stringify(report)+'\n',()=>process.exit(result));
