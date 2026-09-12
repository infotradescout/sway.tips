import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createLiveRoomPaymentOperationStore } from '../src/server/live-room-payment-operation-store.ts';
import { createPaymentWebhookService } from '../src/server/payment-webhook.ts';
import { createDeterministicPaymentProvider } from './lib/deterministic-payment-provider.ts';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

// Only the owned disposable database and deterministic provider are used.
// No external provider requests, production records, or real money are involved.
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
const requestIds = new Map();
const outcomes = [];
async function check(name, action) {
  try { await action(); outcomes.push({ name, passed: true }); }
  catch (error) { outcomes.push({ name, passed: false, error: String(error.cause?.message || error.message || error) }); }
  console.log('PAYMENT_CLOCK_CASE ' + JSON.stringify(outcomes.at(-1)));
}
async function fixture(type = 'capture', existingPaymentId) {
  const paymentId = existingPaymentId || randomUUID();
  if (!existingPaymentId) {
    const requestId = randomUUID();
    const key = 'clock-payment-' + randomUUID();
    const fingerprint = createHash('sha256').update(key).digest('hex');
    await proof.query(`
      insert into requests (id, gig_id, client_request_id, idempotency_key,
        intent_fingerprint, patron_device_id_hash, status, request_type,
        amount_cents, currency, runtime_request_state, activated_at)
      values ($1, $2, $3, $3, $4, $4, 'payment_pending', 'song', 500, 'USD', '{}'::jsonb, null)
    `, [requestId, gigId, key, fingerprint]);
    await proof.query(`
      insert into payments (id, gig_id, performer_id, request_id, action_type,
        legacy_unlinked, payment_status, processor, amount_subtotal,
        platform_fee, amount_total, currency, payment_mode,
        destination_account_id, idempotency_key)
      values ($1, $2, $3, $4, 'request', false, 'authorized', 'stripe',
        500, 100, 600, 'USD', 'test', 'sway_test_platform_balance', $5)
    `, [paymentId, gigId, performerId, requestId, key]);
    requestIds.set(paymentId, requestId);
  }
  const requestId = requestIds.get(paymentId); assert(requestId);
  const operation = await store.enqueue({
    paymentId, gigId, performerId, requestId, operationType: type, processor: 'stripe',
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
async function eventFixture({ type = 'customer.updated', dueSeconds = -120, processingSeconds = null } = {}) {
  const event = {
    providerEventId: 'evt_clock_' + randomUUID(), providerType: type,
    livemode: false, processorPaymentIntentId: 'pi_clock_' + randomUUID(),
    providerStatus: 'succeeded', amountCents: 600,
    metadata: { sway_payment_id: randomUUID() }
  };
  const rawBody = JSON.stringify(event);
  const payload = {
    processorPaymentIntentId: event.processorPaymentIntentId,
    processorChargeId: null, providerStatus: event.providerStatus,
    amountCents: event.amountCents, amountRefundedCents: null,
    fullyRefunded: null, metadata: event.metadata
  };
  const status = processingSeconds === null ? 'pending' : 'processing';
  await proof.query(`
    insert into live_room_processor_events (processor, processor_event_id,
      event_type, payload_sha256, payload, livemode, status, next_attempt_at,
      processing_started_at, processing_lease_owner)
    values ('stripe', $1, $2, $3, $4::jsonb, false,
      $5::live_room_processor_event_status,
      statement_timestamp() + ($6 * interval '1 second'),
      case when $5 = 'processing' then statement_timestamp() + ($7 * interval '1 second') else null end,
      case when $5 = 'processing' then $8 else null end)
  `, [event.providerEventId, type, createHash('sha256').update(rawBody).digest('hex'),
    JSON.stringify(payload), status, dueSeconds, processingSeconds || 0, 'clock-lease-' + randomUUID()]);
  return { event, rawBody, signatureHeader: 'deterministic-test-signature' };
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

  const fake = createDeterministicPaymentProvider();
  const webhook = createPaymentWebhookService({ databaseUrl: proof.databaseUrl, provider: fake.provider });
  await check('database-due verified webhook is processed with app clock behind', async () => {
    const input = await eventFixture({ dueSeconds: 0 });
    const result = await withClockOffset(-60_000, () => webhook.ingestWebhook(input));
    assert.equal(result.status, 'ignored', 'A verified due event must not be left unclaimed');
  });
  await check('future webhook retry is not processed early with app clock ahead', async () => {
    const input = await eventFixture({ dueSeconds: 30 });
    const result = await withClockOffset(60_000, () => webhook.ingestWebhook(input));
    assert.equal(result.status, 'not_claimed');
  });
  await check('active webhook lease is not stolen by an ahead app clock', async () => {
    const input = await eventFixture({ processingSeconds: 0 });
    const result = await withClockOffset(60_000, () => webhook.ingestWebhook(input));
    assert.equal(result.status, 'not_claimed');
  });
  await check('expired webhook lease is recovered despite a behind app clock', async () => {
    const input = await eventFixture({ processingSeconds: -31 });
    const result = await withClockOffset(-60_000, () => webhook.ingestWebhook(input));
    assert.equal(result.status, 'ignored');
  });
  await check('unresolved webhook retains database-based retry delay', async () => {
    const input = await eventFixture({ type: 'payment_intent.succeeded' });
    const result = await withClockOffset(-60_000, () => webhook.ingestWebhook(input));
    assert.equal(result.status, 'accepted_pending');
    const truth = await proof.query(`
      select status, extract(epoch from (next_attempt_at - statement_timestamp()))::float8 as remaining
      from live_room_processor_events where processor_event_id = $1
    `, [input.event.providerEventId]);
    assert.equal(truth.rows[0].status, 'retryable_failed');
    assert(truth.rows[0].remaining > 0 && truth.rows[0].remaining <= 2.1, 'Webhook retry must not be backdated');
    assert.equal((await webhook.ingestWebhook(input)).status, 'not_claimed');
  });
  await check('webhook signature and altered replay protections remain enforced', async () => {
    const input = await eventFixture();
    await assert.rejects(webhook.ingestWebhook({ ...input, signatureHeader: null }), /signature/i);
    assert.equal((await webhook.ingestWebhook(input)).status, 'ignored');
    assert.equal((await webhook.ingestWebhook(input)).status, 'duplicate');
    await assert.rejects(webhook.ingestWebhook({
      ...input, rawBody: JSON.stringify({ ...input.event, metadata: { changed: 'payload' } })
    }), /different signed payload/i);
  });
  const failures = outcomes.filter(row => !row.passed);
  console.log('PAYMENT_CLOCK_SUMMARY ' + JSON.stringify({ database: proof.kind, cases: outcomes.length, failures: failures.length, outcomes }));
  assert.equal(failures.length, 0, 'Payment operation clock regressions');
} finally {
  globalThis.Date = RealDate;
  await proof.close();
}
