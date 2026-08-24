import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createBusinessStore } from '../src/server/business-store';
import { createIdempotencyStore } from '../src/server/idempotency-store';
import { createPaymentService, type AuthorizeActionInput } from '../src/server/payment-service';
import { createPaymentWebhookService } from '../src/server/payment-webhook';
import { createDeterministicPaymentProvider } from './lib/deterministic-payment-provider';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';
import { SWAY_TEST_PLATFORM_BALANCE_DESTINATION } from '../src/server/live-room-seller-readiness';
import { issuePatronStatusReceipt } from '../src/server/patron-status-receipt';

const OWNER_ID = '10000000-0000-4000-8000-000000000001';
const PERFORMER_ID = '10000000-0000-4000-8000-000000000002';
const GIG_ID = '10000000-0000-4000-8000-000000000003';
const ADMIN_ID = '10000000-0000-4000-8000-000000000004';
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
    settlementMode: 'connected_account',
    paymentEnvironment: 'test',
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
  const paymentService = createPaymentService({
    databaseUrl: proof.databaseUrl,
    provider: fake.provider,
    moneyExecutionEnabled: true,
    moneyEnvironment: 'test'
  });
  const businessStore = createBusinessStore(proof.databaseUrl, activeSession as never);

  async function recordLiveMoneyCapabilityDecision(
    decision: 'granted' | 'revoked',
    label: string
  ) {
    await proof.query(`
      insert into performer_capability_grant_events (
        performer_id, capability, decision, actor_type, actor_user_id,
        reason, evidence, idempotency_key_hash
      ) values (
        $1, 'live_money', $2, 'admin', $3,
        $4, $5::jsonb, $6
      )
    `, [
      PERFORMER_ID,
      decision,
      ADMIN_ID,
      `Disposable ${label} live-money ${decision} proof`,
      JSON.stringify({ source: 'sway-live-room-crash-concurrency', label }),
      hash(`live-money-capability:${label}:${decision}`)
    ]);
  }

  async function recordMoneyAuthorityDecision(input: {
    authorityKind: 'seller' | 'payout_controller';
    subjectType: 'seller' | 'payout_account';
    subjectId: string;
    decision: 'granted' | 'revoked';
    label: string;
  }) {
    await proof.query(`
      insert into performer_authority_events (
        performer_id, authority_kind, subject_type, subject_id, decision,
        actor_type, actor_user_id, reason, evidence, idempotency_key_hash
      ) values (
        $1, $2, $3, $4, $5, 'admin', $6,
        $7, $8::jsonb, $9
      )
    `, [
      PERFORMER_ID,
      input.authorityKind,
      input.subjectType,
      input.subjectId,
      input.decision,
      ADMIN_ID,
      `Disposable ${input.label} ${input.decision} proof`,
      JSON.stringify({
        source: 'sway-live-room-crash-concurrency',
        reference: `durability:${input.label}:${input.decision}`
      }),
      hash(`money-authority:${input.label}:${input.decision}`)
    ]);
  }

  async function recordTestMoneyReleaseDecision(
    decision: 'enabled' | 'disabled',
    label: string
  ) {
    await proof.query(`
      insert into live_room_money_release_events (
        environment, decision, actor_user_id, reason, evidence, idempotency_key_hash
      ) values (
        'test', $1, $2, $3, $4::jsonb, $5
      )
    `, [
      decision,
      ADMIN_ID,
      `Disposable ${label} test-money release ${decision} proof`,
      JSON.stringify({ source: 'sway-live-room-crash-concurrency', label }),
      hash(`test-money-release:${label}:${decision}`)
    ]);
  }

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
        money_required, runtime_request_state, activated_at
      ) values ($1, $2, $3, $4, $5, 'payment_pending', 'song', $6, 'USD', true, $7::jsonb, null)
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
      values
        ($1, 'durability-owner@example.test', 'Durability Owner', now(), now(), 'active'),
        ($2, 'durability-admin@example.test', 'Durability Admin', now(), now(), 'disabled')
    `, [OWNER_ID, ADMIN_ID]);
    await proof.query(`update users set role = 'admin' where id = $1`, [ADMIN_ID]);
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
      insert into performer_capability_grant_events (
        performer_id, capability, decision, actor_type, actor_user_id,
        reason, evidence, idempotency_key_hash
      ) values (
        $1, 'live_money', 'granted', 'admin', $2,
        'Disposable Wave 4 payment authority proof',
        '{"source":"sway-live-room-crash-concurrency"}'::jsonb, $3
      )
    `, [PERFORMER_ID, ADMIN_ID, hash('durability-live-money-capability')]);
    await proof.query(`
      insert into performer_authority_events (
        performer_id, authority_kind, subject_type, subject_id, decision,
        actor_type, actor_user_id, reason, evidence, idempotency_key_hash
      ) values
        ($1, 'seller', 'seller', $2, 'granted', 'admin', $3,
         'Disposable exact seller authority proof',
         '{"source":"sway-live-room-crash-concurrency","reference":"durability-seller-authority"}'::jsonb, $4),
        ($1, 'payout_controller', 'payout_account', 'acct_test_durability', 'granted', 'admin', $3,
         'Disposable connected payout authority proof',
         '{"source":"sway-live-room-crash-concurrency","reference":"durability-connected-payout-authority"}'::jsonb, $5),
        ($1, 'payout_controller', 'payout_account', $6, 'granted', 'admin', $3,
         'Disposable platform rehearsal payout authority proof',
         '{"source":"sway-live-room-crash-concurrency","reference":"durability-platform-payout-authority"}'::jsonb, $7)
    `, [
      PERFORMER_ID,
      `seller:${PERFORMER_ID}`,
      ADMIN_ID,
      hash('durability-seller-authority'),
      hash('durability-connected-payout-authority'),
      SWAY_TEST_PLATFORM_BALANCE_DESTINATION,
      hash('durability-platform-payout-authority')
    ]);
    await proof.query(`
      insert into live_room_money_release_events (
        environment, decision, actor_user_id, reason, evidence, idempotency_key_hash
      ) values (
        'test', 'enabled', $1,
        'Disposable Wave 4 test-money release proof',
        '{"source":"sway-live-room-crash-concurrency"}'::jsonb, $2
      )
    `, [ADMIN_ID, hash('durability-test-money-release')]);
    await proof.query(`
      insert into gig_sessions (
        id, performer_id, owner_actor_user_id, last_mutation_actor_user_id,
        status, room_type, money_enabled, money_destination_account_id,
        money_environment, title, runtime_session_state, started_at,
        last_activity_at, auto_closeout_at
      ) values (
        $3, $2, $1, $1, 'active', 'music', true, 'acct_test_durability',
        'test', 'Durability Night', $4::jsonb, now(), now(), now() + interval '4 hours'
      )
    `, [OWNER_ID, PERFORMER_ID, GIG_ID, JSON.stringify(activeSession())]);
    await proof.query(`
      insert into active_room_registry (
        gig_id, performer_id, owner_actor_user_id, talent_name, talent_role,
        route_path, registry_status, started_at
      ) values ($3::uuid, $2::uuid, $1::uuid, 'DJ Durability', 'DJ', '/g/' || $3::uuid::text, 'active', now())
    `, [OWNER_ID, PERFORMER_ID, GIG_ID]);

    // Shared provider-admission locks coexist, but the exclusive release lock
    // cannot pass either one. This avoids globally serializing unrelated rooms
    // while preserving an exact release-revocation boundary.
    // PGlite's advisory-lock facade does not model PostgreSQL shared-lock
    // concurrency, so only the separately attested standalone server can make
    // this claim.
    if (proof.kind === 'real-postgres') {
      const sharedA = new Client({ connectionString: proof.databaseUrl });
      const sharedB = new Client({ connectionString: proof.databaseUrl });
      const exclusive = new Client({ connectionString: proof.databaseUrl });
      await Promise.all([sharedA.connect(), sharedB.connect(), exclusive.connect()]);
      try {
      await Promise.all([sharedA.query('begin'), sharedB.query('begin'), exclusive.query('begin')]);
      await sharedA.query(`select sway_live_money_release_admission_lock('test')`);
      let secondSharedTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sharedB.query(`select sway_live_money_release_admission_lock('test')`),
          new Promise((_, reject) => {
            secondSharedTimer = setTimeout(
              () => reject(new Error('second shared admission lock was serialized')),
              1_000
            );
          })
        ]);
      } finally {
        if (secondSharedTimer) clearTimeout(secondSharedTimer);
      }
      let exclusiveSettled = false;
      const exclusivePromise = exclusive.query(`select sway_live_money_release_lock('test')`)
        .finally(() => { exclusiveSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(exclusiveSettled, false, 'Release mutation must wait for every admitted provider boundary.');
      await sharedA.query('rollback');
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(exclusiveSettled, false, 'One remaining provider boundary must continue to fence release mutation.');
      await sharedB.query('rollback');
      await exclusivePromise;
      await exclusive.query('rollback');
      } finally {
        await Promise.allSettled([
          sharedA.query('rollback'),
          sharedB.query('rollback'),
          exclusive.query('rollback')
        ]);
        await Promise.all([sharedA.end(), sharedB.end(), exclusive.end()]);
      }
    }

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
    const restartedPaymentService = createPaymentService({
      databaseUrl: proof.databaseUrl,
      provider: fake.provider,
      moneyExecutionEnabled: true,
      moneyEnvironment: 'test'
    });
    const recovered = await restartedPaymentService.runDueOperations({ limit: 10 });
    assert.equal(recovered.claimed, 1);
    assert.equal(fake.calls.uniqueAuthorizations, 1, 'Restart must not create a second logical PaymentIntent.');
    const recoveredPayment = await proof.query<{ id: string; payment_status: string; processor_payment_intent_id: string }>(`
      select id, payment_status, processor_payment_intent_id
      from payments where idempotency_key = $1
    `, [lostAuthorize.idempotencyKey]);
    assert.equal(recoveredPayment.rows[0].payment_status, 'authorized');

    // A previous rolling binary cannot lease positive money work because it
    // cannot supply the database-enforced executor generation. Financial
    // identity and the canonical provider payload are immutable once bound.
    await assert.rejects(
      proof.query(`
        update live_room_payment_operations
        set status = 'leased', lease_owner = 'legacy-worker',
            lease_expires_at = now() + interval '30 seconds',
            lease_executor_generation = null, completed_at = null
        where payment_id = $1 and operation_type = 'authorize'
      `, [recoveredPayment.rows[0].id]),
      /current executor generation/i
    );
    await assert.rejects(
      proof.query(`
        update payments set destination_account_id = 'acct_mutated_destination'
        where id = $1
      `, [recoveredPayment.rows[0].id]),
      /financial identity is immutable/i
    );
    await assert.rejects(
      proof.query(`
        update live_room_payment_operations
        set request_payload = request_payload || '{"intentFingerprint":"mutated"}'::jsonb
        where payment_id = $1 and operation_type = 'authorize'
      `, [recoveredPayment.rows[0].id]),
      /operation identity is immutable/i
    );

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
    const inFlightDuplicatePromises = Array.from(
      { length: 9 },
      () => restartedPaymentService.authorizeAction(concurrentOwner.authorizationInput)
    );
    // The current-admission transaction deliberately keeps the payment and
    // operation locks through the provider boundary. Let every duplicate
    // contend, then release the single owner before awaiting the contenders.
    await new Promise((resolve) => setTimeout(resolve, 25));
    fake.clearAuthorizeInterceptor();
    releaseOwnerAuthorization();
    const inFlightDuplicates = await Promise.all(inFlightDuplicatePromises);
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

    // The live finalization request owns visibility while it is in flight.
    // The worker must wait, then reclaim after a simulated crash, and the
    // stale HTTP owner must be fenced from committing or reversing the hold.
    const ownerFenceAction = await reserveRequest({
      label: 'http-worker-owner-fence',
      deviceHash: hash('http-worker-owner-fence-device')
    });
    const ownerFenceAuthorization = await restartedPaymentService.authorizeAction(
      ownerFenceAction.authorizationInput
    );
    assert.equal(ownerFenceAuthorization.status, 'authorized');
    const liveOwnership = await idempotencyStore.claimPendingActionOwner({
      clientRequestId: ownerFenceAction.clientRequestId,
      idempotencyKey: ownerFenceAction.idempotencyKey
    });
    assert.equal(liveOwnership.status, 'acquired');
    if (liveOwnership.status !== 'acquired') throw new Error('owner_fence_fixture_not_acquired');
    const blockedRecovery = await restartedPaymentService.reconcileActionVisibility({ limit: 25 });
    assert.equal(blockedRecovery.requestsActivated, 2, 'Only the two older recoverable fixtures may activate.');
    const blockedTruth = await proof.query<{ activated_at: Date | null; payment_status: string }>(`
      select r.activated_at, p.payment_status
      from requests r join payments p on p.request_id = r.id
      where r.id = $1
    `, [ownerFenceAction.requestId]);
    assert.equal(blockedTruth.rows[0].activated_at, null);
    assert.equal(blockedTruth.rows[0].payment_status, 'authorized');

    await proof.query(`
      update client_pending_actions
      set owner_lease_expires_at = now() - interval '1 second'
      where idempotency_key = $1
    `, [ownerFenceAction.idempotencyKey]);
    const recoveredVisibility = await restartedPaymentService.reconcileActionVisibility({ limit: 25 });
    assert.equal(recoveredVisibility.requestsActivated, 1);
    const recoveredTruth = await proof.query<{ activated_at: Date | null; payment_status: string }>(`
      select r.activated_at, p.payment_status
      from requests r join payments p on p.request_id = r.id
      where r.id = $1
    `, [ownerFenceAction.requestId]);
    assert.ok(recoveredTruth.rows[0].activated_at);
    assert.equal(recoveredTruth.rows[0].payment_status, 'authorized');

    const staleRuntime = {
      ...ownerFenceAction.runtimeState,
      durableRequestId: ownerFenceAction.requestId,
      paymentId: ownerFenceAuthorization.paymentId,
      paymentIntentId: ownerFenceAuthorization.processorPaymentIntentId,
      paymentStatus: 'authorized'
    };
    await assert.rejects(
      businessStore.activateRequestAction(GIG_ID, staleRuntime as never, liveOwnership.owner),
      /pending_action_owner_fenced/
    );

    // A token whose generation still matches is nevertheless stale once its
    // lease deadline passes; it cannot activate before another owner reclaims.
    const leaseDeadlineAction = await reserveRequest({
      label: 'expired-owner-token',
      deviceHash: hash('expired-owner-token-device')
    });
    const leaseDeadlineAuthorization = await restartedPaymentService.authorizeAction(
      leaseDeadlineAction.authorizationInput
    );
    assert.equal(leaseDeadlineAuthorization.status, 'authorized');
    const leaseDeadlineOwner = await idempotencyStore.claimPendingActionOwner({
      clientRequestId: leaseDeadlineAction.clientRequestId,
      idempotencyKey: leaseDeadlineAction.idempotencyKey
    });
    assert.equal(leaseDeadlineOwner.status, 'acquired');
    if (leaseDeadlineOwner.status !== 'acquired') throw new Error('expired_owner_fixture_not_acquired');
    await proof.query(`
      update client_pending_actions
      set owner_lease_expires_at = now() - interval '1 second'
      where idempotency_key = $1
    `, [leaseDeadlineAction.idempotencyKey]);
    const expiredOwnerRuntime = {
      ...leaseDeadlineAction.runtimeState,
      durableRequestId: leaseDeadlineAction.requestId,
      paymentId: leaseDeadlineAuthorization.paymentId,
      paymentIntentId: leaseDeadlineAuthorization.processorPaymentIntentId,
      paymentStatus: 'authorized'
    };
    await assert.rejects(
      businessStore.activateRequestAction(GIG_ID, expiredOwnerRuntime as never, leaseDeadlineOwner.owner),
      /pending_action_owner_fenced/
    );
    const expiredOwnerRecovery = await restartedPaymentService.reconcileActionVisibility({ limit: 25 });
    assert.equal(expiredOwnerRecovery.requestsActivated, 1);

    // Success receipt completion is fenced independently from visibility.
    // An expired owner cannot publish the canonical success even when the
    // business row is already visible.
    const expiredCompletionAction = await reserveRequest({
      label: 'expired-success-completion',
      deviceHash: hash('expired-success-completion-device')
    });
    const expiredCompletionAuthorization = await restartedPaymentService.authorizeAction(
      expiredCompletionAction.authorizationInput
    );
    assert.equal(expiredCompletionAuthorization.status, 'authorized');
    const expiredCompletionOwner = await idempotencyStore.claimPendingActionOwner({
      clientRequestId: expiredCompletionAction.clientRequestId,
      idempotencyKey: expiredCompletionAction.idempotencyKey
    });
    assert.equal(expiredCompletionOwner.status, 'acquired');
    if (expiredCompletionOwner.status !== 'acquired') throw new Error('expired_completion_fixture_not_acquired');
    const expiredCompletionRuntime = {
      ...expiredCompletionAction.runtimeState,
      durableRequestId: expiredCompletionAction.requestId,
      paymentId: expiredCompletionAuthorization.paymentId,
      paymentIntentId: expiredCompletionAuthorization.processorPaymentIntentId,
      paymentStatus: 'authorized'
    };
    await businessStore.activateRequestAction(
      GIG_ID,
      expiredCompletionRuntime as never,
      expiredCompletionOwner.owner
    );
    await proof.query(`
      update client_pending_actions
      set owner_lease_expires_at = now() - interval '1 second'
      where idempotency_key = $1
    `, [expiredCompletionAction.idempotencyKey]);
    const expiredCompletionReceipt = issuePatronStatusReceipt();
    await assert.rejects(
      idempotencyStore.completePendingAction({
        clientRequestId: expiredCompletionAction.clientRequestId,
        idempotencyKey: expiredCompletionAction.idempotencyKey,
        gigId: GIG_ID,
        actionType: 'request',
        receiptHash: expiredCompletionReceipt.receiptHash,
        status: 200,
        body: {
          success: true,
          patron_status_receipt: expiredCompletionReceipt.receipt
        },
        owner: expiredCompletionOwner.owner
      }),
      /pending_action_owner_fenced/
    );

    // Failure fencing happens before a potentially slow provider reversal.
    // Once fenced, no recovery worker can make the action visible even if the
    // owner lease expires while the provider is still responding.
    const reversalFenceAction = await reserveRequest({
      label: 'reversal-before-provider',
      deviceHash: hash('reversal-before-provider-device')
    });
    const reversalFenceAuthorization = await restartedPaymentService.authorizeAction(
      reversalFenceAction.authorizationInput
    );
    assert.equal(reversalFenceAuthorization.status, 'authorized');
    const reversalFenceOwner = await idempotencyStore.claimPendingActionOwner({
      clientRequestId: reversalFenceAction.clientRequestId,
      idempotencyKey: reversalFenceAction.idempotencyKey
    });
    assert.equal(reversalFenceOwner.status, 'acquired');
    if (reversalFenceOwner.status !== 'acquired') throw new Error('reversal_fence_fixture_not_acquired');
    const reversalFence = await idempotencyStore.fencePendingActionFailure({
      clientRequestId: reversalFenceAction.clientRequestId,
      idempotencyKey: reversalFenceAction.idempotencyKey,
      gigId: GIG_ID,
      actionType: 'request',
      owner: reversalFenceOwner.owner
    });
    assert.equal(reversalFence.status, 'fenced');
    await proof.query(`
      update client_pending_actions
      set owner_lease_expires_at = now() - interval '1 second'
      where idempotency_key = $1
    `, [reversalFenceAction.idempotencyKey]);
    const reversalFenceRecovery = await restartedPaymentService.reconcileActionVisibility({ limit: 25 });
    assert.equal(reversalFenceRecovery.requestsActivated, 0);
    const reversalFenceTruth = await proof.query<{ status: string; activated_at: Date | null; payment_status: string }>(`
      select r.status, r.activated_at, p.payment_status
      from requests r join payments p on p.request_id = r.id
      where r.id = $1
    `, [reversalFenceAction.requestId]);
    assert.equal(reversalFenceTruth.rows[0].status, 'denied');
    assert.equal(reversalFenceTruth.rows[0].activated_at, null);
    assert.equal(reversalFenceTruth.rows[0].payment_status, 'authorized');
    const reversalFenceTerminal = await restartedPaymentService.voidOrRefund(reversalFenceAuthorization.paymentId);
    assert.equal(reversalFenceTerminal.status, 'voided');

    // Exercise the worker's own reversal branch: a captured request that is
    // no longer eligible must be fenced invisible before the worker refunds.
    const workerReversalAction = await reserveRequest({
      label: 'worker-owned-reversal',
      deviceHash: hash('worker-owned-reversal-device'),
      runtimeStatus: 'approved'
    });
    const workerReversalAuthorization = await restartedPaymentService.authorizeAction(
      workerReversalAction.authorizationInput
    );
    assert.equal(workerReversalAuthorization.status, 'authorized');
    const workerReversalOwner = await idempotencyStore.claimPendingActionOwner({
      clientRequestId: workerReversalAction.clientRequestId,
      idempotencyKey: workerReversalAction.idempotencyKey
    });
    assert.equal(workerReversalOwner.status, 'acquired');
    if (workerReversalOwner.status !== 'acquired') throw new Error('worker_reversal_fixture_not_acquired');
    await businessStore.activateRequestAction(GIG_ID, {
      ...workerReversalAction.runtimeState,
      durableRequestId: workerReversalAction.requestId,
      paymentId: workerReversalAuthorization.paymentId,
      paymentIntentId: workerReversalAuthorization.processorPaymentIntentId,
      paymentStatus: 'authorized'
    } as never, workerReversalOwner.owner);
    const workerReversalCapture = await restartedPaymentService.captureAuthorization(
      workerReversalAuthorization.paymentId
    );
    assert.equal(workerReversalCapture.status, 'captured');
    await proof.query(`
      update requests
      set status = 'payment_pending', activated_at = null,
          runtime_request_state = jsonb_set(runtime_request_state, '{status}', '"hold"'::jsonb)
      where id = $1
    `, [workerReversalAction.requestId]);
    await proof.query(`
      update client_pending_actions
      set owner_lease_expires_at = now() - interval '1 second'
      where idempotency_key = $1
    `, [workerReversalAction.idempotencyKey]);
    const workerReversalPass = await restartedPaymentService.reconcileActionVisibility({ limit: 25 });
    assert.equal(workerReversalPass.requestsActivated, 0);
    const workerReversalTruth = await proof.query<{
      request_status: string;
      activated_at: Date | null;
      payment_status: string;
      owner_token: string | null;
      owner_lease_expires_at: Date | null;
    }>(`
      select r.status as request_status, r.activated_at, p.payment_status,
             c.owner_token, c.owner_lease_expires_at
      from requests r
      join payments p on p.request_id = r.id
      join client_pending_actions c on c.idempotency_key = r.idempotency_key
      where r.id = $1
    `, [workerReversalAction.requestId]);
    assert.equal(workerReversalTruth.rows[0].request_status, 'denied');
    assert.equal(workerReversalTruth.rows[0].activated_at, null);
    assert.equal(workerReversalTruth.rows[0].payment_status, 'refunded');
    assert.equal(workerReversalTruth.rows[0].owner_token, null);
    assert.equal(workerReversalTruth.rows[0].owner_lease_expires_at, null);

    // A block that commits while recovery owns an invisible free action must
    // win the shared target lock, produce a canonical 403, and leave nothing
    // visible or pending for the expiry worker.
    const blockedFreeAction = await reserveRequest({
      label: 'blocked-free-recovery',
      amountCents: 0,
      deviceHash: hash('blocked-free-recovery-device')
    });
    await proof.query(`
      update requests
      set runtime_request_state = jsonb_set(runtime_request_state, '{paymentStatus}', '"not_applicable"'::jsonb)
      where id = $1
    `, [blockedFreeAction.requestId]);
    await proof.query(`
      insert into active_blocks (scope, normalized_value, reason, status, revoked_at)
      values ('patron_device_id_hash', $1, 'Concurrent recovery safety proof', 'active', null)
    `, [hash('blocked-free-recovery-device')]);
    const blockedFreeRecovery = await restartedPaymentService.reconcileActionVisibility({ limit: 25 });
    assert.equal(blockedFreeRecovery.requestsActivated, 0);
    const blockedFreeTruth = await proof.query<{
      request_status: string;
      activated_at: Date | null;
      pending_status: string;
      response_status: number;
      response_error: string;
    }>(`
      select r.status as request_status, r.activated_at,
             c.status as pending_status, i.first_response_status as response_status,
             i.first_response_body->>'error' as response_error
      from requests r
      join client_pending_actions c on c.idempotency_key = r.idempotency_key
      join idempotency_keys i on i.idempotency_key = r.idempotency_key
      where r.id = $1
    `, [blockedFreeAction.requestId]);
    assert.equal(blockedFreeTruth.rows[0].request_status, 'denied');
    assert.equal(blockedFreeTruth.rows[0].activated_at, null);
    assert.equal(blockedFreeTruth.rows[0].pending_status, 'reconciled');
    assert.equal(blockedFreeTruth.rows[0].response_status, 403);
    assert.match(blockedFreeTruth.rows[0].response_error, /active safety restriction/i);
    await proof.query(`
      update active_blocks set status = 'revoked', revoked_at = now()
      where scope = 'patron_device_id_hash' and normalized_value = $1 and status = 'active'
    `, [hash('blocked-free-recovery-device')]);

    // Visibility can commit before the HTTP response. Even after the browser
    // deadline, that visible truth must remain recoverable and must not be
    // reversed as an orphan.
    const visibleRecovery = await restartedPaymentService.reconcileActionVisibility({ limit: 25 });
    assert.equal(visibleRecovery.requestsActivated, 0, 'The earlier reconciliation already activated both fixtures.');
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
    const capturesBeforeLostAuthorization = fake.calls.capture;
    fake.failOnce('capture_after_commit');
    const captured = await restartedPaymentService.captureAuthorization(recoveredPayment.rows[0].id);
    assert.equal(captured.status, 'captured');
    assert.equal(fake.calls.capture - capturesBeforeLostAuthorization, 1);

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

    // Confirmation must bind every client/canonical identity field before a
    // provider lookup. A forged intent fingerprint gets zero provider reads.
    const confirmBindingAction = await reserveRequest({
      label: 'confirmation-intent-binding',
      deviceHash: hash('confirmation-intent-binding-device')
    });
    const confirmBindingAuthorization = await restartedPaymentService.authorizeAction(
      confirmBindingAction.authorizationInput
    );
    assert.equal(confirmBindingAuthorization.status, 'authorized');
    if (confirmBindingAuthorization.status !== 'authorized') {
      throw new Error('Confirmation binding fixture did not authorize.');
    }
    const retrievesBeforeMismatch = fake.calls.retrieve;
    const mismatchedConfirmation = await restartedPaymentService.confirmAuthorizedAction({
      gigId: GIG_ID,
      actionType: 'request',
      clientRequestId: confirmBindingAction.clientRequestId,
      idempotencyKey: confirmBindingAction.idempotencyKey,
      intentFingerprint: hash('forged-confirmation-intent'),
      patronDeviceIdHash: hash('confirmation-intent-binding-device'),
      processorPaymentIntentId: confirmBindingAuthorization.processorPaymentIntentId
    });
    assert.equal(mismatchedConfirmation.status, 'failed');
    if (mismatchedConfirmation.status === 'failed') {
      assert.equal(mismatchedConfirmation.reason, 'payment_intent_client_request_mismatch');
    }
    assert.equal(
      fake.calls.retrieve,
      retrievesBeforeMismatch,
      'A mismatched confirmation must perform zero provider retrievals.'
    );

    // Current live-money authority is serialized through the provider call.
    // A revocation started while authorization is in flight cannot commit in
    // the middle of that provider boundary; once committed it blocks the next
    // authorization before another provider call.
    const authorityBoundaryAction = await reserveRequest({
      label: 'authority-boundary-owner',
      deviceHash: hash('authority-boundary-owner-device')
    });
    const postRevocationAction = await reserveRequest({
      label: 'authority-boundary-denied',
      deviceHash: hash('authority-boundary-denied-device')
    });
    let releaseAuthorityProvider!: () => void;
    let authorityProviderReached!: () => void;
    const authorityProviderBarrier = new Promise<void>((resolve) => { authorityProviderReached = resolve; });
    const authorityProviderRelease = new Promise<void>((resolve) => { releaseAuthorityProvider = resolve; });
    fake.setAuthorizeInterceptor(async () => {
      authorityProviderReached();
      await authorityProviderRelease;
    });
    const authorizationsBeforeAuthorityBoundary = fake.calls.authorize;
    const authorityBoundaryPromise = restartedPaymentService.authorizeAction(
      authorityBoundaryAction.authorizationInput
    );
    await authorityProviderBarrier;
    let revocationSettled = false;
    const revocationPromise = recordLiveMoneyCapabilityDecision(
      'revoked',
      'provider-boundary'
    ).finally(() => {
      revocationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const revocationWasSerialized = !revocationSettled;
    fake.clearAuthorizeInterceptor();
    releaseAuthorityProvider();
    const authorityBoundaryResult = await authorityBoundaryPromise;
    await revocationPromise;
    assert.equal(revocationWasSerialized, true, 'Revocation must wait for the in-flight provider boundary.');
    assert.equal(authorityBoundaryResult.status, 'authorized');
    assert.equal(fake.calls.authorize - authorizationsBeforeAuthorityBoundary, 1);
    const providerCallsBeforeRevokedAttempt = fake.calls.authorize;
    const revokedAttempt = await restartedPaymentService.authorizeAction(
      postRevocationAction.authorizationInput
    );
    assert.equal(revokedAttempt.status, 'failed');
    if (revokedAttempt.status === 'failed') {
      assert.equal(revokedAttempt.reason, 'live_money_admission_denied');
    }
    assert.equal(fake.calls.authorize, providerCallsBeforeRevokedAttempt);
    await recordLiveMoneyCapabilityDecision('granted', 'provider-boundary-restored');

    // Authority is evaluated with wall-clock time after lock waits. Starting
    // before a grant expires does not preserve authority through the wait.
    const expiringAuthorityAction = await reserveRequest({
      label: 'authority-expires-while-waiting',
      deviceHash: hash('authority-expiry-device')
    });
    await recordLiveMoneyCapabilityDecision('revoked', 'authority-expiry-prep');
    await proof.query(`
      insert into performer_capability_grant_events (
        performer_id, capability, decision, actor_type, actor_user_id,
        reason, evidence, expires_at, idempotency_key_hash
      ) values (
        $1, 'live_money', 'granted', 'admin', $2,
        'Disposable expiring authority lock-wait proof',
        '{"source":"sway-live-room-crash-concurrency","kind":"expiry-wait"}'::jsonb,
        clock_timestamp() + interval '1 second', $3
      )
    `, [PERFORMER_ID, ADMIN_ID, hash('authority-expiry-wait')]);
    const authorityLockClient = new Client({ connectionString: proof.databaseUrl });
    await authorityLockClient.connect();
    await authorityLockClient.query('begin');
    await authorityLockClient.query(`select sway_live_money_release_lock('test')`);
    const callsBeforeAuthorityExpiry = fake.calls.authorize;
    const expiringAuthorityPromise = restartedPaymentService.authorizeAction(
      expiringAuthorityAction.authorizationInput
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await authorityLockClient.query('commit');
    await authorityLockClient.end();
    const expiringAuthorityResult = await expiringAuthorityPromise;
    assert.equal(expiringAuthorityResult.status, 'failed');
    if (expiringAuthorityResult.status === 'failed') {
      assert.equal(expiringAuthorityResult.reason, 'live_money_admission_denied');
    }
    assert.equal(fake.calls.authorize, callsBeforeAuthorityExpiry);
    await recordLiveMoneyCapabilityDecision('granted', 'authority-expiry-restored');

    // The pending-action deadline is also evaluated after that same wait.
    // An offline action that expires while blocked reaches zero provider calls.
    const expiringPendingAction = await reserveRequest({
      label: 'pending-expires-while-waiting',
      deviceHash: hash('pending-expiry-device'),
      expiresAt: new Date(Date.now() + 900).toISOString()
    });
    const pendingLockClient = new Client({ connectionString: proof.databaseUrl });
    await pendingLockClient.connect();
    await pendingLockClient.query('begin');
    await pendingLockClient.query(`select sway_live_money_release_lock('test')`);
    const callsBeforePendingExpiry = fake.calls.authorize;
    const expiringPendingPromise = restartedPaymentService.authorizeAction(
      expiringPendingAction.authorizationInput
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await pendingLockClient.query('commit');
    await pendingLockClient.end();
    const expiringPendingResult = await expiringPendingPromise;
    assert.equal(expiringPendingResult.status, 'failed');
    if (expiringPendingResult.status === 'failed') {
      assert.equal(expiringPendingResult.reason, 'pending_action_expired_before_provider_call');
    }
    assert.equal(fake.calls.authorize, callsBeforePendingExpiry);

    // Room lifecycle truth is re-read only after its row lock is won. A
    // closeout that commits while authorization waits must beat the stale
    // active-room snapshot and reach the provider zero times.
    if (proof.kind === 'real-postgres') {
      const closingRoomAction = await reserveRequest({
        label: 'room-closes-before-authorize',
        deviceHash: hash('room-closes-before-authorize-device')
      });
      const closingRoomClient = new Client({ connectionString: proof.databaseUrl });
      await closingRoomClient.connect();
      await closingRoomClient.query('begin');
      await closingRoomClient.query('select id from gig_sessions where id = $1 for update', [GIG_ID]);
      const callsBeforeRoomClose = fake.calls.authorize;
      const closingRoomPromise = restartedPaymentService.authorizeAction(
        closingRoomAction.authorizationInput
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await closingRoomClient.query(`
        update gig_sessions
        set status = 'closeout_pending',
            runtime_session_state = jsonb_set(runtime_session_state, '{requestsOpen}', 'false'::jsonb, true)
        where id = $1
      `, [GIG_ID]);
      await closingRoomClient.query('commit');
      await closingRoomClient.end();
      const closingRoomResult = await closingRoomPromise;
      assert.equal(closingRoomResult.status, 'failed');
      if (closingRoomResult.status === 'failed') {
        assert.ok(
          ['authorization_canceled_before_provider_call', 'live_money_admission_denied'].includes(closingRoomResult.reason),
          `A room-close winner must fail at the locked admission boundary, received ${closingRoomResult.reason}.`
        );
      }
      assert.equal(fake.calls.authorize, callsBeforeRoomClose);
      await proof.query(`
        update gig_sessions
        set status = 'active',
            runtime_session_state = jsonb_set(runtime_session_state, '{requestsOpen}', 'true'::jsonb, true)
        where id = $1
      `, [GIG_ID]);
    }

    // A moderation visibility change that wins the locked action row is
    // re-read at admission; stale snapshots cannot authorize or capture.
    const hiddenAuthorizationAction = await reserveRequest({
      label: 'hidden-before-authorize',
      deviceHash: hash('hidden-before-authorize-device')
    });
    const hiddenAuthorizationClient = new Client({ connectionString: proof.databaseUrl });
    await hiddenAuthorizationClient.connect();
    await hiddenAuthorizationClient.query('begin');
    await hiddenAuthorizationClient.query('select id from requests where id = $1 for update', [hiddenAuthorizationAction.requestId]);
    const callsBeforeHiddenAuthorization = fake.calls.authorize;
    const hiddenAuthorizationPromise = restartedPaymentService.authorizeAction(
      hiddenAuthorizationAction.authorizationInput
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await hiddenAuthorizationClient.query(`
      update requests
      set runtime_request_state = runtime_request_state || '{"hidden":true}'::jsonb
      where id = $1
    `, [hiddenAuthorizationAction.requestId]);
    await hiddenAuthorizationClient.query('commit');
    await hiddenAuthorizationClient.end();
    const hiddenAuthorizationResult = await hiddenAuthorizationPromise;
    assert.equal(hiddenAuthorizationResult.status, 'failed');
    if (hiddenAuthorizationResult.status === 'failed') {
      assert.equal(hiddenAuthorizationResult.reason, 'authorization_canceled_before_provider_call');
    }
    assert.equal(fake.calls.authorize, callsBeforeHiddenAuthorization);

    const hiddenCaptureAction = await reserveRequest({
      label: 'hidden-before-capture',
      deviceHash: hash('hidden-before-capture-device'),
      runtimeStatus: 'approved'
    });
    const hiddenCaptureAuthorization = await restartedPaymentService.authorizeAction(
      hiddenCaptureAction.authorizationInput
    );
    assert.equal(hiddenCaptureAuthorization.status, 'authorized');
    if (hiddenCaptureAuthorization.status !== 'authorized') throw new Error('hidden_capture_fixture_not_authorized');
    const hiddenCaptureClient = new Client({ connectionString: proof.databaseUrl });
    await hiddenCaptureClient.connect();
    await hiddenCaptureClient.query('begin');
    await hiddenCaptureClient.query('select id from requests where id = $1 for update', [hiddenCaptureAction.requestId]);
    const capturesBeforeHiddenAction = fake.calls.capture;
    const hiddenCapturePromise = restartedPaymentService.captureAuthorization(
      hiddenCaptureAuthorization.paymentId
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await hiddenCaptureClient.query(`
      update requests
      set runtime_request_state = runtime_request_state || '{"hidden":true}'::jsonb
      where id = $1
    `, [hiddenCaptureAction.requestId]);
    await hiddenCaptureClient.query('commit');
    await hiddenCaptureClient.end();
    const hiddenCaptureResult = await hiddenCapturePromise;
    assert.notEqual(hiddenCaptureResult.status, 'captured');
    assert.equal(fake.calls.capture, capturesBeforeHiddenAction);
    const hiddenCaptureRelease = await restartedPaymentService.voidOrRefund(
      hiddenCaptureAuthorization.paymentId
    );
    assert.ok(['voided', 'noop'].includes(hiddenCaptureRelease.status));
    const sellerAuthorityDeniedAction = await reserveRequest({
      label: 'seller-authority-denied',
      deviceHash: hash('seller-authority-denied-device')
    });
    await recordMoneyAuthorityDecision({
      authorityKind: 'seller',
      subjectType: 'seller',
      subjectId: `seller:${PERFORMER_ID}`,
      decision: 'revoked',
      label: 'exact-seller'
    });
    const providerCallsBeforeSellerDenial = fake.calls.authorize;
    const sellerDenied = await restartedPaymentService.authorizeAction(
      sellerAuthorityDeniedAction.authorizationInput
    );
    assert.equal(sellerDenied.status, 'failed');
    assert.equal(fake.calls.authorize, providerCallsBeforeSellerDenial);
    await recordMoneyAuthorityDecision({
      authorityKind: 'seller',
      subjectType: 'seller',
      subjectId: `seller:${PERFORMER_ID}`,
      decision: 'granted',
      label: 'exact-seller-restored'
    });

    const payoutAuthorityDeniedAction = await reserveRequest({
      label: 'payout-authority-denied',
      deviceHash: hash('payout-authority-denied-device')
    });
    await recordMoneyAuthorityDecision({
      authorityKind: 'payout_controller',
      subjectType: 'payout_account',
      subjectId: 'acct_test_durability',
      decision: 'revoked',
      label: 'exact-payout'
    });
    const providerCallsBeforePayoutDenial = fake.calls.authorize;
    const payoutDenied = await restartedPaymentService.authorizeAction(
      payoutAuthorityDeniedAction.authorizationInput
    );
    assert.equal(payoutDenied.status, 'failed');
    assert.equal(fake.calls.authorize, providerCallsBeforePayoutDenial);
    await recordMoneyAuthorityDecision({
      authorityKind: 'payout_controller',
      subjectType: 'payout_account',
      subjectId: 'acct_test_durability',
      decision: 'granted',
      label: 'exact-payout-restored'
    });

    const releaseDeniedAction = await reserveRequest({
      label: 'release-ledger-denied',
      deviceHash: hash('release-ledger-denied-device')
    });
    await recordTestMoneyReleaseDecision('disabled', 'runtime-gate-closed');
    const providerCallsBeforeReleaseDenial = fake.calls.authorize;
    const releaseDenied = await restartedPaymentService.authorizeAction(
      releaseDeniedAction.authorizationInput
    );
    assert.equal(releaseDenied.status, 'failed');
    assert.equal(fake.calls.authorize, providerCallsBeforeReleaseDenial);
    await recordTestMoneyReleaseDecision('enabled', 'runtime-gate-restored');
    await assert.rejects(
      proof.query(`
        update live_room_money_release_events
        set reason = 'Forbidden mutable release evidence'
        where environment = 'test'
      `),
      /append-only|immutable/i
    );

    // Old and new room writers converge on one relational money truth. Old
    // music writers can be derived when the destination is exact; nonmusic
    // writers cannot smuggle paid flags; active room type is immutable.
    const legacyMusicGigId = randomUUID();
    await proof.query(`
      insert into gig_sessions (
        id, performer_id, owner_actor_user_id, last_mutation_actor_user_id,
        status, room_type, title, runtime_session_state, auto_closeout_at
      ) values (
        $1, $2, $3, $3, 'draft', 'music', 'Legacy paid writer proof',
        $4::jsonb, now() + interval '4 hours'
      )
    `, [legacyMusicGigId, PERFORMER_ID, OWNER_ID, JSON.stringify(activeSession())]);
    const legacyProjection = await proof.query<{
      money_enabled: boolean;
      money_destination_account_id: string;
      money_environment: string;
      settlement_mode: string;
    }>(`
      select money_enabled, money_destination_account_id, money_environment,
             runtime_session_state ->> 'settlementMode' as settlement_mode
      from gig_sessions where id = $1
    `, [legacyMusicGigId]);
    assert.equal(legacyProjection.rows[0].money_enabled, true);
    assert.equal(legacyProjection.rows[0].money_destination_account_id, 'acct_test_durability');
    assert.equal(legacyProjection.rows[0].money_environment, 'test');
    assert.equal(legacyProjection.rows[0].settlement_mode, 'connected_account');

    const nonmusicOldWriterGigId = randomUUID();
    await assert.rejects(
      proof.query(`
        insert into gig_sessions (
          id, performer_id, owner_actor_user_id, last_mutation_actor_user_id,
          status, room_type, title, runtime_session_state, auto_closeout_at
        ) values (
          $1, $2, $3, $3, 'draft', 'comedy', 'Forbidden legacy paid comedy room',
          $4::jsonb, now() + interval '4 hours'
        )
      `, [nonmusicOldWriterGigId, PERFORMER_ID, OWNER_ID, JSON.stringify(activeSession())]),
      /Nonmusic rooms cannot project paid requests or tips/
    );
    const nonmusicNewWriterGigId = randomUUID();
    await assert.rejects(
      proof.query(`
        insert into gig_sessions (
          id, performer_id, owner_actor_user_id, last_mutation_actor_user_id,
          status, room_type, money_enabled, money_destination_account_id,
          money_environment, title, runtime_session_state, auto_closeout_at
        ) values (
          $1, $2, $3, $3, 'draft', 'service', true, 'acct_test_durability',
          'test', 'Forbidden relational paid service room', '{}'::jsonb,
          now() + interval '4 hours'
        )
      `, [nonmusicNewWriterGigId, PERFORMER_ID, OWNER_ID]),
      /gig_sessions_money_requires_music/
    );
    await assert.rejects(
      proof.query(`update gig_sessions set room_type = 'comedy' where id = $1`, [GIG_ID]),
      /gig_sessions_active_room_type_immutable|Room type is immutable/
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
    await proof.query(`
      update gig_sessions
      set money_enabled = true,
          money_destination_account_id = $2,
          money_environment = 'test'
      where id = $1
    `, [GIG_ID, SWAY_TEST_PLATFORM_BALANCE_DESTINATION]);
    const platformTestService = createPaymentService({
      databaseUrl: proof.databaseUrl,
      provider: fake.provider,
      moneyExecutionEnabled: true,
      moneyEnvironment: 'test',
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
      set runtime_request_state = jsonb_set(runtime_request_state, '{status}', '"approved"'::jsonb)
      where id = $1
    `, [platformRequest.requestId]);
    const disabledPilotDrainService = createPaymentService({
      databaseUrl: proof.databaseUrl,
      provider: fake.provider,
      moneyExecutionEnabled: true,
      moneyEnvironment: 'test',
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
