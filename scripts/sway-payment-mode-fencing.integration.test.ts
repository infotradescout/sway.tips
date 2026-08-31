import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Stripe from 'stripe';
import { createPaymentService } from '../src/server/payment-service';
import { createPaymentWebhookService } from '../src/server/payment-webhook';
import { createConfiguredPaymentProvider } from '../src/server/payment-provider';
import { createConfiguredStripeConnectService } from '../src/server/stripe-connect';
import { createDeterministicPaymentProvider } from './lib/deterministic-payment-provider';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

const OWNER_ID = '20000000-0000-4000-8000-000000000001';
const PERFORMER_ID = '20000000-0000-4000-8000-000000000002';
const GIG_ID = '20000000-0000-4000-8000-000000000003';
const PAYMENT_ID = '20000000-0000-4000-8000-000000000004';
const PROCESSOR_INTENT_ID = 'pi_payment_mode_fence';

function providerCallCounts(fake: ReturnType<typeof createDeterministicPaymentProvider>) {
  return {
    authorize: fake.calls.authorize,
    capture: fake.calls.capture,
    refund: fake.calls.refund,
    retrieve: fake.calls.retrieve,
    void: fake.calls.void
  };
}

async function main() {
  const proof = await startEmbeddedPostgresProof('payment_mode_fencing');
  try {
    await proof.query(`
      insert into users (id, email, display_name)
      values ($1, 'payment-mode-owner@example.test', 'Payment Mode Owner')
    `, [OWNER_ID]);
    await proof.query(`
      insert into performers (
        id, owner_user_id, handle, display_name, is_active, onboarding_status
      ) values ($1, $2, 'payment-mode-proof', 'Payment Mode Proof', true, 'gig_ready')
    `, [PERFORMER_ID, OWNER_ID]);
    await proof.query(`
      insert into gig_sessions (
        id, performer_id, status, title, started_at, last_activity_at, auto_closeout_at
      ) values ($1, $2, 'active', 'Payment Mode Proof', now(), now(), now() + interval '4 hours')
    `, [GIG_ID, PERFORMER_ID]);
    await proof.query(`
      insert into payments (
        id, gig_id, performer_id, payment_status, processor,
        processor_payment_intent_id, amount_subtotal, platform_fee,
        amount_total, currency, legacy_unlinked, payment_mode
      ) values (
        $1, $2, $3, 'authorized', 'stripe', $4, 500, 50,
        550, 'USD', true, 'test'
      )
    `, [PAYMENT_ID, GIG_ID, PERFORMER_ID, PROCESSOR_INTENT_ID]);

    // A signed live event received by a test-key worker is durably recorded
    // and terminally ignored before payment identity resolution, transition,
    // operation enqueue, audit, or any provider API call.
    const webhookFake = createDeterministicPaymentProvider();
    const webhookService = createPaymentWebhookService({
      databaseUrl: proof.databaseUrl,
      provider: webhookFake.provider
    });
    const paymentBefore = await proof.query<{
      payment_status: string;
      refund_status: string;
      updated_at: Date;
    }>(`
      select payment_status, refund_status, updated_at
      from payments where id = $1
    `, [PAYMENT_ID]);
    const mutationsBefore = await proof.query<{
      payment_events: string;
      operations: string;
      audits: string;
    }>(`
      select
        (select count(*) from payment_events where payment_id = $1)::text as payment_events,
        (select count(*) from live_room_payment_operations where payment_id = $1)::text as operations,
        (select count(*) from audit_events)::text as audits
    `, [PAYMENT_ID]);

    const oppositeModeEvent = {
      providerEventId: `evt_opposite_mode_${randomUUID()}`,
      providerType: 'charge.refunded',
      livemode: true,
      processorPaymentIntentId: PROCESSOR_INTENT_ID,
      processorChargeId: 'ch_payment_mode_fence',
      providerStatus: 'succeeded',
      amountCents: 550,
      amountRefundedCents: 550,
      fullyRefunded: true,
      metadata: { sway_payment_id: PAYMENT_ID }
    };
    const rawOppositeModeEvent = JSON.stringify(oppositeModeEvent);
    const firstDelivery = await webhookService.ingestWebhook({
      rawBody: rawOppositeModeEvent,
      signatureHeader: 'deterministic-test-signature'
    });
    assert.deepEqual(firstDelivery, {
      status: 'ignored',
      reason: 'opposite_payment_mode'
    });

    const inboxAfterFirstDelivery = await proof.query<{
      status: string;
      processed_at: Date | null;
      payment_id: string | null;
      attempt_count: number;
      row_count: string;
    }>(`
      select status, processed_at, payment_id, attempt_count,
             count(*) over ()::text as row_count
      from live_room_processor_events
      where processor = 'stripe' and processor_event_id = $1
    `, [oppositeModeEvent.providerEventId]);
    assert.equal(inboxAfterFirstDelivery.rows[0].status, 'ignored');
    assert.ok(inboxAfterFirstDelivery.rows[0].processed_at);
    assert.equal(inboxAfterFirstDelivery.rows[0].payment_id, null);
    assert.equal(inboxAfterFirstDelivery.rows[0].attempt_count, 1);
    assert.equal(Number(inboxAfterFirstDelivery.rows[0].row_count), 1);

    const duplicateDelivery = await webhookService.ingestWebhook({
      rawBody: rawOppositeModeEvent,
      signatureHeader: 'deterministic-test-signature'
    });
    assert.deepEqual(duplicateDelivery, { status: 'duplicate' });
    await assert.rejects(
      webhookService.ingestWebhook({
        rawBody: JSON.stringify({ ...oppositeModeEvent, providerStatus: 'altered' }),
        signatureHeader: 'deterministic-test-signature'
      }),
      /event id was reused with a different signed payload/
    );

    const [paymentAfter, mutationsAfter, inboxAfterReplay] = await Promise.all([
      proof.query<{
        payment_status: string;
        refund_status: string;
        updated_at: Date;
      }>(`
        select payment_status, refund_status, updated_at
        from payments where id = $1
      `, [PAYMENT_ID]),
      proof.query<{
        payment_events: string;
        operations: string;
        audits: string;
      }>(`
        select
          (select count(*) from payment_events where payment_id = $1)::text as payment_events,
          (select count(*) from live_room_payment_operations where payment_id = $1)::text as operations,
          (select count(*) from audit_events)::text as audits
      `, [PAYMENT_ID]),
      proof.query<{ row_count: string; status: string; attempt_count: number }>(`
        select count(*)::text as row_count, min(status)::text as status,
               min(attempt_count)::int as attempt_count
        from live_room_processor_events
        where processor = 'stripe' and processor_event_id = $1
      `, [oppositeModeEvent.providerEventId])
    ]);
    assert.deepEqual(paymentAfter.rows[0], paymentBefore.rows[0]);
    assert.deepEqual(mutationsAfter.rows[0], mutationsBefore.rows[0]);
    assert.deepEqual(inboxAfterReplay.rows[0], {
      row_count: '1',
      status: 'ignored',
      attempt_count: 1
    });
    assert.deepEqual(
      providerCallCounts(webhookFake),
      { authorize: 0, capture: 0, refund: 0, retrieve: 0, void: 0 }
    );

    // A real signed Connect account event from the opposite Stripe mode is
    // classified before account retrieval, then enters the same durable inbox
    // before acknowledgment. No Stripe API request is possible on this path.
    const connectWebhookSecret = 'whsec_connect_opposite_mode_proof';
    const connectEnv = {
      STRIPE_SECRET_KEY: 'sk_test_connect_opposite_mode_proof',
      STRIPE_WEBHOOK_SECRET: connectWebhookSecret
    } as NodeJS.ProcessEnv;
    const connectService = createConfiguredStripeConnectService(connectEnv);
    const connectPaymentProvider = createConfiguredPaymentProvider(connectEnv);
    assert.ok(connectService);
    assert.ok(connectPaymentProvider);
    const connectEvent = {
      id: `evt_connect_opposite_${randomUUID()}`,
      object: 'event',
      api_version: '2025-12-15.clover',
      created: Math.floor(Date.now() / 1_000),
      data: { object: { id: 'acct_live_opposite_mode', object: 'account' } },
      livemode: true,
      pending_webhooks: 1,
      request: null,
      type: 'account.updated'
    };
    const rawConnectEvent = JSON.stringify(connectEvent);
    const connectSignature = Stripe.webhooks.generateTestHeaderString({
      payload: rawConnectEvent,
      secret: connectWebhookSecret
    });
    const parsedConnectEvent = await connectService.parseAccountUpdatedEvent({
      rawBody: rawConnectEvent,
      signatureHeader: connectSignature,
      webhookSecret: connectWebhookSecret
    });
    assert.equal(parsedConnectEvent?.paymentMode, 'live');
    assert.equal(parsedConnectEvent?.accountId, 'acct_live_opposite_mode');
    assert.equal(parsedConnectEvent?.status, null);

    const connectInbox = createPaymentWebhookService({
      databaseUrl: proof.databaseUrl,
      provider: connectPaymentProvider
    });
    assert.deepEqual(await connectInbox.ingestWebhook({
      rawBody: rawConnectEvent,
      signatureHeader: connectSignature
    }), { status: 'ignored', reason: 'opposite_payment_mode' });
    assert.deepEqual(await connectInbox.ingestWebhook({
      rawBody: rawConnectEvent,
      signatureHeader: connectSignature
    }), { status: 'duplicate' });
    const alteredConnectRaw = JSON.stringify({
      ...connectEvent,
      data: { object: { id: 'acct_live_altered', object: 'account' } }
    });
    const alteredConnectSignature = Stripe.webhooks.generateTestHeaderString({
      payload: alteredConnectRaw,
      secret: connectWebhookSecret
    });
    await assert.rejects(
      connectInbox.ingestWebhook({
        rawBody: alteredConnectRaw,
        signatureHeader: alteredConnectSignature
      }),
      /event id was reused with a different signed payload/
    );
    const connectInboxTruth = await proof.query<{
      status: string;
      payment_id: string | null;
      row_count: string;
    }>(`
      select min(status)::text as status, min(payment_id::text) as payment_id,
             count(*)::text as row_count
      from live_room_processor_events
      where processor = 'stripe' and processor_event_id = $1
    `, [connectEvent.id]);
    assert.deepEqual(connectInboxTruth.rows[0], {
      status: 'ignored',
      payment_id: null,
      row_count: '1'
    });

    // The normal route response is HTTP 200 for an ignored result. Signature
    // or altered-payload errors still use the route's 400 catch path.
    const serverSource = readFileSync(join(process.cwd(), 'server.ts'), 'utf8');
    const routeStart = serverSource.indexOf('app.post("/api/payment/webhook"');
    const routeEnd = serverSource.indexOf('app.get("/api/state"', routeStart);
    const routeSource = routeStart >= 0 && routeEnd > routeStart
      ? serverSource.slice(routeStart, routeEnd)
      : '';
    assert.match(
      routeSource,
      /const result = await paymentWebhookService\.ingestWebhook\([\s\S]*return res\.json\(\{ received: true, result \}\)/
    );
    assert.match(
      routeSource,
      /accountEvent\.paymentMode !== connectRuntimeMode[\s\S]+paymentWebhookService\.ingestWebhook\(\{ rawBody, signatureHeader \}\)[\s\S]+ignored_opposite_mode/
    );
    assert.match(routeSource, /catch \(error\) \{[\s\S]*return res\.status\(400\)\.json/);

    // The database blocks a mismatched operation at write time. To prove the
    // worker's independent defense, simulate a corrupt/pre-guard row in this
    // disposable database and verify failure occurs before any provider call.
    const operationKey = `mode-mismatch:${PAYMENT_ID}`;
    const insertMismatchedOperation = () => proof.query(`
      insert into live_room_payment_operations (
        payment_id, gig_id, performer_id, operation_type, processor,
        payment_mode, idempotency_key, destination_account_id, request_payload
      ) values ($1, $2, $3, 'reverse', 'stripe', 'live', $4, 'acct_live_wrong_mode', '{}'::jsonb)
    `, [PAYMENT_ID, GIG_ID, PERFORMER_ID, operationKey]);
    await assert.rejects(
      insertMismatchedOperation(),
      /payment operation mode live does not match payment mode test/
    );
    await proof.query(`
      drop trigger live_room_payment_operations_mode_guard
      on live_room_payment_operations
    `);
    await insertMismatchedOperation();
    await proof.query(`
      create trigger live_room_payment_operations_mode_guard
        before insert or update of payment_id, payment_mode
        on live_room_payment_operations
        for each row execute function sway_enforce_live_room_payment_operation_mode()
    `);

    const mismatchFake = createDeterministicPaymentProvider();
    const liveProvider = { ...mismatchFake.provider, mode: 'live' as const };
    const liveService = createPaymentService({
      databaseUrl: proof.databaseUrl,
      provider: liveProvider,
      paymentMode: 'live'
    });
    const mismatchRun = await liveService.runDueOperations({ limit: 5 });
    assert.deepEqual(mismatchRun, { claimed: 1, succeeded: 0, failed: 1 });
    const mismatchTruth = await proof.query<{
      status: string;
      last_error: string | null;
      processor_object_id: string | null;
    }>(`
      select status, last_error, processor_object_id
      from live_room_payment_operations where idempotency_key = $1
    `, [operationKey]);
    assert.deepEqual(mismatchTruth.rows[0], {
      status: 'retryable_failed',
      last_error: 'payment_not_found',
      processor_object_id: null
    });
    assert.deepEqual(
      providerCallCounts(mismatchFake),
      { authorize: 0, capture: 0, refund: 0, retrieve: 0, void: 0 }
    );

    console.log('Payment mode fencing deterministic integration test passed.');
  } finally {
    await proof.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
