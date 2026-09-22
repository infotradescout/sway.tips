import assert from 'node:assert/strict';
import fs from 'node:fs';
const expected=String(process.env.SWAY_QUALITY_DASHBOARD_OBSERVE||'');
assert.match(expected,/^[a-f0-9]{40}$/);
const report={expected,startedAt:new Date().toISOString(),result:'fail',customerMutations:0,diagnosticWrites:0,authenticatedOperatorSessionObserved:false,checks:[]};
async function get(path){return fetch('https://app.sway.tips'+path,{headers:{'user-agent':'sway-runtime-proof/dashboard-readonly','x-sway-qa':'1'},redirect:'error',signal:AbortSignal.timeout(20000)});}
async function health(){const response=await get('/api/release-health');const body=await response.json();const value={status:response.status,commit:body.commit,releaseActive:body.releaseActive,migrationsCompatible:body.migrations?.compatible};assert.equal(value.status,200);assert.equal(value.commit,expected);assert.equal(value.releaseActive,true);assert.equal(value.migrationsCompatible,true);return value;}
try{
 report.healthBefore=await health();
 const response=await get('/api/admin/discovery-observatory/acquisition-quality?start=2026-09-01&end=2026-09-02');
 const body=await response.json();assert([401,403].includes(response.status));assert.equal(Object.hasOwn(body,'report'),false);assert.equal(Object.hasOwn(body,'recorded_events'),false);
 report.checks.push({name:'unauthenticated-quality-read-denied',status:response.status,reportExposed:false,cacheControl:response.headers.get('cache-control')});
 report.healthAfter=await health();report.result='pass';
}catch(error){report.error=String(error.stack||error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();report.boundary='Exact live release, compatible migrations and unauthenticated denial only. No real or synthetic audience, customer action, account, or production administrator session is created.';fs.mkdirSync('.validation-public',{recursive:true});fs.writeFileSync('.validation-public/quality-dashboard-live.json',JSON.stringify(report,null,2));fs.writeFileSync('.validation-public/index.html','<meta name="robots" content="noindex,nofollow"><h1>Sway quality-dashboard release</h1><a href="quality-dashboard-live.json">GET-only acceptance</a>');fs.writeFileSync('.validation-public/robots.txt','User-agent: *\nDisallow: /\n');console.log('SWAY_QUALITY_DASHBOARD_LIVE '+JSON.stringify(report));}
