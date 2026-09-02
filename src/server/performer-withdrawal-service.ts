import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  payments,
  payoutProcessorEvents,
  performerPayoutPreferences,
  performerWithdrawals,
  performers,
  users
} from '../db/schema';
import type { NormalizedPayoutRecipient, PayoutDestinationKind } from '../payout-destination';
import { writeAuditEvent } from './audit-log';
import type { PayoutDestinationStore } from './payout-destination-store';
import type { PerformerKycReviewStore } from './performer-kyc-review';
import {
  PayPalPayoutsError,
  payPalSenderItemId,
  type PayPalPayoutItem,
  type PayPalPayoutsAdapter,
  type PayPalPayoutWebhook
} from './paypal-payouts';

export const MINIMUM_WITHDRAWAL_CENTS = 1_000;
export const MAX_WITHDRAWAL_SUBMISSION_ATTEMPTS = 12;
const WITHDRAWAL_LEASE_MS = 30_000;
const WITHDRAWAL_RETRY_DELAY_MS = 60_000;
const PAYPAL_PAYOUT_WEBHOOK_EVENT_TYPES = new Set([
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTSBATCH.PROCESSING',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.PAYOUTS-ITEM.DENIED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.HELD',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED'
]);

function normalizeIdempotencyKey(value: unknown) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return /^[a-zA-Z0-9:_-]{16,128}$/.test(key) ? key : null;
}

function statusFromPayPal(status: string) {
  const normalized = status.trim().toUpperCase();
  if (normalized === 'SUCCESS') return 'paid' as const;
  if (normalized === 'UNCLAIMED') return 'unclaimed' as const;
  if (normalized === 'ONHOLD') return 'held' as const;
  if (normalized === 'FAILED' || normalized === 'BLOCKED' || normalized === 'DENIED' || normalized === 'CANCELED') return 'failed' as const;
  if (normalized === 'RETURNED' || normalized === 'REFUNDED' || normalized === 'REVERSED') return 'returned' as const;
  return 'processing' as const;
}

function normalizedProviderFailureCode(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9_.-]{1,120}$/.test(normalized) ? normalized : null;
}

export function persistedPayoutFailureCode(error: unknown, fallback = 'paypal_payout_unknown_error') {
  if (error instanceof PayPalPayoutsError) {
    return normalizedProviderFailureCode(error.providerName)
      ?? (error.status > 0 ? `PAYPAL_HTTP_${error.status}` : 'PAYPAL_NETWORK_ERROR');
  }
  // Never persist/log an arbitrary Error.message. Provider and transport
  // messages can echo the raw recipient.
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function eventBatchId(event: PayPalPayoutWebhook) {
  const direct = event.resource.payout_batch_id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const header = asRecord(event.resource.batch_header);
  return typeof header.payout_batch_id === 'string' && header.payout_batch_id.trim()
    ? header.payout_batch_id.trim()
    : null;
}

function eventSenderItemId(event: PayPalPayoutWebhook) {
  const payoutItem = asRecord(event.resource.payout_item);
  return typeof payoutItem.sender_item_id === 'string' && payoutItem.sender_item_id.trim()
    ? payoutItem.sender_item_id.trim()
    : null;
}

function withdrawalBalanceDebitExpression() {
  return sql<number>`coalesce(sum(case
    when ${performerWithdrawals.status} in ('requested', 'submitting', 'processing', 'unclaimed', 'held')
      then ${performerWithdrawals.grossAmountCents}
    when ${performerWithdrawals.status} = 'paid'
      then ${performerWithdrawals.netAmountCents} + least(
        coalesce(${performerWithdrawals.actualProviderFeeCents}, ${performerWithdrawals.providerFeeCents}),
        ${performerWithdrawals.providerFeeCents}
      )
    when ${performerWithdrawals.status} = 'returned'
      then least(
        coalesce(${performerWithdrawals.actualProviderFeeCents}, ${performerWithdrawals.providerFeeCents}),
        ${performerWithdrawals.providerFeeCents}
      )
    else 0
  end), 0)::int`;
}

function withdrawalRestriction(owner: {
  emailVerifiedAt: Date | null;
  isActive: boolean;
  onboardingStatus: string;
  payoutHoldReason: string | null;
}, input: { paymentMode: 'test' | 'live'; currentKycApproved: boolean }) {
  if (!owner.emailVerifiedAt) return 'email_verification_required' as const;
  if (
    !owner.isActive
    || owner.onboardingStatus === 'restricted'
    || owner.onboardingStatus === 'suspended'
    || owner.payoutHoldReason
  ) return 'account_restricted' as const;
  if (input.paymentMode === 'live' && !input.currentKycApproved) {
    return 'identity_verification_required' as const;
  }
  return null;
}

export function createPerformerWithdrawalService(input: {
  db: SwayDb;
  destinationStore: PayoutDestinationStore;
  provider: PayPalPayoutsAdapter;
  kycReviewStore?: PerformerKycReviewStore | null;
  liveCanaryPerformerId?: string | null;
  now?: () => Date;
}) {
  const { db, destinationStore, provider } = input;
  const kycReviewStore = input.kycReviewStore ?? null;
  const liveCanaryPerformerId = input.liveCanaryPerformerId?.trim().toLowerCase() || null;
  const now = input.now ?? (() => new Date());

  function balanceSnapshot(
    earnings: { pendingCents: number | null; capturedCents: number | null } | undefined,
    withdrawn: { balanceDebitCents: number | null } | undefined
  ) {
    const capturedCents = Number(earnings?.capturedCents ?? 0);
    const balanceDebitCents = Number(withdrawn?.balanceDebitCents ?? 0);
    return {
      pendingCents: Number(earnings?.pendingCents ?? 0),
      capturedCents,
      reservedCents: balanceDebitCents,
      availableCents: Math.max(0, capturedCents - balanceDebitCents),
      deficitCents: Math.max(0, balanceDebitCents - capturedCents),
      currency: 'USD' as const
    };
  }

  async function balancesForPerformer(performerId: string, paymentMode: 'test' | 'live') {
    const [earnings] = await db.select({
      pendingCents: sql<number>`coalesce(sum(case when ${payments.paymentStatus} in ('payment_pending', 'authorized') then ${payments.amountSubtotal} else 0 end), 0)::int`,
      capturedCents: sql<number>`coalesce(sum(case when ${payments.paymentStatus} = 'captured' and ${payments.refundStatus} = 'not_refunded' then ${payments.amountSubtotal} else 0 end), 0)::int`
    }).from(payments).where(and(
      eq(payments.performerId, performerId),
      eq(payments.paymentMode, paymentMode)
    ));
    const [withdrawn] = await db.select({
      balanceDebitCents: withdrawalBalanceDebitExpression()
    }).from(performerWithdrawals).where(and(
      eq(performerWithdrawals.performerId, performerId),
      eq(performerWithdrawals.paymentMode, paymentMode)
    ));
    return balanceSnapshot(earnings, withdrawn);
  }

  async function applyProviderItem(item: PayPalPayoutItem, source: string) {
    return db.transaction(async (tx) => {
      const identityConditions = [eq(performerWithdrawals.providerSenderItemId, item.senderItemId)];
      if (item.payoutItemId) identityConditions.push(eq(performerWithdrawals.providerItemId, item.payoutItemId));
      identityConditions.push(eq(performerWithdrawals.providerPayoutId, item.payoutBatchId));
      const [withdrawal] = await tx.select().from(performerWithdrawals)
        .where(and(
          eq(performerWithdrawals.paymentMode, provider.mode),
          or(...identityConditions)
        ))
        .for('update')
        .limit(1);
      if (!withdrawal) return { kind: 'not_found' } as const;
      if (withdrawal.providerSenderItemId !== item.senderItemId) return { kind: 'identity_conflict' } as const;
      if (withdrawal.providerPayoutId && withdrawal.providerPayoutId !== item.payoutBatchId) {
        return { kind: 'identity_conflict' } as const;
      }
      if (withdrawal.providerItemId && item.payoutItemId && withdrawal.providerItemId !== item.payoutItemId) {
        return { kind: 'identity_conflict' } as const;
      }

      const nextStatus = statusFromPayPal(item.transactionStatus);
      if (withdrawal.status === 'returned' || withdrawal.status === 'failed') {
        return { kind: 'terminal_noop', withdrawal } as const;
      }
      if (withdrawal.status === 'paid' && nextStatus !== 'paid' && nextStatus !== 'returned') {
        return { kind: 'stale_noop', withdrawal } as const;
      }

      const updatedAt = now();
      const actualProviderFeeCents = item.actualProviderFeeCents ?? withdrawal.actualProviderFeeCents;
      const [updated] = await tx.update(performerWithdrawals).set({
        status: nextStatus,
        providerPayoutId: item.payoutBatchId,
        providerItemId: item.payoutItemId ?? withdrawal.providerItemId,
        providerTransactionId: item.transactionId ?? withdrawal.providerTransactionId,
        providerStatus: item.transactionStatus,
        actualProviderFeeCents,
        failureCode: nextStatus === 'failed'
          ? normalizedProviderFailureCode(item.errorName) ?? 'PAYPAL_PAYOUT_FAILED'
          : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        paidAt: nextStatus === 'paid' ? withdrawal.paidAt ?? updatedAt : null,
        returnedAt: nextStatus === 'returned' ? withdrawal.returnedAt ?? updatedAt : null,
        updatedAt
      }).where(eq(performerWithdrawals.id, withdrawal.id)).returning();

      const providerFeeVarianceCents = actualProviderFeeCents === null
        ? null
        : actualProviderFeeCents - withdrawal.providerFeeCents;
      if (providerFeeVarianceCents !== null && providerFeeVarianceCents > 0) {
        // The performer approved only the quoted fee. Sway absorbs an
        // exceptional positive variance and holds future withdrawals until
        // the live quote is corrected and reviewed.
        await tx.update(performers).set({
          payoutHoldReason: `paypal_fee_variance:${withdrawal.id}`,
          updatedAt
        }).where(and(
          eq(performers.id, withdrawal.performerId),
          isNull(performers.payoutHoldReason)
        ));
      }

      if (
        withdrawal.status !== nextStatus
        || withdrawal.providerStatus !== item.transactionStatus
        || withdrawal.actualProviderFeeCents !== actualProviderFeeCents
      ) {
        await writeAuditEvent(tx, {
          actorId: null,
          actorType: 'system',
          entityType: 'performer_withdrawal',
          entityId: withdrawal.id,
          eventType: 'performer_withdrawal.provider_status',
          previousStatus: withdrawal.status,
          nextStatus,
          metadata: {
            provider: 'paypal_payouts',
            providerStatus: item.transactionStatus,
            providerBatchId: item.payoutBatchId,
            providerItemId: item.payoutItemId,
            quotedProviderFeeCents: withdrawal.providerFeeCents,
            actualProviderFeeCents,
            providerFeeVarianceCents,
            performerDebitedFeeCents: actualProviderFeeCents === null
              ? withdrawal.providerFeeCents
              : Math.min(actualProviderFeeCents, withdrawal.providerFeeCents),
            futureWithdrawalsHeldForPositiveVariance: Boolean(
              providerFeeVarianceCents !== null && providerFeeVarianceCents > 0
            ),
            source
          }
        });
      }
      return { kind: 'updated', withdrawal: updated } as const;
    });
  }

  async function claimSubmission(withdrawalId: string) {
    const leaseOwner = `paypal-payout:${process.pid}:${randomUUID()}`;
    const claimedAt = now();
    const leaseExpiresAt = new Date(claimedAt.getTime() + WITHDRAWAL_LEASE_MS);
    const [claimed] = await db.update(performerWithdrawals).set({
      status: 'submitting',
      leaseOwner,
      leaseExpiresAt,
      attemptCount: sql`${performerWithdrawals.attemptCount} + 1`,
      lastAttemptAt: claimedAt,
      updatedAt: claimedAt
    }).where(and(
      eq(performerWithdrawals.id, withdrawalId),
      eq(performerWithdrawals.paymentMode, provider.mode),
      or(
        eq(performerWithdrawals.status, 'requested'),
        and(eq(performerWithdrawals.status, 'submitting'), lt(performerWithdrawals.leaseExpiresAt, claimedAt))
      ),
      lt(performerWithdrawals.attemptCount, MAX_WITHDRAWAL_SUBMISSION_ATTEMPTS)
    )).returning();
    return claimed ? { claimed, leaseOwner } : null;
  }

  async function submit(withdrawalId: string) {
    const claim = await claimSubmission(withdrawalId);
    if (!claim) {
      const [current] = await db.select().from(performerWithdrawals)
        .where(eq(performerWithdrawals.id, withdrawalId)).limit(1);
      return { kind: 'not_claimed', withdrawal: current ?? null } as const;
    }

    try {
      const destination = await destinationStore.loadForPerformer(claim.claimed.performerId);
      if (
        !destination
        || destination.destinationKind !== claim.claimed.destinationKind
        || destination.recipientType !== claim.claimed.recipientType
        || destination.recipientFingerprint !== claim.claimed.recipientFingerprint
      ) {
        throw new PayPalPayoutsError({
          message: 'payout_destination_changed_before_submission',
          status: 422,
          retryable: false,
          providerName: 'DESTINATION_CHANGED'
        });
      }

      const created = await provider.createPayout({
        withdrawalId: claim.claimed.id,
        destinationKind: claim.claimed.destinationKind as PayoutDestinationKind,
        recipientType: destination.recipientType,
        recipientValue: destination.recipientValue,
        netAmountCents: claim.claimed.netAmountCents
      });
      if (created.senderItemId !== claim.claimed.providerSenderItemId) {
        throw new PayPalPayoutsError({
          message: 'paypal_sender_item_identity_mismatch',
          status: 502,
          retryable: false,
          providerName: 'IDENTITY_MISMATCH'
        });
      }
      const submittedAt = now();
      const immediateStatus = statusFromPayPal(created.batchStatus);
      const immediatelyRejected = immediateStatus === 'failed';
      const submitted = await db.transaction(async (tx) => {
        const [updated] = await tx.update(performerWithdrawals).set({
          status: immediatelyRejected ? 'failed' : 'processing',
          providerPayoutId: created.payoutBatchId,
          providerStatus: created.batchStatus,
          failureCode: immediatelyRejected ? 'PAYPAL_BATCH_DENIED' : null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: submittedAt
        }).where(and(
          eq(performerWithdrawals.id, claim.claimed.id),
          eq(performerWithdrawals.paymentMode, provider.mode),
          eq(performerWithdrawals.status, 'submitting'),
          eq(performerWithdrawals.leaseOwner, claim.leaseOwner)
        )).returning();
        if (!updated) return null;

        await writeAuditEvent(tx, {
          actorId: claim.claimed.ownerUserId,
          actorType: 'performer',
          entityType: 'performer_withdrawal',
          entityId: claim.claimed.id,
          eventType: immediatelyRejected
            ? 'performer_withdrawal.submission_failed'
            : 'performer_withdrawal.submitted',
          previousStatus: 'submitting',
          nextStatus: immediatelyRejected ? 'failed' : 'processing',
          metadata: {
            provider: 'paypal_payouts',
            providerBatchId: created.payoutBatchId,
            providerStatus: created.batchStatus,
            failureCode: immediatelyRejected ? 'PAYPAL_BATCH_DENIED' : null,
            rawRecipientStoredInAudit: false
          }
        });
        return updated;
      });
      if (!submitted) return { kind: 'lease_lost' } as const;

      if (immediatelyRejected) {
        return {
          kind: 'terminal_error',
          withdrawal: submitted,
          failureCode: 'PAYPAL_BATCH_DENIED'
        } as const;
      }

      const batch = await provider.getBatch(created.payoutBatchId, created.senderItemId).catch(() => null);
      if (batch?.item) {
        const applied = await applyProviderItem(batch.item, 'submission_readback');
        return { kind: 'submitted', withdrawal: 'withdrawal' in applied ? applied.withdrawal : submitted } as const;
      }
      return { kind: 'submitted', withdrawal: submitted } as const;
    } catch (error) {
      const retryable = error instanceof PayPalPayoutsError ? error.retryable : true;
      const retryExhausted = retryable
        && claim.claimed.attemptCount >= MAX_WITHDRAWAL_SUBMISSION_ATTEMPTS;
      const failureCode = persistedPayoutFailureCode(error);
      const nextStatus = retryExhausted ? 'held' : retryable ? 'requested' : 'failed';
      const updated = await db.transaction(async (tx) => {
        const [next] = await tx.update(performerWithdrawals).set({
          status: nextStatus,
          failureCode: retryExhausted
            ? 'paypal_payout_retry_exhausted'
            : retryable ? null : failureCode.slice(0, 120),
          lastError: failureCode.slice(0, 500),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now()
        }).where(and(
          eq(performerWithdrawals.id, claim.claimed.id),
          eq(performerWithdrawals.paymentMode, provider.mode),
          eq(performerWithdrawals.status, 'submitting'),
          eq(performerWithdrawals.leaseOwner, claim.leaseOwner)
        )).returning();
        if (next && nextStatus !== 'requested') {
          await writeAuditEvent(tx, {
            actorId: null,
            actorType: 'system',
            entityType: 'performer_withdrawal',
            entityId: next.id,
            eventType: nextStatus === 'held'
              ? 'performer_withdrawal.submission_review_required'
              : 'performer_withdrawal.submission_failed',
            previousStatus: 'submitting',
            nextStatus,
            metadata: { provider: 'paypal_payouts', failureCode: next.failureCode }
          });
        }
        return next ?? null;
      });
      return {
        kind: retryExhausted ? 'held_for_review' : retryable ? 'retryable_error' : 'terminal_error',
        withdrawal: updated ?? claim.claimed,
        failureCode
      } as const;
    }
  }

  return {
    async getOwnerBalance(inputBalance: { ownerUserId: string; paymentMode: 'test' | 'live' }) {
      const [owner] = await db.select({
        performerId: performers.id,
        emailVerifiedAt: users.emailVerifiedAt,
        isActive: performers.isActive,
        onboardingStatus: performers.onboardingStatus,
        payoutHoldReason: performers.payoutHoldReason
      })
        .from(performers)
        .innerJoin(users, eq(users.id, performers.ownerUserId))
        .where(eq(performers.ownerUserId, inputBalance.ownerUserId))
        .limit(1);
      if (!owner) return { kind: 'not_found' } as const;
      const currentKycApproved = inputBalance.paymentMode === 'test'
        || Boolean(await kycReviewStore?.loadCurrentApproval(owner.performerId));
      return {
        kind: 'ok',
        performerId: owner.performerId,
        providerFeeCents: provider.feeCents,
        withdrawalRestriction: withdrawalRestriction(owner, {
          paymentMode: inputBalance.paymentMode,
          currentKycApproved
        }),
        ...(await balancesForPerformer(owner.performerId, inputBalance.paymentMode))
      } as const;
    },

    async requestWithdrawal(request: {
      ownerUserId: string;
      paymentMode: 'test' | 'live';
      idempotencyKey: unknown;
      destinationKind: PayoutDestinationKind;
      recipientConfirmation: NormalizedPayoutRecipient;
      grossAmountCents: number;
    }) {
      const idempotencyKey = normalizeIdempotencyKey(request.idempotencyKey);
      if (!idempotencyKey) return { kind: 'invalid_idempotency_key' } as const;
      if (request.recipientConfirmation.destinationKind !== request.destinationKind) {
        return { kind: 'invalid_recipient_confirmation' } as const;
      }
      if (provider.mode !== request.paymentMode) return { kind: 'provider_mode_mismatch' } as const;
      if (!Number.isSafeInteger(request.grossAmountCents) || request.grossAmountCents < MINIMUM_WITHDRAWAL_CENTS) {
        return { kind: 'below_minimum' } as const;
      }

      const reservation = await db.transaction(async (tx) => {
        const [owner] = await tx.select({
          performerId: performers.id,
          emailVerifiedAt: users.emailVerifiedAt,
          isActive: performers.isActive,
          onboardingStatus: performers.onboardingStatus,
          payoutHoldReason: performers.payoutHoldReason
        })
          .from(performers)
          .innerJoin(users, eq(users.id, performers.ownerUserId))
          .where(eq(performers.ownerUserId, request.ownerUserId))
          .for('update')
          .limit(1);
        if (!owner) return { kind: 'not_found' } as const;
        const currentKycApproved = request.paymentMode === 'test'
          || Boolean(await kycReviewStore?.loadCurrentApproval(owner.performerId, tx));
        const restriction = withdrawalRestriction(owner, {
          paymentMode: request.paymentMode,
          currentKycApproved
        });
        if (restriction === 'email_verification_required') return { kind: restriction } as const;
        if (restriction === 'account_restricted') return { kind: restriction } as const;
        if (restriction === 'identity_verification_required') return { kind: restriction } as const;

        if (request.paymentMode === 'live') {
          if (!liveCanaryPerformerId || owner.performerId.toLowerCase() !== liveCanaryPerformerId) {
            return { kind: 'live_canary_not_allowed' } as const;
          }
          if (request.grossAmountCents !== MINIMUM_WITHDRAWAL_CENTS) {
            return { kind: 'live_canary_amount_required' } as const;
          }
        }

        const [destination] = await tx.select({
          destinationKind: performerPayoutPreferences.destinationKind,
          recipientType: performerPayoutPreferences.recipientType,
          recipientFingerprint: performerPayoutPreferences.recipientValueFingerprint,
          recipientPreview: performerPayoutPreferences.recipientValuePreview
        }).from(performerPayoutPreferences)
          .where(and(
            eq(performerPayoutPreferences.performerId, owner.performerId),
            eq(performerPayoutPreferences.paymentMode, request.paymentMode)
          ))
          .for('update')
          .limit(1);
        if (!destination || destination.destinationKind !== request.destinationKind) {
          return { kind: 'destination_not_ready' } as const;
        }
        const confirmedRecipientFingerprint = destinationStore.fingerprintRecipient({
          performerId: owner.performerId,
          recipient: request.recipientConfirmation
        });
        if (
          destination.recipientType !== request.recipientConfirmation.recipientType
          || destination.recipientFingerprint !== confirmedRecipientFingerprint
        ) {
          return { kind: 'destination_changed' } as const;
        }

        const [existing] = await tx.select().from(performerWithdrawals).where(and(
          eq(performerWithdrawals.performerId, owner.performerId),
          eq(performerWithdrawals.idempotencyKey, idempotencyKey)
        )).limit(1);
        if (existing) {
          const sameIntent = existing.destinationKind === request.destinationKind
            && existing.recipientType === destination.recipientType
            && existing.recipientFingerprint === destination.recipientFingerprint
            && existing.paymentMode === request.paymentMode
            && existing.grossAmountCents === request.grossAmountCents;
          return sameIntent
            ? { kind: 'replay', withdrawal: existing } as const
            : { kind: 'idempotency_conflict' } as const;
        }

        if (request.paymentMode === 'live') {
          const [priorLiveCanary] = await tx.select({ id: performerWithdrawals.id })
            .from(performerWithdrawals)
            .where(and(
              eq(performerWithdrawals.performerId, owner.performerId),
              eq(performerWithdrawals.paymentMode, 'live')
            ))
            .limit(1);
          if (priorLiveCanary) return { kind: 'live_canary_already_used' } as const;
        }

        // Lock the same payment rows included by the balance aggregates. The
        // lifecycle locks performer -> payment in this order too, eliminating
        // the refund/dispute-versus-withdrawal snapshot race.
        await tx.select({ id: payments.id }).from(payments).where(and(
          eq(payments.performerId, owner.performerId),
          eq(payments.paymentMode, request.paymentMode)
        )).orderBy(asc(payments.id)).for('update');

        const [earnings] = await tx.select({
          pendingCents: sql<number>`coalesce(sum(case when ${payments.paymentStatus} in ('payment_pending', 'authorized') then ${payments.amountSubtotal} else 0 end), 0)::int`,
          capturedCents: sql<number>`coalesce(sum(case when ${payments.paymentStatus} = 'captured' and ${payments.refundStatus} = 'not_refunded' then ${payments.amountSubtotal} else 0 end), 0)::int`
        }).from(payments).where(and(
          eq(payments.performerId, owner.performerId),
          eq(payments.paymentMode, request.paymentMode)
        ));
        const [withdrawn] = await tx.select({
          balanceDebitCents: withdrawalBalanceDebitExpression()
        }).from(performerWithdrawals).where(and(
          eq(performerWithdrawals.performerId, owner.performerId),
          eq(performerWithdrawals.paymentMode, request.paymentMode)
        ));
        const balances = balanceSnapshot(earnings, withdrawn);
        if (balances.deficitCents > 0) return { kind: 'negative_balance', deficitCents: balances.deficitCents } as const;
        if (request.grossAmountCents > balances.availableCents) {
          return { kind: 'insufficient_balance', availableCents: balances.availableCents } as const;
        }
        const netAmountCents = request.grossAmountCents - provider.feeCents;
        if (netAmountCents <= 0) return { kind: 'fee_exceeds_amount' } as const;

        const withdrawalId = randomUUID();
        const [withdrawal] = await tx.insert(performerWithdrawals).values({
          id: withdrawalId,
          performerId: owner.performerId,
          ownerUserId: request.ownerUserId,
          idempotencyKey,
          destinationKind: request.destinationKind,
          recipientType: destination.recipientType,
          recipientFingerprint: destination.recipientFingerprint,
          recipientPreview: destination.recipientPreview,
          paymentMode: request.paymentMode,
          deliverySpeed: 'provider',
          status: 'requested',
          grossAmountCents: request.grossAmountCents,
          providerFeeCents: provider.feeCents,
          netAmountCents,
          provider: 'paypal_payouts',
          providerSenderItemId: payPalSenderItemId(withdrawalId)
        }).returning();

        await writeAuditEvent(tx, {
          actorId: request.ownerUserId,
          actorType: 'performer',
          entityType: 'performer_withdrawal',
          entityId: withdrawal.id,
          eventType: 'performer_withdrawal.request',
          previousStatus: null,
          nextStatus: 'requested',
          metadata: {
            grossAmountCents: request.grossAmountCents,
            quotedProviderFeeCents: provider.feeCents,
            netAmountCents,
            destinationKind: request.destinationKind,
            recipientType: destination.recipientType,
            recipientPreview: destination.recipientPreview,
            paymentMode: request.paymentMode,
            provider: 'paypal_payouts',
            swayPayoutMarkupCents: 0,
            rawRecipientStoredInAudit: false
          }
        });
        return { kind: 'created', withdrawal } as const;
      });

      if (reservation.kind !== 'created' && reservation.kind !== 'replay') return reservation;
      if (!['requested', 'submitting'].includes(reservation.withdrawal.status)) return reservation;
      const submission = await submit(reservation.withdrawal.id);
      if (submission.kind === 'retryable_error') {
        return { kind: 'provider_retryable', withdrawal: submission.withdrawal } as const;
      }
      if (submission.kind === 'terminal_error') {
        return { kind: 'provider_rejected', withdrawal: submission.withdrawal } as const;
      }
      if (submission.kind === 'held_for_review') {
        return { kind: 'provider_review_required', withdrawal: submission.withdrawal } as const;
      }
      if (submission.kind === 'lease_lost' || submission.kind === 'not_claimed') {
        return {
          kind: 'processing',
          withdrawal: submission.kind === 'not_claimed' ? submission.withdrawal : reservation.withdrawal
        } as const;
      }
      return { kind: reservation.kind, withdrawal: submission.withdrawal } as const;
    },

    async ingestWebhook(webhook: {
      event: PayPalPayoutWebhook;
      rawBody: string;
      paymentMode: 'test' | 'live';
    }) {
      if (webhook.paymentMode !== provider.mode) throw new Error('paypal_payout_webhook_mode_mismatch');
      const payloadSha256 = createHash('sha256').update(webhook.rawBody, 'utf8').digest('hex');
      const payoutBatchId = eventBatchId(webhook.event);
      const senderItemId = eventSenderItemId(webhook.event);
      const [inserted] = await db.insert(payoutProcessorEvents).values({
        provider: 'paypal_payouts',
        providerEventId: webhook.event.providerEventId,
        eventType: webhook.event.eventType,
        payloadSha256,
        payload: {
          providerEventId: webhook.event.providerEventId,
          eventType: webhook.event.eventType,
          payoutBatchId,
          senderItemId,
          rawRecipientStored: false
        },
        paymentMode: webhook.paymentMode
      }).onConflictDoNothing({
        target: [payoutProcessorEvents.provider, payoutProcessorEvents.providerEventId]
      }).returning();
      const [eventRow] = inserted
        ? [inserted]
        : await db.select().from(payoutProcessorEvents).where(and(
            eq(payoutProcessorEvents.provider, 'paypal_payouts'),
            eq(payoutProcessorEvents.providerEventId, webhook.event.providerEventId)
          )).limit(1);
      if (!eventRow) throw new Error('paypal_payout_webhook_event_missing');
      if (eventRow.payloadSha256 !== payloadSha256) throw new Error('paypal_payout_webhook_replay_mismatch');
      if (eventRow.status === 'processed' || eventRow.status === 'ignored') return { kind: 'duplicate' } as const;

      if (
        !PAYPAL_PAYOUT_WEBHOOK_EVENT_TYPES.has(webhook.event.eventType.trim().toUpperCase())
        || !payoutBatchId
      ) {
        await db.update(payoutProcessorEvents).set({ status: 'ignored', processedAt: now() })
          .where(eq(payoutProcessorEvents.id, eventRow.id));
        return { kind: 'ignored' } as const;
      }
      try {
        const batch = await provider.getBatch(payoutBatchId, senderItemId ?? undefined);
        if (!batch.item) throw new Error('paypal_payout_webhook_item_not_ready');
        const applied = await applyProviderItem(batch.item, `webhook:${webhook.event.providerEventId}`);
        await db.update(payoutProcessorEvents).set({
          withdrawalId: 'withdrawal' in applied ? applied.withdrawal.id : null,
          status: applied.kind === 'not_found' ? 'ignored' : 'processed',
          processedAt: now(),
          lastError: null
        }).where(eq(payoutProcessorEvents.id, eventRow.id));
        return { kind: applied.kind, applied } as const;
      } catch (error) {
        const safeFailureCode = persistedPayoutFailureCode(error, 'paypal_payout_webhook_failed');
        await db.update(payoutProcessorEvents).set({
          status: 'failed',
          lastError: safeFailureCode.slice(0, 500)
        }).where(eq(payoutProcessorEvents.id, eventRow.id));
        throw error;
      }
    },

    async reconcilePending(limit = 20) {
      const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
      const reconciliationTime = now();
      const retryBefore = new Date(reconciliationTime.getTime() - WITHDRAWAL_RETRY_DELAY_MS);
      const results: Array<Record<string, unknown>> = [];

      // Provider truth has priority over new/retried submissions. A large
      // requested backlog must never starve a paid, returned, or failed payout
      // that is already holding a performer's balance.
      const providerRows = await db.select({
        id: performerWithdrawals.id,
        providerPayoutId: performerWithdrawals.providerPayoutId,
        providerSenderItemId: performerWithdrawals.providerSenderItemId
      }).from(performerWithdrawals).where(and(
        eq(performerWithdrawals.paymentMode, provider.mode),
        inArray(performerWithdrawals.status, ['processing', 'unclaimed', 'held']),
        isNotNull(performerWithdrawals.providerPayoutId)
      )).orderBy(asc(performerWithdrawals.updatedAt)).limit(boundedLimit);
      for (const row of providerRows) {
        try {
          const batch = await provider.getBatch(row.providerPayoutId!, row.providerSenderItemId ?? undefined);
          results.push(batch.item
            ? await applyProviderItem(batch.item, 'scheduled_reconciliation')
            : { kind: 'item_pending', withdrawalId: row.id });
        } catch (error) {
          results.push({
            kind: 'error',
            withdrawalId: row.id,
            error: persistedPayoutFailureCode(error, 'paypal_payout_reconciliation_failed')
          });
        }
      }

      let remaining = boundedLimit - results.length;
      if (remaining <= 0) return results;
      const exhaustedRows = await db.select({
        id: performerWithdrawals.id,
        status: performerWithdrawals.status
      })
        .from(performerWithdrawals)
        .where(and(
          eq(performerWithdrawals.paymentMode, provider.mode),
          or(
            eq(performerWithdrawals.status, 'requested'),
            and(eq(performerWithdrawals.status, 'submitting'), lt(performerWithdrawals.leaseExpiresAt, reconciliationTime))
          ),
          gte(performerWithdrawals.attemptCount, MAX_WITHDRAWAL_SUBMISSION_ATTEMPTS)
        ))
        .limit(remaining);
      for (const row of exhaustedRows) {
        const held = await db.transaction(async (tx) => {
          const [updated] = await tx.update(performerWithdrawals).set({
            status: 'held',
            failureCode: 'paypal_payout_retry_exhausted',
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: now()
          }).where(and(
            eq(performerWithdrawals.id, row.id),
            eq(performerWithdrawals.paymentMode, provider.mode),
            inArray(performerWithdrawals.status, ['requested', 'submitting'])
          )).returning();
          if (!updated) return null;
          await writeAuditEvent(tx, {
            actorId: null,
            actorType: 'system',
            entityType: 'performer_withdrawal',
            entityId: updated.id,
            eventType: 'performer_withdrawal.submission_review_required',
            previousStatus: row.status,
            nextStatus: 'held',
            metadata: {
              provider: 'paypal_payouts',
              failureCode: 'paypal_payout_retry_exhausted'
            }
          });
          return updated;
        });
        if (held) results.push({ kind: 'held_for_review', withdrawalId: held.id });
      }

      remaining = boundedLimit - results.length;
      if (remaining <= 0) return results;
      const retryRows = await db.select({ id: performerWithdrawals.id })
        .from(performerWithdrawals)
        .where(and(
          eq(performerWithdrawals.paymentMode, provider.mode),
          or(
            and(
              eq(performerWithdrawals.status, 'requested'),
              or(isNull(performerWithdrawals.lastAttemptAt), lt(performerWithdrawals.lastAttemptAt, retryBefore))
            ),
            and(
              eq(performerWithdrawals.status, 'submitting'),
              lt(performerWithdrawals.leaseExpiresAt, reconciliationTime)
            )
          ),
          lt(performerWithdrawals.attemptCount, MAX_WITHDRAWAL_SUBMISSION_ATTEMPTS)
        ))
        .limit(remaining);
      for (const row of retryRows) results.push(await submit(row.id));
      return results;
    }
  };
}
