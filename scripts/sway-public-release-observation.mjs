import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

// Only the existing isolated static proof service may run this observer.
// No credentials, mutation requests, tests, provider calls or app deployment.
for (const key of Object.keys(process.env)) if (/^BASH_FUNC_.+%%$/.test(key)) delete process.env[key];
assert.equal(process.env.RENDER_SERVICE_ID, 'srv-daesln0u01pc73fso5kg');
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
assert.equal(process.env.SWAY_PUBLIC_RELEASE_OBSERVATION, 'true');
for (const key of ['SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED','SWAY_NATIVE_TICKETS_ENABLED','SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED','SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED','SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED']) assert.equal(process.env[key], 'false');
assert.deepEqual(Object.keys(process.env).filter(key => /DATABASE_URL$|(?:STRIPE|PAYPAL|EMAIL|R2|AWS|CLOUDFLARE).*(?:SECRET|TOKEN|API_KEY|ACCESS_KEY)|PAYOUT_RECIPIENT_ENCRYPTION_KEY/.test(key) && process.env[key]?.trim()), []);
const head = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(head, process.env.SWAY_VALIDATION_EXPECTED_SHA);
assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(), '');
const mode = process.env.SWAY_PUBLIC_OBSERVATION_MODE;
assert(['artifacts','production'].includes(mode));
const artifactBase = 'https://sway-release-proof.onrender.com';
const hosts = ['https://sway.tips','https://www.sway.tips','https://app.sway.tips'];
const artifactPaths = ['index.html','robots.txt','source-evidence.json', ...['native','embedded'].flatMap(kind => ['results.json','sources-1440.png','sources-390.png','sources-320.png'].map(name => `music-sources-proof/${kind}/${name}`))];
const allowed = new Set([...artifactPaths.map(path => `${artifactBase}/${path}`), ...hosts.flatMap(host => ['/api/build-marker','/api/release-health'].map(path => host + path))]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function read(url) {
  assert(allowed.has(url), 'Unlisted read');
  const signal = AbortSignal.timeout(20000);
  const response = await fetch(url, {method:'GET', redirect:'error', signal, headers:{'cache-control':'no-cache'}});
  assert.equal(response.status, 200, `GET failed: ${url}`);
  const reader = response.body.getReader(); let size=0; const parts=[];
  try { while (true) { const {done,value}=await reader.read(); if(done) break; size+=value.length; assert(size<=3000000,'Oversized public artifact'); parts.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(()=>{}); }
  return Buffer.concat(parts);
}
const report={schemaVersion:1,mode,observer:head,observedAt:new Date().toISOString(),testsRun:false,productionMutations:false,providerCalls:false,observations:[]};
// Retain the exact existing receipt and its complete Sources artifact bundle;
// do not replace acceptance with an observation or regenerate candidate tests.
const files = new Map();
for (const path of artifactPaths) files.set(path, await read(`${artifactBase}/${path}`));
const receipt = JSON.parse(files.get('source-evidence.json').toString('utf8'));
assert.equal(receipt.candidate,'d1cf90aab06b31fea8cfc7b8a270e9f961a7e5cf');
assert.equal(receipt.tree,'103ef8e643dc15a10d2816bdf5dcb9c13e56f5e1');
assert.equal(receipt.passed,true); assert.equal(receipt.steps.length,16); assert(receipt.steps.every(row=>row.passed));
report.candidate=receipt.candidate; report.receiptSha256=digest(files.get('source-evidence.json'));
for (const kind of ['native','embedded']) {
 const result=JSON.parse(files.get(`music-sources-proof/${kind}/results.json`).toString('utf8'));
 assert.equal(result.passed,true); assert.equal(result.checks.length,13);
}
if (mode==='artifacts') {
 for (const width of [390,320,1440]) {
  const bytes=files.get(`music-sources-proof/native/sources-${width}.png`);
  const metadata=await sharp(bytes).metadata(); assert.equal(metadata.width,width);
  const preview=await sharp(bytes).resize({width:Math.min(width,960),withoutEnlargement:true}).webp({quality:35,effort:6}).toBuffer();
  const row={width,height:metadata.height,originalSha256:digest(bytes),previewSha256:digest(preview),previewBytes:preview.length};
  report.observations.push(row); console.log('SWAY_ARTIFACT_IMAGE_'+width+' '+JSON.stringify({...row,mime:'image/webp',base64:preview.toString('base64')}));
 }
} else {
 const expected=process.env.SWAY_PUBLIC_EXPECTED_PRODUCTION_SHA; assert.match(expected||'',/^[a-f0-9]{40}$/);
 for (const host of hosts) {
  const marker=JSON.parse((await read(host+'/api/build-marker')).toString('utf8'));
  const health=JSON.parse((await read(host+'/api/release-health')).toString('utf8'));
  assert.equal(marker.commit,expected); assert.equal(health.commit,expected);
  assert.equal(health.releaseActive,true); assert.equal(health.database.reachable,true); assert.equal(health.migrations.compatible,true);
  report.observations.push({host,commit:marker.commit,releaseActive:health.releaseActive,databaseReachable:health.database.reachable,migrationsCompatible:health.migrations.compatible});
 }
}
assert.equal(digest(await read(artifactBase+'/source-evidence.json')),report.receiptSha256,'Receipt changed during observation');
for (const [path,bytes] of files) {
 const full='.validation-public/'+path; mkdirSync(full.slice(0,full.lastIndexOf('/')),{recursive:true}); writeFileSync(full,bytes);
}
writeFileSync('.validation-public/read-only-observation.json',JSON.stringify(report,null,2));
console.log('SWAY_PUBLIC_OBSERVATION_COMPLETE '+JSON.stringify(report));
