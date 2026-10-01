import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';
import { sendShareLinkCopied, sendDiscoveryEvent } from '../src/shells/frictionClient.ts';

// The helper can optionally target standalone PostgreSQL. This test explicitly
// forbids that path: only its newly created in-memory, loopback fixture is used.
for (const key of ['DATABASE_URL','TEST_DATABASE_URL','SWAY_REAL_POSTGRES_PROOF_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','BREVO_API_KEY','SENDGRID_API_KEY','SMTP_PASS']) {
  assert(!process.env[key], 'Ingestion regression cannot inherit credentials: ' + key);
}
assert.notEqual(process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF, 'true');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(root, 'tmp/public-entry-qa/discovery-ingestion');
fs.mkdirSync(output, { recursive: true });
const report = { result: 'fail', cases: [], productionWrites: 0, scope: 'Real server.ts via Node/TSX ESM-only loader, real client helpers, and a fresh PGlite-backed audit store over loopback PostgreSQL protocol. Browser globals are fixtures; not production ingestion, standalone concurrency, human traffic, or revenue.' };
const originalFetch = globalThis.fetch;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let database, child, serverLog = '', childClosed;
const lifecycle = { pid: null, spawnError: null, exit: null, close: null, stdoutBytes: 0, stderrBytes: 0, outputTruncated: false, lastProbe: null, cleanup: null };
const secrets = new Set();
function redact(value) {
  let text = String(value);
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[REDACTED_URI]')
    .replace(/((?:password|passwd|pwd|token|secret|authorization|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]');
}
function capture(stream, chunk) {
  lifecycle[stream + 'Bytes'] += chunk.length;
  if (lifecycle.outputTruncated) return;
  // Join before redaction; omit all text on overflow rather than secret fragments.
  if (serverLog.length + chunk.length > 262144) { serverLog = ''; lifecycle.outputTruncated = true; return; }
  serverLog += chunk.toString();
}
async function waitForClose(milliseconds) {
  if (!child || lifecycle.close) return true;
  let timer;
  try { return await Promise.race([childClosed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
try {
  database = await startEmbeddedPostgresProof('public_entry_ingestion');
  assert.equal(database.kind, 'embedded-postgres');
  const target = new URL(database.databaseUrl);
  assert.equal(target.hostname, '127.0.0.1');
  for (const value of [database.databaseUrl, target.password, decodeURIComponent(target.password), encodeURIComponent(target.password), encodeURIComponent(decodeURIComponent(target.password))]) secrets.add(value);
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['--import', 'tsx/esm', 'server.ts'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', DATABASE_URL: database.databaseUrl, SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  childClosed = new Promise(resolve => child.once('close', (code, signal) => { lifecycle.close = { code, signal }; resolve(); }));
  lifecycle.pid = child.pid ?? null;
  child.once('error', error => { lifecycle.spawnError = { code: error.code ?? null, message: redact(error.message) }; });
  child.once('exit', (code, signal) => { lifecycle.exit = { code, signal }; });
  child.stdout.on('data', data => capture('stdout', data));
  child.stderr.on('data', data => capture('stderr', data));
  let ready = false;
  // Match the bounded source-startup budget used by acquisition quality: cold
  // Node/TSX imports can exceed the old 150 immediate-failure polling attempts.
  const startupStarted = performance.now();
  const startupDeadline = startupStarted + 90_000;
  let startupAttempts = 0;
  while (performance.now() < startupDeadline) {
    if (lifecycle.spawnError || child.exitCode !== null || child.signalCode !== null) break;
    startupAttempts++;
    const probeTimeout = Math.max(1, Math.floor(Math.min(1000, startupDeadline - performance.now())));
    try {
      const response = await originalFetch(origin + '/api/build-marker', { signal: AbortSignal.timeout(probeTimeout) });
      lifecycle.lastProbe = { status: response.status, json: (response.headers.get('content-type') || '').includes('json') };
      if (performance.now() < startupDeadline && response.ok && (response.headers.get('content-type') || '').includes('json')) { ready = true; break; }
    } catch (error) { lifecycle.lastProbe = { errorName: error.name, errorCode: error.cause?.code ?? null }; }
    const remaining = startupDeadline - performance.now();
    if (remaining > 0) await delay(Math.min(200, remaining));
  }
  report.startup = { pid: child.pid ?? null, budgetMs: 90_000, elapsedMs: Math.round(performance.now() - startupStarted), attempts: startupAttempts, ready };
  assert(ready, 'Owned ESM source application did not start');
  for (const denied of [false, true]) {
    const local = storage(), session = storage();
    const win = { location: { pathname: '/talent/gigs', search: '' } };
    for (const [key, value] of [['localStorage', local], ['sessionStorage', session]]) {
      Object.defineProperty(win, key, { get() { if (denied) throw new Error('Owned storage denial'); return value; } });
    }
    Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
    Object.defineProperty(globalThis, 'document', { value: { referrer: '' }, configurable: true });
    const emitted = [], pending = [];
    globalThis.fetch = (url, options) => {
      assert.equal(url, '/api/analytics/shell', 'Only the owned telemetry request is permitted');
      const payload = JSON.parse(options.body);
      const result = { payload, status: null, body: null }; emitted.push(result);
      const promise = originalFetch(origin + url, { ...options, signal: AbortSignal.timeout(10000) }).then(async response => {
        result.status = response.status;
        result.body = await response.clone().json();
        return response;
      });
      pending.push(promise); return promise;
    };
    const row = { storage: denied ? 'denied' : 'available', passed: false };
    try {
      sendShareLinkCopied({ shell: 'talent', surface: 'share-kit', route_family: 'talent-gigs', has_route_context: true, has_session_context: false, build_commit: 'owned-ingestion-fixture' });
      await Promise.all(pending.splice(0));
      const privateTouchStored = local.getItem('sway.discovery.firstTouch') !== null;
      win.location.pathname = '/discover'; win.location.search = '?utm_source=google';
      for (const event of ['discovery_landing', 'discovery_primary_action']) {
        sendDiscoveryEvent(event, { shell: 'patron', surface: 'public-discover', route_family: 'public-discover', has_route_context: true, has_session_context: false, build_commit: 'owned-ingestion-fixture', ...(event === 'discovery_primary_action' ? { action_kind: 'other' } : {}) });
      }
      await Promise.all(pending.splice(0));
      assert.equal(emitted.length, 3);
      row.statuses = emitted.map(item => item.status);
      row.publicEntries = emitted.slice(1).map(item => item.payload.entry_path ?? null);
      row.publicSources = emitted.slice(1).map(item => item.payload.attribution_channel ?? null);
      row.privateTouchStored = privateTouchStored;
      assert.equal(emitted[0].status, 202, 'Private share telemetry must remain accepted without a fabricated public entry');
      assert.equal(emitted[0].payload.entry_path, undefined, 'Private path must not be sent as a public entry');
      assert.equal(privateTouchStored, false, 'Private activity must not capture public first touch');
      assert.deepEqual(row.statuses, [202, 202, 202]);
      assert.deepEqual(row.publicEntries, ['/discover', '/discover']);
      assert.deepEqual(row.publicSources, ['google', 'google']);
      const journeyId = emitted[1].payload.journey_id;
      assert.equal(emitted[2].payload.journey_id, journeyId);
      const persisted = await database.query(`SELECT event_type, metadata FROM audit_events WHERE metadata->>'journey_id' = $1 AND event_type IN ('discovery_landing', 'discovery_primary_action') ORDER BY created_at, event_type`, [journeyId]);
      assert.equal(persisted.rows.length, 2, 'Both accepted public events must reach the actual audit store');
      assert(persisted.rows.every(item => item.metadata.entry_path === '/discover' && item.metadata.source === 'google'));
      assert(persisted.rows.every(item => item.metadata.link_strength === 'client_correlated_unverified'));
      const invalid = await originalFetch(origin + '/api/analytics/shell', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...emitted[1].payload, entry_path: '/talent/gigs' }), signal: AbortSignal.timeout(10000) });
      assert.equal(invalid.status, 400, 'The unchanged server must still reject a private entry path');
      const afterInvalid = await database.query(`SELECT count(*)::int AS count FROM audit_events WHERE metadata->>'journey_id' = $1 AND event_type IN ('discovery_landing', 'discovery_primary_action')`, [journeyId]);
      assert.equal(afterInvalid.rows[0].count, 2, 'Rejected private paths cannot enter the public funnel');
      row.persistedPublicEvents = 2; row.rejectedPrivateEntryStatus = 400; row.passed = true;
    } catch (error) { row.error = redact(error.stack || error); }
    finally { report.cases.push(row); console.log('DISCOVERY_INGESTION_CASE ' + JSON.stringify(row)); }
  }
  assert.equal(report.cases.length, 2);
  assert(report.cases.every(row => row.passed), 'Private-to-public ingestion regression failed');
  report.result = 'pass';
} catch (error) { report.error = redact(error.stack || error); }
finally {
  globalThis.fetch = originalFetch; restoreGlobal('window', previousWindow); restoreGlobal('document', previousDocument);
  if (child) {
    if (!lifecycle.spawnError && child.exitCode === null && child.signalCode === null) {
      lifecycle.cleanup = { termSent: child.kill('SIGTERM'), killSent: false, closed: false };
      if (!await waitForClose(5000) && child.exitCode === null && child.signalCode === null) lifecycle.cleanup.killSent = child.kill('SIGKILL');
    }
    const closed = await waitForClose(5000);
    lifecycle.cleanup = { ...lifecycle.cleanup, closed };
    if (!closed) { report.result = 'fail'; report.error = redact((report.error || '') + ' Owned server close was not observed within bounded cleanup.'); }
    report.serverLifecycle = lifecycle;
    if (report.result !== 'pass') report.serverTail = redact(serverLog).slice(-4000);
  }
  await database?.close();
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log('DISCOVERY_INGESTION_SUMMARY ' + JSON.stringify(report));
}
// Embedded database cleanup must not reset a failed proof to a successful exit.
if (report.result !== 'pass') process.exit(1);
