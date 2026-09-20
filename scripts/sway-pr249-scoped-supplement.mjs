import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';

// This explicitly selected supplement never imports the full hosted validator.
const HEAD = 'b354e1a6a842d39d8601f49323f56d2603348a1f';
const BASE = 'e15db1518ef2b1823442d18479d71af4ee0ca95a';
const HELPER = '906cfb91a00646d9cafb0bfd70f5442a64079bf5';
const BRANCH = 'implement/direct-music-control-20260916';
const ORIGIN = 'https://github.com/infotradescout/sway.tips.git';
assert.equal(process.env.RENDER_SERVICE_ID, 'srv-daesln0u01pc73fso5kg');
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
assert.equal(process.env.SWAY_PR249_SCOPED_SUPPLEMENT, 'true');
const original = process.cwd();
const launcher = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(launcher, process.env.SWAY_VALIDATION_EXPECTED_SHA);
assert.equal(launcher, process.env.RENDER_GIT_COMMIT);
const disabled = ['SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED', 'SWAY_NATIVE_TICKETS_ENABLED',
  'SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED', 'SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED',
  'SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED'];
for (const key of disabled) assert.equal(process.env[key], 'false');
assert.deepEqual(Object.keys(process.env).filter(key => /DATABASE_URL$|(?:STRIPE|PAYPAL|EMAIL|R2|AWS|CLOUDFLARE).*(?:SECRET|TOKEN|API_KEY|ACCESS_KEY)|PAYOUT_RECIPIENT_ENCRYPTION_KEY/.test(key) && process.env[key]?.trim()), []);
const temp = mkdtempSync(join(tmpdir(), 'sway-pr249-scoped-'));
const clone = join(temp, 'source'), repo = join(temp, 'candidate'), evidence = join(temp, 'merge-evidence');
const out = resolve('.validation-public');
mkdirSync(out, { recursive: true });
const env = { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', NODE_ENV: 'test',
  TZ: 'UTC', GIT_TERMINAL_PROMPT: '0', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  ...Object.fromEntries(disabled.map(key => [key, 'false'])) };
const report = { launcher, startingHead: HEAD, sharedHostBase: BASE, helperSource: HELPER,
  startedAt: new Date().toISOString(), scope: 'Pinned two-parent merge and the original exact-candidate registry contract only',
  steps: [], passed: false, fullHostedGatesRepeated: false, newServiceCreated: false,
  productionChanged: false, actualPlayerCommands: 0, completionCriterionMet: false,
  nativeWindows: 'not_executed_here', downloadedCmdStartup: 'not_executed', realPlayerAcceptance: 'not_executed',
  publication: { status: 'not_attempted' }, cleanup: { attempted: false, stopped: false, listenerClosed: false } };
let pg;
const scrub = text => String(text).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[OWNED_LOOPBACK_DATABASE]');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (args, cwd = clone) => execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30000 }).trim();
const persist = () => writeFileSync(join(out, 'pr249-supplement.json'), JSON.stringify(report, null, 2) + '\n');
async function run(name, cmd, args, { cwd = repo, timeout = 180000, extraEnv = {}, required = true } = {}) {
  console.log('SWAY_PR249_BEGIN ' + name);
  const start = Date.now(); let text = '', timedOut = false, escalation;
  const child = spawn(cmd, args, { cwd, env: { ...env, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const consume = data => { const value = scrub(data); text += value; process.stdout.write(value); };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const timer = setTimeout(() => { timedOut = true; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 5000); }, timeout);
  const result = await new Promise(done => { child.once('error', error => done({ code: null, error: error.message })); child.once('close', (code, signal) => done({ code, signal })); });
  clearTimeout(timer); clearTimeout(escalation); kill('SIGKILL');
  writeFileSync(join(out, name + '.log'), text);
  const row = { name, ...result, timedOut, durationMs: Date.now() - start,
    passed: result.code === 0 && !result.signal && !timedOut && !result.error, logSha256: hash(text) };
  report.steps.push(row); persist(); console.log('SWAY_PR249_RESULT ' + JSON.stringify(row));
  if (required && !row.passed) throw new Error(name + ' did not pass');
  return { row, text };
}
async function listenerAvailable(port) {
  return new Promise((resolveResult, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolveResult(true); });
    socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolveResult(false); else reject(error); });
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Listener shutdown check timed out')); });
  });
}
async function stopOwnedDatabase() {
  if (!pg || report.cleanup.stopped) return;
  report.cleanup.attempted = true;
  await pg.stop();
  report.cleanup.stopped = true;
  report.cleanup.listenerClosed = !(await listenerAvailable(25439));
  assert.equal(report.cleanup.listenerClosed, true, 'Owned database remained available after stop');
}
try {
  // Preserve the previously published exact-source receipt, not a rewritten summary.
  const prior = await fetch('https://sway-release-proof.onrender.com/source-evidence.json', { signal: AbortSignal.timeout(20000), redirect: 'error' });
  assert.equal(prior.status, 200, 'Previous receipt must be preserved before replacing proof output');
  const priorBytes = Buffer.from(await prior.arrayBuffer());
  assert.ok(priorBytes.length > 0 && priorBytes.length < 2 * 1024 * 1024);
  const priorJson = JSON.parse(priorBytes.toString('utf8'));
  report.preservedPrevious = { candidate: priorJson.candidate, passed: priorJson.passed,
    sha256: hash(priorBytes), path: 'source-evidence.json' };
  writeFileSync(join(out, 'source-evidence.json'), priorBytes);
  writeFileSync(join(out, 'previous-source-evidence-' + hash(priorBytes) + '.json'), priorBytes);
  await run('clone', 'git', ['clone', '--no-hardlinks', '--no-checkout', original, clone], { cwd: temp });
  git(['remote', 'set-url', 'origin', ORIGIN]);
  await run('fetch-pinned-sources', 'git', ['fetch', '--depth=128', 'origin', HEAD, BASE, HELPER], { cwd: clone });
  const helper = execFileSync('git', ['show', HELPER + ':maintenance/sway-pr249-20260920/reconcile.py'], { cwd: clone, env });
  const helperPath = join(temp, 'reconcile.py'); writeFileSync(helperPath, helper);
  report.helperSha256 = hash(helper);
  await run('preservation-checked-merge', 'python3', [helperPath, clone, repo, evidence], { cwd: temp });
  report.merge = JSON.parse(readFileSync(join(evidence, 'merge.json'), 'utf8'));
  report.candidate = report.merge.source; report.tree = report.merge.tree;
  assert.equal(git(['rev-parse', 'HEAD'], repo), report.candidate);
  cpSync(evidence, join(out, 'merge'), { recursive: true });
  await run('locked-install', 'npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { timeout: 600000 });
  await run('changed-shared-host-contract', process.execPath, ['--test', 'scripts/grindzone-host.contract.test.mjs']);
  await run('merged-server-compile', process.execPath, ['--input-type=module', '-e',
    "import {buildSync} from 'esbuild'; buildSync({entryPoints:['server.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:" + JSON.stringify(join(temp, 'server.cjs')) + '});']);
  const deps = join(temp, 'native-dependencies'); mkdirSync(deps);
  await run('owned-postgres-helper-install', 'npm', ['install', '--prefix', deps, '--no-audit', '--no-fund', '--package-lock=false', 'embedded-postgres@18.4.0-beta.17'], { cwd: temp, timeout: 600000 });
  const requireDeps = createRequire(join(deps, 'package.json'));
  const { default: EmbeddedPostgres } = await import(pathToFileURL(requireDeps.resolve('embedded-postgres')).href);
  const password = randomBytes(18).toString('hex');
  pg = new EmbeddedPostgres({ databaseDir: join(temp, 'pgdata'), user: 'postgres', password,
    port: 25439, persistent: false, onLog: () => {}, onError: message => console.error(scrub(message)) });
  await pg.initialise(); await pg.start();
  const dbName = 'sway_pr249_registry_disposable_proof'; await pg.createDatabase(dbName);
  const client = pg.getPgClient(); await client.connect();
  try { report.database = (await client.query('select version(), pg_backend_pid() as pid, inet_server_port() as port')).rows[0]; }
  finally { await client.end(); }
  assert.match(report.database.version, /^PostgreSQL /); assert.equal(report.database.port, 25439);
  const registry = await run('exact-candidate-registry', process.execPath, ['scripts/sway-active-room-registry.contract.test.mjs'], {
    extraEnv: { DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:25439/${dbName}`, SWAY_ALLOW_DISPOSABLE_DATABASE_RESET: 'true' }
  });
  assert.ok(!/skipped/i.test(registry.text), 'A skipped registry proof is not acceptance');
  assert.ok(registry.text.includes('Active room registry database proof passed:'), 'Database success marker missing');
  report.registry = { candidate: report.candidate, passed: true, zeroSkips: true, logSha256: registry.row.logSha256,
    scope: 'Original candidate contract against a fresh owned native PostgreSQL process, not standalone contention or a real room' };
  assert.equal(git(['diff', '--name-only', 'HEAD'], repo), '', 'Tests changed tracked source');
  report.trackedSourceUnchanged = true;
  await stopOwnedDatabase();
  report.passed = true;
  // No credential discovery, force push, main merge or deployment. Try only the
  // repository's ordinary Git transport, and retain the bundle if it is read-only.
  if (process.env.SWAY_PR249_PUBLISH_CANDIDATE === 'true') {
    const refs = Object.fromEntries(git(['ls-remote', 'origin', 'refs/heads/main', 'refs/heads/' + BRANCH]).split('\n').map(line => { const [sha, ref] = line.split(/\s+/); return [ref, sha]; }));
    assert.equal(refs['refs/heads/main'], BASE, 'Main advanced; preserve newer GrindZone work');
    assert.equal(refs['refs/heads/' + BRANCH], HEAD, 'Task branch advanced; preserve newer work');
    const pushed = await run('publish-existing-draft-branch', 'git', ['push', 'origin', report.candidate + ':refs/heads/' + BRANCH], { cwd: repo, timeout: 30000, required: false });
    if (pushed.row.passed) {
      assert.equal(git(['ls-remote', 'origin', 'refs/heads/' + BRANCH]).split(/\s+/)[0], report.candidate);
      report.publication = { status: 'published_to_existing_draft_branch', candidate: report.candidate, mainChanged: false };
    } else {
      report.publication = { status: 'not_published_git_transport_failed', candidate: report.candidate, bundle: 'merge/candidate.bundle', exitCode: pushed.row.code };
    }
  }
} catch (error) {
  report.passed = false; report.error = scrub(error.stack || error); console.error('SWAY_PR249_ERROR ' + report.error);
} finally {
  try { await stopOwnedDatabase(); } catch (error) { report.passed = false; report.cleanup.error = scrub(error.stack || error); }
  report.finishedAt = new Date().toISOString();
  try {
    if (existsSync(evidence)) cpSync(evidence, join(out, 'merge'), { recursive: true });
    writeFileSync(join(out, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    writeFileSync(join(out, 'index.html'), '<meta name="robots" content="noindex,nofollow"><h1>Sway PR249 scoped evidence</h1><p>Merge and registry supplement only. Not original-player, Windows startup or release acceptance.</p><a href="pr249-supplement.json">Current scoped receipt</a><p><a href="source-evidence.json">Unchanged previous hosted receipt</a></p>');
    persist();
  } catch (error) { report.passed = false; report.artifactError = scrub(error.message || error); }
  console.log('SWAY_PR249_SUMMARY ' + JSON.stringify(report));
  await Promise.all([process.stdout, process.stderr].map(stream => new Promise(resolveFlush => stream.write('', resolveFlush))));
  // embedded-postgres has its own zero-exit hook. Never let it turn a test or
  // cleanup failure into an apparent successful deployment of evidence.
  process.exit(report.passed === true ? 0 : 1);
}
