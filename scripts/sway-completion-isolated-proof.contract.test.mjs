import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Only the wrapper is under test. Every command runs in a disposable local Git
// fixture with an inert npm executable; these are not Sway gate-pass receipts.
// No database driver, provider client, network operation or deployment is used.
const runnerPath = resolve('scripts/sway-completion-isolated-proof.mjs');
const root = mkdtempSync(join(tmpdir(), 'sway-isolated-proof-guard-'));
const controls = {
  SWAY_ISOLATED_VALIDATION: 'true',
  SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED: 'false',
  SWAY_NATIVE_TICKETS_ENABLED: 'false',
  SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED: 'false',
  SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED: 'false',
  SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED: 'false'
};
const baseEnv = { PATH: process.env.PATH, ...controls };
const run = (cwd, env) => spawnSync(process.execPath, [runnerPath], {
  cwd, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024
});
function assertFailure(result, pattern) {
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, pattern);
  for (const line of result.stdout.split('\n').filter(line => line.startsWith('SWAY_COMPLETION_PROOF_SUMMARY '))) {
    assert.equal(JSON.parse(line.slice('SWAY_COMPLETION_PROOF_SUMMARY '.length)).passed, false);
  }
}
function assertNoCommands(directory) {
  assert.equal(existsSync(join(directory, 'node_modules/proof-events.jsonl')), false);
}

const npmFixture = `#!/usr/bin/env node
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const mode = JSON.parse(readFileSync('control.json', 'utf8')).mode;
mkdirSync('node_modules/playwright', { recursive: true });
const args = process.argv.slice(2);
appendFileSync('node_modules/proof-events.jsonl', JSON.stringify({
  command: args.join(' '), render: process.env.RENDER, service: process.env.RENDER_SERVICE_ID,
  shellFunctions: Object.keys(process.env).filter(key => /^BASH_FUNC_.+%%$/.test(key))
}) + '\\n');
if (args[0] === 'ci') {
  writeFileSync('node_modules/playwright/cli.js',
    "require('node:fs').appendFileSync('node_modules/proof-events.jsonl', JSON.stringify({command:'chromium'}) + '\\\\n');");
  if (mode === 'cancel') {
    const descendant = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
    writeFileSync('node_modules/proof-pids.json', JSON.stringify([process.pid, descendant.pid]));
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  }
}
if (args[1] === 'lint') {
  if (mode === 'failed-gate') process.exitCode = 17;
  if (mode === 'untracked-source') {
    mkdirSync('src', { recursive: true }); writeFileSync('src/unreviewed.ts', 'export const injected = true;');
  }
  if (mode === 'ignored-config') writeFileSync('.env.runtime', 'UNREVIEWED_FIXTURE=true');
  if (mode === 'unknown-output') {
    mkdirSync('.tmp', { recursive: true }); writeFileSync('.tmp/unreviewed.mjs', 'throw new Error();');
  }
}
if (args[1] === 'test:contracts' && mode === 'pass') {
  mkdirSync('tmp/music-sources-proof', { recursive: true });
  writeFileSync('tmp/music-sources-proof/results.json', '{}');
}
`;

function fixture(mode) {
  const directory = join(root, mode);
  mkdirSync(join(directory, 'bin'), { recursive: true });
  copyFileSync(runnerPath, join(directory, 'proof.mjs'));
  writeFileSync(join(directory, '.gitignore'), 'node_modules/\n.env*\n.tmp/\n');
  writeFileSync(join(directory, 'control.json'), JSON.stringify({ mode }));
  writeFileSync(join(directory, 'bin/npm'), npmFixture, { mode: 0o755 });
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Isolated runner fixture', '-c', 'user.email=runner-fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Disposable wrapper regression fixture');
  const head = git('rev-parse', 'HEAD');
  return {
    directory,
    env: { ...baseEnv, PATH: join(directory, 'bin') + ':' + baseEnv.PATH,
      SWAY_VALIDATION_EXPECTED_SHA: head, RENDER_GIT_COMMIT: head,
      RENDER: 'true', RENDER_SERVICE_ID: 'srv-isolated-guard-fixture' }
  };
}

let canceledRunner;
let descendantPids = [];
function running(pid) {
  try {
    process.kill(pid, 0);
    // A reparented zombie has stopped executing and cannot retain a server.
    if (process.platform === 'linux' && existsSync('/proc/self/stat')) {
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
    throw error;
  }
}

try {
  assertFailure(run(root, { ...baseEnv, SWAY_ISOLATED_VALIDATION: 'false' }), /explicitly isolated/);
  for (const key of Object.keys(controls).filter(key => key !== 'SWAY_ISOLATED_VALIDATION')) {
    assertFailure(run(root, { ...baseEnv, [key]: 'true' }), /must be disabled/);
  }
  for (const key of [
    'DATABASE_URL', 'SWAY_TEST_DATABASE_URL', 'POSTGRES_URL', 'PGHOST', 'PGDATABASE', 'PGUSER',
    'PGPASSWORD', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGOPTIONS',
    'STRIPE_SECRET_KEY', 'STRIPE_TEST_SECRET_KEY', 'STRIPE_CONNECT_WEBHOOK_SECRET',
    'SWAY_AUDIO_R2_ACCESS_KEY_ID', 'RESEND_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
    'BASH_FUNC_STRIPE_SECRET_KEY'
  ]) {
    const secret = 'private-fixture-value-that-must-not-be-printed';
    const result = run(root, { ...baseEnv, [key]: secret });
    assertFailure(result, /refuses inherited databases and provider credentials/);
    assert.equal((result.stdout + result.stderr).includes(secret), false, key + ' exposed its value.');
    assert.doesNotMatch(result.stdout, /SWAY_COMPLETION_PROOF_BEGIN/);
  }

  const wrongPin = fixture('wrong-pin');
  assertFailure(run(wrongPin.directory, { ...wrongPin.env, SWAY_VALIDATION_EXPECTED_SHA: '0'.repeat(40) }), /differs from the reviewed source/);
  assertNoCommands(wrongPin.directory);
  const dirty = fixture('dirty');
  writeFileSync(join(dirty.directory, 'control.json'), '{}');
  assertFailure(run(dirty.directory, dirty.env), /initial checkout must be clean/);
  assertNoCommands(dirty.directory);
  const stale = fixture('stale');
  mkdirSync(join(stale.directory, '.completion-proof-public'));
  writeFileSync(join(stale.directory, '.completion-proof-public/summary.json'), '{"passed":true}');
  assertFailure(run(stale.directory, stale.env), /initial checkout must be clean|stale proof directory/);
  assertNoCommands(stale.directory);

  for (const mode of ['failed-gate', 'untracked-source', 'ignored-config', 'unknown-output', 'pass']) {
    const test = fixture(mode);
    const result = run(test.directory, {
      ...test.env,
      'BASH_FUNC_copy_secret_files%%': '() { echo inherited-function-must-not-run; }',
      'BASH_FUNC_remove_secret_files%%': '() { echo inherited-function-must-not-run; }',
      'BASH_FUNC_unrelated_helper%%': '() { echo inherited-function-must-not-run; }'
    });
    assert.ifError(result.error);
    assert.ok(existsSync(join(test.directory, 'node_modules/proof-events.jsonl')),
      'Fixture commands did not start: ' + result.stdout + result.stderr);
    const events = readFileSync(join(test.directory, 'node_modules/proof-events.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.command), [
      'ci --include=dev --no-audit --no-fund', 'chromium', 'run lint', 'run build', 'run test:contracts'
    ], 'Every required gate must execute before a successful receipt.');
    for (const event of events.filter(event => event.command !== 'chromium')) {
      assert.equal(event.render, 'true');
      assert.equal(event.service, 'srv-isolated-guard-fixture', 'Hosting markers must remain intact in children.');
      assert.deepEqual(event.shellFunctions, [], 'Inherited executable shell definitions must not reach children.');
    }
    assert.doesNotMatch(result.stdout + result.stderr, /inherited-function-must-not-run/);
    const receipt = join(test.directory, '.completion-proof-public/summary.json');
    if (mode === 'pass') {
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(readFileSync(receipt, 'utf8'));
      assert.equal(summary.passed, true);
      assert.equal(summary.head, test.env.SWAY_VALIDATION_EXPECTED_SHA);
      assert.equal(summary.results.length, 5);
    } else {
      assertFailure(result, mode === 'failed-gate' ? /"passed":false/ : /Unreviewed files exist/);
      assert.equal(existsSync(receipt), false, 'A failed proof must create no success receipt.');
    }
  }

  if (process.platform !== 'win32') {
    const cancellation = fixture('cancel');
    canceledRunner = spawn(process.execPath, [runnerPath], {
      cwd: cancellation.directory, env: cancellation.env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    canceledRunner.stdout.on('data', chunk => { output += chunk; });
    canceledRunner.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolveExit => canceledRunner.once('exit', (code, signal) => resolveExit({ code, signal })));
    const pidFile = join(cancellation.directory, 'node_modules/proof-pids.json');
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    assert.ok(existsSync(pidFile), 'Detached gate fixture did not start: ' + output);
    descendantPids = JSON.parse(readFileSync(pidFile, 'utf8'));
    assert.ok(descendantPids.every(running));
    canceledRunner.kill('SIGTERM');
    let timer;
    const outcome = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cancelled runner did not exit.')), 5_000);
    })]).finally(() => clearTimeout(timer));
    assert.equal(outcome.code, 143);
    for (let attempt = 0; attempt < 100 && descendantPids.some(running); attempt++) {
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    assert.ok(descendantPids.every(pid => !running(pid)), 'Cancellation left a detached gate or grandchild running.');
    assert.equal(existsSync(join(cancellation.directory, '.completion-proof-public')), false);
  }
  console.log('Isolated proof runner guard regressions passed: credential refusal, exact pin, source/output integrity, hard gate failures, retained hosting markers and cancellation cleanup. Fixture commands do not attest Sway gate execution.');
} finally {
  if (canceledRunner && canceledRunner.exitCode === null && canceledRunner.signalCode === null) canceledRunner.kill('SIGKILL');
  for (const pid of descendantPids) {
    try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  rmSync(root, { recursive: true, force: true });
}
