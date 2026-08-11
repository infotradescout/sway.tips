import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createBusinessStore } from '../src/server/business-store';
import { createIdempotencyStore } from '../src/server/idempotency-store';
import { createPaymentService, type AuthorizeActionInput } from '../src/server/payment-service';
import { createPaymentWebhookService } from '../src/server/payment-webhook';
import { createDeterministicPaymentProvider } from './lib/deterministic-payment-provider';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';
import { SWAY_TEST_PLATFORM_BALANCE_DESTINATION } from '../src/server/live-room-seller-readiness';

const OWNER_ID = '10000000-0000-4000-8000-000000000001';
const PERFORMER_ID = '10000000-0000-4000-8000-000000000002';
const GIG_ID = '10000000-0000-4000-8000-000000000003';
const DEVICE_HASH = createHash('sha256').update('durability-proof-browser').digest('hex');
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function activeSession() {
  return {
    status: 'active',
    startedAt: new Date().toISOString(),
    autoCloseoutAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    closedAt: null,
    ownerActorUserId: OWNER_ID,
    lastMutationActorUserId: OWNER_ID,
    talentName: 'DJ Durability',
    talentRole: 'DJ',
    feeType: 'patron',
    minimumTip: 5,
    endGigTimerStartedAt: null,
    isFeatured: false,
    featuredExpiresAt: null,
    featuredCost: 0,
    featuredDurationHours: 0,
    requestsOpen: true,
    requestWindowMode: 'manual',
    requestWindowExpiresAt: null,
    requestWindowDuration: null,
    requestWindowLabel: null,
    requestPresets: [],
    operatingMode: 'manual',
    searchScope: 'catalog',
    paymentsEnabled: true,
    tipsEnabled: true,
    totals: { totalTips: 0, accumulatedFees: 0, totalCount: 0, topRequest: 'None yet' }
  };
}

async function waitFor(assertion: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function main() {
  const proof = await startEmbeddedPostgresProof('live_room_crash_concurrency');
  const fake = createDeterministicPaymentProvider();
  const idempotencyStore = createIdempotencyStore(proof.databaseUrl);
  const paymentService = createPaymentService({ databaseUrl: proof.databaseUrl, provider: fake.provider });
  const businessStore = createBusinessStore(proof.databaseUrl, activeSession as never);

  async function reserveRequest(input: {
    label: string;
    amountCents?: number;
    deviceHash?: string;
    expiresAt?: string;
    runtimeStatus?: 'hold' | 'approved' | 'fulfilled';
  }) {
    const clientRequestId = `client-${input.label}-${randomUUID()}`;
    const idempotencyKey = `idempotency-${input.label}-${randomUUID()}`;
    const intentFingerprint = hash(`intent:${input.label}:${clientRequestId}`);
    const payloadHash = hash(`payload:${input.label}:${clientRequestId}`);
    const amountCents = input.amountCents ?? 500;
    const reservation = await idempotencyStore.reservePendingAction({
      clientRequestId,
      idempotencyKey,
      patronDeviceIdHash: input.deviceHash ?? DEVICE_HASH,
      gigId: GIG_ID,
      actionType: 'request',
      amountCents,
      currency: 'USD',
      targetEntityType: 'music',
      targetEntityId: input.label,
      payloadHash,
      intentFingerprint,
      expiresAt: input.expiresAt
    });
    assert.equal(reservation.kind, 'new');
    const runtimeId = `req-${clientRequestId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const runtimeState = {
      id: runtimeId,
      type: 'request',
      targetType: 'music',
      title: input.label,
      subtitle: 'Durability Artist',
      senderName: 'Proof Patron',
      message: '',
      amount: amountCents / 100,
      holdAmount: amountCents / 100,
      platformFee: 0.5,
      sponsorCount: 1,
      status: input.runtimeStatus ?? 'hold',
      createdAt: new Date().toISOString(),
      clientRequestId,
      idempotencyKey,
      idempotencyFingerprint: intentFingerprint,
      patronDeviceIdHash: input.deviceHash ?? DEVICE_HASH,
      gigId: GIG_ID,
      payloadHash,
      amountCents,
      currency: 'USD',
      boosts: []
    };
    const created = await proof.query<{ id: string }>(`
      insert into requests (
        gig_id, client_request_id, idempotency_key, intent_fingerprint,
        patron_device_id_hash, status, request_type, amount_cents, currency,
        runtime_request_state, activated_at
      ) values ($1, $2, $3, $4, $5, 'payment_pending', 'song', $6, 'USD', $7::jsonb, null)
      returning id
    `, [GIG_ID, clientRequestId, idempotencyKey, intentFingerprint, input.deviceHash ?? DEVICE_HASH, amountCents, JSON.stringify(runtimeState)]);
    const requestId = created.rows[0].id;
    const authorizationInput: AuthorizeActionInput = {
      gigId: GIG_ID,
      actionType: 'request',
      amountSubtotalCents: amountCents,
      platformFeeCents: 50,
      platformFeePayer: 'patron',
      attributionSource: 'creator_direct',
      campaignId: null,
      commissionBpsApplied: null,
      currency: 'USD',
      idempotencyKey,
      intentFingerprint,
      requestId,
      runtimeRequestId: runtimeId,
      clientRequestId,
      paymentMethod: 'pm_card_visa',
      confirm: true
    };
    return { clientRequestId, idempotencyKey, intentFingerprint, requestId, runtimeId, runtimeState, authorizationInput };
  }

  try {
    await proof.query(`
      insert into users (id, email, display_name, email_verified_at, terms_accepted_at, pro_mode_status)
      values ($1, 'durability-owner@example.test', 'Durability Owner', now(), now(), 'active')
    `, [OWNER_ID]);
    await proof.query(`
      insert into performers (
        id, owner_user_id, handle, display_name, is_active, onboarding_status,
        payment_account_status, kyc_status, payouts_enabled, charges_enabled,
        stripe_connected_account_id
      ) values (
        $2, $1, 'dj-durability', 'DJ Durability', true, 'gig_ready',
        'payouts_enabled', 'verified', true, true, 'acct_test_durability'
      )
    `, [OWNER_ID, PERFORMER_ID]);
    await proof.query(`
      insert into gig_sessions (
        id, performer_id, owner_actor_user_id, last_mutation_actor_user_id,
        status, title, runtime_session_state, started_at, last_activity_at, auto_closeout_at
      ) values ($3, $2, $1, $1, 'active', 'Durability Night', $4::jsonb, now(), now(), now() + interval '4 hours')
    `, [OWNER_ID, PERFORMER_ID, GIG_ID, JSON.stringify(activeSession())]);
    await proof.query(`
      insert into active_room_registry (
        gig_id, performer_id, owner_actor_user_id, talent_name, talent_role,
        route_path, registry_status, started_at
      ) values ($3::uuid, $2::uuid, $1::uuid, 'DJ Durability', 'DJ', '/g/' || $3::uuid::text, 'active', now())
    `, [OWNER_ID, PERFORMER_ID, GIG_ID]);

    // Caller-provided expiration may shorten, but never extend, the server's
    // five-minute financial uncertainty budget.
    const clampStartedAt = Date.now();
    const clamped = await reserveRequest({
      label: 'ttl-clamp',
      expiresAt: '2100-01-01T00:00:00.000Z'
    });
    const clampedDeadline = await proof.query<{ expires_at: Date; created_at: Date }>(`
      select expires_at, created_at from client_pending_actions where idempotency_key = $1
    `, [clamped.idempotencyKey]);
    assert.ok(new Date(clampedDeadline.rows[0].expires_at).getTime() <= clampStartedAt + FIVE_MINUTES_MS + 1_000);
    await proof.query(`update requests set status = 'denied' where id = $1`, [clamped.requestId]);
    await proof.query(`
      update client_pending_actions set status = 'reconciled' where idempotency_key = $1
    `, [clamped.idempotencyKey]);

    // Lost authorization response: remote intent exists, local call reports
    // processing, restart reclaims the exact operation and reuses one intent.
    const lostAuthorize = await reserveRequest({ label: 'lost-authorize' });
    fake.failOnce('authorize_after_commit');
    const firstAuthorization = await paymentService.authorizeAction(lostAuthorize.authorizationInput);
    assert.equal(firstAuthorization.status, 'processing');
    assert.equal(fake.calls.uniqueAuthorizations, 1);
    await proof.query(`
      update live_room_payment_operations
      set available_at = now(), lease_owner = null, lease_expires_at = null,
          status = 'retryable_failed'
      where idempotency_key = $1
    `, [`authorize:${lostAuthorize.idempotencyKey}`]);
    const restartedPaymentService = createPaymentService({ databaseUrl: proof.databaseUrl, provider: fake.provider });
    const recovered = await restartedPaymentService.runDueOperations({ limit: 10 });
    assert.equal(recovered.claimed, 1);
    assert.equal(fake.calls.uniqueAuthorizations, 1, 'Restart must not create a second logical PaymentIntent.');
    const recoveredPayment = await proof.query<{ id: string; payment_status: string; processor_payment_intent_id: string }>(`
      select id, payment_status, processor_payment_intent_id
      from payments where idempotency_key = $1
    `, [lostAuthorize.idempotencyKey]);
    assert.equal(recoveredPayment.rows[0].payment_status, 'authorized');

    // Ten first callers race before any payment or provider result exists.
    // They must converge on one durable owner, payment, operation, and remote
    // authorization rather than merely replaying an already-settled row.
    const concurrentOwner = await reserveRequest({
      label: 'concurrent-first-owner',
      deviceHash: hash('concurrent-first-owner-device')
    });
    const authorizationsBeforeOwnerRace = fake.calls.uniqueAuthorizations;
    let releaseOwnerAuthorization!: () => void;
    let ownerReachedProvider!: () => void;
    const ownerProviderReached = new Promise<void>((resolve) => { ownerReachedProvider = resolve; });
    const ownerProviderRelease = new Promise<void>((resolve) => { releaseOwnerAuthorization = resolve; });
    fake.setAuthorizeInterceptor(async () => {
      ownerReachedProvider();
      await ownerProviderRelease;
    });
    const ownerResultPromise = restartedPaymentService.authorizeAction(concurrentOwner.authorizationInput);
    await ownerProviderReached;
    const inFlightDuplicates = await Promise.all(
      Array.from({ length: 9 }, () => restartedPaymentService.authorizeAction(concurrentOwner.authorizationInput))
    );
    assert.ok(inFlightDuplicates.every((result) => result.status === 'processing'));
    fake.clearAuthorizeInterceptor();
    releaseOwnerAuthorization();
    const duplicateResults = [await ownerResultPromise, ...inFlightDuplicates];
    assert.ok(duplicateResults.every((result) => ['authorized', 'processing'].includes(result.status)));
    await restartedPaymentService.runDueOperations({ limit: 10 });
    const duplicateCounts = await proof.query<{ payments: string; operations: string }>(`
      select
        (select count(*) from payments where idempotency_key = $1)::text as payments,
        (select count(*) from live_room_payment_operations where idempotency_key = $2)::text as operations
    `, [concurrentOwner.idempotencyKey, `authorize:${concurrentOwner.idempotencyKey}`]);
    assert.equal(Number(duplicateCounts.rows[0].payments), 1);
    assert.equal(Number(duplicateCounts.rows[0].operations), 1);
    assert.equal(fake.calls.uniqueAuthorizations - authorizationsBeforeOwnerRace, 1);
    const concurrentOwnerPayment = await proof.query<{ payment_status: string }>(`
      select payment_status from payments where idempotency_key = $1
    `, [concurrentOwner.idempotencyKey]);
    assert.equal(concurrentOwnerPayment.rows[0].payment_status, 'authorized');

    // Visibility can commit before the HTTP response. Even after the browser
    // deadline, that visible truth must remain recoverable and must not be
    // reversed as an orphan.
    const visibleRecovery = await restartedPaymentService.reconcileActionVisibility({ limit: 25 });
    assert.equal(visibleRecovery.requestsActivated, 2);
    await proof.query(`
      update client_pending_actions
      set expires_at = now() - interval '1 minute', created_at = now() - interval '10 minutes'
      where idempotency_key = $1
    `, [lostAuthorize.idempotencyKey]);
    const visiblePendingTruth = await idempotencyStore.reconcilePendingAction({
      clientRequestId: lostAuthorize.clientRequestId,
      idempotencyKey: lostAuthorize.idempotencyKey
    });
    assert.notEqual(visiblePendingTruth.status, 'expired');

    await proof.query(`
      update requests
      set status = 'approved', runtime_request_state = jsonb_set(runtime_request_state, '{status}', '"approved"'::jsonb)
      where id = $1
    `, [lostAuthorize.requestId]);
    fake.failOnce('capture_after_commit');
    const captured = await restartedPaymentService.captureAuthorization(recoveredPayment.rows[0].id);
    assert.equal(captured.status, 'captured');
    assert.equal(fake.calls.capture, 1);

    // A nonterminal refund cannot release the liability. The retry uses the
    // same reverse operation and requires transfer/application-fee reversal.
    fake.failOnce('refund_pending_once');
    const pendingRefund = await restartedPaymentService.voidOrRefund(recoveredPayment.rows[0].id);
    assert.equal(pendingRefund.status, 'pending');
    await proof.query(`
      update live_room_payment_operations
      set available_at = now(), status = 'retryable_failed', lease_owner = null, lease_expires_at = null
      where payment_id = $1 and operation_type = 'reverse'
    `, [recoveredPayment.rows[0].id]);
    await restartedPaymentService.runDueOperations({ limit: 10 });
    const refunded = await proof.query<{ payment_status: string; refund_status: string }>(`
      select payment_status, refund_status from payments where id = $1
    `, [recoveredPayment.rows[0].id]);
    assert.equal(refunded.rows[0].payment_status, 'refunded');
    assert.equal(refunded.rows[0].refund_status, 'refunded');
    assert.equal(fake.calls.lastRefundInput?.reverseTransfer, true);
    assert.equal(fake.calls.lastRefundInput?.refundApplicationFee, true);

    // Crash between invisible business reservation and payment reservation:
    // the worker fences and terminalizes the orphan without ever contacting
    // the provider.
    const orphan = await reserveRequest({ label: 'no-payment-orphan', deviceHash: hash('orphan-device') });
    const uniqueBeforeOrphanExpiry = fake.calls.uniqueAuthorizations;
    await proof.query(`
      update client_pending_actions
      set expires_at = now() - interval '1 second', created_at = now() - interval '10 minutes'
      where idempotency_key = $1
    `, [orphan.idempotencyKey]);
    await restartedPaymentService.reconcileActionVisibility({ limit: 50 });
    const orphanTruth = await proof.query<{ status: string; activated_at: Date | null; first_response_status: number }>(`
      select r.status, r.activated_at, i.first_response_status
      from requests r join idempotency_keys i on i.idempotency_key = r.idempotency_key
      where r.id = $1
    `, [orphan.requestId]);
    assert.equal(orphanTruth.rows[0].status, 'denied');
    assert.equal(orphanTruth.rows[0].activated_at, null);
    assert.equal(orphanTruth.rows[0].first_response_status, 410);
    assert.equal(fake.calls.uniqueAuthorizations, uniqueBeforeOrphanExpiry);

    // If provider authorization exists when the deadline passes, denial is
    // durable first and the hold is then terminally voided.
    const expiredAuthorization = await reserveRequest({ label: 'expired-authorization', deviceHash: hash('expired-auth-device') });
    const expiredAuthorizationResult = await restartedPaymentService.authorizeAction(expiredAuthorization.authorizationInput);
    assert.equal(expiredAuthorizationResult.status, 'authorized');
    await proof.query(`
      update client_pending_actions
      set expires_at = now() - interval '1 second', created_at = now() - interval '10 minutes'
      where idempotency_key = $1
    `, [expiredAuthorization.idempotencyKey]);
    await restartedPaymentService.reconcileActionVisibility({ limit: 50 });
    const expiredAuthorizationTruth = await proof.query<{
      request_status: string;
      activated_at: Date | null;
      payment_status: string;
      response_status: number;
    }>(`
      select r.status as request_status, r.activated_at, p.payment_status,
             i.first_response_status as response_status
      from requests r
      join payments p on p.request_id = r.id
      join idempotency_keys i on i.idempotency_key = r.idempotency_key
      where r.id = $1
    `, [expiredAuthorization.requestId]);
    assert.equal(expiredAuthorizationTruth.rows[0].request_status, 'denied');
    assert.equal(expiredAuthorizationTruth.rows[0].activated_at, null);
    assert.equal(expiredAuthorizationTruth.rows[0].payment_status, 'voided');
    assert.equal(expiredAuthorizationTruth.rows[0].response_status, 410);

    // Capture can commit at the processor while the browser ownership lease
    // expires. The same reconciliation pass must notice that newly crossed
    // deadline after recovering processor truth, fence the invisible action,
    // fully refund the destination charge, and publish only the canonical 410.
    const expiryDuringCapture = await reserveRequest({
      label: 'expiry-during-capture',
      deviceHash: hash('expiry-during-capture-device'),
      runtimeStatus: 'approved'
    });
    const expiringCaptureAuthorization = await restartedPaymentService.authorizeAction(
      expiryDuringCapture.authorizationInput
    );
    assert.equal(expiringCaptureAuthorization.status, 'authorized');
    let releaseCaptureTruth!: () => void;
    let captureTruthReached!: () => void;
    const captureTruthBarrier = new Promise<void>((resolve) => { captureTruthReached = resolve; });
    const captureTruthRelease = new Promise<void>((resolve) => { releaseCaptureTruth = resolve; });
    fake.setRetrieveInterceptor(async (intent) => {
      captureTruthReached();
      await captureTruthRelease;
      return fake.snapshot(intent.processorPaymentIntentId);
    });
    const expiryDuringCapturePass = restartedPaymentService.reconcileActionVisibility({ limit: 50 });
    await captureTruthBarrier;
    await proof.query(`
      update client_pending_actions
      set expires_at = now() - interval '1 second', created_at = now() - interval '10 minutes'
      where idempotency_key = $1
    `, [expiryDuringCapture.idempotencyKey]);
    fake.clearRetrieveInterceptor();
    releaseCaptureTruth();
    const expiryDuringCaptureResult = await expiryDuringCapturePass;
    assert.ok(expiryDuringCaptureResult.expiredPaymentsReversed >= 1);
    const expiryDuringCaptureTruth = await proof.query<{
      request_status: string;
      activated_at: Date | null;
      payment_status: string;
      refund_status: string | null;
      response_status: number;
    }>(`
      select r.status as request_status, r.activated_at, p.payment_status,
             p.refund_status, i.first_response_status as response_status
      from requests r
      join payments p on p.request_id = r.id
      join idempotency_keys i on i.idempotency_key = r.idempotency_key
      where r.id = $1
    `, [expiryDuringCapture.requestId]);
    assert.equal(expiryDuringCaptureTruth.rows[0].request_status, 'denied');
    assert.equal(expiryDuringCaptureTruth.rows[0].activated_at, null);
    assert.equal(expiryDuringCaptureTruth.rows[0].payment_status, 'refunded');
    assert.equal(expiryDuringCaptureTruth.rows[0].refund_status, 'refunded');
    assert.equal(expiryDuringCaptureTruth.rows[0].response_status, 410);

    // Independent patrons can authorize simultaneously without one room
    // snapshot overwriting another.
    const concurrentActions = await Promise.all([
      reserveRequest({ label: 'concurrent-a', deviceHash: hash('device-a') }),
      reserveRequest({ label: 'concurrent-b', deviceHash: hash('device-b') }),
      reserveRequest({ label: 'concurrent-c', deviceHash: hash('device-c') })
    ]);
    const concurrentResults = await Promise.all(
      concurrentActions.map((action) => restartedPaymentService.authorizeAction(action.authorizationInput))
    );
    assert.ok(concurrentResults.every((result) => result.status === 'authorized'));
    const concurrentCount = await proof.query<{ count: string }>(`
      select count(*)::text as count from payments
      where idempotency_key = any($1::text[])
    `, [concurrentActions.map((action) => action.idempotencyKey)]);
    assert.equal(Number(concurrentCount.rows[0].count), 3);

    const webhookB = createPaymentWebhookService({ databaseUrl: proof.databaseUrl, provider: fake.provider });

    // A signed capture event may arrive before the lost authorization response
    // is recovered locally. It must remain retryable, then converge after the
    // predecessor operation, and duplicate delivery must not create a second
    // inbox row or payment transition.
    const earlyCaptureAction = await reserveRequest({
      label: 'early-capture-webhook',
      deviceHash: hash('early-capture-webhook-device')
    });
    const existingIntentIds = new Set(fake.intentsById.keys());
    fake.failOnce('authorize_after_commit');
    const earlyCaptureAuthorization = await restartedPaymentService.authorizeAction(
      earlyCaptureAction.authorizationInput
    );
    if (earlyCaptureAuthorization.status !== 'processing') {
      throw new Error(`Expected a lost authorization response, received ${earlyCaptureAuthorization.status}.`);
    }
    const earlyCaptureIntentId = [...fake.intentsById.keys()].find((id) => !existingIntentIds.has(id));
    assert.ok(earlyCaptureIntentId);
    const earlyCaptureIntent = fake.snapshot(earlyCaptureIntentId);
    const earlyCaptureEvent = {
      providerEventId: `evt_early_capture_${randomUUID()}`,
      providerType: 'payment_intent.succeeded',
      livemode: false,
      processorPaymentIntentId: earlyCaptureIntent.processorPaymentIntentId,
      processorChargeId: `ch_${earlyCaptureIntent.processorPaymentIntentId}`,
      providerStatus: 'succeeded',
      amountCents: earlyCaptureIntent.amountCents,
      metadata: {
        ...(earlyCaptureIntent.metadata ?? {}),
        sway_payment_id: earlyCaptureAuthorization.paymentId
      }
    };
    const rawEarlyCaptureEvent = JSON.stringify(earlyCaptureEvent);
    const earlyCaptureResult = await webhookB.ingestWebhook({
      rawBody: rawEarlyCaptureEvent,
      signatureHeader: 'deterministic-test-signature'
    });
    assert.equal(earlyCaptureResult.status, 'accepted_pending');
    const earlyInboxPending = await proof.query<{ status: string }>(`
      select status from live_room_processor_events where processor_event_id = $1
    `, [earlyCaptureEvent.providerEventId]);
    assert.equal(earlyInboxPending.rows[0].status, 'retryable_failed');

    await proof.query(`
      update live_room_payment_operations
      set available_at = now(), status = 'retryable_failed', lease_owner = null, lease_expires_at = null
      where payment_id = $1 and operation_type = 'authorize'
    `, [earlyCaptureAuthorization.paymentId]);
    await restartedPaymentService.runDueOperations({ limit: 25 });
    await proof.query(`
      update live_room_processor_events set next_attempt_at = now()
      where processor_event_id = $1
    `, [earlyCaptureEvent.providerEventId]);
    const delayedCaptureResult = await webhookB.runDueEvents({ limit: 25 });
    assert.ok(delayedCaptureResult.processed >= 1);
    const earlyCaptureTruth = await proof.query<{
      payment_status: string;
      inbox_status: string;
      inbox_rows: string;
      transition_rows: string;
    }>(`
      select p.payment_status,
             e.status as inbox_status,
             (select count(*) from live_room_processor_events where processor_event_id = $2)::text as inbox_rows,
             (select count(*) from payment_events where processor_event_id = $2)::text as transition_rows
      from payments p
      join live_room_processor_events e on e.processor_event_id = $2
      where p.id = $1
    `, [earlyCaptureAuthorization.paymentId, earlyCaptureEvent.providerEventId]);
    assert.equal(earlyCaptureTruth.rows[0].payment_status, 'captured');
    assert.equal(earlyCaptureTruth.rows[0].inbox_status, 'processed');
    assert.equal(Number(earlyCaptureTruth.rows[0].inbox_rows), 1);
    assert.equal(Number(earlyCaptureTruth.rows[0].transition_rows), 1);
    const duplicateCaptureEvent = await webhookB.ingestWebhook({
      rawBody: rawEarlyCaptureEvent,
      signatureHeader: 'deterministic-test-signature'
    });
    assert.equal(duplicateCaptureEvent.status, 'duplicate');

    // A full-refund event can be the first financial webhook after local
    // authorization. Provider truth must pivot the reversal from void to
    // refund and converge terminally even without a preceding capture event.
    const earlyRefundAction = await reserveRequest({
      label: 'early-refund-webhook',
      deviceHash: hash('early-refund-webhook-device')
    });
    const earlyRefundAuthorization = await restartedPaymentService.authorizeAction(
      earlyRefundAction.authorizationInput
    );
    if (earlyRefundAuthorization.status !== 'authorized') {
      throw new Error(`Expected an authorized refund fixture, received ${earlyRefundAuthorization.status}.`);
    }
    fake.markFullyRefunded(earlyRefundAuthorization.processorPaymentIntentId);
    const earlyRefundIntent = fake.snapshot(earlyRefundAuthorization.processorPaymentIntentId);
    const earlyRefundEvent = {
      providerEventId: `evt_early_refund_${randomUUID()}`,
      providerType: 'charge.refunded',
      livemode: false,
      processorPaymentIntentId: earlyRefundIntent.processorPaymentIntentId,
      processorChargeId: earlyRefundIntent.processorChargeId,
      providerStatus: 'succeeded',
      amountCents: earlyRefundIntent.amountCents,
      amountRefundedCents: earlyRefundIntent.amountRefundedCents,
      fullyRefunded: true,
      metadata: {
        ...(earlyRefundIntent.metadata ?? {}),
        sway_payment_id: earlyRefundAuthorization.paymentId
      }
    };
    const rawEarlyRefundEvent = JSON.stringify(earlyRefundEvent);
    const earlyRefundResult = await webhookB.ingestWebhook({
      rawBody: rawEarlyRefundEvent,
      signatureHeader: 'deterministic-test-signature'
    });
    assert.equal(earlyRefundResult.status, 'processed');
    const earlyRefundTruth = await proof.query<{
      payment_status: string;
      refund_status: string;
      inbox_status: string;
      inbox_rows: string;
    }>(`
      select p.payment_status, p.refund_status, e.status as inbox_status,
             (select count(*) from live_room_processor_events where processor_event_id = $2)::text as inbox_rows
      from payments p
      join live_room_processor_events e on e.processor_event_id = $2
      where p.id = $1
    `, [earlyRefundAuthorization.paymentId, earlyRefundEvent.providerEventId]);
    assert.equal(earlyRefundTruth.rows[0].payment_status, 'refunded');
    assert.equal(earlyRefundTruth.rows[0].refund_status, 'refunded');
    assert.equal(earlyRefundTruth.rows[0].inbox_status, 'processed');
    assert.equal(Number(earlyRefundTruth.rows[0].inbox_rows), 1);
    const duplicateRefundEvent = await webhookB.ingestWebhook({
      rawBody: rawEarlyRefundEvent,
      signatureHeader: 'deterministic-test-signature'
    });
    assert.equal(duplicateRefundEvent.status, 'duplicate');

    // A distinct predecessor event first delivered after the payment has
    // reached a later terminal state is stale, not retryable. Persist it once
    // as ignored without regressing the payment or writing a transition.
    const staleAuthorizationEvent = {
      providerEventId: `evt_stale_authorization_${randomUUID()}`,
      providerType: 'payment_intent.amount_capturable_updated',
      livemode: false,
      processorPaymentIntentId: earlyRefundIntent.processorPaymentIntentId,
      processorChargeId: earlyRefundIntent.processorChargeId,
      providerStatus: 'requires_capture',
      amountCents: earlyRefundIntent.amountCents,
      metadata: {
        ...(earlyRefundIntent.metadata ?? {}),
        sway_payment_id: earlyRefundAuthorization.paymentId
      }
    };
    const rawStaleAuthorizationEvent = JSON.stringify(staleAuthorizationEvent);
    const staleAuthorizationResult = await webhookB.ingestWebhook({
      rawBody: rawStaleAuthorizationEvent,
      signatureHeader: 'deterministic-test-signature'
    });
    assert.equal(staleAuthorizationResult.status, 'ignored');
    assert.equal(staleAuthorizationResult.reason, 'stale_predecessor_event');
    const staleAuthorizationTruth = await proof.query<{
      payment_status: string;
      inbox_status: string;
      inbox_rows: string;
      transition_rows: string;
    }>(`
      select p.payment_status,
             e.status as inbox_status,
             (select count(*) from live_room_processor_events where processor_event_id = $2)::text as inbox_rows,
             (select count(*) from payment_events where processor_event_id = $2)::text as transition_rows
      from payments p
      join live_room_processor_events e on e.processor_event_id = $2
      where p.id = $1
    `, [earlyRefundAuthorization.paymentId, staleAuthorizationEvent.providerEventId]);
    assert.equal(staleAuthorizationTruth.rows[0].payment_status, 'refunded');
    assert.equal(staleAuthorizationTruth.rows[0].inbox_status, 'ignored');
    assert.equal(Number(staleAuthorizationTruth.rows[0].inbox_rows), 1);
    assert.equal(Number(staleAuthorizationTruth.rows[0].transition_rows), 0);
    const duplicateStaleAuthorizationEvent = await webhookB.ingestWebhook({
      rawBody: rawStaleAuthorizationEvent,
      signatureHeader: 'deterministic-test-signature'
    });
    assert.equal(duplicateStaleAuthorizationEvent.status, 'duplicate');

    // A stale webhook worker cannot overwrite the terminal outcome produced
    // by the worker that reclaimed its lease.
    let releaseStaleWorker!: (error: Error) => void;
    let staleWorkerClaimed!: () => void;
    const staleClaim = new Promise<void>((resolve) => { staleWorkerClaimed = resolve; });
    const staleBarrier = new Promise<void>((_resolve, reject) => { releaseStaleWorker = reject; });
    const webhookA = createPaymentWebhookService({
      databaseUrl: proof.databaseUrl,
      provider: fake.provider,
      hooks: {
        async afterClaim() {
          staleWorkerClaimed();
          await staleBarrier;
        }
      }
    });
    const unknownEvent = {
      providerEventId: `evt_unknown_${randomUUID()}`,
      providerType: 'customer.updated',
      livemode: false,
      metadata: {}
    };
    const rawUnknownEvent = JSON.stringify(unknownEvent);
    const staleAttempt = webhookA.ingestWebhook({
      rawBody: rawUnknownEvent,
      signatureHeader: 'deterministic-test-signature'
    });
    await staleClaim;
    await proof.query(`
      update live_room_processor_events
      set processing_started_at = now() - interval '31 seconds', next_attempt_at = now()
      where processor_event_id = $1
    `, [unknownEvent.providerEventId]);
    const newerWorker = await webhookB.runDueEvents({ limit: 1 });
    assert.equal(newerWorker.processed, 1);
    releaseStaleWorker(new Error('stale_worker_resumed_after_reclaim'));
    await staleAttempt;
    const webhookTruth = await proof.query<{ status: string; processing_lease_owner: string | null; count: string }>(`
      select status, processing_lease_owner,
             count(*) over ()::text as count
      from live_room_processor_events where processor_event_id = $1
    `, [unknownEvent.providerEventId]);
    assert.equal(webhookTruth.rows[0].status, 'ignored');
    assert.equal(webhookTruth.rows[0].processing_lease_owner, null);
    assert.equal(Number(webhookTruth.rows[0].count), 1);

    // The expand migration also protects a rolling old worker: a terminal
    // inbox outcome cannot regress even if an old process updates by ID only.
    await assert.rejects(
      proof.query(`
        update live_room_processor_events set status = 'retryable_failed'
        where processor_event_id = $1
      `, [unknownEvent.providerEventId]),
      /live_room_processor_terminal_state_is_immutable/
    );

    // Stripe test-mode rehearsals can exercise the complete payment lifecycle
    // before Connect is enabled. The durable row uses an explicit test-only
    // destination, while the provider receives no transfer destination and a
    // captured refund never attempts transfer/application-fee reversal.
    await proof.query(`
      update performers
      set payment_account_status = 'not_started', kyc_status = 'not_required',
          payouts_enabled = false, charges_enabled = false,
          stripe_connected_account_id = null
      where id = $1
    `, [PERFORMER_ID]);
    const platformTestService = createPaymentService({
      databaseUrl: proof.databaseUrl,
      provider: fake.provider,
      testPlatformBalancePerformerIds: new Set([PERFORMER_ID])
    });
    const platformRequest = await reserveRequest({
      label: 'platform-test-balance',
      deviceHash: hash('platform-test-balance-device')
    });
    const platformAuthorization = await platformTestService.authorizeAction(platformRequest.authorizationInput);
    assert.ok(['authorized', 'processing'].includes(platformAuthorization.status));
    if (platformAuthorization.status === 'processing') {
      await platformTestService.runDueOperations({ limit: 10 });
    }
    const platformPayment = await proof.query<{
      id: string;
      destination_account_id: string;
      payment_status: string;
      operation_status: string;
      last_error: string | null;
    }>(`
      select p.id, p.destination_account_id, p.payment_status,
             o.status as operation_status, o.last_error
      from payments p
      join live_room_payment_operations o on o.payment_id = p.id and o.operation_type = 'authorize'
      where p.idempotency_key = $1
    `, [platformRequest.idempotencyKey]);
    assert.equal(
      platformPayment.rows[0].payment_status,
      'authorized',
      `Platform test authorization failed: ${JSON.stringify(platformPayment.rows[0])}`
    );
    assert.equal(platformPayment.rows[0].destination_account_id, SWAY_TEST_PLATFORM_BALANCE_DESTINATION);
    assert.equal(fake.calls.lastAuthorizeInput?.destinationAccountId, undefined);
    assert.equal(fake.calls.lastAuthorizeInput?.applicationFeeAmountCents, undefined);
    assert.equal(fake.calls.lastAuthorizeInput?.metadata?.sway_settlement_mode, 'platform_test_balance');
    assert.equal(typeof fake.calls.lastAuthorizeInput?.metadata?.sway_fee_charged_to_patron_cents, 'string');
    assert.deepEqual(
      Object.keys(fake.calls.lastAuthorizeInput?.metadata ?? {}).filter((key) => key.length > 40),
      [],
      'Every Stripe metadata key must stay within Stripe\'s 40-character limit.'
    );
    await proof.query(`
      update requests
      set status = 'approved', runtime_request_state = jsonb_set(runtime_request_state, '{status}', '"approved"'::jsonb)
      where id = $1
    `, [platformRequest.requestId]);
    const disabledPilotDrainService = createPaymentService({
      databaseUrl: proof.databaseUrl,
      provider: fake.provider,
      testPlatformBalancePerformerIds: new Set()
    });
    const platformCapture = await disabledPilotDrainService.captureAuthorization(platformPayment.rows[0].id);
    assert.equal(platformCapture.status, 'captured');
    const platformRefund = await disabledPilotDrainService.voidOrRefund(platformPayment.rows[0].id);
    assert.equal(platformRefund.status, 'refunded');
    assert.equal(fake.calls.lastRefundInput?.reverseTransfer, false);
    assert.equal(fake.calls.lastRefundInput?.refundApplicationFee, false);

    // Two closeout workers race through the real business store. Exactly one
    // establishes the admission barrier; the other observes it.
    const closeoutResults = await Promise.all([
      businessStore.beginRoomCloseout(GIG_ID),
      businessStore.beginRoomCloseout(GIG_ID)
    ]);
    assert.deepEqual(
      closeoutResults.map((result) => result.status).sort(),
      ['already_pending', 'started']
    );
    const closeoutTruth = await proof.query<{ status: string; requests_open: string }>(`
      select status, runtime_session_state->>'requestsOpen' as requests_open
      from gig_sessions where id = $1
    `, [GIG_ID]);
    assert.equal(closeoutTruth.rows[0].status, 'closeout_pending');
    assert.equal(closeoutTruth.rows[0].requests_open, 'false');

    console.log(proof.kind === 'real-postgres'
      ? 'Sway live-room real PostgreSQL crash/concurrency proof passed.'
      : 'Sway live-room embedded deterministic crash/recovery proof passed; real PostgreSQL concurrency is not claimed.');
  } finally {
    await proof.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
