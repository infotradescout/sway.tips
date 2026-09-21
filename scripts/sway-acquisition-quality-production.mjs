import assert from 'node:assert/strict';
import fs from 'node:fs';
const expected=String(process.env.SWAY_ACQUISITION_QUALITY_OBSERVE||'');
assert.match(expected,/^[a-f0-9]{40}$/);
const authorizedWrite=process.env.SWAY_ACQUISITION_QA_WRITE_APPROVED==='true';
const journey='a0238b41-6069-4cf6-9421-c45db1059472';
const report={expected,startedAt:new Date().toISOString(),result:'fail',diagnosticWritesAttempted:0,organicUsersCreated:0,customerMutations:0,journeyId:authorizedWrite?journey:null};
async function health(){
 const response=await fetch('https://app.sway.tips/api/release-health',{headers:{'user-agent':'sway-runtime-proof/acquisition-quality'},redirect:'error',signal:AbortSignal.timeout(20000)});
 const value=await response.json();
 const observed={status:response.status,commit:value.commit,releaseActive:value.releaseActive,migrationsCompatible:value.migrations?.compatible};
 assert.equal(observed.status,200);assert.equal(observed.commit,expected);assert.equal(observed.releaseActive,true);assert.equal(observed.migrationsCompatible,true);return observed;
}
try{
 report.healthBefore=await health();
 if(authorizedWrite){
  // Exactly one attempt. On uncertain delivery, inspect the persisted journey;
  // never automatically retry this write or present it as customer acquisition.
  report.diagnosticWritesAttempted=1;
  console.log('ACQUISITION_QA_ATTEMPT '+JSON.stringify({journeyId:journey,expected}));
  const response=await fetch('https://app.sway.tips/api/analytics/shell',{method:'POST',redirect:'error',headers:{'content-type':'application/json','user-agent':'sway-runtime-proof/acquisition-quality','x-sway-qa':'1'},body:JSON.stringify({shell:'patron',surface:'public-discover',event:'discovery_landing',route_family:'public-discover',has_route_context:true,has_session_context:false,build_commit:'owned-diagnostic',journey_id:journey,entry_path:'/discover',attribution_channel:'unknown'}),signal:AbortSignal.timeout(20000)});
  report.ingestionStatus=response.status;report.response=await response.json();
  assert.equal(response.status,202);assert.equal(report.response.accepted,true);
 }
 report.healthAfter=await health();report.result='pass';
 report.boundary='This checks live release health and optional explicit QA ingestion only. Persisted classification and exclusion require an independent aggregate database read. No genuine visitors, conversions, search impressions or growth are established.';
}catch(error){report.error=String(error.stack||error);process.exitCode=1;}
finally{
 report.finishedAt=new Date().toISOString();fs.mkdirSync('.validation-public',{recursive:true});
 fs.writeFileSync('.validation-public/acquisition-production.json',JSON.stringify(report,null,2));
 fs.writeFileSync('.validation-public/index.html','<meta name="robots" content="noindex,nofollow"><h1>Acquisition release observation</h1><a href="acquisition-production.json">Receipt</a>');
 fs.writeFileSync('.validation-public/robots.txt','User-agent: *\nDisallow: /\n');
 console.log('ACQUISITION_PRODUCTION '+JSON.stringify(report));
}
