import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';
import { createSwayDb } from '../src/db/client';
import { createPerformerSessionStore } from '../src/server/performer-session-store';

// Exercise the canonical endpoint with owned disposable database records and
// persisted sessions. No provider requests, browser stubs or duplicated query.
const proof = await startEmbeddedPostgresProof('library_source_counts');
const sessions = createPerformerSessionStore({ databaseUrl: proof.databaseUrl, dbOverride: createSwayDb(proof.databaseUrl) });
let child: ReturnType<typeof spawn> | undefined;
let failed = false;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
try {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: proof.databaseUrl,
      SWAY_APP_BASE_URL: base, APP_URL: base, APP_BASE_URL: base, DISABLE_HMR: 'true', VITE_SWAY_DEMO_MODE: 'false',
      SWAY_LIVE_MONEY_ENABLED: 'false', SWAY_TICKET_MONEY_ENABLED: 'false', SWAY_PERFORMER_WITHDRAWALS_ENABLED: 'false',
      SWAY_PAYPAL_PAYOUTS_ENABLED: 'false', SWAY_PAYPAL_PAYOUT_LIVE_EXECUTION_ENABLED: 'false',
      STRIPE_SECRET_KEY: '', STRIPE_PUBLISHABLE_KEY: '', VITE_STRIPE_PUBLISHABLE_KEY: '', STRIPE_WEBHOOK_SECRET: '',
      SWAY_EMAIL_PROVIDER: '', SWAY_EMAIL_API_KEY: '', SWAY_EMAIL_FROM: '' },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  let ready = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    assert.equal(child.exitCode, null, 'Owned local server must remain running');
    try { ready = (await fetch(base + '/api/health/network-probe', { signal: AbortSignal.timeout(1000) })).status === 204; } catch {}
    if (ready) break;
    await pause(100);
  }
  assert(ready, 'Owned local server must become ready');
  async function owner(label: string) {
    const user = randomUUID(), performer = randomUUID();
    await proof.query("insert into users(id,email,display_name,role,pro_mode_status,email_verified_at,terms_accepted_at) values ($1,$2,$3,'performer','active',now(),now())", [user, `${user}@sources.sway.test`, label]);
    await proof.query("insert into performers(id,owner_user_id,display_name,is_active) values ($1,$2,$3,true)", [performer, user, label]);
    const session = await sessions.issueSession({ actorUserId: user, issuedBy: user });
    return { performer, cookie: `${sessions.cookieName}=${session.token}` };
  }
  async function read(actor: { cookie: string }, query = '') {
    const response = await fetch(base + '/api/talent/library/sources' + query, { headers: { cookie: actor.cookie } });
    assert.equal(response.status, 200);
    return (await response.json()).sources as { sourceKey: string; trackCount: number }[];
  }
  async function save(actor: { performer: string; cookie: string }, sourceKey: string, count: number) {
    const response = await fetch(base + '/api/talent/library/import', {
      method: 'POST', headers: { cookie: actor.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceKey, sourceLabel: sourceKey, tracks: Array.from({ length: count }, (_, index) => ({ externalTrackId: `song-${index}`, title: `Song ${index}`, artist: 'Synthetic artist' })) })
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).performerId, actor.performer);
  }
  const first = await owner('First'), second = await owner('Second');
  assert.equal((await fetch(base + '/api/talent/library/sources')).status, 401);
  await save(first, 'shared-export', 2);
  await save(first, 'other-export', 1);
  await save(second, 'shared-export', 4);
  await proof.query("insert into performer_library_sources(performer_id,source_key,source_label,sync_key_hash,sync_key_preview) values ($1,'empty','Empty',$2,'file-import')", [first.performer, randomUUID()]);
  const counts = (rows: Awaited<ReturnType<typeof read>>) => Object.fromEntries(rows.map(row => [row.sourceKey, row.trackCount]));
  assert.deepEqual(counts(await read(first)), { 'shared-export': 2, 'other-export': 1, empty: 0 });
  assert.deepEqual(counts(await read(second, `?performerId=${first.performer}`)), { 'shared-export': 4 });
  await save(first, 'shared-export', 1);
  assert.deepEqual(counts(await read(first)), { 'shared-export': 1, 'other-export': 1, empty: 0 });
  assert.deepEqual(counts(await read(second)), { 'shared-export': 4 });
  console.log('Source counts passed through actual API: source isolation, performer isolation, zero-track source, replacement, unauthenticated denial.');
} catch (error) {
  failed = true;
  console.error('Source count API behavior failed:', error);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt++) await pause(100);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await proof.close();
}
if (failed) process.exit(1);
