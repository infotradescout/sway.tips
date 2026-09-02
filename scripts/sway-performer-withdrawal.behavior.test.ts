import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { normalizePayoutRecipient } from '../src/payout-destination';
import { createPayoutDestinationStore } from '../src/server/payout-destination-store';
import { createPayoutRecipientCipher } from '../src/server/payout-recipient-crypto';
import {
  PayPalPayoutsError,
  payPalSenderItemId,
  type PayPalPayoutsAdapter
} from '../src/server/paypal-payouts';
import {
  createPerformerWithdrawalService,
  persistedPayoutFailureCode
} from '../src/server/performer-withdrawal-service';

process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  process.exit(1);
});

await import('./sway-payout-destination-capabilities.behavior.test');
await import('./sway-payout-destination.behavior.test');
await import('./sway-payment-pricing.behavior.test');
await import('./sway-paypal-payouts.behavior.test');
await import('./sway-paypal-payout-readiness.behavior.test');
await import('./sway-payout-recipient-privacy.behavior.test');
await import('./sway-performer-payout-kyc.behavior.test');
await import('./sway-performer-live-withdrawal-canary.behavior.test');
await import('./sway-withdrawal-refund-concurrency.integration.test');

const root = process.cwd();
const database = new PGlite();
const migrationFiles = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

try {
  for (const migrationFile of migrationFiles) {
    const statements = readFileSync(join(root, 'drizzle', migrationFile), 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    await database.exec('BEGIN');
    try {
      for (const statement of statements) await database.exec(statement);
      await database.exec('COMMIT');
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }
  }

  const db = drizzle(database, { schema }) as unknown as SwayDb;
  const ownerUserId = '11000000-0000-4000-8000-000000000046';
  const performerId = '21000000-0000-4000-8000-000000000046';
  const gigId = '31000000-0000-4000-8000-000000000046';
  await db.insert(schema.users).values({
    id: ownerUserId,
    email: 'withdrawal-owner@example.test',
    displayName: 'Withdrawal Owner',
    emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z')
  });
  await db.insert(schema.performers).values({
    id: performerId,
    ownerUserId,
    displayName: 'Withdrawal Performer',
    handle: 'withdrawal-performer',
    isActive: true
  });
  await db.insert(schema.gigSessions).values({
    id: gigId,
    performerId,
    status: 'closed',
    title: 'withdrawal-test',
    venueName: 'test',
    autoCloseoutAt: new Date('2026-09-01T12:00:00.000Z')
  });
  const paymentIds = [
    '41000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000002',
    '41000000-0000-4000-8000-000000000003'
  ];
  await db.insert(schema.payments).values([
    { id: paymentIds[0], gigId, performerId, paymentMode: 'test', paymentStatus: 'captured', processor: 'stripe', amountSubtotal: 500, platformFee: 100, amountTotal: 600 },
    { id: paymentIds[1], gigId, performerId, paymentMode: 'test', paymentStatus: 'captured', processor: 'stripe', amountSubtotal: 500, platformFee: 100, amountTotal: 600 },
    { id: paymentIds[2], gigId, performerId, paymentMode: 'test', paymentStatus: 'captured', processor: 'stripe', amountSubtotal: 500, platformFee: 100, amountTotal: 600 },
    { gigId, performerId, paymentMode: 'test', paymentStatus: 'authorized', processor: 'stripe', amountSubtotal: 400, platformFee: 100, amountTotal: 500 },
    { gigId, performerId, paymentMode: 'live', paymentStatus: 'captured', processor: 'stripe', amountSubtotal: 9_999, platformFee: 100, amountTotal: 10_099 }
  ]);

  const cipher = createPayoutRecipientCipher(Buffer.alloc(32, 11));
  const destinationStore = createPayoutDestinationStore(db, cipher, 'test');
  const recipient = normalizePayoutRecipient({
    destinationKind: 'paypal',
    recipientType: 'email',
    recipientValue: 'performer-paypal@example.test'
  });
  assert.ok(recipient);
  const savedRecipient = await destinationStore.saveForOwner({ performerId, ownerUserId, recipient });
  if (savedRecipient.kind === 'not_found') throw new Error('payout recipient owner missing');
  assert.equal(savedRecipient.kind, 'updated');
  const mistypedRecipient = normalizePayoutRecipient({
    destinationKind: 'paypal',
    recipientType: 'email',
    recipientValue: 'performer-paypa1@example.test'
  });
  assert.ok(mistypedRecipient);

  let providerStatus = 'PENDING';
  let actualProviderFeeCents: number | null = null;
  let providerBatchReads = 0;
  const providerCalls: Array<Record<string, unknown>> = [];
  const providerBatches = new Map<string, string>();
  const provider = {
    mode: 'test' as const,
    feeCents: 25,
    async createPayout(payout: Parameters<PayPalPayoutsAdapter['createPayout']>[0]) {
      providerCalls.push(payout);
      const senderItemId = payPalSenderItemId(payout.withdrawalId);
      const payoutBatchId = `BATCH-${senderItemId}`;
      providerBatches.set(payoutBatchId, senderItemId);
      return {
        payoutBatchId,
        senderItemId,
        batchStatus: 'PENDING'
      };
    },
    async getBatch(payoutBatchId: string, senderItemId?: string) {
      providerBatchReads += 1;
      return {
        payoutBatchId,
        batchStatus: providerStatus,
        item: {
          payoutBatchId,
          senderItemId: senderItemId ?? providerBatches.get(payoutBatchId) ?? 'missing-sender-item-id',
          payoutItemId: 'PAYOUT-ITEM-0001',
          transactionId: providerStatus === 'SUCCESS' ? 'TXN-0001' : null,
          transactionStatus: providerStatus,
          actualProviderFeeCents,
          errorName: null
        }
      };
    },
    async verifyWebhook() {
      throw new Error('not used by the ledger behavior test');
    }
  } as unknown as PayPalPayoutsAdapter;
  const service = createPerformerWithdrawalService({ db, destinationStore, provider });

  const before = await service.getOwnerBalance({ ownerUserId, paymentMode: 'test' });
  assert.equal(before.kind, 'ok');
  if (before.kind !== 'ok') throw new Error('missing owner balance');
  assert.equal(before.availableCents, 1_500, 'captured performer subtotals must accumulate without subtracting Sway fees');
  assert.equal(before.pendingCents, 400);
  assert.equal(before.providerFeeCents, 25);
  assert.equal(before.withdrawalRestriction, null);

  assert.equal((await service.requestWithdrawal({
    ownerUserId,
    paymentMode: 'test',
    idempotencyKey: 'short',
    destinationKind: 'paypal',
    recipientConfirmation: recipient,
    grossAmountCents: 1_000
  })).kind, 'invalid_idempotency_key');
  assert.equal((await service.requestWithdrawal({
    ownerUserId,
    paymentMode: 'test',
    idempotencyKey: 'withdrawal:test:below-minimum',
    destinationKind: 'paypal',
    recipientConfirmation: recipient,
    grossAmountCents: 999
  })).kind, 'below_minimum');
  assert.equal((await service.requestWithdrawal({
    ownerUserId,
    paymentMode: 'test',
    idempotencyKey: 'withdrawal:test:stale-recipient',
    destinationKind: 'paypal',
    recipientConfirmation: mistypedRecipient,
    grossAmountCents: 1_000
  })).kind, 'destination_changed', 'cash-out must be bound to the exact recipient reviewed by the performer');
  assert.equal((await service.requestWithdrawal({
    ownerUserId,
    paymentMode: 'live',
    idempotencyKey: 'withdrawal:live:mode-fence',
    destinationKind: 'paypal',
    recipientConfirmation: recipient,
    grossAmountCents: 1_000
  })).kind, 'provider_mode_mismatch', 'test credentials must never touch live earnings');

  const first = await service.requestWithdrawal({
    ownerUserId,
    paymentMode: 'test',
    idempotencyKey: 'withdrawal:test:0001',
    destinationKind: 'paypal',
    recipientConfirmation: recipient,
    grossAmountCents: 1_000
  });
  assert.equal(first.kind, 'created');
  if (first.kind !== 'created') throw new Error('withdrawal was not created');
  assert.equal(first.withdrawal.status, 'processing');
  assert.equal(first.withdrawal.providerFeeCents, 25);
  assert.equal(first.withdrawal.netAmountCents, 975);
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0], {
    withdrawalId: first.withdrawal.id,
    destinationKind: 'paypal',
    recipientType: 'email',
    recipientValue: 'performer-paypal@example.test',
    netAmountCents: 975
  });

  const storedWithdrawalJson = JSON.stringify((await db.select().from(schema.performerWithdrawals))[0]);
  assert.equal(storedWithdrawalJson.includes('performer-paypal@example.test'), false, 'withdrawal rows must not store raw recipients');
  const auditJson = JSON.stringify(await db.select().from(schema.auditEvents));
  assert.equal(auditJson.includes('performer-paypal@example.test'), false, 'withdrawal audits must not store raw recipients');

  const after = await service.getOwnerBalance({ ownerUserId, paymentMode: 'test' });
  assert.equal(after.kind, 'ok');
  if (after.kind !== 'ok') throw new Error('missing owner balance');
  assert.equal(after.availableCents, 500, 'one combined withdrawal must reserve the accumulated balance once');
  assert.equal(after.reservedCents, 1_000);

  const replay = await service.requestWithdrawal({
    ownerUserId,
    paymentMode: 'test',
    idempotencyKey: 'withdrawal:test:0001',
    destinationKind: 'paypal',
    recipientConfirmation: recipient,
    grossAmountCents: 1_000
  });
  assert.equal(replay.kind, 'replay');
  assert.equal(providerCalls.length, 1, 'an HTTP replay after provider submission must not issue a second payout');

  assert.equal((await service.requestWithdrawal({
    ownerUserId,
    paymentMode: 'test',
    idempotencyKey: 'withdrawal:test:0001',
    destinationKind: 'paypal',
    recipientConfirmation: recipient,
    grossAmountCents: 1_100
  })).kind, 'idempotency_conflict');
  assert.equal((await service.requestWithdrawal({
    ownerUserId,
    paymentMode: 'test',
    idempotencyKey: 'withdrawal:test:too-large',
    destinationKind: 'paypal',
    recipientConfirmation: recipient,
    grossAmountCents: 1_000
  })).kind, 'insufficient_balance');

  providerStatus = 'SUCCESS';
  actualProviderFeeCents = 30;
  const firstPayoutId = first.withdrawal.providerPayoutId;
  assert.ok(firstPayoutId);
  const readsBeforeIgnoredEvent = providerBatchReads;
  const ignoredWebhookBody = JSON.stringify({ id: 'WH-IGNORED', event_type: 'CUSTOMER.DISPUTE.CREATED' });
  assert.equal((await service.ingestWebhook({
    event: {
      providerEventId: 'WH-IGNORED',
      eventType: 'CUSTOMER.DISPUTE.CREATED',
      resource: { payout_batch_id: firstPayoutId }
    },
    rawBody: ignoredWebhookBody,
    paymentMode: 'test'
  })).kind, 'ignored');
  assert.equal(providerBatchReads, readsBeforeIgnoredEvent, 'unrelated verified PayPal events must not query or mutate payout state');
  const rawWebhook = JSON.stringify({ id: 'WH-0001', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' });
  const webhookResult = await service.ingestWebhook({
    event: {
      providerEventId: 'WH-0001',
      eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
      resource: { payout_batch_id: firstPayoutId }
    },
    rawBody: rawWebhook,
    paymentMode: 'test'
  });
  assert.equal(webhookResult.kind, 'updated');
  const [paid] = await db.select().from(schema.performerWithdrawals)
    .where(eq(schema.performerWithdrawals.id, first.withdrawal.id));
  assert.equal(paid.status, 'paid');
  assert.equal(paid.actualProviderFeeCents, 30);
  assert.equal(paid.providerTransactionId, 'TXN-0001');

  const paidBalance = await service.getOwnerBalance({ ownerUserId, paymentMode: 'test' });
  assert.equal(paidBalance.kind, 'ok');
  if (paidBalance.kind !== 'ok') throw new Error('missing paid balance');
  assert.equal(paidBalance.reservedCents, 1_000, 'a higher provider fee must never silently debit more than the disclosed gross cash-out');
  assert.equal(paidBalance.availableCents, 500);
  const [feeVariancePerformer] = await db.select({ payoutHoldReason: schema.performers.payoutHoldReason })
    .from(schema.performers)
    .where(eq(schema.performers.id, performerId));
  assert.equal(
    feeVariancePerformer.payoutHoldReason,
    `paypal_fee_variance:${first.withdrawal.id}`,
    'a positive PayPal fee variance must hold future withdrawals instead of silently charging the performer'
  );

  assert.equal((await service.ingestWebhook({
    event: {
      providerEventId: 'WH-0001',
      eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
      resource: { payout_batch_id: firstPayoutId }
    },
    rawBody: rawWebhook,
    paymentMode: 'test'
  })).kind, 'duplicate');
  await assert.rejects(service.ingestWebhook({
    event: {
      providerEventId: 'WH-0001',
      eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
      resource: { payout_batch_id: 'DIFFERENT' }
    },
    rawBody: `${rawWebhook} `,
    paymentMode: 'test'
  }), /webhook_replay_mismatch/);
  const [eventRow] = await db.select().from(schema.payoutProcessorEvents)
    .where(eq(schema.payoutProcessorEvents.providerEventId, 'WH-0001'));
  assert.equal(JSON.stringify(eventRow.payload).includes('performer-paypal@example.test'), false);
  assert.equal(eventRow.status, 'processed');

  await db.update(schema.payments).set({ refundStatus: 'refunded' })
    .where(eq(schema.payments.id, paymentIds[0]));
  let reduced = await service.getOwnerBalance({ ownerUserId, paymentMode: 'test' });
  assert.equal(reduced.kind, 'ok');
  if (reduced.kind !== 'ok') throw new Error('missing reduced balance');
  assert.equal(reduced.availableCents, 0);
  assert.equal(reduced.deficitCents, 0);
  await db.update(schema.payments).set({ refundStatus: 'refunded' })
    .where(eq(schema.payments.id, paymentIds[1]));
  reduced = await service.getOwnerBalance({ ownerUserId, paymentMode: 'test' });
  assert.equal(reduced.kind, 'ok');
  if (reduced.kind !== 'ok') throw new Error('missing deficit balance');
  assert.equal(reduced.availableCents, 0);
  assert.equal(reduced.deficitCents, 500, 'post-payout refunds must become an explicit deficit, never a new payout');

  const retryOwnerId = '11000000-0000-4000-8000-000000000047';
  const retryPerformerId = '21000000-0000-4000-8000-000000000047';
  const retryGigId = '31000000-0000-4000-8000-000000000047';
  await db.insert(schema.users).values({ id: retryOwnerId, email: 'retry@example.test', displayName: 'Retry Owner', emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z') });
  await db.insert(schema.performers).values({ id: retryPerformerId, ownerUserId: retryOwnerId, displayName: 'Retry Performer', handle: 'retry-performer', isActive: true });
  await db.insert(schema.gigSessions).values({ id: retryGigId, performerId: retryPerformerId, status: 'closed', title: 'retry-test', venueName: 'test', autoCloseoutAt: new Date('2026-09-01T12:00:00.000Z') });
  await db.insert(schema.payments).values({ gigId: retryGigId, performerId: retryPerformerId, paymentMode: 'test', paymentStatus: 'captured', processor: 'stripe', amountSubtotal: 1_500, platformFee: 100, amountTotal: 1_600 });
  const venmoRecipient = normalizePayoutRecipient({ destinationKind: 'venmo', recipientType: 'user_handle', recipientValue: '@retry-artist' });
  assert.ok(venmoRecipient);
  const savedVenmoRecipient = await destinationStore.saveForOwner({ performerId: retryPerformerId, ownerUserId: retryOwnerId, recipient: venmoRecipient });
  if (savedVenmoRecipient.kind === 'not_found') throw new Error('Venmo payout recipient owner missing');

  let attempts = 0;
  const retryProvider = {
    ...provider,
    async createPayout(payout: Parameters<PayPalPayoutsAdapter['createPayout']>[0]) {
      attempts += 1;
      if (attempts === 1) throw new PayPalPayoutsError({
        message: 'temporary provider outage for @retry-artist',
        status: 503,
        retryable: true,
        providerName: 'SERVICE_UNAVAILABLE'
      });
      return provider.createPayout(payout);
    }
  } as unknown as PayPalPayoutsAdapter;
  const retryService = createPerformerWithdrawalService({ db, destinationStore, provider: retryProvider });
  const retryRequest = {
    ownerUserId: retryOwnerId,
    paymentMode: 'test' as const,
    idempotencyKey: 'withdrawal:test:retry-0001',
    destinationKind: 'venmo' as const,
    recipientConfirmation: venmoRecipient,
    grossAmountCents: 1_000
  };
  assert.equal((await retryService.requestWithdrawal(retryRequest)).kind, 'provider_retryable');
  const [safeRetryRow] = await db.select().from(schema.performerWithdrawals)
    .where(eq(schema.performerWithdrawals.performerId, retryPerformerId));
  assert.equal(safeRetryRow.lastError, 'SERVICE_UNAVAILABLE');
  assert.equal(JSON.stringify(safeRetryRow).includes('@retry-artist'), false, 'provider error persistence must never echo the raw recipient');
  const duringRetry = await retryService.getOwnerBalance({ ownerUserId: retryOwnerId, paymentMode: 'test' });
  assert.equal(duringRetry.kind, 'ok');
  if (duringRetry.kind !== 'ok') throw new Error('missing retry balance');
  assert.equal(duringRetry.availableCents, 500, 'an uncertain provider attempt must keep the gross amount reserved');
  const changedVenmoRecipient = normalizePayoutRecipient({
    destinationKind: 'venmo',
    recipientType: 'user_handle',
    recipientValue: '@different-artist'
  });
  assert.ok(changedVenmoRecipient);
  assert.equal((await destinationStore.saveForOwner({
    performerId: retryPerformerId,
    ownerUserId: retryOwnerId,
    recipient: changedVenmoRecipient
  })).kind, 'withdrawal_in_progress', 'an unresolved payout must freeze its exact recipient across retries');
  await assert.rejects(
    db.update(schema.performerPayoutPreferences)
      .set({ recipientValuePreview: '@different-artist' })
      .where(eq(schema.performerPayoutPreferences.performerId, retryPerformerId)),
    (error: unknown) => {
      const cause = error && typeof error === 'object' && 'cause' in error
        ? (error as { cause?: unknown }).cause
        : null;
      return String(cause ?? error).includes('payout recipient locked while withdrawal is unresolved');
    },
    'the database must reject recipient mutation while provider outcome is uncertain'
  );
  await assert.rejects(
    db.update(schema.performerPayoutPreferences)
      .set({ paymentMode: 'live' })
      .where(eq(schema.performerPayoutPreferences.performerId, retryPerformerId)),
    (error: unknown) => {
      const cause = error && typeof error === 'object' && 'cause' in error
        ? (error as { cause?: unknown }).cause
        : null;
      return String(cause ?? error).includes('payout recipient locked while withdrawal is unresolved');
    },
    'the database must reject test/live recipient rebinding while provider outcome is uncertain'
  );
  providerStatus = 'PENDING';
  assert.equal((await retryService.requestWithdrawal(retryRequest)).kind, 'replay');
  assert.equal(attempts, 2, 'a stable provider identity may safely retry an uncertain submission');

  const [originalPreference] = await db.select().from(schema.performerPayoutPreferences)
    .where(eq(schema.performerPayoutPreferences.performerId, performerId));
  await db.insert(schema.performerWithdrawals).values({
    performerId,
    ownerUserId,
    idempotencyKey: 'withdrawal:test:requested-backlog',
    destinationKind: 'paypal',
    recipientType: 'email',
    recipientFingerprint: originalPreference.recipientValueFingerprint,
    recipientPreview: originalPreference.recipientValuePreview,
    paymentMode: 'test',
    status: 'requested',
    grossAmountCents: 1_000,
    providerFeeCents: 25,
    netAmountCents: 975,
    providerSenderItemId: 'requested-backlog-sender'
  });
  const attemptsBeforePriorityProof = attempts;
  const priorityResult = await retryService.reconcilePending(1);
  assert.equal(priorityResult.length, 1);
  assert.equal(providerBatchReads > readsBeforeIgnoredEvent, true);
  assert.equal(attempts, attemptsBeforePriorityProof, 'provider-truth reconciliation must run before requested backlog submission');

  const [wrongModeWithdrawal] = await db.insert(schema.performerWithdrawals).values({
    performerId,
    ownerUserId,
    idempotencyKey: 'withdrawal:live:must-not-use-test-provider',
    destinationKind: 'paypal',
    recipientType: 'email',
    recipientFingerprint: originalPreference.recipientValueFingerprint,
    recipientPreview: originalPreference.recipientValuePreview,
    paymentMode: 'live',
    status: 'requested',
    grossAmountCents: 1_000,
    providerFeeCents: 25,
    netAmountCents: 975,
    providerSenderItemId: 'wrong-mode-live-sender'
  }).returning();
  await retryService.reconcilePending(100);
  const [wrongModeAfterReconcile] = await db.select().from(schema.performerWithdrawals)
    .where(eq(schema.performerWithdrawals.id, wrongModeWithdrawal.id));
  assert.equal(wrongModeAfterReconcile.status, 'requested');
  assert.equal(wrongModeAfterReconcile.attemptCount, 0);
  assert.equal(
    providerCalls.some((call) => call.withdrawalId === wrongModeWithdrawal.id),
    false,
    'a sandbox worker must never submit or reconcile a live withdrawal'
  );

  await db.update(schema.performers).set({ payoutHoldReason: 'manual_risk_review' })
    .where(eq(schema.performers.id, retryPerformerId));
  const heldAccountBalance = await retryService.getOwnerBalance({ ownerUserId: retryOwnerId, paymentMode: 'test' });
  assert.equal(heldAccountBalance.kind, 'ok');
  if (heldAccountBalance.kind !== 'ok') throw new Error('missing held-account balance');
  assert.equal(heldAccountBalance.withdrawalRestriction, 'account_restricted');
  assert.equal((await retryService.requestWithdrawal({
    ...retryRequest,
    idempotencyKey: 'withdrawal:test:held-account'
  })).kind, 'account_restricted');

  await db.update(schema.performers).set({ payoutHoldReason: null })
    .where(eq(schema.performers.id, retryPerformerId));
  await db.update(schema.users).set({ emailVerifiedAt: null })
    .where(eq(schema.users.id, retryOwnerId));
  const unverifiedBalance = await retryService.getOwnerBalance({ ownerUserId: retryOwnerId, paymentMode: 'test' });
  assert.equal(unverifiedBalance.kind, 'ok');
  if (unverifiedBalance.kind !== 'ok') throw new Error('missing unverified balance');
  assert.equal(unverifiedBalance.withdrawalRestriction, 'email_verification_required');
  assert.equal((await retryService.requestWithdrawal({
    ...retryRequest,
    idempotencyKey: 'withdrawal:test:unverified-account'
  })).kind, 'email_verification_required');

  await db.update(schema.users).set({ emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z') })
    .where(eq(schema.users.id, retryOwnerId));
  await db.update(schema.performers).set({ isActive: false })
    .where(eq(schema.performers.id, retryPerformerId));
  assert.equal((await retryService.requestWithdrawal({
    ...retryRequest,
    idempotencyKey: 'withdrawal:test:inactive-account'
  })).kind, 'account_restricted');

  const createSafetyFixture = async (suffix: '048' | '049', email: string) => {
    const safetyOwnerId = `11000000-0000-4000-8000-000000000${suffix}`;
    const safetyPerformerId = `21000000-0000-4000-8000-000000000${suffix}`;
    const safetyGigId = `31000000-0000-4000-8000-000000000${suffix}`;
    await db.insert(schema.users).values({
      id: safetyOwnerId,
      email,
      displayName: 'Safety Owner',
      emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z')
    });
    await db.insert(schema.performers).values({
      id: safetyPerformerId,
      ownerUserId: safetyOwnerId,
      displayName: 'Safety Performer',
      handle: `safety-performer-${suffix}`,
      isActive: true
    });
    await db.insert(schema.gigSessions).values({
      id: safetyGigId,
      performerId: safetyPerformerId,
      status: 'closed',
      title: 'safety-test',
      venueName: 'test',
      autoCloseoutAt: new Date('2026-09-01T12:00:00.000Z')
    });
    await db.insert(schema.payments).values({
      gigId: safetyGigId,
      performerId: safetyPerformerId,
      paymentMode: 'test',
      paymentStatus: 'captured',
      processor: 'stripe',
      amountSubtotal: 1_500,
      platformFee: 100,
      amountTotal: 1_600
    });
    const safetyRecipient = normalizePayoutRecipient({
      destinationKind: 'paypal',
      recipientType: 'email',
      recipientValue: email
    });
    assert.ok(safetyRecipient);
    assert.equal((await destinationStore.saveForOwner({
      performerId: safetyPerformerId,
      ownerUserId: safetyOwnerId,
      recipient: safetyRecipient
    })).kind, 'updated');
    return { safetyOwnerId, safetyPerformerId, safetyRecipient };
  };

  const deniedFixture = await createSafetyFixture('048', 'denied-recipient@example.test');
  const deniedProvider = {
    ...provider,
    async createPayout(payout: Parameters<PayPalPayoutsAdapter['createPayout']>[0]) {
      return {
        payoutBatchId: `DENIED-${payout.withdrawalId}`,
        senderItemId: payPalSenderItemId(payout.withdrawalId),
        batchStatus: 'DENIED'
      };
    }
  } as PayPalPayoutsAdapter;
  const deniedService = createPerformerWithdrawalService({ db, destinationStore, provider: deniedProvider });
  const deniedResult = await deniedService.requestWithdrawal({
    ownerUserId: deniedFixture.safetyOwnerId,
    paymentMode: 'test',
    idempotencyKey: 'withdrawal:test:immediate-denied',
    destinationKind: 'paypal',
    recipientConfirmation: deniedFixture.safetyRecipient,
    grossAmountCents: 1_000
  });
  assert.equal(deniedResult.kind, 'provider_rejected');
  if (deniedResult.kind !== 'provider_rejected') throw new Error('expected immediate denial');
  assert.equal(deniedResult.withdrawal.status, 'failed');
  assert.equal(deniedResult.withdrawal.failureCode, 'PAYPAL_BATCH_DENIED');
  const deniedBalance = await deniedService.getOwnerBalance({
    ownerUserId: deniedFixture.safetyOwnerId,
    paymentMode: 'test'
  });
  assert.equal(deniedBalance.kind, 'ok');
  if (deniedBalance.kind !== 'ok') throw new Error('missing denied balance');
  assert.equal(deniedBalance.availableCents, 1_500, 'an immediate batch denial must release the reservation');

  const rawErrorFixture = await createSafetyFixture('049', 'raw-error-recipient@example.test');
  const rawErrorProvider = {
    ...provider,
    async createPayout() {
      throw new Error('failed recipient raw-error-recipient@example.test');
    }
  } as PayPalPayoutsAdapter;
  const rawErrorService = createPerformerWithdrawalService({ db, destinationStore, provider: rawErrorProvider });
  assert.equal((await rawErrorService.requestWithdrawal({
    ownerUserId: rawErrorFixture.safetyOwnerId,
    paymentMode: 'test',
    idempotencyKey: 'withdrawal:test:raw-provider-error',
    destinationKind: 'paypal',
    recipientConfirmation: rawErrorFixture.safetyRecipient,
    grossAmountCents: 1_000
  })).kind, 'provider_retryable');
  const [rawErrorWithdrawal] = await db.select().from(schema.performerWithdrawals)
    .where(eq(schema.performerWithdrawals.performerId, rawErrorFixture.safetyPerformerId));
  assert.equal(rawErrorWithdrawal.lastError, 'paypal_payout_unknown_error');
  assert.equal(JSON.stringify(rawErrorWithdrawal).includes('raw-error-recipient@example.test'), false);
  assert.equal(
    persistedPayoutFailureCode(new PayPalPayoutsError({
      message: 'provider rejected recipient',
      status: 422,
      retryable: false,
      providerName: 'raw-error-recipient@example.test'
    })),
    'PAYPAL_HTTP_422',
    'provider error names must match a strict code grammar before persistence or logging'
  );
} finally {
  await database.close();
}

console.log(`PayPal/Venmo accumulated performer withdrawal behavior test passed (${migrationFiles.length} migrations).`);
