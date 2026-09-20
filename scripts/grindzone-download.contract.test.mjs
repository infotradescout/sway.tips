import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const script=new URL('./prepare-grindzone-host.mjs',import.meta.url);
test('download build retains the deployed relay pin and stages only fixed public files',()=>{
 const source=readFileSync(script,'utf8');assert.match(source,/sourceSha='58ceb46de0ab10463dcdd7187985d91d8b4bf45a'/);assert.match(source,/downloadSourceSha='5974923b6a87666c87af34742df96bbe0bdef18c'/);
 assert.match(source,/git.*diff.*--exit-code/s);assert.match(source,/--test-reporter=tap/);assert.match(source,/dist\/grindzone-download/);assert.match(source,/manifest\.privateEnrollmentIncluded!==false/);assert.match(source,/manifest\.playerDataIncluded!==false/);assert.match(source,/checksum|integrity/i);assert.doesNotMatch(source,/process\.env\.(DATABASE_URL|GRINDZONE_PHONE_KEY|STRIPE_SECRET_KEY)/);
});
test('disabled shared-phone feature performs no build or disk writes',async()=>{
 const cwd=process.cwd(),previous=process.env.GRINDZONE_PHONE_ENABLED,dir=mkdtempSync(path.join(tmpdir(),'grindzone-disabled-build-'));
 try{process.chdir(dir);delete process.env.GRINDZONE_PHONE_ENABLED;const module=await import(script.href+'?disabled-test');assert.equal(module.sourceSha,'58ceb46de0ab10463dcdd7187985d91d8b4bf45a');assert.deepEqual(readdirSync(dir),[]);}
 finally{process.chdir(cwd);if(previous===undefined)delete process.env.GRINDZONE_PHONE_ENABLED;else process.env.GRINDZONE_PHONE_ENABLED=previous;rmSync(dir,{recursive:true,force:true});}
});
