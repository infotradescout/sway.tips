import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const script=new URL('./prepare-grindzone-host.mjs',import.meta.url);
test('phone-enabled download and live relay use one reviewed source and only public artifacts',()=>{
 const source=readFileSync(script,'utf8'),relay=source.match(/sourceSha='([a-f0-9]{40})'/)?.[1],download=source.match(/downloadSourceSha='([a-f0-9]{40})'/)?.[1];
 assert.ok(relay);assert.equal(relay,download);assert.notEqual(relay,'58ceb46de0ab10463dcdd7187985d91d8b4bf45a');
 assert.match(source,/git.*diff.*--exit-code/s);assert.match(source,/--test-reporter=tap/);assert.match(source,/verify-phone-connection\.mjs/);assert.match(source,/dist\/grindzone-download/);
 assert.match(source,/manifest\.privateEnrollmentIncluded!==false/);assert.match(source,/manifest\.playerDataIncluded!==false/);assert.match(source,/checksum|integrity/i);
 assert.doesNotMatch(source,/process\.env\.(DATABASE_URL|GRINDZONE_PHONE_KEY|STRIPE_SECRET_KEY)/);
});
test('disabled shared-phone feature performs no build or disk writes',async()=>{
 const cwd=process.cwd(),previous=process.env.GRINDZONE_PHONE_ENABLED,dir=mkdtempSync(path.join(tmpdir(),'grindzone-disabled-build-'));
 try{process.chdir(dir);delete process.env.GRINDZONE_PHONE_ENABLED;const module=await import(script.href+'?disabled-test');assert.match(module.sourceSha,/^[a-f0-9]{40}$/);assert.equal(module.sourceSha,module.downloadSourceSha);assert.deepEqual(readdirSync(dir),[]);}
 finally{process.chdir(cwd);if(previous===undefined)delete process.env.GRINDZONE_PHONE_ENABLED;else process.env.GRINDZONE_PHONE_ENABLED=previous;rmSync(dir,{recursive:true,force:true});}
});
// Preserve node:test failures explicitly for the existing hard-contract convention.
// Wait until asynchronous tests finish; never force a successful exit.
process.on('beforeExit', () => { if (process.exitCode) process.exit(1); });
