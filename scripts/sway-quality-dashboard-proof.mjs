import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const candidate = process.env.SWAY_QUALITY_DASHBOARD_SHA || '';
assert.match(candidate, /^[a-f0-9]{40}$/);
for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'SWAY_REAL_POSTGRES_PROOF_DATABASE_URL', 'STRIPE_SECRET_KEY', 'SESSION_SECRET', 'BREVO_API_KEY', 'SENDGRID_API_KEY', 'SMTP_PASS']) assert(!process.env[key], 'No production credentials: ' + key);
const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sway-quality-dashboard-'));
const source = path.join(temporary, 'source');
const output = path.join(root, '.validation-public'); fs.mkdirSync(output, { recursive: true });
const env = Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','PLAYWRIGHT_BROWSERS_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { CI: 'true', TZ: 'UTC', NODE_OPTIONS: '--max-old-space-size=3072' });
const evidence = { candidate, harness: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), startedAt: new Date().toISOString(), result: 'fail', steps: [], productionWrites: 0, scope: 'Exact Sway admin report integration; isolated API and browser fixtures. No production authenticated session or customer growth claim.' };
function run(label, command, args, cwd = source, extraEnv = {}) {
  console.log('SWAY_DASHBOARD_START ' + label);
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, timeout: 1200000 });
  const step = { label, exit: result.status, at: new Date().toISOString() }; evidence.steps.push(step);
  fs.writeFileSync(path.join(output, 'dashboard-' + label + '.log'), (result.stdout || '') + (result.stderr || ''));
  console.log((result.stdout || '').slice(-12000)); console.log((result.stderr || '').slice(-6000)); console.log('SWAY_DASHBOARD_STEP ' + JSON.stringify(step));
  assert.equal(result.status, 0, label + ' failed: ' + (result.error || 'see log'));
  return (result.stdout || '').trim();
}
try {
  run('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', root, source], temporary);
  run('fetch', 'git', ['fetch', '--no-tags', 'https://github.com/infotradescout/sway.tips.git', candidate]);
  run('checkout', 'git', ['checkout', '--detach', candidate]);
  assert.equal(run('identity', 'git', ['rev-parse', 'HEAD']), candidate);
  assert.equal(run('initial-clean', 'git', ['status', '--porcelain']), '');
  const changes = run('bounded-diff', 'git', ['diff', '--name-only', '2011efd13cb9d7b068721e5512b32e3c21cd7cfc', candidate]).split('\n');
  const allowed = new Set(['src/acquisition-quality-report.ts','src/server/acquisition-quality-routes.ts','src/server/affiliate-program.ts','src/shells/AcquisitionQualityPanel.tsx','src/shells/DiscoveryObservatoryPage.tsx','src/shells/DiscoveryEvidencePage.tsx','scripts/report-acquisition-quality.mjs','scripts/sway-acquisition-dashboard.test.mjs','scripts/sway-acquisition-dashboard.browser.test.mjs','scripts/sway-discovery-observatory.contract.test.mjs','scripts/sway-discovery-observatory.legacy.contract.test.mjs']);
  assert(changes.every(file => allowed.has(file)), 'Unreviewed change outside the assigned slice');
  const resumed = candidate === 'b65d92ae016ff5c18b08feab704c3e4375dfddd3';
  if (resumed) {
    const delta = run('verified-runtime-unchanged', 'git', ['diff', '--name-only', '4106ace4bcc95e42146ed4008ca9ef475af9f810', candidate]).split('\n').sort();
    assert.deepEqual(delta, ['scripts/sway-discovery-observatory.contract.test.mjs','scripts/sway-discovery-observatory.legacy.contract.test.mjs'].sort());
    evidence.reusedExecution = { candidate: '4106ace4bcc95e42146ed4008ca9ef475af9f810', deploy: 'dep-daotti00cd8s73b146d0', passed: ['targeted whole-module/registered-HTTP tests','lint','production build','390/1440 browser matrix','actual server ingress and SQL'], previousOverallResult: 'fail', failure: 'Hard test registration/normalization only. All runtime, SQL and browser-test blobs are unchanged.' };
  }
  run('npm-ci', 'npm', ['ci','--include=dev','--no-audit','--no-fund']);
  if (!resumed) {
    run('targeted', process.execPath, ['--import','tsx','--test','scripts/sway-acquisition-dashboard.test.mjs']);
    run('lint', 'npm', ['run','lint']);
    run('build', 'npm', ['run','build']);
    run('chromium', process.execPath, ['node_modules/playwright/cli.js','install','chromium']);
    run('browser', process.execPath, ['scripts/sway-acquisition-dashboard.browser.test.mjs'], source, { SWAY_QUALITY_BROWSER_OUTPUT: output });
    run('ingress-and-sql', process.execPath, ['--import','tsx','scripts/sway-acquisition-quality.test.mjs']);
  }
  run('contracts', 'npm', ['run','test:contracts']);
  assert.equal(run('final-clean', 'git', ['status','--porcelain']), '');
  evidence.result = 'pass';
} catch (error) { evidence.error = String(error.stack || error); }
finally {
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'quality-dashboard-evidence.json'), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(output, 'index.html'), '<meta name="robots" content="noindex,nofollow"><h1>Sway quality-dashboard validation</h1><a href="quality-dashboard-evidence.json">Exact-source execution receipt</a>');
  fs.writeFileSync(path.join(output, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  console.log('SWAY_DASHBOARD_SUMMARY ' + JSON.stringify(evidence));
  fs.rmSync(temporary, { recursive: true, force: true });
  if (evidence.result !== 'pass') process.exitCode = 1;
}
