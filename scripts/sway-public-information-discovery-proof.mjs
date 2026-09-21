import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const candidate = '757f92edc45cc7b8b4a17ea161d465697a221c3e';
const metadataCandidate = '940337b312352c38578f13b839d2dab4eb0c61f5';
const base = '8186649c586a570a9c4efbd8ed2b8307fde58501';
const output = resolve('.validation-public');
const temporary = mkdtempSync(join(tmpdir(), 'sway-public-information-'));
const checkout = join(temporary, 'repo');
const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { CI: 'true', NODE_OPTIONS: '--max-old-space-size=3072' });
const report = { candidate, base, startedAt: new Date().toISOString(), steps: [], result: 'fail', productionChanged: false, trafficMeasured: false, observations: [] };
mkdirSync(output, { recursive: true });
function run(label, command, args, cwd = checkout) {
  console.log('INFORMATION_STEP_START ' + label);
  const result = spawnSync(command, args, { cwd, env, encoding:'utf8', timeout:1200000, maxBuffer:32*1024*1024 });
  writeFileSync(join(output, label + '.log'), (result.stdout || '') + (result.stderr || ''));
  console.log((result.stdout || '').slice(-16000)); console.log((result.stderr || '').slice(-8000));
  report.steps.push({ label, exit: result.status, at: new Date().toISOString() });
  console.log('INFORMATION_STEP_END ' + JSON.stringify(report.steps.at(-1)));
  assert.equal(result.status, 0, label + ': ' + String(result.error || 'command failed'));
  return result.stdout.trim();
}
try {
  for (const key of ['DATABASE_URL','TEST_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','BREVO_API_KEY','SENDGRID_API_KEY','SMTP_PASS']) assert(!process.env[key], 'No production credentials: ' + key);
  run('clone', 'git', ['clone','--no-hardlinks','--no-checkout',process.cwd(),checkout], temporary);
  run('fetch-candidate', 'git', ['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',candidate]);
  run('checkout', 'git', ['checkout','--detach',candidate]);
  assert.equal(run('identity','git',['rev-parse','HEAD']), candidate);
  assert.equal(run('initial-clean','git',['status','--porcelain']), '');
  const original = run('original-renderer','git',['show',base + ':scripts/sway-dj-beta-about-preload.cjs']);
  const current = readFileSync(join(checkout,'scripts/sway-dj-beta-about-preload.cjs'),'utf8').trim();
  const expected = original.replace("'use strict';", "'use strict';\n\nconst { buildPublicInformationMetadata } = require('./sway-public-information-metadata.cjs');")
    .replace('<title>${title}</title><meta name="description" content="${description}"><link rel="canonical" href="https://app.sway.tips${path}">', '${buildPublicInformationMetadata(path, title, description, content)}');
  assert.equal(current, expected, 'Visible copy, styles and route behavior must remain byte-identical');
  report.visibleContentPreserved = true;
  const changed = run('registration-only-delta','git',['diff','--name-only',metadataCandidate,candidate]).split('\n').sort();
  assert.deepEqual(changed, ['package.json','scripts/sway-contract-gate-normalization.contract.test.mjs']);
  const before = JSON.parse(run('previous-package','git',['show',metadataCandidate + ':package.json']));
  const after = JSON.parse(readFileSync(join(checkout,'package.json'),'utf8'));
  const nativePrefix = 'node --test scripts/grindzone-download.contract.test.mjs && node --test scripts/grindzone-host.contract.test.mjs && ';
  assert.equal(after.scripts['test:contracts'], nativePrefix + before.scripts['test:contracts']);
  after.scripts['test:contracts'] = before.scripts['test:contracts'];
  assert.deepEqual(after, before, 'Other scripts/dependencies must remain unchanged');
  if (process.env.SWAY_PUBLIC_INFO_DISCOVERY_OBSERVE) {
    const expectedCommit = process.env.SWAY_PUBLIC_INFO_DISCOVERY_OBSERVE;
    assert.match(expectedCommit, /^[a-f0-9]{40}$/);
    const require = createRequire(join(checkout,'package.json'));
    const pages = require(join(checkout,'scripts/sway-dj-beta-about-preload.cjs'));
    for (const [path, html] of [['/about',pages.ABOUT_PAGE_HTML],['/faq',pages.FAQ_PAGE_HTML]]) {
      for (const agent of ['sway-runtime-proof/3.0','Googlebot/2.1','OAI-SearchBot/1.3','ChatGPT-User/1.0']) {
        const response = await fetch('https://app.sway.tips' + path, { headers:{'user-agent':agent,accept:'text/html'},redirect:'manual',signal:AbortSignal.timeout(20000) });
        const body = await response.text();
        const row = { path, agent, status:response.status, build:response.headers.get('x-commit-sha'), contentMatches:body===html, noindex:/noindex/i.test(response.headers.get('x-robots-tag') || '') };
        report.observations.push(row); console.log('INFORMATION_PRODUCTION ' + JSON.stringify(row));
        assert.equal(row.status,200); assert.equal(row.build,expectedCommit); assert.equal(row.contentMatches,true); assert.equal(row.noindex,false);
      }
    }
    report.scope = 'Owned diagnostic GETs of exact production HTML. Not genuine crawler, Google indexing, ranking or referral evidence.';
  } else {
    run('npm-ci','npm',['ci','--include=dev','--no-audit','--no-fund']);
    run('metadata-tests',process.execPath,['--test','scripts/sway-public-information-metadata.test.cjs']);
    run('native-registration',process.execPath,['scripts/sway-contract-gate-normalization.contract.test.mjs']);
    run('lint','npm',['run','lint']);
    run('build','npm',['run','build']);
    run('browser-install',process.execPath,['node_modules/playwright/cli.js','install','chromium']);
    run('contracts','npm',['run','test:contracts']);
    // Keep generated browser evidence outside the clean source boundary. Only
    // the known output directory in this owned disposable checkout may move.
    const untracked = run('generated-artifacts','git',['ls-files','--others','--exclude-standard']).split('\n').filter(Boolean);
    assert(untracked.every(file => file.startsWith('tmp/public-entry-qa/')), 'Unexpected untracked output: ' + untracked.join(', '));
    if (existsSync(join(checkout,'tmp/public-entry-qa'))) {
      cpSync(join(checkout,'tmp/public-entry-qa'), join(output,'public-entry-qa'), { recursive:true });
      rmSync(join(checkout,'tmp/public-entry-qa'), { recursive:true });
    }
    assert.equal(run('final-clean','git',['status','--porcelain']), '');
    report.scope = 'Exact-source npm ci, lint, production build and full contracts, including native shared-host checks and real Express/Chromium public pages. No production database or provider credentials.';
  }
  report.result = 'pass';
} catch (error) { report.error = String(error.stack || error); console.error('INFORMATION_FAILURE ' + report.error); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(output, 'public-information-discovery.json'),JSON.stringify(report,null,2));
  writeFileSync(join(output,'robots.txt'),'User-agent: *\nDisallow: /\n');
  writeFileSync(join(output,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Sway public information verification</h1><a href="public-information-discovery.json">Receipt</a>');
  console.log('INFORMATION_SUMMARY ' + JSON.stringify(report));
  rmSync(temporary,{recursive:true,force:true});
}
