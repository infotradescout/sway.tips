import test from 'node:test';
import assert from 'node:assert/strict';
import {bindPhoneSource,legacyPhoneSource} from './grindzone-build-binding.mjs';
const marker="'node_modules/.grindzone-phone', '"+legacyPhoneSource+"', 'cloud/shared-host.mjs'",next='a'.repeat(40);
test('build binding changes only the declared relay source argument',()=>{
 const source='unchanged application code; join('+marker+'); unchanged route handlers';
 assert.equal(bindPhoneSource(source,next),source.replace(marker,marker.replace(legacyPhoneSource,next)));
});
test('missing or duplicated entry fails instead of modifying other host code',()=>{
 assert.throws(()=>bindPhoneSource('const unrelated="'+legacyPhoneSource+'";',next));assert.throws(()=>bindPhoneSource(marker+marker,next));
});
test('non-revision substitutions are rejected',()=>{for(const v of ['main','../other','',null])assert.throws(()=>bindPhoneSource(marker,v));});
