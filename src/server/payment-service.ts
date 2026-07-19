import { and, eq, inArray, sql } from 'drizzle-orm';
import { createSwayDb } from '../db/client';
import { payments, gigSessions, performers } from '../db/schema';
import type { PaymentProviderAdapter } from './payment-provider';
import { createPaymentLifecycleService } from './payment-lifecycle';
import { resolveSwayPlatformFeePolicyForGig } from './partner-entitlement-store';

export type AuthorizeActionInput = {
  gigId: string;
  actionType: 'tip' | 'request' | 'boost' | 'bump' | 'vip';
  amountSubtotalCents: number;
  // The fee Sway proposes before any Brand Partner cap -- resolveSwayPlatformFeePolicyForGig
  // may clamp this down; the persisted platformFee always reflects the post-cap amount.
  platformFeeCents: number;
  platformFeePayer?: 'patron' | 'performer';
  attributionSource: 'creator_direct' | 'sway_promoted';
  campaignId: string | null;
  commissionBpsApplied: number | null;
  currency: string;
  idempotencyKey: string;
  runtimeRequestId?: string | null;
  clientRequestId?: string | null;
  paymentMethod?: string;
  confirm?: boolean;
  metadata?: Record<string, string>;
};

export type ConfirmAuthorizedActionInput = Omit<AuthorizeActionInput, 'idempotencyKey' | 'paymentMethod' | 'confirm'> & {
  processorPaymentIntentId: string;
};

export type AuthorizeActionResult =
  | { status: 'disabled' }
  // 'authorized' is returned ONLY when the provider confirms the funds are held
  // (PaymentIntent requires_capture). A request may enter app state / triage only
  // on this result.
  | { status: 'authorized'; paymentId: string; processorPaymentIntentId: string; clientSecret: string | null; platformFeeCents: number; platformFeeCapCents: number | null; partnerTermsVersion: string | null; partnerTermsHash: string | null }
  // 'requires_confirmation' means a PaymentIntent exists but is not yet a hold.
  // The caller MUST NOT create app state; the patron must confirm the payment
  // (via clientSecret) before the action can proceed.
  | { status: 'requires_confirmation'; paymentId: string; processorPaymentIntentId: string; clientSecret: string | null; providerStatus: string; platformFeeCents: number; platformFeeCapCents: number | null; partnerTermsVersion: string | null; partnerTermsHash: string | null }
  | { status: 'failed'; reason: string };

export type SettleResult =
  | { status: 'disabled' }
  | { status: 'noop' }
  | { status: 'captured' | 'voided' | 'refunded'; paymentId: string }
  | { status: 'failed'; reason: string };

export type CloseoutTotals = {
  source: 'database_captured_payments';
  capturedCount: number;
  capturedSubtotalCents: number;
  capturedTotalCents: number;
  platformFeeCents: number;
};

export function calculateSwayPaymentAmounts(input: {
  amountSubtotalCents: number;
  platformFeeCents: number;
  platformFeePayer?: 'patron' | 'performer';
}) {
  const platformFeePayer = input.platformFeePayer === 'performer' ? 'performer' : 'patron';
  const platformFeeChargedToPatronCents = platformFeePayer === 'patron'
    ? input.platformFeeCents
    : 0;

  return {
    amountSubtotalCents: input.amountSubtotalCents,
    platformFeeCents: input.platformFeeCents,
    platformFeePayer,
    platformFeeChargedToPatronCents,
    amountTotalCents: input.amountSubtotalCents + platformFeeChargedToPatronCents
  };
}

/**
 * Provider-backed payment orchestration.
 *
 * Every transition is persisted: a `payments` row plus `payment_events` and
 * `audit_events` rows written by the finite-state lifecycle service. Closeout
 * totals aggregate exclusively from captured `payments` rows in the database,
 * never from runtime arrays. When no provider/database is configured the service
 * is disabled and fails safe: it never fabricates a successful financial state.
 */
export function createPaymentService(config: {
  databaseUrl?: string;
  provider: PaymentProviderAdapter | null;
}) {
  const db = config.databaseUrl ? createSwayDb(config.databaseUrl) : null;
  const provider = config.provider;
  const lifecycle = createPaymentLifecycleService(config.databaseUrl);
  const enabled = Boolean(db && provider);

  function isEnabled() {
    return enabled;
  }

  async function authorizeAction(input: AuthorizeActionInput): Promise<AuthorizeActionResult> {
    if (!db || !provider) {
      return { status: 'disabled' };
    }

    let feePolicy;
    try {
      feePolicy = await resolveSwayPlatformFeePolicyForGig({
        db,
        gigId: input.gigId,
        proposedPlatformFeeCents: input.platformFeeCents
      });
    } catch {
      return { status: 'failed', reason: 'platform_fee_policy_unavailable' };
    }

    const {
      platformFeePayer,
      platformFeeChargedToPatronCents,
      amountTotalCents
    } = calculateSwayPaymentAmounts({
      amountSubtotalCents: input.amountSubtotalCents,
      platformFeeCents: feePolicy.platformFeeCents,
      platformFeePayer: input.platformFeePayer
    });

    const [created] = await db
      .insert(payments)
      .values({
        gigId: input.gigId,
        requestId: null,
        requestBoostId: null,
        paymentStatus: 'created',
        processor: provider.processor,
        amountSubtotal: input.amountSubtotalCents,
        platformFee: feePolicy.platformFeeCents,
        amountTotal: amountTotalCents,
        currency: input.currency,
        attributionSource: input.attributionSource,
        campaignId: input.campaignId,
        commissionBpsApplied: input.commissionBpsApplied,
        captureMode: 'manual'
      })
      .returning({ id: payments.id });

    const paymentId = created.id;

    // Passthrough target: only attached when the performer has a Stripe
    // Connect account that can actually accept charges. If not (not yet
    // connected, or still onboarding), the charge still proceeds without a
    // destination -- paid actions are never blocked on Connect onboarding.
    const [destinationRow] = await db
      .select({
        stripeConnectedAccountId: performers.stripeConnectedAccountId,
        chargesEnabled: performers.chargesEnabled
      })
      .from(gigSessions)
      .innerJoin(performers, eq(performers.id, gigSessions.performerId))
      .where(eq(gigSessions.id, input.gigId))
      .limit(1);

    const destinationAccountId = destinationRow?.chargesEnabled
      ? destinationRow.stripeConnectedAccountId ?? undefined
      : undefined;

    try {
      const authorization = await provider.authorizePayment({
        amountTotalCents,
        currency: input.currency,
        idempotencyKey: `authorize:${input.idempotencyKey}`,
        paymentMethod: input.paymentMethod,
        confirm: input.confirm,
        ...(destinationAccountId
          ? { destinationAccountId, applicationFeeAmountCents: feePolicy.platformFeeCents }
          : {}),
        metadata: {
          sway_payment_id: paymentId,
          sway_gig_id: input.gigId,
          sway_action_type: input.actionType,
          sway_platform_fee_cents: String(feePolicy.platformFeeCents),
          sway_platform_fee_payer: platformFeePayer,
          sway_platform_fee_charged_to_patron_cents: String(platformFeeChargedToPatronCents),
          ...(feePolicy.platformFeeCapCents === null ? {} : { sway_platform_fee_cap_cents: String(feePolicy.platformFeeCapCents) }),
          ...(feePolicy.partnerTermsVersion ? { sway_partner_terms_version: feePolicy.partnerTermsVersion } : {}),
          ...(feePolicy.partnerTermsHash ? { sway_partner_terms_hash: feePolicy.partnerTermsHash } : {}),
          ...(input.runtimeRequestId ? { sway_runtime_request_id: input.runtimeRequestId } : {}),
          ...(input.clientRequestId ? { sway_client_request_id: input.clientRequestId } : {}),
          ...(input.metadata ?? {})
        }
      });

      await db
        .update(payments)
        .set({
          processorPaymentIntentId: authorization.processorPaymentIntentId,
          processorChargeId: authorization.processorChargeId,
          updatedAt: new Date()
        })
        .where(eq(payments.id, paymentId));

      await lifecycle.transitionPaymentState({
        paymentId,
        processor: provider.processor,
        nextStatus: 'payment_pending',
        eventType: 'payment.authorization.requested',
        actorType: 'system',
        metadata: {
          processorPaymentIntentId: authorization.processorPaymentIntentId,
          actionType: input.actionType
        }
      });

      // Funds are only "authorized" (capturable) once the PaymentIntent reaches
      // requires_capture. Until then the action must NOT enter app state: we
      // return requires_confirmation so the caller can have the patron confirm
      // their card (clientSecret) before any request/boost/tip is created.
      const capturable = authorization.status === 'requires_capture';
      if (!capturable) {
        return {
          status: 'requires_confirmation',
          paymentId,
          processorPaymentIntentId: authorization.processorPaymentIntentId,
          clientSecret: authorization.clientSecret,
          providerStatus: authorization.status,
          ...feePolicy
        };
      }

      await lifecycle.transitionPaymentState({
        paymentId,
        processor: provider.processor,
        nextStatus: 'authorized',
        eventType: 'payment_intent.amount_capturable_updated',
        processorEventId: authorization.processorPaymentIntentId,
        actorType: 'system',
        metadata: {
          processorPaymentIntentId: authorization.processorPaymentIntentId,
          providerStatus: authorization.status
        }
      });

      return {
        status: 'authorized',
        paymentId,
        processorPaymentIntentId: authorization.processorPaymentIntentId,
        clientSecret: authorization.clientSecret,
        ...feePolicy
      };
    } catch (error) {
      // Fail safe: mark the payment failed so no successful financial state exists.
      await lifecycle.transitionPaymentState({
        paymentId,
        processor: provider.processor,
        nextStatus: 'failed',
        eventType: 'payment.authorization.failed',
        actorType: 'system',
        metadata: { reason: error instanceof Error ? error.message : 'unknown_provider_error' }
      }).catch(() => undefined);

      return { status: 'failed', reason: error instanceof Error ? error.message : 'unknown_provider_error' };
    }
  }

  async function confirmAuthorizedAction(input: ConfirmAuthorizedActionInput): Promise<AuthorizeActionResult> {
    if (!db || !provider) {
      return { status: 'disabled' };
    }

    let feePolicy;
    try {
      feePolicy = await resolveSwayPlatformFeePolicyForGig({
        db,
        gigId: input.gigId,
        proposedPlatformFeeCents: input.platformFeeCents
      });
    } catch {
      return { status: 'failed', reason: 'platform_fee_policy_unavailable' };
    }

    const { amountTotalCents } = calculateSwayPaymentAmounts({
      amountSubtotalCents: input.amountSubtotalCents,
      platformFeeCents: feePolicy.platformFeeCents,
      platformFeePayer: input.platformFeePayer
    });
    const [payment] = await db
      .select({
        id: payments.id,
        gigId: payments.gigId,
        paymentStatus: payments.paymentStatus,
        processorPaymentIntentId: payments.processorPaymentIntentId,
        processorChargeId: payments.processorChargeId,
        amountSubtotal: payments.amountSubtotal,
        platformFee: payments.platformFee,
        amountTotal: payments.amountTotal,
        currency: payments.currency,
        attributionSource: payments.attributionSource,
        campaignId: payments.campaignId,
        commissionBpsApplied: payments.commissionBpsApplied
      })
      .from(payments)
      .where(eq(payments.processorPaymentIntentId, input.processorPaymentIntentId))
      .limit(1);

    if (!payment || !payment.processorPaymentIntentId) {
      return { status: 'failed', reason: 'payment_intent_not_found' };
    }

    const sameFinancialIntent =
      payment.gigId === input.gigId
      && payment.amountSubtotal === input.amountSubtotalCents
      && payment.platformFee === feePolicy.platformFeeCents
      && payment.amountTotal === amountTotalCents
      && payment.currency.toUpperCase() === input.currency.toUpperCase()
      && payment.attributionSource === input.attributionSource
      && payment.campaignId === input.campaignId
      && payment.commissionBpsApplied === input.commissionBpsApplied;

    if (!sameFinancialIntent) {
      return { status: 'failed', reason: 'payment_intent_mismatch' };
    }

    if (payment.paymentStatus === 'authorized') {
      return {
        status: 'authorized',
        paymentId: payment.id,
        processorPaymentIntentId: payment.processorPaymentIntentId,
        clientSecret: null,
        ...feePolicy
      };
    }

    if (payment.paymentStatus !== 'payment_pending') {
      return { status: 'failed', reason: `payment_intent_not_capturable_from_${payment.paymentStatus}` };
    }

    try {
      const authorization = await provider.retrievePaymentAuthorization(input.processorPaymentIntentId);
      if (
        input.clientRequestId
        && authorization.metadata?.sway_client_request_id
        && authorization.metadata.sway_client_request_id !== input.clientRequestId
      ) {
        return { status: 'failed', reason: 'payment_intent_client_request_mismatch' };
      }

      await db
        .update(payments)
        .set({
          processorChargeId: authorization.processorChargeId,
          updatedAt: new Date()
        })
        .where(eq(payments.id, payment.id));

      const capturable = authorization.status === 'requires_capture';
      if (!capturable) {
        return {
          status: 'requires_confirmation',
          paymentId: payment.id,
          processorPaymentIntentId: authorization.processorPaymentIntentId,
          clientSecret: authorization.clientSecret,
          providerStatus: authorization.status,
          ...feePolicy
        };
      }

      await lifecycle.transitionPaymentState({
        paymentId: payment.id,
        processor: provider.processor,
        nextStatus: 'authorized',
        eventType: 'payment_intent.amount_capturable_updated',
        processorEventId: `client_confirmed:${authorization.processorPaymentIntentId}`,
        actorType: 'system',
        metadata: {
          processorPaymentIntentId: authorization.processorPaymentIntentId,
          providerStatus: authorization.status,
          actionType: input.actionType
        }
      });

      return {
        status: 'authorized',
        paymentId: payment.id,
        processorPaymentIntentId: authorization.processorPaymentIntentId,
        clientSecret: authorization.clientSecret,
        ...feePolicy
      };
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error ? error.message : 'unknown_provider_error' };
    }
  }

  async function loadPayment(paymentId: string) {
    if (!db) return null;
    const [row] = await db
      .select({
        id: payments.id,
        paymentStatus: payments.paymentStatus,
        processorPaymentIntentId: payments.processorPaymentIntentId
      })
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    return row ?? null;
  }

  async function captureAuthorization(paymentId: string): Promise<SettleResult> {
    if (!db || !provider) return { status: 'disabled' };
    const payment = await loadPayment(paymentId);
    if (!payment || !payment.processorPaymentIntentId) return { status: 'noop' };
    if (payment.paymentStatus !== 'authorized') return { status: 'noop' };

    try {
      const result = await provider.capturePayment({
        processorPaymentIntentId: payment.processorPaymentIntentId,
        idempotencyKey: `capture:${paymentId}`
      });

      await db
        .update(payments)
        .set({ processorChargeId: result.processorChargeId, updatedAt: new Date() })
        .where(eq(payments.id, paymentId));

      await lifecycle.transitionPaymentState({
        paymentId,
        processor: provider.processor,
        nextStatus: 'captured',
        eventType: 'charge.captured',
        processorEventId: result.processorChargeId,
        actorType: 'operator',
        metadata: { providerStatus: result.status }
      });

      return { status: 'captured', paymentId };
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error ? error.message : 'capture_failed' };
    }
  }

  async function voidOrRefund(paymentId: string): Promise<SettleResult> {
    if (!db || !provider) return { status: 'disabled' };
    const payment = await loadPayment(paymentId);
    if (!payment || !payment.processorPaymentIntentId) return { status: 'noop' };

    try {
      if (payment.paymentStatus === 'authorized' || payment.paymentStatus === 'payment_pending') {
        const result = await provider.voidPayment({
          processorPaymentIntentId: payment.processorPaymentIntentId,
          idempotencyKey: `void:${paymentId}`
        });
        await lifecycle.transitionPaymentState({
          paymentId,
          processor: provider.processor,
          nextStatus: 'voided',
          eventType: 'payment.intent.canceled',
          actorType: 'operator',
          metadata: { providerStatus: result.status }
        });
        return { status: 'voided', paymentId };
      }

      if (payment.paymentStatus === 'captured') {
        const result = await provider.refundPayment({
          processorPaymentIntentId: payment.processorPaymentIntentId,
          idempotencyKey: `refund:${paymentId}`
        });
        await lifecycle.transitionPaymentState({
          paymentId,
          processor: provider.processor,
          nextStatus: 'refunded',
          eventType: 'charge.refunded',
          actorType: 'operator',
          metadata: { providerStatus: result.status }
        });
        return { status: 'refunded', paymentId };
      }

      return { status: 'noop' };
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error ? error.message : 'reversal_failed' };
    }
  }

  async function voidOrRefundMany(paymentIds: string[]): Promise<void> {
    for (const paymentId of paymentIds) {
      await voidOrRefund(paymentId);
    }
  }

  async function resolvePaymentIdByIntent(processorPaymentIntentId: string): Promise<string | null> {
    if (!db) return null;
    const [row] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.processorPaymentIntentId, processorPaymentIntentId))
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * DB-backed closeout totals: aggregates only captured `payments` rows for the
   * gig. Runtime arrays are never used as the financial source of truth.
   */
  async function aggregateCapturedTotals(gigId: string): Promise<CloseoutTotals> {
    const empty: CloseoutTotals = {
      source: 'database_captured_payments',
      capturedCount: 0,
      capturedSubtotalCents: 0,
      capturedTotalCents: 0,
      platformFeeCents: 0
    };
    if (!db) return empty;

    const [row] = await db
      .select({
        capturedCount: sql<number>`count(*)::int`,
        capturedSubtotalCents: sql<number>`coalesce(sum(${payments.amountSubtotal}), 0)::int`,
        capturedTotalCents: sql<number>`coalesce(sum(${payments.amountTotal}), 0)::int`,
        platformFeeCents: sql<number>`coalesce(sum(${payments.platformFee}), 0)::int`
      })
      .from(payments)
      .where(and(eq(payments.gigId, gigId), inArray(payments.paymentStatus, ['captured', 'paid_out'])));

    if (!row) return empty;
    return {
      source: 'database_captured_payments',
      capturedCount: Number(row.capturedCount ?? 0),
      capturedSubtotalCents: Number(row.capturedSubtotalCents ?? 0),
      capturedTotalCents: Number(row.capturedTotalCents ?? 0),
      platformFeeCents: Number(row.platformFeeCents ?? 0)
    };
  }

  return {
    isEnabled,
    hasDurableStore: Boolean(db),
    processor: provider?.processor ?? null,
    authorizeAction,
    confirmAuthorizedAction,
    captureAuthorization,
    voidOrRefund,
    voidOrRefundMany,
    resolvePaymentIdByIntent,
    aggregateCapturedTotals,
    transitionPaymentState: lifecycle.transitionPaymentState
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
