import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { classifyDiscoveryRequest, runDiscoveryTraffic, withDiscoveryTrafficEvidence, readDiscoveryTrafficClass } from '../src/server/discovery-traffic.ts';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';
import { ACQUISITION_QUALITY_SQL, validateAcquisitionWindow } from './report-acquisition-quality.mjs';

for (const key of ['DATABASE_URL','TEST_DATABASE_URL','SWAY_REAL_POSTGRES_PROOF_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','BREVO_API_KEY','SENDGRID_API_KEY','SMTP_PASS']) assert(!process.env[key], 'No inherited credentials: '+key);
assert.notEqual(process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF, 'true');
const report={passed:false, checks:[], scope:'Real server.ts, request guard and audit writes with isolated PGlite/PostgreSQL-protocol data. Request signals and conversion fixtures are synthetic; no production writes or verified human audience.'};
const browserHeaders={
  'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
  'referer':'https://app.sway.tips/discover', 'origin':'https://app.sway.tips',
  'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty'
};
const req=headers=>({method:'POST',originalUrl:'/api/analytics/shell',headers});
const classify=headers=>classifyDiscoveryRequest(req(headers)).classification;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let db,child,output='';
try {
  assert.equal(classify(browserHeaders),'browser_candidate');
  for(const agent of ['Googlebot/2.1','OAI-SearchBot/1.3','ChatGPT-User/1.0','facebookexternalhit/1.1','Mozilla/5.0 AppleWebKit/537.36 Chrome/140 Safari/537.36 SomeCrawler/1.0']) assert.equal(classify({...browserHeaders,'user-agent':agent}),'automation_signal');
  for(const agent of ['Mozilla/5.0 HeadlessChrome/140.0 Safari/537.36','sway-runtime-proof/3.0','curl/8.0','python-requests/2']) assert.equal(classify({...browserHeaders,'user-agent':agent}),'qa_signal');
  assert.equal(classify({...browserHeaders,'x-sway-qa':'1'}),'qa_signal');
  assert.equal(classify({...browserHeaders,referer:'https://app.sway.tips/discover?sway_qa=1'}),'qa_signal');
  assert.equal(classify({...browserHeaders,'user-agent':'Googlebot/2.1','x-sway-traffic-class':'browser_candidate'}),'automation_signal');
  for(const headers of [{},{...browserHeaders,'sec-fetch-site':'cross-site'},{...browserHeaders,referer:'https://app.sway.tips.evil.invalid/'},{...browserHeaders,referer:'https://app.sway.tips@evil.invalid/'},{...browserHeaders,origin:'https://evil.invalid'},{...browserHeaders,'user-agent':['Mozilla/5.0','Googlebot']}]) assert.equal(classify(headers),'unclassified');
  const original={source:'google'};
  assert.equal(withDiscoveryTrafficEvidence(original),original);
  await Promise.all(Array.from({length:24},(_,index)=>{
    const expected=index%2?'automation_signal':'browser_candidate';
    return runDiscoveryTraffic(req(index%2?{...browserHeaders,'user-agent':'OAI-SearchBot/1.3'}:browserHeaders),async()=>{
      await pause(index%5);
      const meta=withDiscoveryTrafficEvidence({source:'google',traffic_quality:{classification:'browser_candidate'}});
      assert.equal(meta.source,'google'); assert.equal(readDiscoveryTrafficClass(meta),expected);
      assert(!JSON.stringify(meta.traffic_quality).includes('Mozilla'));
    });
  }));
  assert.equal(withDiscoveryTrafficEvidence(original),original,'No request context may leak to the caller');
  for(const url of ['/api/admin/discovery-observatory','/api/request/create','/api/analytics/shell/other','/discover']) runDiscoveryTraffic({...req(browserHeaders),originalUrl:url},()=>assert.equal(withDiscoveryTrafficEvidence(original),original));
  assert.throws(()=>runDiscoveryTraffic(req(browserHeaders),()=>{throw new Error('callback failure');}),/callback failure/);
  assert.equal(withDiscoveryTrafficEvidence(original),original);
  assert.equal(readDiscoveryTrafficClass({source:'google'}),'legacy_unclassified');
  assert.equal(readDiscoveryTrafficClass({traffic_quality:{version:999,classification:'browser_candidate'}}),'unclassified');
  validateAcquisitionWindow('2026-08-24T05:00:00Z','2026-09-21T05:00:00Z');
  for(const range of [['2026-02-30T00:00:00Z','2026-03-02T00:00:00Z'],['2026-09-21','2026-09-22'],['2026-01-01T00:00:00Z','2026-09-01T00:00:00Z']]) assert.throws(()=>validateAcquisitionWindow(...range));
  report.checks.push('classification signals, provider impersonation boundaries, 24 interleaved contexts, scope isolation, failure propagation and strict reporting dates');

  db=await startEmbeddedPostgresProof('acquisition_quality');
  assert.equal(db.kind,'embedded-postgres');assert.equal(new URL(db.databaseUrl).hostname,'127.0.0.1');
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const origin='http://127.0.0.1:'+port;
  child=spawn(process.execPath,['--import','tsx','server.ts'],{env:{...process.env,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),DATABASE_URL:db.databaseUrl,SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION:'true'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>{output=(output+b).slice(-20000);});child.stderr.on('data',b=>{output=(output+b).slice(-20000);});
  let ready=false;
  for(let i=0;i<150;i++){
    if(child.exitCode!==null||child.signalCode!==null)break;
    try{const response=await fetch(origin+'/api/build-marker',{signal:AbortSignal.timeout(1000)});if(response.ok&&(response.headers.get('content-type')||'').includes('json')){ready=true;break;}}catch{}
    await pause(200);
  }
  assert(ready,'Isolated server startup failed: '+output);
  const payload=id=>({shell:'patron',surface:'public-discover',event:'discovery_landing',route_family:'public-discover',has_route_context:true,has_session_context:false,build_commit:'quality-fixture',journey_id:id,entry_path:'/discover',attribution_channel:'google'});
  const send=(body,headers)=>fetch(origin+'/api/analytics/shell',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const cases=[['browser_candidate',browserHeaders],['automation_signal',{...browserHeaders,'user-agent':'Googlebot/2.1'}],['automation_signal',{...browserHeaders,'user-agent':'OAI-SearchBot/1.3'}],['automation_signal',{...browserHeaders,'user-agent':'ChatGPT-User/1.0'}],['qa_signal',{...browserHeaders,'x-sway-qa':'1'}],['qa_signal',{...browserHeaders,'user-agent':'Mozilla/5.0 HeadlessChrome/140 Safari/537.36'}],['unclassified',{'user-agent':'UnknownClient/1'}]];
  await Promise.all(cases.map(async([expected,headers])=>{
    const id=randomUUID();const response=await send(payload(id),headers);assert.equal(response.status,202,await response.text());
    const stored=await db.query("SELECT metadata FROM audit_events WHERE metadata->>'journey_id'=$1",[id]);assert.equal(stored.rows.length,1);
    assert.equal(stored.rows[0].metadata.source,'google');assert.equal(stored.rows[0].metadata.link_strength,'client_correlated_unverified');
    assert.equal(readDiscoveryTrafficClass(stored.rows[0].metadata),expected,'Actual request/audit classification');
    assert.deepEqual(Object.keys(stored.rows[0].metadata.traffic_quality).sort(),['basis','classification','reason','version']);
  }));
  const fake=await send({...payload(randomUUID()),traffic_quality:{version:1,classification:'browser_candidate'}},browserHeaders);assert.equal(fake.status,400,'Clients cannot submit traffic authority');
  const privateEntry=await send({...payload(randomUUID()),entry_path:'/talent/gigs'},browserHeaders);assert.equal(privateEntry.status,400);
  const spoofId=randomUUID();assert.equal((await send(payload(spoofId),{...browserHeaders,'user-agent':'OAI-SearchBot/1.3','x-sway-traffic-class':'browser_candidate'})).status,202);
  assert.equal(readDiscoveryTrafficClass((await db.query("SELECT metadata FROM audit_events WHERE metadata->>'journey_id'=$1",[spoofId])).rows[0].metadata),'automation_signal');
  const noJourney=payload(randomUUID());delete noJourney.journey_id;assert.equal((await send(noJourney,{...browserHeaders,'x-sway-qa':'1'})).status,202);
  const fallback=await db.query("SELECT metadata FROM audit_events WHERE event_type='discovery_landing' AND NOT(metadata ? 'journey_id') ORDER BY created_at DESC LIMIT 1");
  assert.equal(readDiscoveryTrafficClass(fallback.rows[0].metadata),'qa_signal','Legacy telemetry fallback also carries server evidence');
  const denied=await fetch(origin+'/api/admin/discovery-observatory',{headers:{...browserHeaders,'x-sway-qa':'1'},signal:AbortSignal.timeout(10000)});assert([401,403].includes(denied.status),'QA markers cannot grant administrator access');
  report.checks.push('actual analytics HTTP route: seven concurrent traffic classes, unchanged sources/link strength, client-tag rejection, private-entry rejection, fallback audit tagging and protected-admin denial');

  // All report fixtures are confined to this new in-memory database and a fixed historical window.
  const traffic=classification=>({version:1,classification,reason:'synthetic_fixture',basis:'server_observed_request_signals'});
  const start='2026-08-01T00:00:00Z',end='2026-08-02T00:00:00Z';
  const empty=(await db.query(ACQUISITION_QUALITY_SQL,[start,end])).rows[0].report;
  assert.equal(empty.quality_available,false);assert.equal(empty.browser_candidate_journeys,null);
  const journey=()=>randomUUID();const jGood=journey(),jTainted=journey(),jLegacy=journey(),jWrong=journey();
  const row=async(id,event,stage,time,quality,extra={})=>{
    const metadata={stage,journey_id:id,source:'google',entry_path:'/discover',link_strength:'client_correlated_unverified',...(quality?{traffic_quality:traffic(quality)}:{}),...extra};
    await db.query("INSERT INTO audit_events(event_id,actor_type,entity_type,entity_id,event_type,metadata,created_at) VALUES($1,'anonymous','shell_friction',$2,$3,$4::jsonb,$5::timestamptz)",[randomUUID(),id,event,JSON.stringify(metadata),'2026-08-01T'+time+'Z']);
  };
  await row(jLegacy,'discovery_landing','entry','01:00:00',null);
  const legacy=(await db.query(ACQUISITION_QUALITY_SQL,[start,end])).rows[0].report;assert.equal(legacy.quality_available,false);assert.equal(legacy.browser_candidate_journeys,null);
  for(const id of [jGood,jTainted,jWrong])await row(id,'discovery_landing','entry','02:00:00','browser_candidate');
  const entity={entity_kind:'live_room',entity_key:'public-room',action_kind:'room_entry'};
  for(const id of [jGood,jTainted,jWrong])await row(id,'discovery_primary_action','action','02:01:00','browser_candidate',entity);
  await row(jTainted,'discovery_landing','entry','02:00:01','automation_signal');
  await row(jGood,'room_entry_completed','outcome','02:02:00',null,{...entity,outcome_status:'completed',link_strength:'direct_server_observed'});
  await row(jWrong,'room_entry_completed','outcome','02:02:00',null,{...entity,entity_key:'different-room',outcome_status:'completed',link_strength:'direct_server_observed'});
  await row(jWrong,'tip_action_completed','outcome','01:00:00',null,{entity_kind:'live_room',entity_key:'public-room',action_kind:'tip',outcome_status:'completed',link_strength:'direct_server_observed'});
  await row(jTainted,'room_entry_completed','outcome','02:02:00',null,{...entity,outcome_status:'completed',link_strength:'direct_server_observed'});
  const totals=(await db.query(ACQUISITION_QUALITY_SQL,[start,end])).rows[0].report;
  assert.equal(totals.browser_candidate_journeys,2);assert.equal(totals.linked_durable_outcomes,1);assert.equal(totals.unlinked_durable_outcomes,3);
  assert.equal(totals.candidate_sources[0].journeys_with_linked_durable_outcome,1);assert.equal(totals.verified_unique_people,null);
  for(const id of [jGood,jWrong,jLegacy,jTainted])assert(!JSON.stringify(totals).includes(id),'Report cannot disclose journey IDs');
  report.checks.push('actual SQL: absent classification stays unavailable; automation-tainted journeys excluded; source/entry/action/entity/time-ordered durable matching; wrong entity, early outcome and legacy traffic cannot inflate conversions');
  report.passed=true;
}catch(error){report.error=String(error.stack||error);report.serverTail=output.slice(-4000);}
finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');for(let i=0;i<50&&child.exitCode===null&&child.signalCode===null;i++)await pause(100);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
  await db?.close();
  console.log('ACQUISITION_QUALITY_TEST '+JSON.stringify(report));
}
if(!report.passed)process.exit(1);
