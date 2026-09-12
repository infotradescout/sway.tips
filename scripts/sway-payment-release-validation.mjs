import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Used only by the existing isolated validation service; never by npm start/build.
export async function runPaymentValidation() {
  assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
  assert.equal(process.env.RENDER_SERVICE_ID, 'srv-daesln0u01pc73fso5kg');
  const candidate = process.env.SWAY_PAYMENT_VALIDATION_CANDIDATE_SHA;
  const focused = process.env.SWAY_PAYMENT_VALIDATION_FOCUS === 'recovery';
  assert(!process.env.SWAY_PAYMENT_VALIDATION_FOCUS || focused);
  assert.match(candidate || '', /^[a-f0-9]{40}$/);
  for (const key of ['SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED', 'SWAY_NATIVE_TICKETS_ENABLED', 'SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED', 'SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED', 'SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED']) assert.equal(process.env[key], 'false', key);
  const forbidden = Object.keys(process.env).filter(k => /DATABASE_URL$|(?:STRIPE|PAYPAL|EMAIL|R2|AWS|CLOUDFLARE).*(?:SECRET|TOKEN|API_KEY|ACCESS_KEY)|PAYOUT_RECIPIENT_ENCRYPTION_KEY/.test(k) && process.env[k]?.trim());
  assert.deepEqual(forbidden, [], 'Validation must not inherit any production data/provider secrets');
  const original = process.cwd();
  const launcher = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
  assert.equal(launcher, process.env.SWAY_VALIDATION_EXPECTED_SHA);
  assert.equal(execFileSync('git', ['status','--porcelain'],{encoding:'utf8'}).trim(), '');
  const temp = mkdtempSync(join(tmpdir(), 'sway-payment-proof-'));
  const repo = join(temp, 'candidate');
  const out = resolve('.validation-public');
  mkdirSync(out, {recursive:true});
  const report = { candidate, launcher, startedAt:new Date().toISOString(), focused, scope:focused ? 'Focused native recovery diagnostic only; not full application approval' : 'Exact candidate application and loopback-database tests; public GET-only deployment observation. No provider transfer or production write.', steps:[], production:[], passed:false, providerTransactionsExecuted:false, productionMutations:false };
  let pg;
  const childEnv = {};
  for (const key of ['PATH','HOME','USER','SHELL','LANG','TMPDIR','PLAYWRIGHT_BROWSERS_PATH']) if(process.env[key]) childEnv[key]=process.env[key];
  Object.assign(childEnv,{CI:'true',NODE_ENV:'test',DISABLE_HMR:'true',TZ:'UTC',SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED:'false',SWAY_NATIVE_TICKETS_ENABLED:'false',SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED:'false',SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED:'false'});
  const scrub = text => String(text).replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[OWNED_LOOPBACK_DATABASE]');
  async function step(name, command, args, {cwd=repo, env={}, timeout=300000, required=true}={}) {
    console.log('SWAY_MONEY_BEGIN '+name);
    const started=Date.now(); let output='',timedOut=false,escalation;
    const child=spawn(command,args,{cwd,env:{...childEnv,...env},detached:true,stdio:['ignore','pipe','pipe']});
    const kill=signal=>{if(!child.pid)return;try{process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}};
    const timer=setTimeout(()=>{timedOut=true;kill('SIGTERM');escalation=setTimeout(()=>kill('SIGKILL'),5000);},timeout);
    const consume=data=>{const text=scrub(data);process.stdout.write(text);output=(output+text).slice(-20000);};
    child.stdout.on('data',consume);child.stderr.on('data',consume);
    const result=await new Promise(resolveResult=>{child.once('error',e=>resolveResult({code:null,error:e.message}));child.once('close',(code,signal)=>resolveResult({code,signal}));});
    clearTimeout(timer);clearTimeout(escalation);kill('SIGKILL');
    const row={name,passed:result.code===0&&!timedOut,...result,timedOut,durationMs:Date.now()-started,tail:output.slice(-6000)};
    report.steps.push(row);writeFileSync(join(out,'money-evidence.json'),JSON.stringify(report,null,2));
    console.log('SWAY_MONEY_RESULT '+JSON.stringify(row));
    if(required&&!row.passed)throw new Error(name+' failed');
    return row;
  }
  function sanitized(value,key='') {
    if(/secret|token|password|credential|recipient|email|key|account|performer.*id/i.test(key))return Boolean(value)?'[present; omitted]':null;
    if(Array.isArray(value))return value.slice(0,60).map(v=>sanitized(v));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitized(v,k)]));
    return typeof value==='string'?value.slice(0,500):value;
  }
  async function observeProduction() {
    for(const base of ['https://app.sway.tips','https://sway-tips.onrender.com'])for(const pathname of ['/api/build-marker','/api/release-health','/api/payment/config']) {
      let row;
      try {
        const response=await fetch(base+pathname,{method:'GET',redirect:'error',headers:{'Cache-Control':'no-cache','User-Agent':'SwayReadOnlyPaymentAudit/1.0'},signal:AbortSignal.timeout(20000)});
        const text=await response.text();let payload;try{payload=JSON.parse(text);}catch{payload={nonJson:true,length:text.length};}
        row={base,pathname,status:response.status,at:new Date().toISOString(),payload:sanitized(payload)};
      }catch(error){row={base,pathname,error:String(error)};}
      report.production.push(row);console.log('SWAY_MONEY_PRODUCTION '+JSON.stringify(row));
    }
  }
  try {
    await observeProduction();
    await step('clone-candidate','git',['clone','--no-hardlinks','--no-checkout',original,repo],{cwd:temp});
    await step('fetch-exact-candidate','git',['fetch','--depth=1','https://github.com/infotradescout/sway.tips.git',candidate]);
    await step('checkout-exact-candidate','git',['checkout','--detach',candidate]);
    assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),candidate);
    assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(),'');
    report.tree=execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:repo,encoding:'utf8'}).trim();
    report.migrationFiles=readdirSync(join(repo,'drizzle')).filter(n=>/^\d{4}_.+\.sql$/.test(n)).length;
    const server=readFileSync(join(repo,'server.ts'),'utf8').split('\n');
    report.paymentRouteSource=server.flatMap((line,index)=>line.includes('"/api/payment/config"')||line.includes("'/api/payment/config'")?[{line:index+1,source:server.slice(index,index+65).join('\n')}]:[]);
    console.log('SWAY_MONEY_ROUTE_SOURCE '+JSON.stringify(report.paymentRouteSource));
    await step('candidate-clean-install','npm',['ci','--include=dev'],{timeout:600000});
    await step('lint','npm',['run','lint']);
    await step('build','npm',['run','build']);
    await step('chromium','node',['node_modules/playwright/cli.js','install','chromium']);
    if(!focused)for(const name of ['test:paypal-payout-readiness','test:paypal-payouts','test:payout-destinations','test:performer-withdrawals','test:payment-pricing'])await step(name,'npm',['run',name],{required:false});
    const deps=join(temp,'native-dependencies');mkdirSync(deps);
    await step('native-postgres-install','npm',['install','--prefix',deps,'--no-audit','--no-fund','--package-lock=false','embedded-postgres@18.4.0-beta.17'],{cwd:temp,timeout:600000});
    const requireDeps=createRequire(join(deps,'package.json'));
    const {default:EmbeddedPostgres}=await import(pathToFileURL(requireDeps.resolve('embedded-postgres')).href);
    const password=randomBytes(18).toString('hex');
    pg=new EmbeddedPostgres({databaseDir:join(temp,'pgdata'),user:'postgres',password,port:25439,persistent:false,onLog:()=>{},onError:message=>console.error(scrub(message))});
    await pg.initialise();await pg.start();
    const dbName='sway_payment_disposable_proof';await pg.createDatabase(dbName);
    const client=pg.getPgClient();await client.connect();
    const attestation=await client.query('select version(), pg_backend_pid() as pid, inet_server_port() as port');await client.end();
    report.nativeDatabase=attestation.rows[0];assert.match(report.nativeDatabase.version,/^PostgreSQL /);assert.equal(report.nativeDatabase.port,25439);
    console.log('SWAY_MONEY_NATIVE_DATABASE '+JSON.stringify(report.nativeDatabase));
    const dbUrl=`postgresql://postgres:${password}@127.0.0.1:25439/${dbName}`;
    const nativeEnv={SWAY_ALLOW_DISPOSABLE_DATABASE_RESET:'true',SWAY_REQUIRE_REAL_POSTGRES_PROOF:'true',SWAY_REAL_POSTGRES_PROOF_DATABASE_URL:dbUrl};
    const nativeTests=focused?['test:integration:live-room-real-postgres-concurrency']:['test:performer-withdrawals','test:integration:withdrawal-refund-concurrency','test:integration:live-room-real-postgres-concurrency'];
    for(const name of nativeTests) {
      const result=await step('native:'+name,'npm',['run',name],{env:nativeEnv,timeout:600000,required:false});
      if(!result.passed) {
        const requireCandidate=createRequire(join(repo,'package.json'));
        const {Client}=requireCandidate('pg');
        const diagnostic=new Client({connectionString:dbUrl});
        try {
          await diagnostic.connect();
          const rows=await diagnostic.query("select p.id, p.idempotency_key, p.payment_status, p.refund_status, p.action_type, p.legacy_unlinked, p.destination_account_id, p.amount_total, o.operation_type, o.status as operation_status, o.last_error from payments p left join live_room_payment_operations o on o.payment_id=p.id order by p.created_at desc, o.created_at desc limit 25");
          report.recoveryDiagnostic=rows.rows;
          console.log('SWAY_MONEY_RECOVERY_DIAGNOSTIC '+JSON.stringify(rows.rows));
        } catch(error) {report.recoveryDiagnosticError=scrub(error.message);}
        finally {await diagnostic.end();}
      }
    }
    if(!focused)for(const name of ['test:integration:simulated-live-night-browser','test:browser:payment-modal-viewport','test:browser:profile-payout-options','test:contracts'])await step(name,'npm',['run',name],{timeout:name==='test:contracts'?1200000:600000,required:false});
    // The existing browser suite emits screenshots/results here. Archive only
    // this known untracked proof directory; never hide a tracked source change.
    assert.equal(execFileSync('git',['diff','--name-only','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),'','Tests changed tracked source');
    const untracked=execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:repo,encoding:'utf8'}).trim().split('\n').filter(Boolean);
    assert(untracked.every(name=>name.startsWith('tmp/public-entry-qa/')),'Unexpected untracked files: '+JSON.stringify(untracked));
    report.generatedProofFiles=untracked;
    if(existsSync(join(repo,'tmp/public-entry-qa'))) {
      cpSync(join(repo,'tmp/public-entry-qa'),join(out,'public-entry-qa'),{recursive:true});
      rmSync(join(repo,'tmp/public-entry-qa'),{recursive:true});
    }
    report.sourceStatus=execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim();
    assert.equal(report.sourceStatus,'','Candidate must be clean after archiving generated proof');
    report.passed=report.steps.every(row=>row.passed);
  } catch(error) {
    report.error=scrub(error.stack||error);console.error('SWAY_MONEY_ERROR '+report.error);
  } finally {
    try{await pg?.stop();}catch(error){report.cleanupError=String(error);report.passed=false;}
    report.finishedAt=new Date().toISOString();
    writeFileSync(join(out,'money-evidence.json'),JSON.stringify(report,null,2));
    writeFileSync(join(out,'robots.txt'),'User-agent: *\nDisallow: /\n');
    writeFileSync(join(out,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Payment application verification: '+(report.passed?'tests passed':'FAILED / incomplete')+'</h1><p>No real provider transfer or production write.</p><a href="money-evidence.json">Exact-source evidence</a>');
    console.log('SWAY_MONEY_SUMMARY '+JSON.stringify({...report,steps:report.steps.map(({tail,...row})=>row),paymentRouteSource:undefined}));
    if(!report.passed)process.exitCode=1;
  }
}
