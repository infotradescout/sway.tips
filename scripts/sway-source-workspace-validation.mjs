import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

assert.equal(process.env.RENDER_SERVICE_ID, 'srv-daesln0u01pc73fso5kg');
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
const head = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
assert.equal(head, process.env.SWAY_VALIDATION_EXPECTED_SHA);
const base = '7db08c3946da01c8831a24b61fe54903d6c87c84';
execFileSync('git', ['fetch','origin',base], {stdio:'ignore',timeout:30000});
// Exercise the existing checkout's normal authentication only. No credential
// inspection, elevation, branch creation, force push or production write.
const result = spawnSync('git', ['push','--dry-run','origin',`${base}:refs/heads/feat/music-sources-20260912`], {
  env:{...process.env,GIT_TERMINAL_PROMPT:'0'},encoding:'utf8',timeout:30000
});
const report={launcher:head,base,normalGitPushAvailable:result.status===0,exitCode:result.status,errorCode:result.error?.code??null};
console.log('SWAY_SOURCE_EXECUTION '+JSON.stringify(report));
mkdirSync('.validation-public',{recursive:true});
writeFileSync('.validation-public/source-execution.json',JSON.stringify(report));
writeFileSync('.validation-public/index.html','<meta name="robots" content="noindex"><p>Isolated source execution check only. No Sway production changes.</p>');
writeFileSync('.validation-public/robots.txt','User-agent: *\nDisallow: /\n');
