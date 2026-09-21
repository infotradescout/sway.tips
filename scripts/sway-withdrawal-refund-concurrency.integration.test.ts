import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { normalizePayoutRecipient } from '../src/payout-destination';
import { createPaymentLifecycleService } from '../src/server/payment-lifecycle';
import { createPayoutDestinationStore } from '../src/server/payout-destination-store';
import { createPayoutRecipientCipher } from '../src/server/payout-recipient-crypto';
import { createPerformerWithdrawalService } from '../src/server/performer-withdrawal-service';
import { payPalSenderItemId, type PayPalPayoutsAdapter } from '../src/server/paypal-payouts';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => { throw new Error(`${label} exceeded ${timeoutMs}ms; possible lock-order deadlock.`); })
  ]);
}

const proof = await startEmbeddedPostgresProof('withdrawal_refund_concurrency');
if (process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF === 'true') {
  assert.equal(proof.kind, 'real-postgres', 'Strict withdrawal/refund concurrency proof requires standalone PostgreSQL.');
}
const db = createSwayDb(proof.databaseUrl);
const ownerUserId = '11000000-0000-4000-8000-000000000095';
const performerId = '21000000-0000-4000-8000-000000000095';
const gigId = '31000000-0000-4000-8000-000000000095';
const paymentId = '41000000-0000-4000-8000-000000000095';

try {
  await db.insert(schema.users).values({
    id: ownerUserId,
    email: 'refund-race@example.test',
    displayName: 'Refund Race',
    emailVerifiedAt: new Date()
  });
  await db.insert(schema.performers).values({
    id: performerId,
    ownerUserId,
    displayName: 'Refund Race',
    handle: 'refund-race',
    isActive: true
  });
  await db.insert(schema.gigSessions).values({
    id: gigId,
    performerId,
    status: 'closed',
    title: 'refund-race',
    venueName: 'test',
    autoCloseoutAt: new Date()
  });
  await db.insert(schema.payments).values({
    id: paymentId,
    gigId,
    performerId,
    paymentMode: 'test',
    paymentStatus: 'captured',
    refundStatus: 'not_refunded',
    processor: 'stripe',
    amountSubtotal: 1_000,
    platformFee: 100,
    amountTotal: 1_100
  });
  const recipient = normalizePayoutRecipient({
    destinationKind: 'paypal',
    recipientType: 'email',
    recipientValue: 'refund-race@example.test'
  });
  assert.ok(recipient);
  const destinationStore = createPayoutDestinationStore(db, createPayoutRecipientCipher(Buffer.alloc(32, 29)), 'test');
  assert.equal((await destinationStore.saveForOwner({ performerId, ownerUserId, recipient })).kind, 'updated');

  let blockProvider = false;
  let providerEntered = deferred();
  let releaseProvider = deferred();
  const provider = {
    mode: 'test' as const,
    feeCents: 25,
    async createPayout(payout: Parameters<PayPalPayoutsAdapter['createPayout']>[0]) {
      providerEntered.resolve();
      if (blockProvider) await releaseProvider.promise;
      return {
        payoutBatchId: `RACE-BATCH-${payout.withdrawalId}`,
        senderItemId: payPalSenderItemId(payout.withdrawalId),
        batchStatus: 'PENDING'
      };
    },
    async getBatch(payoutBatchId: string, senderItemId?: string) {
      return {
        payoutBatchId,
        batchStatus: 'PENDING',
        item: {
          payoutBatchId,
          senderItemId: senderItemId!,
          payoutItemId: null,
          transactionId: null,
          transactionStatus: 'PENDING',
          actualProviderFeeCents: null,
          errorName: null
        }
      };
    },
    async verifyWebhook() { throw new Error('not used'); }
  } as PayPalPayoutsAdapter;
  const withdrawals = createPerformerWithdrawalService({ db, destinationStore, provider });
  const lifecycle = createPaymentLifecycleService(proof.databaseUrl);

  const refundFirst = await lifecycle.markRefundPending({
    paymentId,
    processor: 'stripe',
    actorType: 'system',
    source: 'concurrency_proof_refund_first'
  });
  assert.equal(refundFirst.status, 'updated');
  assert.equal((await withdrawals.requestWithdrawal({
    ownerUserId,
    paymentMode: 'test',
    idempotencyKey: 'withdrawal:race:refund-first',
    destinationKind: 'paypal',
    recipientConfirmation: recipient,
    grossAmountCents: 1_000
  })).kind, 'insufficient_balance');

  await db.update(schema.payments).set({ refundStatus: 'not_refunded' })
    .where(eq(schema.payments.id, paymentId));
  blockProvider = true;
  providerEntered = deferred();
  releaseProvider = deferred();
  const withdrawalFirstPromise = withdrawals.requestWithdrawal({
    ownerUserId,
    paymentMode: 'test',
    idempotencyKey: 'withdrawal:race:withdrawal-first',
    destinationKind: 'paypal',
    recipientConfirmation: recipient,
    grossAmountCents: 1_000
  });
  await within(providerEntered.promise, 'withdrawal reservation before provider call');
  const refundAfterReservation = await within(lifecycle.markRefundPending({
    paymentId,
    processor: 'stripe',
    actorType: 'system',
    source: 'concurrency_proof_withdrawal_first'
  }), 'refund after withdrawal reservation');
  assert.equal(refundAfterReservation.status, 'updated');
  releaseProvider.resolve();
  const withdrawalFirst = await within(withdrawalFirstPromise, 'withdrawal provider completion');
  assert.equal(withdrawalFirst.kind, 'created');

  const finalBalance = await withdrawals.getOwnerBalance({ ownerUserId, paymentMode: 'test' });
  assert.equal(finalBalance.kind, 'ok');
  if (finalBalance.kind !== 'ok') throw new Error('missing final balance');
  assert.equal(finalBalance.reservedCents, 1_000);
  assert.equal(finalBalance.availableCents, 0);
  assert.equal(finalBalance.deficitCents, 1_000, 'a later refund must become an explicit deficit after the earlier withdrawal reservation');
  assert.equal((await db.select().from(schema.performerWithdrawals)).length, 1, 'the race must reserve exactly one withdrawal');

  console.log(`Withdrawal/refund lock-order integration test passed (${proof.kind}${proof.kind === 'embedded-postgres' ? '; serialized protocol proof, strict real concurrency not claimed' : ''}).`);
} finally {
  await proof.close();
}
