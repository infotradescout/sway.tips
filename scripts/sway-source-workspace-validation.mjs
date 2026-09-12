import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(process.env.RENDER_SERVICE_ID, 'srv-daesln0u01pc73fso5kg');
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
const launcher=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(launcher,process.env.SWAY_VALIDATION_EXPECTED_SHA);
for(const key of ['SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED','SWAY_NATIVE_TICKETS_ENABLED','SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED','SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED','SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED'])assert.equal(process.env[key],'false');
const forbidden=Object.keys(process.env).filter(key=>/DATABASE_URL$|(?:STRIPE|PAYPAL|EMAIL|R2|AWS|CLOUDFLARE).*(?:SECRET|TOKEN|API_KEY|ACCESS_KEY)|PAYOUT_RECIPIENT_ENCRYPTION_KEY/.test(key)&&process.env[key]?.trim());
assert.deepEqual(forbidden,[]);
const candidate=process.env.SWAY_SOURCE_CANDIDATE_SHA;
assert.match(candidate||'',/^[a-f0-9]{40}$/);
const original=process.cwd(),temp=mkdtempSync(join(tmpdir(),'sway-sources-')),repo=join(temp,'candidate'),out=resolve('.validation-public');
mkdirSync(out,{recursive:true});
const env={PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',NODE_ENV:'test',TZ:'UTC',GIT_TERMINAL_PROMPT:'0',DISABLE_HMR:'true'};
const report={launcher,candidate,startedAt:new Date().toISOString(),steps:[],productionMutations:false,providerRequests:false};
function run(name,cmd,args,cwd=repo,timeout=300000){
 const r=spawnSync(cmd,args,{cwd,env,encoding:'utf8',timeout,maxBuffer:16000000});
 const row={name,exitCode:r.status,error:r.error?.code||null,tail:((r.stdout||'')+(r.stderr||'')).slice(-7000)};
 report.steps.push(row);console.log('SWAY_SOURCE_RESULT '+JSON.stringify(row));return r;
}
try{
 assert.equal(run('clone','git',['clone','--no-hardlinks','--no-checkout',original,repo],temp).status,0);
 assert.equal(run('fetch','git',['fetch','--depth=1','https://github.com/infotradescout/sway.tips.git',candidate]).status,0);
 assert.equal(run('checkout','git',['checkout','--detach',candidate]).status,0);
 assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(),'');
 for(const [path,terms] of [
  ['src/components/TalentDashboard.tsx',['const handleDjLibraryFileImport','const handleSpotifyPlaylistImport','const loadLinkedLibrarySources','const loadRequestLibrary']],
  ['server.ts',["app.post('/api/talent/library/import", "app.get('/api/talent/library", "app.post('/api/talent/library/sources"]]
 ]){
  const lines=readFileSync(join(repo,path),'utf8').split('\n');
  for(const term of terms){const i=lines.findIndex(line=>line.includes(term));console.log('SWAY_SOURCE_INSPECT '+JSON.stringify({path,term,line:i+1,source:i>=0?lines.slice(i,i+110).join('\n'):null}));}
 }
 assert.equal(run('install','npm',['ci','--include=dev'],repo,600000).status,0);
 run('parser-baseline','node',['--import','tsx','scripts/sway-music-list-import.test.mjs']);
 run('lint-baseline','npm',['run','lint']);
 // Test only the checkout's existing normal Git authentication. Do not inspect
 // credentials or change refs; this dry run may report unavailable write access.
 const push=spawnSync('git',['push','--dry-run','https://github.com/infotradescout/sway.tips.git',`${candidate}:refs/heads/feat/music-sources-20260912`],{cwd:repo,env,encoding:'utf8',timeout:30000});
 report.normalGitPushAvailable=push.status===0;report.pushErrorCode=push.error?.code||null;
 console.log('SWAY_SOURCE_PUSH_CAPABILITY '+JSON.stringify({available:report.normalGitPushAvailable,exitCode:push.status,errorCode:report.pushErrorCode}));
}catch(error){report.error=String(error);console.log('SWAY_SOURCE_ERROR '+String(error));}
report.finishedAt=new Date().toISOString();
writeFileSync(join(out,'source-evidence.json'),JSON.stringify(report,null,2));
writeFileSync(join(out,'index.html'),'<meta name="robots" content="noindex,nofollow"><p>Isolated Sources inspection. No Sway production change.</p>');
writeFileSync(join(out,'robots.txt'),'User-agent: *\nDisallow: /\n');
console.log('SWAY_SOURCE_SUMMARY '+JSON.stringify({...report,steps:report.steps.map(({tail,...row})=>row)}));
if(report.error||report.steps.some(row=>row.exitCode!==0))process.exitCode=1;
