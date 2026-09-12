import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createLiveRoomPaymentOperationStore } from '../src/server/live-room-payment-operation-store.ts';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

// No provider is constructed. These tests operate only on the owned disposable
// database accepted by the existing guard, never production data or money.
const RealDate = globalThis.Date;
async function withClockOffset(offsetMs, action) {
  class OffsetDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offsetMs);
      else super(...args);
    }
    static now() { return RealDate.now() + offsetMs; }
  }
  globalThis.Date = OffsetDate;
  try { return await action(); }
  finally { globalThis.Date = RealDate; }
}

const proof = await startEmbeddedPostgresProof('payment_operation_clock');
const store = createLiveRoomPaymentOperationStore(proof.databaseUrl, 'test');
const ownerId = randomUUID(), performerId = randomUUID(), gigId = randomUUID();
const outcomes = [];
async function check(name, action) {
  try { await action(); outcomes.push({ name, passed: true }); }
  catch (error) { outcomes.push({ name, passed: false, error: String(error.stack || error) }); }
  console.log('PAYMENT_CLOCK_CASE ' + JSON.stringify(outcomes.at(-1)));
}
async function fixture(type = 'capture', existingPaymentId) {
  const paymentId = existingPaymentId || randomUUID();
  if (!existingPaymentId) await proof.query(`
    insert into payments (id, gig_id, performer_id, payment_status, processor,
      amount_subtotal, platform_fee, amount_total, currency, payment_mode,
      destination_account_id, idempotency_key)
    values ($1, $2, $3, 'authorized', 'stripe', 500, 100, 600, 'USD',
      'test', 'sway_test_platform_balance', $4)
  `, [paymentId, gigId, performerId, 'clock-payment-' + randomUUID()]);
  const operation = await store.enqueue({
    paymentId, gigId, performerId, operationType: type, processor: 'stripe',
    idempotencyKey: 'clock-operation-' + randomUUID(),
    destinationAccountId: 'sway_test_platform_balance', requestPayload: {}
  });
  assert(operation);
  return operation;
}
async function due(operation) {
  await proof.query("update live_room_payment_operations set available_at = statement_timestamp() - interval '10 seconds' where id = $1", [operation.id]);
}
async function assertDatabaseLease(operation) {
  const result = await proof.query(`
    select extract(epoch from (lease_expires_at - statement_timestamp()))::float8 as remaining
    from live_room_payment_operations where id = $1
  `, [operation.id]);
  assert(result.rows[0].remaining > 25 && result.rows[0].remaining <= 30.1,
    'A lease must last 30 database seconds, independently of the app clock: ' + result.rows[0].remaining);
}
try {
  await proof.query("insert into users (id, email, display_name) values ($1, $2, 'Clock Proof Owner')", [ownerId, 'clock-' + ownerId + '@example.test']);
  await proof.query("insert into performers (id, owner_user_id, handle, display_name, is_active) values ($1, $2, $3, 'Clock Proof Performer', true)", [performerId, ownerId, 'clock-' + performerId.slice(0, 8)]);
  await proof.query("insert into gig_sessions (id, performer_id, owner_actor_user_id, status, title, started_at, last_activity_at, auto_closeout_at) values ($1, $2, $3, 'active', 'Disposable clock proof', now(), now(), now() + interval '4 hours')", [gigId, performerId, ownerId]);

  await check('new database-due operation is claimable with app clock behind', async () => {
    const operation = await fixture();
    const leased = await withClockOffset(-60_000, () => store.claim('behind-worker', operation.id));
    assert(leased, 'Database-due capture was incorrectly left pending');
    await assertDatabaseLease(leased);
  });
  await check('future operation is not executed early with app clock ahead', async () => {
    const operation = await fixture();
    await proof.query("update live_room_payment_operations set available_at = statement_timestamp() + interval '30 seconds' where id = $1", [operation.id]);
    const leased = await withClockOffset(60_000, () => store.claim('ahead-worker', operation.id));
    assert.equal(leased, null, 'Future retry must not run before database deadline');
  });
  await check('lease length is based on database time when app clock is ahead', async () => {
    const operation = await fixture(); await due(operation);
    const leased = await withClockOffset(60_000, () => store.claim('lease-clock-worker', operation.id));
    assert(leased); await assertDatabaseLease(leased);
  });
  await check('active sibling prevents overlapping capture and reversal under skew', async () => {
    const capture = await fixture(); await due(capture);
    const owner = await store.claim('capture-owner', capture.id); assert(owner);
    const reverse = await fixture('reverse', capture.paymentId); await due(reverse);
    const overlapping = await withClockOffset(60_000, () => store.claim('reverse-owner', reverse.id));
    assert.equal(overlapping, null, 'Clock skew must not bypass active sibling lease');
  });
  await check('expired lease can be reclaimed behind app clock and old owner is fenced', async () => {
    const operation = await fixture(); await due(operation);
    const oldOwner = await store.claim('old-owner', operation.id); assert(oldOwner);
    await proof.query("update live_room_payment_operations set lease_expires_at = statement_timestamp() - interval '1 second' where id = $1", [operation.id]);
    const newOwner = await withClockOffset(-60_000, () => store.claim('new-owner', operation.id));
    assert(newOwner); assert.notEqual(newOwner.leaseOwner, oldOwner.leaseOwner);
    await store.markSucceeded(oldOwner, { resultPayload: { stale: true } });
    const current = await store.load(operation.id);
    assert.equal(current.status, 'leased'); assert.equal(current.leaseOwner, newOwner.leaseOwner);
  });
  await check('retry backoff is not backdated by the app clock', async () => {
    const operation = await fixture(); await due(operation);
    const owner = await store.claim('retry-owner', operation.id); assert(owner);
    await withClockOffset(-60_000, () => store.markFailed(owner, new Error('synthetic_retry')));
    const immediate = await store.claim('retry-too-early', operation.id);
    assert.equal(immediate, null, 'The retry delay must survive app clock skew');
  });
  await check('closeout cannot steal an unexpired authorization under app clock skew', async () => {
    const operation = await fixture('authorize'); await due(operation);
    const owner = await store.claim('authorize-owner', operation.id); assert(owner);
    const result = await withClockOffset(60_000, () => store.prepareAuthorizationForCloseout(operation.paymentId));
    assert.equal(result.status, 'in_flight');
    assert.equal((await store.load(operation.id)).leaseOwner, owner.leaseOwner);
  });
  await check('closeout recovers an expired authorization even with app clock behind', async () => {
    const operation = await fixture('authorize'); await due(operation);
    assert(await store.claim('expired-authorize-owner', operation.id));
    await proof.query("update live_room_payment_operations set lease_expires_at = statement_timestamp() - interval '1 second' where id = $1", [operation.id]);
    const result = await withClockOffset(-60_000, () => store.prepareAuthorizationForCloseout(operation.paymentId));
    assert.equal(result.status, 'reconcile');
    assert(await store.claim('closeout-recovery', operation.id));
  });
  await check('two independent callers still obtain one operation owner', async () => {
    const operation = await fixture(); await due(operation);
    const claims = await Promise.all([store.claim('race-a', operation.id), store.claim('race-b', operation.id)]);
    assert.equal(claims.filter(Boolean).length, 1);
  });
  const failures = outcomes.filter(row => !row.passed);
  console.log('PAYMENT_CLOCK_SUMMARY ' + JSON.stringify({ database: proof.kind, cases: outcomes.length, failures: failures.length, outcomes }));
  assert.equal(failures.length, 0, 'Payment operation clock regressions');
} finally {
  globalThis.Date = RealDate;
  await proof.close();
}
