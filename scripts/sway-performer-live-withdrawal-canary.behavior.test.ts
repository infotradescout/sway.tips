import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { normalizePayoutRecipient } from '../src/payout-destination';
import { createPayoutDestinationStore } from '../src/server/payout-destination-store';
import { createPayoutRecipientCipher } from '../src/server/payout-recipient-crypto';
import { createPerformerWithdrawalService } from '../src/server/performer-withdrawal-service';
import {
  createPerformerKycReviewStore,
  PERFORMER_KYC_PROCESS_APPROVAL_VERSION
} from '../src/server/performer-kyc-review';
import { payPalSenderItemId, type PayPalPayoutsAdapter } from '../src/server/paypal-payouts';

const database = new PGlite();
try {
  const migrationFiles = readdirSync(join(process.cwd(), 'drizzle'))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migrationFile of migrationFiles) {
    const statements = readFileSync(join(process.cwd(), 'drizzle', migrationFile), 'utf8')
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
  const ownerUserId = '11000000-0000-4000-8000-000000000093';
  const reviewerUserId = '11000000-0000-4000-8000-000000000094';
  const performerId = '21000000-0000-4000-8000-000000000093';
  const gigId = '31000000-0000-4000-8000-000000000093';
  await db.insert(schema.users).values([
    { id: ownerUserId, email: 'live-canary@example.test', displayName: 'Live Canary', emailVerifiedAt: new Date() },
    { id: reviewerUserId, email: 'live-reviewer@example.test', displayName: 'Live Reviewer', role: 'admin' }
  ]);
  await db.insert(schema.performers).values({
    id: performerId,
    ownerUserId,
    displayName: 'Live Canary',
    handle: 'live-canary',
    isActive: true
  });
  await db.insert(schema.gigSessions).values({
    id: gigId,
    performerId,
    status: 'closed',
    title: 'live-canary',
    venueName: 'test',
    autoCloseoutAt: new Date()
  });
  await db.insert(schema.payments).values({
    gigId,
    performerId,
    paymentMode: 'live',
    paymentStatus: 'captured',
    processor: 'stripe',
    amountSubtotal: 1_500,
    platformFee: 100,
    amountTotal: 1_600
  });
  const recipient = normalizePayoutRecipient({
    destinationKind: 'paypal',
    recipientType: 'email',
    recipientValue: 'live-recipient@example.test'
  });
  assert.ok(recipient);
  const destinationStore = createPayoutDestinationStore(db, createPayoutRecipientCipher(Buffer.alloc(32, 23)), 'live');
  assert.equal((await destinationStore.saveForOwner({ performerId, ownerUserId, recipient })).kind, 'updated');
  const kycReviewStore = createPerformerKycReviewStore({
    db,
    processApprovalVersion: PERFORMER_KYC_PROCESS_APPROVAL_VERSION
  });
  let providerCalls = 0;
  const provider = {
    mode: 'live' as const,
    feeCents: 25,
    async createPayout(payout: Parameters<PayPalPayoutsAdapter['createPayout']>[0]) {
      providerCalls += 1;
      return {
        payoutBatchId: `LIVE-BATCH-${payout.withdrawalId}`,
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
    async verifyWebhook() {
      throw new Error('not used');
    }
  } as PayPalPayoutsAdapter;
  const service = createPerformerWithdrawalService({
    db,
    destinationStore,
    provider,
    kycReviewStore,
    liveCanaryPerformerId: performerId
  });
  const request = {
    ownerUserId,
    paymentMode: 'live' as const,
    idempotencyKey: 'withdrawal:live:canary-0001',
    destinationKind: 'paypal' as const,
    recipientConfirmation: recipient,
    grossAmountCents: 1_000
  };
  assert.equal((await service.requestWithdrawal(request)).kind, 'identity_verification_required');
  assert.equal(providerCalls, 0);

  assert.equal((await kycReviewStore.approve({
    performerId,
    reviewerUserId,
    evidenceReference: 'paypal-live-canary-review-0001'
  })).kind, 'approved');
  assert.equal((await service.requestWithdrawal({
    ...request,
    idempotencyKey: 'withdrawal:live:wrong-amount',
    grossAmountCents: 1_100
  })).kind, 'live_canary_amount_required');

  const created = await service.requestWithdrawal(request);
  assert.equal(created.kind, 'created');
  assert.equal(providerCalls, 1);
  assert.equal((await service.requestWithdrawal(request)).kind, 'replay');
  assert.equal(providerCalls, 1, 'the live canary replay must never send a second payout');
  assert.equal((await service.requestWithdrawal({
    ...request,
    idempotencyKey: 'withdrawal:live:canary-0002'
  })).kind, 'live_canary_already_used');

  const wrongCanary = createPerformerWithdrawalService({
    db,
    destinationStore,
    provider,
    kycReviewStore,
    liveCanaryPerformerId: '21000000-0000-4000-8000-000000000099'
  });
  assert.equal((await wrongCanary.requestWithdrawal({
    ...request,
    idempotencyKey: 'withdrawal:live:wrong-performer'
  })).kind, 'live_canary_not_allowed');
} finally {
  await database.close();
}

console.log('One-use exact-$10 live PayPal payout canary behavior test passed.');
