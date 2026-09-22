import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const candidate = '9a59478d2f54780026d6bca0ac233e226ca47670';
const base = 'e067b2700626a67291eb3ed73683def00242086a';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sway-retained-taint-'));
const checkout = path.join(temporary, 'source');
const output = path.resolve('.validation-public');
const env = Object.fromEntries(['PATH','HOME','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { CI: 'true', NODE_OPTIONS: '--max-old-space-size=3072' });
const report = { candidate, base, harness: process.env.RENDER_GIT_COMMIT, startedAt: new Date().toISOString(), result: 'fail', steps: [], productionWrites: 0, scope: 'Exact SQL exclusion repair, isolated fixtures and existing release gates. No production traffic measurement or authenticated operator session.' };
function run(label, command, args, cwd = checkout, expected = 0) {
  console.log('RETAINED_TAINT_START ' + label);
  const r = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 900000, maxBuffer: 48 * 1024 * 1024 });
  const text = (r.stdout || '') + (r.stderr || '');
  report.steps.push({ label, exit: r.status, expected, at: new Date().toISOString(), error: r.error?.message || null });
  console.log('RETAINED_TAINT_STEP ' + JSON.stringify(report.steps.at(-1)));
  if (r.status !== expected) console.error(text.slice(-16000));
  assert.equal(r.status, expected, label);
  return text;
}
try {
  for (const key of ['DATABASE_URL','TEST_DATABASE_URL','SWAY_REAL_POSTGRES_PROOF_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','BREVO_API_KEY','SENDGRID_API_KEY','SMTP_PASS']) assert(!process.env[key], 'Isolated runner cannot inherit ' + key);
  run('clone','git',['clone','--no-hardlinks','--no-checkout',process.cwd(),checkout],temporary);
  run('fetch','git',['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',candidate]);
  run('checkout','git',['checkout','--detach',candidate]);
  assert.equal(run('identity','git',['rev-parse','HEAD']).trim(),candidate);
  assert.equal(run('initial-clean','git',['status','--porcelain']).trim(),'');
  assert.deepEqual(run('bounded-diff','git',['diff','--name-only',base,candidate]).trim().split('\n').sort(),[
    'scripts/report-acquisition-quality.mjs','scripts/sway-acquisition-retained-taint.test.mjs','scripts/sway-telemetry.contract.test.mjs'
  ]);
  run('npm-ci','npm',['ci','--include=dev','--no-audit','--no-fund']);
  const positive = run('retained-sql-regression',process.execPath,['--test','--test-reporter=tap','scripts/sway-acquisition-retained-taint.test.mjs']);
  assert.match(positive, /^# pass 13\s*$/m); assert.match(positive,/^# fail 0\s*$/m);
  const file = path.join(checkout,'scripts/report-acquisition-quality.mjs');
  const fixed = fs.readFileSync(file);
  const old = run('baseline-report','git',['show',base+':scripts/report-acquisition-quality.mjs']);
  try {
    fs.writeFileSync(file,old);
    const negative = run('baseline-negative-control',process.execPath,['--test','--test-reporter=tap','scripts/sway-acquisition-retained-taint.test.mjs'],checkout,1);
    assert.match(negative,/retained-taint admission/);
    report.negativeControl = 'Unmodified baseline fails the retained-taint admission assertion.';
  } finally { fs.writeFileSync(file,fixed); }
  run('restored-source','git',['diff','--exit-code','HEAD','--']);
  run('lint','npm',['run','lint']);
  run('build','npm',['run','build']);
  run('full-contracts','npm',['run','test:contracts']);
  run('tracked-clean','git',['diff','--exit-code','HEAD','--']);
  const generated = run('generated','git',['ls-files','--others','--exclude-standard']).trim().split('\n').filter(Boolean);
  assert(generated.every(p => p.startsWith('tmp/public-entry-qa/') || p.startsWith('tmp/music-sources-proof/')), 'Unexpected generated files');
  report.generatedFiles = generated.length;
  for (const folder of ['tmp/public-entry-qa','tmp/music-sources-proof']) {
    assert.equal(run('untracked-only-'+path.basename(folder),'git',['ls-files','--',folder]).trim(),'');
    fs.rmSync(path.join(checkout,folder), { recursive:true, force:true });
  }
  assert.equal(run('final-clean','git',['status','--porcelain']).trim(),'');
  report.result = 'pass';
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  fs.rmSync(temporary, { recursive: true, force: true });
  report.ownedCheckoutRemoved = !fs.existsSync(temporary);
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output,'retained-taint.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(output,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Retained-history exclusion verification</h1><a href="retained-taint.json">Exact result and boundaries</a>');
  fs.writeFileSync(path.join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');
  console.log('RETAINED_TAINT_SUMMARY ' + JSON.stringify(report));
}
