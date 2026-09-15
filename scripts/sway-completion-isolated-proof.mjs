import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A separate build-only proof service. Never attach an application database,
// provider credentials, production domains, or application runtime to this job.
// Render exports Bash build helpers, including functions named for secret-file
// copying. These are executable shell definitions, not application credentials.
// None is needed by this shell:false runner. Discard the entire Bash function
// namespace before any subprocess so inherited shell code cannot run there.
for (const key of Object.keys(process.env)) {
  if (/^BASH_FUNC_.+%%$/.test(key)) delete process.env[key];
}
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true', 'An explicitly isolated proof environment is required.');
for (const key of [
  'SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED',
  'SWAY_NATIVE_TICKETS_ENABLED',
  'SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED',
  'SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED',
  'SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED'
]) assert.equal(process.env[key], 'false', `${key} must be disabled.`);
const forbiddenKeys = Object.keys(process.env).filter(key =>
  /(?:DATABASE|POSTGRES|MYSQL|REDIS|MONGODB)_(?:URL|URI)(?:_|$)/i.test(key)
  || /^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|PASSFILE|SERVICE|SERVICEFILE|OPTIONS|SSLMODE|SSLCERT|SSLKEY|SSLROOTCERT|URL)$/i.test(key)
  || /(?:^|_)(?:SECRET|TOKEN|PASSWORD|CREDENTIALS?|API_KEY|ACCESS_KEY|CLIENT_ID|PRIVATE_KEY)(?:_|$)/i.test(key)
).filter(key => Boolean(process.env[key]?.trim()));
assert.deepEqual(forbiddenKeys, [], 'The proof refuses inherited databases and provider credentials.');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');
const tree = git('rev-parse', 'HEAD^{tree}');
assert.match(process.env.SWAY_VALIDATION_EXPECTED_SHA || '', /^[a-f0-9]{40}$/, 'Pin an exact reviewed source commit.');
assert.equal(head, process.env.SWAY_VALIDATION_EXPECTED_SHA, 'The checkout differs from the reviewed source.');
if (process.env.RENDER_GIT_COMMIT) assert.equal(head, process.env.RENDER_GIT_COMMIT);
assert.equal(git('status', '--porcelain'), '', 'The initial checkout must be clean.');

// Dependencies/build output and these exact test artifacts are disposable.
// Inspect ignored files too: an ignored .env or new source file is not proof
// output and must not become an unreviewed input to a mandatory gate.
const disposableFiles = new Set([
  'artifacts/readiness-223/account-reads/results.json',
  ...['results.json', 'failure.png', 'sources-1440.png', 'sources-390.png', 'sources-320.png']
    .map(name => `tmp/music-sources-proof/${name}`),
  ...[
    'access-control.persisted-readiness.bundle.cjs', 'active-room-registry.contract.bundle.cjs',
    'moderation-service.contract.bundle.cjs', 'performer-session-store.contract.bundle.cjs',
    'performer-login.contract.bundle.cjs', 'performer-login-mailer.contract.bundle.cjs',
    'performer-password-login.contract.bundle.cjs', 'performer-self-serve-signup.contract.bundle.cjs',
    'performer-password-auth.contract.bundle.cjs', 'payout-options-mobile.png',
    'performer-sources-mobile.png', 'performer-room-tools-mobile.png', 'performer-roles-mobile.png',
    ...[390, 1440].flatMap(width => [
      `cash-out-balance-unavailable-${width}.png`, `cash-out-failed-${width}.png`,
      `cash-out-initial-balance-unavailable-${width}.png`
    ])
  ].map(name => `.tmp/${name}`)
]);
function assertNoUnexpectedFiles() {
  const unexpected = execFileSync('git', [
    'ls-files', '--others', '-z', '--', '.', ':(exclude)node_modules/**', ':(exclude)dist/**'
  ], { encoding: 'utf8' })
    .split('\0').filter(Boolean)
    .filter(path => !path.startsWith('node_modules/') && !path.startsWith('dist/') && !disposableFiles.has(path));
  assert.deepEqual(unexpected, [], 'Unreviewed files exist outside the exact disposable output paths.');
}
function cleanOwnedBrowserProofOutputs() {
  // These directories are created only by mandatory browser/contract suites in
  // this isolated checkout. Delete the exact owned output roots rather than
  // weakening the final clean-source assertion with broad directory allowlists.
  for (const path of [
    'artifacts/account-home-browser',
    'artifacts/readiness-223/room-start',
    'tmp/public-entry-qa'
  ]) rmSync(path, { recursive: true, force: true });
  const readinessRoot = 'artifacts/readiness-223';
  if (existsSync(readinessRoot)) {
    for (const name of readdirSync(readinessRoot)) {
      if (/^response-order-\d+$/.test(name)) {
        rmSync(`${readinessRoot}/${name}`, { recursive: true, force: true });
      }
    }
  }
}
assertNoUnexpectedFiles();
const outputDirectory = resolve('.completion-proof-public');
assert.equal(existsSync(outputDirectory), false, 'Refusing a stale proof directory.');

const results = [];
const startedAt = new Date().toISOString();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const activeChildren = new Set();
function signalTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error?.code !== 'ESRCH') throw error; }
}

function killActiveChildren() {
  for (const child of activeChildren) signalTree(child, 'SIGKILL');
}
// A cancelled build must not orphan its detached test servers, databases or
// browsers. The exit hook also covers uncaught failures in this wrapper.
process.once('exit', killActiveChildren);
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    killActiveChildren();
    process.exit(exitCode);
  });
}

async function run(name, command, args, timeoutMs) {
  console.log(`SWAY_COMPLETION_PROOF_BEGIN ${name}`);
  const start = Date.now();
  const digest = createHash('sha256');
  let timedOut = false;
  let escalation;
  const child = spawn(command, args, {
    cwd: process.cwd(),
    // Keep hosting markers and existing database safety controls intact.
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    detached: process.platform !== 'win32'
  });
  activeChildren.add(child);
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on('data', chunk => { digest.update(chunk); destination.write(chunk); });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    signalTree(child, 'SIGTERM');
    escalation = setTimeout(() => signalTree(child, 'SIGKILL'), 5_000);
  }, timeoutMs);
  let outcome;
  try {
    outcome = await new Promise(resolveResult => {
      child.once('error', error => resolveResult({ exitCode: null, signal: null, error: error.message }));
      child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal, error: null }));
    });
  } finally {
    clearTimeout(timer);
    if (escalation) clearTimeout(escalation);
    signalTree(child, 'SIGKILL');
    activeChildren.delete(child);
  }
  const result = {
    name, ...outcome, timedOut, durationMs: Date.now() - start,
    passed: !timedOut && outcome.exitCode === 0 && !outcome.error,
    outputSha256: digest.digest('hex')
  };
  results.push(result);
  console.log(`SWAY_COMPLETION_PROOF_RESULT ${JSON.stringify(result)}`);
  return result.passed;
}

const installed = await run('locked-dependencies', npm, ['ci', '--include=dev', '--no-audit', '--no-fund'], 300_000);
const browserInstalled = installed && await run('pinned-chromium', process.execPath,
  ['node_modules/playwright/cli.js', 'install', 'chromium'], 300_000);
if (installed && browserInstalled) {
  // Fail the focused integration checks before spending another full-suite run.
  // The complete mandatory gate is still required and is never substituted.
  for (const [name, command, args, timeoutMs] of [
    ['lint', npm, ['run', 'lint'], 180_000],
    ['sources-preflight', process.execPath, ['scripts/sway-performer-connections.contract.test.mjs'], 300_000],
    ['performer-account-preflight', process.execPath, ['scripts/sway-performer-account-reads.behavior.test.mjs'], 180_000],
    ['production-build', npm, ['run', 'build'], 300_000],
    ['mandatory-contracts', npm, ['run', 'test:contracts'], 1_200_000]
  ]) {
    if (!await run(name, command, args, timeoutMs)) break;
  }
}

// Tests may create disposable ignored output. They may not alter reviewed code.
cleanOwnedBrowserProofOutputs();
git('diff', '--exit-code', 'HEAD', '--');
assertNoUnexpectedFiles();
assert.equal(git('rev-parse', 'HEAD'), head);
assert.equal(git('rev-parse', 'HEAD^{tree}'), tree);
const required = ['locked-dependencies', 'pinned-chromium', 'lint', 'sources-preflight', 'performer-account-preflight', 'production-build', 'mandatory-contracts'];
const passed = required.length === results.length
  && required.every(name => results.some(result => result.name === name && result.passed));
const summary = {
  schemaVersion: 1, passed, head, tree, node: process.version, startedAt,
  finishedAt: new Date().toISOString(), results,
  scope: 'Isolated required gates, including native browser tests. No application deployment or provider activation.',
  limits: ['No live payments or payouts', 'No actual streaming-provider or physical deck proof',
    'No real R2 object-store proof', 'No standalone PostgreSQL concurrency attestation',
    'No whole-product or competitive 10/10 claim']
};
console.log(`SWAY_COMPLETION_PROOF_SUMMARY ${JSON.stringify(summary)}`);
if (!passed) {
  process.exitCode = 1;
} else {
  mkdirSync(outputDirectory);
  writeFileSync(resolve(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(resolve(outputDirectory, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  writeFileSync(resolve(outputDirectory, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sway isolated verification</title><main><h1>Required gates passed</h1><p>Source: <code>${head}</code></p><p>This is an isolated verification receipt. It is not the Sway application, a production release, or a whole-product rating.</p><p><a href="summary.json">Exact source and verification results</a></p></main></html>\n`);
}
