import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { basename } from 'node:path';
import { Client } from 'pg';
import { startEmbeddedPostgresProof } from './embedded-postgres-proof.ts';

const CHILD_FLAG = 'SWAY_ISOLATED_PAYMENT_CLOCK_TEST_CHILD';
const LABEL = 'payment_operation_clock';
const EXPECTED_DATABASE = '/sway_embedded_disposable_test_' + LABEL;

// Native PostgreSQL already owns an independent clock. PGlite uses the host's
// JavaScript clock, so keep that engine in the parent and run application clock
// injection in a child. The same 15 assertions run in both configurations.
export async function startIsolatedClockDatabase() {
  if (process.env[CHILD_FLAG] === 'true') {
    assert(process.connected && typeof process.send === 'function', 'Clock child requires parent IPC');
    const databaseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Clock database parent handshake timed out')), 10_000);
      process.once('message', message => {
        clearTimeout(timer);
        if (message?.type !== 'owned-clock-database' || typeof message.databaseUrl !== 'string') {
          reject(new Error('Invalid clock database handshake'));
        } else resolve(message.databaseUrl);
      });
      process.send({ type: 'clock-child-ready' });
    });
    const url = new URL(databaseUrl);
    assert.equal(url.protocol, 'postgresql:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.pathname, EXPECTED_DATABASE);
    assert.equal(url.username, 'postgres');
    assert.equal(url.password, 'postgres');
    assert(Number(url.port) > 0);
    // The parent alone creates/destroys the disposable database. The child
    // never resets schemas or accepts an arbitrary external database target.
    return {
      kind: 'embedded-postgres',
      databaseUrl,
      async query(text, values = []) {
        const client = new Client({ connectionString: databaseUrl });
        await client.connect();
        try { return await client.query(text, values); }
        finally { await client.end(); }
      },
      async close() {
        const { closeDisposableSwayDbProof } = await import('../../src/db/client.ts');
        await closeDisposableSwayDbProof(databaseUrl);
        if (process.connected) process.disconnect();
      }
    };
  }

  const proof = await startEmbeddedPostgresProof(LABEL);
  if (proof.kind === 'real-postgres') return proof;
  assert.equal(basename(process.argv[1] || ''), 'sway-payment-operation-clock.integration.test.mjs');
  let child;
  let timedOut = false;
  let timer;
  let escalation;
  let exitCode = 1;
  try {
    child = fork(process.argv[1], [], {
      execArgv: ['--import', 'tsx'],
      cwd: process.cwd(),
      env: { ...process.env, [CHILD_FLAG]: 'true' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    child.on('message', message => {
      if (message?.type === 'clock-child-ready') {
        child.send({ type: 'owned-clock-database', databaseUrl: proof.databaseUrl });
      }
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 3_000);
    }, 100_000);
    const result = await new Promise(resolve => {
      child.once('error', error => resolve({ code: 1, error }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (result.error) console.error(result.error);
    exitCode = !timedOut && result.code === 0 ? 0 : 1;
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await proof.close();
  }
  // Only the child executes the actual test body. Propagate failure exactly;
  // never fall through and rerun with two clocks sharing one process.
  process.exit(exitCode);
}
