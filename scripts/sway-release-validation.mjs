import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Deliberately separate from the production build/start commands. This runner
// accepts no inherited database or payment credentials and publishes no app assets.
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true', 'This runner requires an isolated validation environment.');
for (const name of [
  'SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED',
  'SWAY_NATIVE_TICKETS_ENABLED',
  'SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED',
  'SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED',
  'SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED'
]) {
  assert.equal(process.env[name], 'false', `${name} must remain disabled in the inherited environment.`);
}
const forbidden = Object.keys(process.env).filter((name) => (
  /DATABASE_URL$/.test(name)
  || /^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SWAY_EMAIL_API_KEY)$/.test(name)
  || /PAYPAL.*(?:SECRET|TOKEN)$/.test(name)
)).filter((name) => Boolean(process.env[name]?.trim()));
assert.deepEqual(forbidden, [], 'Do not attach existing databases or provider credentials to this runner.');

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.match(head, /^[a-f0-9]{40}$/);
if (process.env.RENDER_GIT_COMMIT) assert.equal(head, process.env.RENDER_GIT_COMMIT, 'Render source identity does not match the checkout.');
if (process.env.SWAY_VALIDATION_EXPECTED_SHA) assert.equal(head, process.env.SWAY_VALIDATION_EXPECTED_SHA, 'Unexpected validation source.');
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'Validation requires an unchanged checkout.');
console.log(`SWAY_VALIDATION_SOURCE ${head} node=${process.version}`);

// Temporary, read-only source locations for the reproducible closeout failure.
// No source is patched and no inherited credentials or customer data are read.
const serverLines = readFileSync('server.ts', 'utf8').split('\n');
for (const anchor of ['function syncActiveGigRouteContext', '/api/state/:gigId', "case 'end_session'", "case 'closeout_session'"]) {
  const index = serverLines.findIndex((line) => line.includes(anchor));
  console.log(`SWAY_ROOM_SOURCE_LOCATION ${JSON.stringify({ anchor, line: index + 1 })}`);
  if (index >= 0) console.log(`SWAY_ROOM_SOURCE_EXCERPT ${JSON.stringify(serverLines.slice(Math.max(0, index - 4), index + 90).join('\n'))}`);
}

const publishDirectory = resolve('.validation-public');
rmSync(publishDirectory, { recursive: true, force: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = [
  ['catalog-action-behavior', ['scripts/sway-catalog-actions.behavior.test.mjs'], 180_000, process.execPath],
  ['catalog-action-browser', ['scripts/sway-catalog-actions.browser.test.mjs'], 300_000, process.execPath],
  ['lint', ['run', 'lint'], 180_000],
  ['build', ['run', 'build'], 300_000],
  ['playback-recovery-browser', ['scripts/sway-playback-recovery.browser.test.mjs'], 300_000, process.execPath],
  ['catalog-read-recovery', ['--import', 'tsx', 'scripts/sway-performer-catalog-reads.behavior.test.mjs'], 180_000, process.execPath],
  ['catalog-recovery-browser', ['scripts/sway-performer-catalog-recovery.browser.test.mjs'], 300_000, process.execPath],
  ['profile-editor-integration-browser', ['--import', 'tsx', 'scripts/sway-profile-editor-integration.browser.test.ts'], 300_000, process.execPath],
  // Exercise real account/room transitions early; every remaining gate still runs.
  ['simulated-live-night-browser', ['run', 'test:integration:simulated-live-night-browser'], 600_000],
  ['payment-pricing', ['run', 'test:payment-pricing'], 180_000],
  ['event-read-recovery', ['--import', 'tsx', 'scripts/sway-performer-event-reads.behavior.test.mjs'], 180_000, process.execPath],
  ['events-recovery-browser', ['scripts/sway-performer-events-recovery.browser.test.mjs'], 300_000, process.execPath],
  ['event-listings-contract', ['scripts/sway-public-event-listings.contract.test.mjs'], 300_000, process.execPath],
  ['room-restart', ['scripts/sway-performer-room-restart.behavior.test.mjs'], 180_000, process.execPath],
  ['room-restart-browser', ['scripts/sway-performer-room-restart.browser.test.mjs'], 180_000, process.execPath],
  ['contracts', ['run', 'test:contracts'], 1_200_000],
  ['readiness-browser', ['run', 'test:browser:readiness-223'], 600_000],
  ['payment-viewport-browser', ['run', 'test:browser:payment-modal-viewport'], 300_000],
  ['profile-payout-browser', ['run', 'test:browser:profile-payout-options'], 300_000]
];

function signalTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function runStep(name, args, timeoutMs, command = npm) {
  console.log(`SWAY_VALIDATION_BEGIN ${name}`);
  const startedAt = Date.now();
  let timedOut = false;
  let escalation;
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, CI: 'true' },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    shell: false
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    signalTree(child, 'SIGTERM');
    escalation = setTimeout(() => signalTree(child, 'SIGKILL'), 5_000);
  }, timeoutMs);
  let result;
  try {
    result = await new Promise((resolveResult) => {
      child.once('error', (error) => resolveResult({ code: null, signal: null, error: error.message }));
      child.once('close', (code, signal) => resolveResult({ code, signal, error: null }));
    });
  } finally {
    clearTimeout(timeout);
    if (escalation) clearTimeout(escalation);
    // A failed suite must not leave its local server or browser behind for the
    // following suite. Every child is in this isolated process group.
    signalTree(child, 'SIGKILL');
  }
  const passed = !timedOut && result.code === 0 && !result.error;
  const record = { name, passed, ...result, timedOut, durationMs: Date.now() - startedAt };
  console.log(`SWAY_VALIDATION_RESULT ${JSON.stringify(record)}`);
  return record;
}

const results = [];
for (const [name, args, timeoutMs, command] of steps) {
  results.push(await runStep(name, args, timeoutMs, command));
}
const failed = results.filter((result) => !result.passed).map((result) => result.name);
console.log(`SWAY_VALIDATION_SUMMARY ${JSON.stringify({ head, passed: results.length - failed.length, failed, total: results.length })}`);
if (failed.length) {
  process.exitCode = 1;
} else {
  mkdirSync(publishDirectory, { recursive: true });
  writeFileSync(resolve(publishDirectory, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Validation</title><p>Isolated validation passed. This is not the Sway application or production release approval.</p></html>\n');
  writeFileSync(resolve(publishDirectory, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
}
