import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.RENDER_SERVICE_ID, 'srv-daesln0u01pc73fso5kg');
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
const launcher = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(launcher, process.env.SWAY_VALIDATION_EXPECTED_SHA);
for (const key of ['SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED','SWAY_NATIVE_TICKETS_ENABLED','SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED','SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED','SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED']) assert.equal(process.env[key], 'false');
assert.deepEqual(Object.keys(process.env).filter(key => /DATABASE_URL$|(?:STRIPE|PAYPAL|EMAIL|R2|AWS|CLOUDFLARE).*(?:SECRET|TOKEN|API_KEY|ACCESS_KEY)|PAYOUT_RECIPIENT_ENCRYPTION_KEY/.test(key) && process.env[key]?.trim()), []);
const candidate = process.env.SWAY_SOURCE_CANDIDATE_SHA;
assert.match(candidate || '', /^[a-f0-9]{40}$/);
const original = process.cwd(), temp = mkdtempSync(join(tmpdir(), 'sway-sources-')), repo = join(temp, 'candidate'), out = resolve('.validation-public');
mkdirSync(out, { recursive: true });
const env = { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', NODE_ENV: 'test', TZ: 'UTC', GIT_TERMINAL_PROMPT: '0', DISABLE_HMR: 'true', SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED: 'false', SWAY_NATIVE_TICKETS_ENABLED: 'false', SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED: 'false', SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED: 'false', SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED: 'false' };
const report = { launcher, candidate, startedAt: new Date().toISOString(), scope: 'Exact source application gates plus real-browser imports on owned loopback PostgreSQL. No live provider accounts or production writes.', steps: [], passed: false, productionMutations: false, providerTransactions: false };
let pg;
const scrub = text => String(text).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[OWNED_LOOPBACK_DATABASE]');
async function run(name, cmd, args, { cwd = repo, timeout = 300000, extraEnv = {}, required = false } = {}) {
  console.log('SWAY_SOURCE_BEGIN ' + name);
  const started = Date.now(); let output = '', timedOut = false, escalation;
  const child = spawn(cmd, args, { cwd, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const consume = chunk => { const text = scrub(chunk); process.stdout.write(text); output = (output + text).slice(-14000); };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 5000); }, timeout);
  const result = await new Promise(resolveResult => { child.once('error', error => resolveResult({ code: null, error: error.message })); child.once('close', (code, signal) => resolveResult({ code, signal })); });
  clearTimeout(timer); clearTimeout(escalation); kill('SIGKILL');
  const row = { name, ...result, timedOut, passed: result.code === 0 && !timedOut, durationMs: Date.now() - started, tail: output.slice(-7000) };
  report.steps.push(row); writeFileSync(join(out, 'source-evidence.json'), JSON.stringify(report, null, 2));
  console.log('SWAY_SOURCE_RESULT ' + JSON.stringify(row));
  if (required && !row.passed) throw new Error(name + ' failed');
  return row;
}
try {
  await run('clone', 'git', ['clone','--no-hardlinks','--no-checkout',original,repo], { cwd: temp, required: true });
  await run('fetch', 'git', ['fetch','--depth=1','https://github.com/infotradescout/sway.tips.git',candidate], { required: true });
  await run('checkout', 'git', ['checkout','--detach',candidate], { required: true });
  assert.equal(execFileSync('git', ['status','--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');
  assert.equal(execFileSync('git', ['rev-parse','HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), candidate);
  report.tree = execFileSync('git', ['rev-parse','HEAD^{tree}'], { cwd: repo, encoding: 'utf8' }).trim();
  await run('install', 'npm', ['ci','--include=dev'], { timeout: 600000, required: true });
  await run('parsers', 'node', ['--import','tsx','scripts/sway-music-list-import.test.mjs']);
  await run('confirmed-import-helper', 'node', ['--import','tsx','scripts/sway-music-file-import.test.mjs']);
  await run('existing-dj-importers', 'node', ['scripts/sway-dj-library-importers.test.mjs']);
  await run('connections-contract', 'node', ['scripts/sway-performer-connections.contract.test.mjs']);
  await run('lint', 'npm', ['run','lint'], { required: true });
  await run('build', 'npm', ['run','build'], { required: true });
  await run('chromium', 'node', ['node_modules/playwright/cli.js','install','chromium'], { required: true });
  const deps = join(temp, 'native-dependencies'); mkdirSync(deps);
  await run('native-postgres-install', 'npm', ['install','--prefix',deps,'--no-audit','--no-fund','--package-lock=false','embedded-postgres@18.4.0-beta.17'], { cwd: temp, timeout: 600000, required: true });
  const requireDeps = createRequire(join(deps,'package.json'));
  const { default: EmbeddedPostgres } = await import(pathToFileURL(requireDeps.resolve('embedded-postgres')).href);
  const password = randomBytes(18).toString('hex');
  pg = new EmbeddedPostgres({ databaseDir: join(temp,'pgdata'), user: 'postgres', password, port: 25439, persistent: false, onLog: () => {}, onError: message => console.error(scrub(message)) });
  await pg.initialise(); await pg.start();
  const dbName = 'sway_sources_disposable_proof'; await pg.createDatabase(dbName);
  const client = pg.getPgClient(); await client.connect();
  report.nativeDatabase = (await client.query('select version(), pg_backend_pid() as pid, inet_server_port() as port')).rows[0]; await client.end();
  assert.match(report.nativeDatabase.version, /^PostgreSQL /); assert.equal(report.nativeDatabase.port, 25439);
  console.log('SWAY_SOURCE_NATIVE_DATABASE ' + JSON.stringify(report.nativeDatabase));
  await run('sources-browser-native-persistence', 'node', ['--import','tsx','scripts/sway-music-sources.browser.test.mjs'], {
    timeout: 600000, extraEnv: { SWAY_ALLOW_DISPOSABLE_DATABASE_RESET: 'true', SWAY_REQUIRE_REAL_POSTGRES_PROOF: 'true', SWAY_REAL_POSTGRES_PROOF_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:25439/${dbName}` }
  });
  await run('contracts', 'npm', ['run','test:contracts'], { timeout: 1200000 });
  await run('room-account-scope-browser', 'node', ['scripts/sway-room-account-scope.browser.test.mjs']);
  assert.equal(execFileSync('git', ['diff','--name-only','HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), '', 'Tests changed tracked source');
  report.trackedSourceUnchanged = true;
  report.generatedFiles = execFileSync('git', ['ls-files','--others','--exclude-standard'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  report.passed = report.steps.every(row => row.passed);
} catch (error) {
  report.error = scrub(error.stack || error); console.error('SWAY_SOURCE_ERROR ' + report.error);
} finally {
  for (const name of ['music-sources-proof','public-entry-qa']) {
    if (existsSync(join(repo,'tmp',name))) cpSync(join(repo,'tmp',name), join(out,name), { recursive: true });
  }
  try { await pg?.stop(); } catch (error) { report.cleanupError = scrub(error.message); report.passed = false; }
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(out,'source-evidence.json'), JSON.stringify(report,null,2));
  writeFileSync(join(out,'index.html'), '<meta name="robots" content="noindex,nofollow"><h1>Sources validation: ' + (report.passed ? 'passed' : 'failed or incomplete') + '</h1><p>Owned test application only. Not Sway production or provider integration certification.</p><a href="source-evidence.json">Evidence</a>');
  writeFileSync(join(out,'robots.txt'), 'User-agent: *\nDisallow: /\n');
  console.log('SWAY_SOURCE_SUMMARY ' + JSON.stringify({ ...report, steps: report.steps.map(({ tail, ...row }) => row) }));
  if (!report.passed) process.exitCode = 1;
}
