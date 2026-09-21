import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';
import { sendShareLinkCopied, sendDiscoveryEvent } from '../src/shells/frictionClient.ts';

// The helper can optionally target standalone PostgreSQL. This test explicitly
// forbids that path: only its newly created in-memory, loopback fixture is used.
for (const key of ['DATABASE_URL','TEST_DATABASE_URL','SWAY_REAL_POSTGRES_PROOF_DATABASE_URL','STRIPE_SECRET_KEY','SESSION_SECRET','BREVO_API_KEY','SENDGRID_API_KEY','SMTP_PASS']) {
  assert(!process.env[key], 'Ingestion regression cannot inherit credentials: ' + key);
}
assert.notEqual(process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF, 'true');
const output = path.resolve('tmp/public-entry-qa/discovery-ingestion');
fs.mkdirSync(output, { recursive: true });
const report = { result: 'fail', cases: [], productionWrites: 0, scope: 'Real server.ts telemetry route, real client helpers, and a fresh PGlite-backed audit store over loopback PostgreSQL protocol. Browser globals are fixtures; not production ingestion, standalone concurrency, human traffic, or revenue.' };
const originalFetch = globalThis.fetch;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let database, child, serverLog = '';
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
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', DATABASE_URL: database.databaseUrl, SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { serverLog = (serverLog + data).slice(-20000); });
  child.stderr.on('data', data => { serverLog = (serverLog + data).slice(-20000); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await originalFetch(origin + '/api/build-marker', { signal: AbortSignal.timeout(1000) });
      if (response.ok && (response.headers.get('content-type') || '').includes('json')) { ready = true; break; }
    } catch { /* The owned server may still be starting. */ }
    await delay(200);
  }
  assert(ready, 'Owned application did not start: ' + serverLog);
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
    } catch (error) { row.error = String(error.stack || error); }
    finally { report.cases.push(row); console.log('DISCOVERY_INGESTION_CASE ' + JSON.stringify(row)); }
  }
  assert.equal(report.cases.length, 2);
  assert(report.cases.every(row => row.passed), 'Private-to-public ingestion regression failed');
  report.result = 'pass';
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  globalThis.fetch = originalFetch; restoreGlobal('window', previousWindow); restoreGlobal('document', previousDocument);
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) await delay(100);
    if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  }
  await database?.close();
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log('DISCOVERY_INGESTION_SUMMARY ' + JSON.stringify(report));
}
