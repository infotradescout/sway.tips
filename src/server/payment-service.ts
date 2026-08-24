import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { closeDisposableSwayDbProof, createSwayDb } from '../db/client';
import {
  activeBlocks,
  gigSessions,
  clientPendingActions,
  liveRoomPaymentOperations,
  payments,
  performers,
  requestBoosts,
  requests
} from '../db/schema';
import { lockModerationBlockIdentities, moderationBlockIdentities } from './moderation-block-lock';
import type { PaymentProviderAdapter } from './payment-provider';
import { createPaymentLifecycleService } from './payment-lifecycle';
import {
  createLiveRoomPaymentOperationStore,
  CURRENT_LIVE_ROOM_POSITIVE_EXECUTOR_GENERATION
} from './live-room-payment-operation-store';
import { resolveSwayPlatformFeePolicyForGig } from './partner-entitlement-store';
import { createIdempotencyStore, type PendingActionOwner } from './idempotency-store';
import {
  isTestModePlatformBalancePerformerAllowed,
  isSwayTestPlatformBalanceDestination,
  resolveLiveRoomSellerMoneyReadiness
} from './live-room-seller-readiness';

type ActionType = 'tip' | 'request' | 'boost' | 'bump' | 'vip';

export type AuthorizeActionInput = {
  gigId: string;
  actionType: ActionType;
  amountSubtotalCents: number;
  platformFeeCents: number;
  platformFeePayer?: 'patron' | 'performer';
  attributionSource: 'creator_direct' | 'sway_promoted';
  campaignId: string | null;
  commissionBpsApplied: number | null;
  currency: string;
  idempotencyKey: string;
  intentFingerprint: string;
  requestId?: string | null;
  requestBoostId?: string | null;
  runtimeRequestId?: string | null;
  clientRequestId?: string | null;
  paymentMethod?: string;
  confirm?: boolean;
  metadata?: Record<string, string>;
};

export type ConfirmAuthorizedActionInput = {
  gigId: string;
  actionType: 'tip' | 'request' | 'boost';
  clientRequestId: string;
  idempotencyKey: string;
  intentFingerprint: string;
  patronDeviceIdHash: string;
  processorPaymentIntentId: string;
};

type FeePolicySnapshot = {
  platformFeeCents: number;
  platformFeeCapCents: number | null;
  partnerTermsVersion: string | null;
  partnerTermsHash: string | null;
};

type AuthorizeSuccessFields = FeePolicySnapshot & {
  paymentId: string;
  processorPaymentIntentId: string;
  clientSecret: string | null;
};

export type AuthorizeActionResult =
  | { status: 'disabled' }
  | ({ status: 'authorized' } & AuthorizeSuccessFields)
  | ({ status: 'requires_confirmation'; providerStatus: string } & AuthorizeSuccessFields)
  | { status: 'processing'; paymentId: string; reason: string }
  | { status: 'failed'; reason: string };

export type SettleResult =
  | { status: 'disabled' }
  | { status: 'noop' }
  | { status: 'pending'; paymentId: string; reason: string }
  | { status: 'captured' | 'voided' | 'refunded'; paymentId: string }
  | { status: 'failed'; reason: string };

export type PaymentReversalResult = {
  paymentId: string;
  result: SettleResult;
};

export function isTerminalProviderReversalStatus(action: 'void' | 'refund', providerStatus: string) {
  return action === 'void'
    ? providerStatus === 'canceled'
    : providerStatus === 'succeeded';
}

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function recordString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function recordNumber(record: Record<string, unknown>, key: string) {
  const value = Number(record[key]);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function recordBoolean(record: Record<string, unknown>, key: string) {
  return record[key] === true;
}

function operationRetryReason(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isTerminalProcessorError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const type = 'type' in error && typeof error.type === 'string' ? error.type : '';
  // StripeIdempotencyError is deliberately absent. An expired operation lease
  // can overlap an earlier request that Stripe is still executing; "key in use"
  // is therefore provider uncertainty, not proof that no PaymentIntent exists.
  return new Set([
    'StripeCardError',
    'StripeInvalidRequestError',
    'StripeAuthenticationError',
    'StripePermissionError'
  ]).has(type);
}

function feePolicyFromPayload(payload: Record<string, unknown>): FeePolicySnapshot {
  return {
    platformFeeCents: recordNumber(payload, 'platformFeeCents') ?? 0,
    platformFeeCapCents: payload.platformFeeCapCents === null
      ? null
      : recordNumber(payload, 'platformFeeCapCents'),
    partnerTermsVersion: recordString(payload, 'partnerTermsVersion'),
    partnerTermsHash: recordString(payload, 'partnerTermsHash')
  };
}

function actionLink(input: Pick<AuthorizeActionInput, 'actionType' | 'requestId' | 'requestBoostId'>) {
  if (input.actionType === 'boost') {
    if (!input.requestBoostId || input.requestId) return null;
    return { requestId: null, requestBoostId: input.requestBoostId };
  }
  if (!['tip', 'request'].includes(input.actionType) || !input.requestId || input.requestBoostId) return null;
  return { requestId: input.requestId, requestBoostId: null };
}

export function createPaymentService(config: {
  databaseUrl?: string;
  provider: PaymentProviderAdapter | null;
  moneyExecutionEnabled?: boolean;
  moneyEnvironment?: 'test' | 'live' | null;
  testPlatformBalancePerformerIds?: ReadonlySet<string>;
}) {
  const db = config.databaseUrl ? createSwayDb(config.databaseUrl) : null;
  const provider = config.provider;
  const lifecycle = createPaymentLifecycleService(config.databaseUrl);
  const operationStore = createLiveRoomPaymentOperationStore(config.databaseUrl);
  const idempotencyStore = createIdempotencyStore(config.databaseUrl);
  const enabled = Boolean(db && provider);
  const moneyExecutionEnabled = config.moneyExecutionEnabled === true;
  const moneyEnvironment = config.moneyEnvironment === 'test' || config.moneyEnvironment === 'live'
    ? config.moneyEnvironment
    : null;
  const testPlatformBalancePerformerIds = config.testPlatformBalancePerformerIds ?? new Set<string>();
  const workerId = `live-room-payment:${process.pid}`;

  function isEnabled() {
    return enabled;
  }

  async function withCurrentLiveMoneyAdmission<T>(input: {
    phase: 'authorize' | 'confirm' | 'capture';
    gigId: string;
    destinationAccountId: string;
    operation?: typeof liveRoomPaymentOperations.$inferSelect;
    requireLeasedOperation?: boolean;
    expectedClientRequestId?: string;
    expectedIntentFingerprint?: string;
    expectedPatronDeviceIdHash?: string;
    expectedProcessorPaymentIntentId?: string;
    execute: (admission: {
      operation: typeof liveRoomPaymentOperations.$inferSelect;
      payment: typeof payments.$inferSelect;
      payload: Record<string, unknown>;
      recoveryAttempt: boolean;
      unresolvedPendingExpired: boolean;
    }) => Promise<T>;
  }): Promise<T> {
    if (!db || !provider || !moneyExecutionEnabled || !moneyEnvironment) {
      throw new Error('live_money_release_gate_closed');
    }
    let admissionPassed = false;
    try {
      return await db.transaction(async (tx) => {
        if (!input.operation) throw new Error('payment_operation_lease_lost');

        // One lock order is used at the provider boundary: room, seller,
        // operation, payment, action, pending action, then the shared release
        // lock inside the SQL authority function. Every mutable precondition is
        // re-read only after its row lock is held.
        const [lockedRoom] = await tx
          .select({
            id: gigSessions.id,
            performerId: gigSessions.performerId,
            status: gigSessions.status,
            roomType: gigSessions.roomType,
            moneyEnabled: gigSessions.moneyEnabled,
            destinationAccountId: gigSessions.moneyDestinationAccountId,
            moneyEnvironment: gigSessions.moneyEnvironment
          })
          .from(gigSessions)
          .where(eq(gigSessions.id, input.gigId))
          .for('update')
          .limit(1);
        if (
          !lockedRoom
          || lockedRoom.roomType !== 'music'
          || lockedRoom.moneyEnabled !== true
          || lockedRoom.destinationAccountId !== input.destinationAccountId
          || lockedRoom.moneyEnvironment !== moneyEnvironment
        ) throw new Error('live_money_admission_denied');

        const [lockedSeller] = await tx
          .select({ id: performers.id })
          .from(performers)
          .where(eq(performers.id, lockedRoom.performerId))
          .for('update')
          .limit(1);
        if (!lockedSeller) throw new Error('live_money_admission_denied');

        const [lockedOperation] = await tx
          .select()
          .from(liveRoomPaymentOperations)
          .where(eq(liveRoomPaymentOperations.id, input.operation.id))
          .for('update')
          .limit(1);
        if (
          !lockedOperation
          || lockedOperation.gigId !== input.gigId
          || lockedOperation.performerId !== lockedRoom.performerId
          || lockedOperation.destinationAccountId !== input.destinationAccountId
          || lockedOperation.processor !== provider.processor
          || (input.phase === 'capture'
            ? lockedOperation.operationType !== 'capture'
            : lockedOperation.operationType !== 'authorize')
          || (input.phase === 'confirm'
            && !['awaiting_customer', 'succeeded'].includes(lockedOperation.status))
          || lockedOperation.minimumExecutorGeneration > CURRENT_LIVE_ROOM_POSITIVE_EXECUTOR_GENERATION
          || (input.requireLeasedOperation !== false && (
            lockedOperation.status !== 'leased'
            || lockedOperation.leaseOwner !== input.operation.leaseOwner
            || lockedOperation.leaseExecutorGeneration === null
            || lockedOperation.leaseExecutorGeneration < lockedOperation.minimumExecutorGeneration
          ))
        ) throw new Error('payment_operation_lease_lost');

        const [lockedPayment] = await tx
          .select()
          .from(payments)
          .where(eq(payments.id, lockedOperation.paymentId))
          .for('update')
          .limit(1);
        if (
          !lockedPayment
          || lockedPayment.legacyUnlinked
          || lockedPayment.gigId !== lockedOperation.gigId
          || lockedPayment.performerId !== lockedOperation.performerId
          || lockedPayment.requestId !== lockedOperation.requestId
          || lockedPayment.requestBoostId !== lockedOperation.requestBoostId
          || lockedPayment.destinationAccountId !== lockedOperation.destinationAccountId
          || lockedPayment.processor !== lockedOperation.processor
          || (input.expectedProcessorPaymentIntentId
            && lockedPayment.processorPaymentIntentId !== input.expectedProcessorPaymentIntentId)
        ) throw new Error('payment_operation_identity_mismatch');

        const payload = asRecord(lockedOperation.requestPayload);
        if (lockedOperation.operationType === 'authorize') {
          if (
            recordString(payload, 'actionType') !== lockedPayment.actionType
            || recordNumber(payload, 'amountSubtotalCents') !== lockedPayment.amountSubtotal
            || recordNumber(payload, 'amountTotalCents') !== lockedPayment.amountTotal
            || (recordString(payload, 'currency') ?? '').toUpperCase() !== lockedPayment.currency.toUpperCase()
            || (input.expectedClientRequestId
              && recordString(payload, 'clientRequestId') !== input.expectedClientRequestId)
            || (input.expectedIntentFingerprint
              && recordString(payload, 'intentFingerprint') !== input.expectedIntentFingerprint)
          ) throw new Error('payment_operation_identity_mismatch');
        } else if (
          recordString(payload, 'processorPaymentIntentId') !== lockedPayment.processorPaymentIntentId
          || recordString(payload, 'paymentStatus') !== 'authorized'
        ) {
          throw new Error('payment_operation_identity_mismatch');
        }

        let actionStatus: string | null = null;
        let actionActivatedAt: Date | null = null;
        let actionRuntime: Record<string, unknown> = {};
        let actionClientRequestId: string | null = null;
        let actionIdempotencyKey: string | null = null;
        let actionIntentFingerprint: string | null = null;
        let actionPatronDeviceIdHash: string | null = null;
        let committedStatus: string | null = null;
        let committedActivatedAt: Date | null = null;
        let committedRuntime: Record<string, unknown> = {};

        if (lockedPayment.requestId) {
          const [action] = await tx
            .select()
            .from(requests)
            .where(eq(requests.id, lockedPayment.requestId))
            .for('update')
            .limit(1);
          if (!action || action.gigId !== lockedPayment.gigId) {
            throw new Error('payment_operation_identity_mismatch');
          }
          actionStatus = action.status;
          actionActivatedAt = action.activatedAt;
          actionRuntime = asRecord(action.runtimeRequestState);
          actionClientRequestId = action.clientRequestId;
          actionIdempotencyKey = action.idempotencyKey;
          actionIntentFingerprint = action.intentFingerprint;
          actionPatronDeviceIdHash = action.patronDeviceIdHash;
          committedStatus = action.status;
          committedActivatedAt = action.activatedAt;
          committedRuntime = actionRuntime;
          if (
            action.moneyRequired !== true
            || action.amountCents !== lockedPayment.amountSubtotal
            || action.currency.toUpperCase() !== lockedPayment.currency.toUpperCase()
          ) throw new Error('payment_operation_identity_mismatch');
        } else if (lockedPayment.requestBoostId) {
          const [boostIdentity] = await tx
            .select({ requestId: requestBoosts.requestId })
            .from(requestBoosts)
            .where(eq(requestBoosts.id, lockedPayment.requestBoostId))
            .limit(1);
          if (!boostIdentity) throw new Error('payment_operation_identity_mismatch');
          const [parent] = await tx
            .select({
              status: requests.status,
              activatedAt: requests.activatedAt,
              runtimeState: requests.runtimeRequestState
            })
            .from(requests)
            .where(eq(requests.id, boostIdentity.requestId))
            .for('update')
            .limit(1);
          if (!parent) throw new Error('payment_operation_identity_mismatch');
          const [action] = await tx
            .select()
            .from(requestBoosts)
            .where(eq(requestBoosts.id, lockedPayment.requestBoostId))
            .for('update')
            .limit(1);
          if (
            !action
            || action.gigId !== lockedPayment.gigId
            || action.requestId !== boostIdentity.requestId
          ) {
            throw new Error('payment_operation_identity_mismatch');
          }
          actionStatus = action.status;
          actionActivatedAt = action.activatedAt;
          actionRuntime = asRecord(action.runtimeBoostState);
          actionClientRequestId = action.clientRequestId;
          actionIdempotencyKey = action.idempotencyKey;
          actionIntentFingerprint = action.intentFingerprint;
          actionPatronDeviceIdHash = action.patronDeviceIdHash;
          if (
            action.moneyRequired !== true
            || action.amountCents !== lockedPayment.amountSubtotal
            || action.currency.toUpperCase() !== lockedPayment.currency.toUpperCase()
          ) throw new Error('payment_operation_identity_mismatch');
          committedStatus = parent.status;
          committedActivatedAt = parent.activatedAt;
          committedRuntime = asRecord(parent.runtimeState);
        } else {
          throw new Error('payment_operation_identity_mismatch');
        }

        if (
          actionIdempotencyKey !== lockedPayment.idempotencyKey
          || (lockedOperation.operationType === 'authorize' && (
            actionClientRequestId !== recordString(payload, 'clientRequestId')
            || actionIntentFingerprint !== recordString(payload, 'intentFingerprint')
          ))
          || (input.expectedClientRequestId && actionClientRequestId !== input.expectedClientRequestId)
          || (input.expectedIntentFingerprint && actionIntentFingerprint !== input.expectedIntentFingerprint)
          || (input.expectedPatronDeviceIdHash
            && actionPatronDeviceIdHash !== input.expectedPatronDeviceIdHash)
        ) throw new Error('payment_operation_identity_mismatch');

        const [pending] = await tx
          .select()
          .from(clientPendingActions)
          .where(eq(clientPendingActions.idempotencyKey, lockedPayment.idempotencyKey!))
          .for('update')
          .limit(1);
        const effectiveDeadline = pending
          ? Math.min(pending.expiresAt.getTime(), pending.createdAt.getTime() + 5 * 60 * 1000)
          : null;
        const recoveryAttempt = input.phase === 'authorize'
          ? lockedOperation.attemptCount > 1
            || Boolean(lockedPayment.processorPaymentIntentId || lockedOperation.processorObjectId)
          : input.phase === 'capture'
            ? lockedOperation.attemptCount > 1 || Boolean(lockedOperation.processorObjectId)
            : false;

        // Acquire the shared release lock and evaluate every authority grant
        // only after all mutable identity rows are locked. The TTL check below
        // intentionally happens after this call as the lock wait itself can
        // cross the action deadline.
        await tx.execute(sql`select sway_require_current_live_room_money_authority(
          ${input.gigId}::uuid,
          ${input.destinationAccountId}::text,
          ${moneyEnvironment}::text
        )`);
        const unresolvedPendingExpired = !actionActivatedAt && (
          !pending
          || !['pending', 'retrying'].includes(pending.status)
          || pending.gigId !== lockedPayment.gigId
          || pending.clientRequestId !== actionClientRequestId
          || pending.actionType !== lockedPayment.actionType
          || effectiveDeadline === null
          || effectiveDeadline <= Date.now()
        );

        if (
          recordBoolean(actionRuntime, 'hidden')
          || recordBoolean(actionRuntime, 'removed')
          || recordBoolean(actionRuntime, 'shadowBanned')
        ) {
          if (!recoveryAttempt) throw new Error(input.phase === 'capture'
            ? 'capture_canceled_before_provider_call'
            : 'authorization_canceled_before_provider_call');
        }
        if (input.phase === 'authorize' || input.phase === 'confirm') {
          if (!recoveryAttempt && lockedRoom.status !== 'active') {
            throw new Error('authorization_canceled_before_provider_call');
          }
          if (!recoveryAttempt && (unresolvedPendingExpired || actionStatus !== 'payment_pending')) {
            throw new Error('pending_action_expired_before_provider_call');
          }
        } else {
          const committedTargetEligible = Boolean(
            committedActivatedAt
            && ['approved', 'fulfilled'].includes(committedStatus ?? '')
            && !recordBoolean(committedRuntime, 'hidden')
            && !recordBoolean(committedRuntime, 'removed')
            && !recordBoolean(committedRuntime, 'shadowBanned')
          );
          const committedCaptureRequired = Boolean(
            actionActivatedAt
            && committedTargetEligible
            && (lockedPayment.requestId || actionStatus === 'approved')
          );
          const invisibleRequestNeedsCapture = Boolean(
            lockedPayment.requestId
            && (
              recordString(actionRuntime, 'type') === 'tip'
              || ['approved', 'fulfilled'].includes(recordString(actionRuntime, 'status') ?? '')
            )
          );
          const invisibleBoostNeedsCapture = Boolean(
            lockedPayment.requestBoostId
            && committedTargetEligible
          );
          const invisibleCaptureRequired = Boolean(
            !actionActivatedAt
            && lockedRoom.status === 'active'
            && actionStatus === 'payment_pending'
            && !unresolvedPendingExpired
            && (invisibleRequestNeedsCapture || invisibleBoostNeedsCapture)
          );
          if (!recoveryAttempt && !committedCaptureRequired && !invisibleCaptureRequired) {
            throw new Error('capture_canceled_before_provider_call');
          }
        }

        admissionPassed = true;
        return input.execute({
          operation: lockedOperation,
          payment: lockedPayment,
          payload,
          recoveryAttempt,
          unresolvedPendingExpired
        });
      });
    } catch (error) {
      if (admissionPassed || (error instanceof Error && [
        'payment_operation_lease_lost',
        'payment_operation_identity_mismatch',
        'capture_canceled_before_provider_call',
        'authorization_canceled_before_provider_call',
        'pending_action_expired_before_provider_call'
      ].includes(error.message))) throw error;
      throw new Error('live_money_admission_denied');
    }
  }

  async function loadPayment(paymentId: string) {
    if (!db) return null;
    const [row] = await db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .limit(1);
    return row ?? null;
  }

  async function loadAuthorizeOperation(paymentId: string) {
    if (!db) return null;
    const [row] = await db
      .select()
      .from(liveRoomPaymentOperations)
      .where(and(
        eq(liveRoomPaymentOperations.paymentId, paymentId),
        eq(liveRoomPaymentOperations.operationType, 'authorize')
      ))
      .limit(1);
    return row ?? null;
  }

  async function loadPendingActionDeadline(idempotencyKey: string | null) {
    if (!db || !idempotencyKey) return null;
    const [row] = await db
      .select({
        status: clientPendingActions.status,
        expiresAt: clientPendingActions.expiresAt,
        createdAt: clientPendingActions.createdAt
      })
      .from(clientPendingActions)
      .where(eq(clientPendingActions.idempotencyKey, idempotencyKey))
      .limit(1);
    return row ?? null;
  }

  async function hasExpiredUnresolvedPendingAction(payment: NonNullable<Awaited<ReturnType<typeof loadPayment>>>) {
    const [linkedAction] = payment.requestBoostId
      ? await db!
        .select({ activatedAt: requestBoosts.activatedAt })
        .from(requestBoosts)
        .where(eq(requestBoosts.id, payment.requestBoostId))
        .limit(1)
      : payment.requestId
        ? await db!
          .select({ activatedAt: requests.activatedAt })
          .from(requests)
          .where(eq(requests.id, payment.requestId))
          .limit(1)
        : [];
    if (linkedAction?.activatedAt) return false;
    const pending = await loadPendingActionDeadline(payment.idempotencyKey);
    const effectiveDeadline = pending
      ? Math.min(pending.expiresAt.getTime(), pending.createdAt.getTime() + 5 * 60 * 1000)
      : null;
    if (!pending || !['pending', 'retrying'].includes(pending.status)) return true;
    return effectiveDeadline === null || effectiveDeadline <= Date.now();
  }

  async function alignPaymentWithProviderTruth(
    paymentId: string,
    authorization: Awaited<ReturnType<PaymentProviderAdapter['retrievePaymentAuthorization']>>,
    source: string
  ) {
    if (!db || !provider) throw new Error('payment_service_disabled');
    await db
      .update(payments)
      .set({
        processorPaymentIntentId: authorization.processorPaymentIntentId,
        processorChargeId: authorization.processorChargeId,
        updatedAt: new Date()
      })
      .where(eq(payments.id, paymentId));

    const advance = async (nextStatus: 'payment_pending' | 'authorized' | 'captured' | 'voided' | 'refunded') => {
      const current = await loadPayment(paymentId);
      if (!current) throw new Error('payment_not_found');
      if (current.paymentStatus === nextStatus) return;
      const transition = await lifecycle.transitionPaymentState({
        paymentId,
        processor: provider.processor,
        nextStatus,
        eventType: `payment.provider_truth.${nextStatus}`,
        processorEventId: `provider-truth:${paymentId}:${authorization.processorPaymentIntentId}:${nextStatus}`,
        actorType: 'system',
        allowOutOfOrderNoop: true,
        allowProviderTruthRecovery: true,
        metadata: {
          source,
          providerStatus: authorization.status,
          processorPaymentIntentId: authorization.processorPaymentIntentId,
          processorChargeId: authorization.processorChargeId,
          amountRefundedCents: authorization.amountRefundedCents ?? null,
          fullyRefunded: authorization.fullyRefunded ?? null
        }
      });
      if (['missing', 'unavailable', 'ignored_out_of_order', 'concurrent_noop'].includes(transition.status)) {
        throw new Error(`provider_truth_transition_${transition.status}`);
      }
    };

    if (authorization.status === 'succeeded') {
      let current = await loadPayment(paymentId);
      if (current?.paymentStatus === 'created' || current?.paymentStatus === 'failed') {
        await advance('payment_pending');
        current = await loadPayment(paymentId);
      }
      if (current?.paymentStatus === 'payment_pending') await advance('authorized');
      current = await loadPayment(paymentId);
      if (current?.paymentStatus === 'authorized') await advance('captured');
      current = await loadPayment(paymentId);
      if (
        current
        && ['captured', 'disputed', 'paid_out'].includes(current.paymentStatus)
        && authorization.fullyRefunded === true
        && Number(authorization.amountRefundedCents ?? 0) >= current.amountTotal
      ) {
        await advance('refunded');
        await db
          .update(payments)
          .set({ refundStatus: 'refunded', updatedAt: new Date() })
          .where(eq(payments.id, paymentId));
      }
    } else if (authorization.status === 'requires_capture') {
      let current = await loadPayment(paymentId);
      if (current?.paymentStatus === 'created' || current?.paymentStatus === 'failed') {
        await advance('payment_pending');
        current = await loadPayment(paymentId);
      }
      if (current?.paymentStatus === 'payment_pending') await advance('authorized');
    } else if (authorization.status === 'canceled') {
      const current = await loadPayment(paymentId);
      if (current && ['created', 'payment_pending', 'authorized', 'failed'].includes(current.paymentStatus)) {
        await advance('voided');
      }
    } else {
      const current = await loadPayment(paymentId);
      if (current?.paymentStatus === 'created' || current?.paymentStatus === 'failed') {
        await advance('payment_pending');
      }
    }
    return loadPayment(paymentId);
  }

  async function reserveAuthorization(input: AuthorizeActionInput, feePolicy: FeePolicySnapshot) {
    if (!db || !provider) throw new Error('payment_service_disabled');
    if (!moneyExecutionEnabled || !moneyEnvironment) throw new Error('live_money_release_gate_closed');
    const link = actionLink(input);
    if (!link || !input.intentFingerprint || !input.clientRequestId) {
      throw new Error('durable_action_link_required');
    }

    const amounts = calculateSwayPaymentAmounts({
      amountSubtotalCents: input.amountSubtotalCents,
      platformFeeCents: feePolicy.platformFeeCents,
      platformFeePayer: input.platformFeePayer
    });
    const requestPayload = {
      amountTotalCents: amounts.amountTotalCents,
      amountSubtotalCents: input.amountSubtotalCents,
      currency: input.currency,
      paymentMethod: input.paymentMethod ?? null,
      confirm: input.confirm === true,
      actionType: input.actionType,
      runtimeRequestId: input.runtimeRequestId ?? null,
      clientRequestId: input.clientRequestId,
      intentFingerprint: input.intentFingerprint,
      platformFeePayer: amounts.platformFeePayer,
      platformFeeChargedToPatronCents: amounts.platformFeeChargedToPatronCents,
      platformFeeCents: feePolicy.platformFeeCents,
      platformFeeCapCents: feePolicy.platformFeeCapCents,
      partnerTermsVersion: feePolicy.partnerTermsVersion,
      partnerTermsHash: feePolicy.partnerTermsHash,
      metadata: input.metadata ?? {}
    };

    return db.transaction(async (tx) => {
      const actionConditions = [eq(payments.idempotencyKey, input.idempotencyKey)];
      if (link.requestId) actionConditions.push(eq(payments.requestId, link.requestId));
      if (link.requestBoostId) actionConditions.push(eq(payments.requestBoostId, link.requestBoostId));
      const [existing] = await tx
        .select()
        .from(payments)
        .where(or(...actionConditions))
        .for('update')
        .limit(1);
      if (existing) {
        if (
          existing.gigId !== input.gigId
          || existing.actionType !== input.actionType
          || existing.idempotencyKey !== input.idempotencyKey
          || existing.requestId !== link.requestId
          || existing.requestBoostId !== link.requestBoostId
          || existing.amountSubtotal !== input.amountSubtotalCents
          || existing.platformFee !== feePolicy.platformFeeCents
          || existing.amountTotal !== amounts.amountTotalCents
          || existing.currency.toUpperCase() !== input.currency.toUpperCase()
          || existing.attributionSource !== input.attributionSource
          || existing.campaignId !== input.campaignId
          || existing.commissionBpsApplied !== input.commissionBpsApplied
        ) {
          throw new Error('durable_payment_identity_conflict');
        }
        const [operation] = await tx
          .select()
          .from(liveRoomPaymentOperations)
          .where(and(
            eq(liveRoomPaymentOperations.paymentId, existing.id),
            eq(liveRoomPaymentOperations.operationType, 'authorize')
          ))
          .limit(1);
        if (
          !operation
          || operation.processor !== provider.processor
          || !isDeepStrictEqual(operation.requestPayload, requestPayload)
        ) throw new Error(operation ? 'durable_payment_identity_conflict' : 'durable_authorization_operation_missing');
        return { payment: existing, operation };
      }

      const [candidateDestination] = await tx
        .select({
          performerId: performers.id,
          roomStatus: gigSessions.status,
          roomType: gigSessions.roomType,
          moneyEnabled: gigSessions.moneyEnabled,
          isActive: performers.isActive,
          onboardingStatus: performers.onboardingStatus,
          paymentAccountStatus: performers.paymentAccountStatus,
          kycStatus: performers.kycStatus,
          chargesEnabled: performers.chargesEnabled,
          payoutsEnabled: performers.payoutsEnabled,
          stripeConnectedAccountId: performers.stripeConnectedAccountId,
          payoutHoldReason: performers.payoutHoldReason
        })
        .from(gigSessions)
        .innerJoin(performers, eq(performers.id, gigSessions.performerId))
        .where(eq(gigSessions.id, input.gigId))
        .limit(1);
      if (candidateDestination?.roomType !== 'music' || candidateDestination.moneyEnabled !== true) {
        throw new Error('room_money_not_enabled');
      }
      const sellerReadiness = resolveLiveRoomSellerMoneyReadiness({
        roomStatus: candidateDestination?.roomStatus,
        seller: candidateDestination,
        allowTestPlatformBalance: isTestModePlatformBalancePerformerAllowed(
          candidateDestination?.performerId,
          testPlatformBalancePerformerIds
        )
      });
      const destinationAccountId = sellerReadiness.destinationAccountId;
      if (!sellerReadiness.ready || !destinationAccountId || !candidateDestination?.performerId) {
        throw new Error(candidateDestination?.roomStatus === 'active' ? 'seller_payout_not_ready' : 'room_not_accepting_money');
      }
      try {
        await tx.execute(sql`select sway_require_current_live_room_money_authority(
          ${input.gigId}::uuid,
          ${destinationAccountId}::text,
          ${moneyEnvironment}::text
        )`);
      } catch {
        throw new Error('live_money_admission_denied');
      }

      // The SQL admission function now owns the deterministic room -> seller
      // lock order for the rest of this transaction. Reload the authoritative
      // values after those locks are held so no pre-lock snapshot is persisted.
      const [destination] = await tx
        .select({
          performerId: performers.id,
          roomStatus: gigSessions.status,
          roomType: gigSessions.roomType,
          moneyEnabled: gigSessions.moneyEnabled,
          isActive: performers.isActive,
          onboardingStatus: performers.onboardingStatus,
          paymentAccountStatus: performers.paymentAccountStatus,
          kycStatus: performers.kycStatus,
          chargesEnabled: performers.chargesEnabled,
          payoutsEnabled: performers.payoutsEnabled,
          stripeConnectedAccountId: performers.stripeConnectedAccountId,
          payoutHoldReason: performers.payoutHoldReason
        })
        .from(gigSessions)
        .innerJoin(performers, eq(performers.id, gigSessions.performerId))
        .where(eq(gigSessions.id, input.gigId))
        .limit(1);
      const currentSellerReadiness = resolveLiveRoomSellerMoneyReadiness({
        roomStatus: destination?.roomStatus,
        seller: destination,
        allowTestPlatformBalance: isTestModePlatformBalancePerformerAllowed(
          destination?.performerId,
          testPlatformBalancePerformerIds
        )
      });
      if (
        destination?.roomType !== 'music'
        || destination.moneyEnabled !== true
        || !destination.performerId
        || !currentSellerReadiness.ready
        || currentSellerReadiness.destinationAccountId !== destinationAccountId
      ) {
        throw new Error('live_money_admission_denied');
      }

      if (link.requestId) {
        const [request] = await tx
          .select({
            id: requests.id,
            gigId: requests.gigId,
            clientRequestId: requests.clientRequestId,
            idempotencyKey: requests.idempotencyKey,
            intentFingerprint: requests.intentFingerprint
          })
          .from(requests)
          .where(eq(requests.id, link.requestId))
          .for('update')
          .limit(1);
        if (
          !request
          || request.gigId !== input.gigId
          || request.clientRequestId !== input.clientRequestId
          || request.idempotencyKey !== input.idempotencyKey
          || request.intentFingerprint !== input.intentFingerprint
        ) throw new Error('durable_request_payment_link_mismatch');
      } else if (link.requestBoostId) {
        const [boost] = await tx
          .select({
            id: requestBoosts.id,
            gigId: requestBoosts.gigId,
            clientRequestId: requestBoosts.clientRequestId,
            idempotencyKey: requestBoosts.idempotencyKey,
            intentFingerprint: requestBoosts.intentFingerprint
          })
          .from(requestBoosts)
          .where(eq(requestBoosts.id, link.requestBoostId))
          .for('update')
          .limit(1);
        if (
          !boost
          || boost.gigId !== input.gigId
          || boost.clientRequestId !== input.clientRequestId
          || boost.idempotencyKey !== input.idempotencyKey
          || boost.intentFingerprint !== input.intentFingerprint
        ) throw new Error('durable_boost_payment_link_mismatch');
      }

      const [payment] = await tx
        .insert(payments)
        .values({
          gigId: input.gigId,
          performerId: destination.performerId,
          requestId: link.requestId,
          requestBoostId: link.requestBoostId,
          actionType: input.actionType,
          idempotencyKey: input.idempotencyKey,
          destinationAccountId,
          legacyUnlinked: false,
          paymentStatus: 'created',
          processor: provider.processor,
          amountSubtotal: input.amountSubtotalCents,
          platformFee: feePolicy.platformFeeCents,
          amountTotal: amounts.amountTotalCents,
          currency: input.currency,
          attributionSource: input.attributionSource,
          campaignId: input.campaignId,
          commissionBpsApplied: input.commissionBpsApplied,
          captureMode: 'manual'
        })
        .returning();

      const [operation] = await tx
        .insert(liveRoomPaymentOperations)
        .values({
          paymentId: payment.id,
          gigId: input.gigId,
          performerId: destination.performerId,
          requestId: link.requestId,
          requestBoostId: link.requestBoostId,
          operationType: 'authorize',
          processor: provider.processor,
          idempotencyKey: `authorize:${input.idempotencyKey}`,
          destinationAccountId,
          requestPayload
        })
        .returning();
      return { payment, operation };
    });
  }

  async function resultForExistingAuthorization(paymentId: string): Promise<AuthorizeActionResult> {
    const payment = await loadPayment(paymentId);
    const operation = await loadAuthorizeOperation(paymentId);
    if (!payment || !operation) return { status: 'failed', reason: 'durable_authorization_missing' };
    const payload = asRecord(operation.requestPayload);
    const feePolicy = feePolicyFromPayload(payload);
    if (['authorized', 'captured'].includes(payment.paymentStatus) && payment.processorPaymentIntentId) {
      return {
        status: 'authorized',
        paymentId: payment.id,
        processorPaymentIntentId: payment.processorPaymentIntentId,
        clientSecret: recordString(asRecord(operation.resultPayload), 'clientSecret'),
        ...feePolicy
      };
    }
    if (payment.paymentStatus === 'payment_pending' && payment.processorPaymentIntentId) {
      const result = asRecord(operation.resultPayload);
      return {
        status: 'requires_confirmation',
        paymentId: payment.id,
        processorPaymentIntentId: payment.processorPaymentIntentId,
        clientSecret: recordString(result, 'clientSecret'),
        providerStatus: recordString(result, 'providerStatus') ?? 'requires_confirmation',
        ...feePolicy
      };
    }
    if (['voided', 'refunded', 'failed'].includes(payment.paymentStatus) || operation.status === 'terminal_failed') {
      return { status: 'failed', reason: operation.lastError ?? `payment_${payment.paymentStatus}` };
    }
    return { status: 'processing', paymentId: payment.id, reason: operation.lastError ?? 'authorization_in_progress' };
  }

  async function executeAuthorizeOperation(operation: typeof liveRoomPaymentOperations.$inferSelect) {
    if (!db || !provider) throw new Error('payment_service_disabled');
    const payment = await loadPayment(operation.paymentId);
    if (!payment) throw new Error('payment_not_found');
    if (payment.processorPaymentIntentId && ['authorized', 'captured'].includes(payment.paymentStatus)) {
      await operationStore.markSucceeded(operation, {
        processorObjectId: payment.processorPaymentIntentId,
        resultPayload: { outcome: 'noop_already_authorized' }
      });
      return;
    }
    let expiredBeforeProviderCall = await hasExpiredUnresolvedPendingAction(payment);
    if (
      expiredBeforeProviderCall
      && operation.attemptCount <= 1
      && !payment.processorPaymentIntentId
      && !operation.processorObjectId
    ) {
      throw new Error('pending_action_expired_before_provider_call');
    }
    const [room] = await db
      .select({ status: gigSessions.status })
      .from(gigSessions)
      .where(eq(gigSessions.id, payment.gigId))
      .limit(1);
    const recoveryAttempt = operation.attemptCount > 1
      || Boolean(payment.processorPaymentIntentId || operation.processorObjectId);
    if (room?.status !== 'active' && !recoveryAttempt) {
      throw new Error('authorization_canceled_before_provider_call');
    }

    const payload = asRecord(operation.requestPayload);
    const metadata = asRecord(payload.metadata);
    const usesTestPlatformBalance = isSwayTestPlatformBalanceDestination(operation.destinationAccountId);
    const authorization = await withCurrentLiveMoneyAdmission({
      phase: 'authorize',
      gigId: payment.gigId,
      destinationAccountId: operation.destinationAccountId,
      operation,
      execute: ({ payment: admittedPayment, operation: admittedOperation, payload: admittedPayload, unresolvedPendingExpired }) => {
        expiredBeforeProviderCall = unresolvedPendingExpired;
        return provider.authorizePayment({
        amountTotalCents: recordNumber(admittedPayload, 'amountTotalCents') ?? admittedPayment.amountTotal,
        currency: recordString(admittedPayload, 'currency') ?? admittedPayment.currency,
        idempotencyKey: admittedOperation.idempotencyKey,
        paymentMethod: recordString(admittedPayload, 'paymentMethod') ?? undefined,
        confirm: recordBoolean(admittedPayload, 'confirm'),
        destinationAccountId: usesTestPlatformBalance ? undefined : admittedOperation.destinationAccountId,
        applicationFeeAmountCents: usesTestPlatformBalance ? undefined : admittedPayment.platformFee,
        metadata: {
          sway_payment_id: admittedPayment.id,
          sway_gig_id: admittedPayment.gigId,
          sway_action_type: admittedPayment.actionType ?? 'request',
          sway_platform_fee_cents: String(admittedPayment.platformFee),
          sway_platform_fee_payer: recordString(admittedPayload, 'platformFeePayer') ?? 'patron',
          sway_fee_charged_to_patron_cents: String(recordNumber(admittedPayload, 'platformFeeChargedToPatronCents') ?? 0),
          sway_settlement_mode: usesTestPlatformBalance ? 'platform_test_balance' : 'connected_account',
          ...(recordNumber(admittedPayload, 'platformFeeCapCents') === null ? {} : { sway_platform_fee_cap_cents: String(recordNumber(admittedPayload, 'platformFeeCapCents')) }),
          ...(recordString(admittedPayload, 'partnerTermsVersion') ? { sway_partner_terms_version: recordString(admittedPayload, 'partnerTermsVersion')! } : {}),
          ...(recordString(admittedPayload, 'partnerTermsHash') ? { sway_partner_terms_hash: recordString(admittedPayload, 'partnerTermsHash')! } : {}),
          ...(recordString(admittedPayload, 'runtimeRequestId') ? { sway_runtime_request_id: recordString(admittedPayload, 'runtimeRequestId')! } : {}),
          ...(recordString(admittedPayload, 'clientRequestId') ? { sway_client_request_id: recordString(admittedPayload, 'clientRequestId')! } : {}),
          ...Object.fromEntries(Object.entries(metadata).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : []))
        }
      });
      }
    });

    await alignPaymentWithProviderTruth(payment.id, authorization, `authorize_operation:${operation.id}`);

    const resultPayload = {
      clientSecret: authorization.clientSecret,
      providerStatus: authorization.status,
      ...feePolicyFromPayload(payload)
    };
    if (expiredBeforeProviderCall || await hasExpiredUnresolvedPendingAction(payment)) {
      // A retry after provider uncertainty must first discover the remote
      // PaymentIntent with the original idempotency key. Once discovered, an
      // expired action is released/refunded and can never become visible.
      await operationStore.markSucceeded(operation, {
        processorObjectId: authorization.processorPaymentIntentId,
        resultPayload: { ...resultPayload, outcome: 'expired_action_provider_truth_recovered' }
      });
      await voidOrRefund(payment.id);
      await idempotencyStore.expireStalePendingActions({ limit: 10 });
      return;
    }
    const [latestRoom] = await db
      .select({ status: gigSessions.status })
      .from(gigSessions)
      .where(eq(gigSessions.id, payment.gigId))
      .limit(1);
    if (latestRoom?.status !== 'active') {
      await operationStore.markSucceeded(operation, {
        processorObjectId: authorization.processorPaymentIntentId,
        resultPayload: { ...resultPayload, outcome: 'recovered_during_closeout' }
      });
      await voidOrRefund(payment.id);
      return;
    }

    if (authorization.status !== 'requires_capture') {
      await operationStore.markAwaitingCustomer(operation, {
        processorObjectId: authorization.processorPaymentIntentId,
        resultPayload
      });
      return;
    }

    await operationStore.markSucceeded(operation, {
      processorObjectId: authorization.processorPaymentIntentId,
      resultPayload
    });
  }

  async function authorizeAction(input: AuthorizeActionInput): Promise<AuthorizeActionResult> {
    if (!db || !provider) return { status: 'disabled' };
    if (!moneyExecutionEnabled || !moneyEnvironment) {
      return { status: 'failed', reason: 'live_money_release_gate_closed' };
    }
    let feePolicy: FeePolicySnapshot;
    try {
      feePolicy = await resolveSwayPlatformFeePolicyForGig({
        db,
        gigId: input.gigId,
        proposedPlatformFeeCents: input.platformFeeCents
      });
    } catch {
      return { status: 'failed', reason: 'platform_fee_policy_unavailable' };
    }

    let reservation;
    try {
      reservation = await reserveAuthorization(input, feePolicy);
    } catch (error) {
      return { status: 'failed', reason: operationRetryReason(error, 'payment_reservation_failed') };
    }

    if (reservation.operation.status !== 'pending' && reservation.operation.status !== 'retryable_failed') {
      return resultForExistingAuthorization(reservation.payment.id);
    }
    const operation = await operationStore.claim(workerId, reservation.operation.id);
    if (!operation) return resultForExistingAuthorization(reservation.payment.id);
    try {
      await executeAuthorizeOperation(operation);
    } catch (error) {
      await markOperationFailure(operation, error);
    }
    return resultForExistingAuthorization(reservation.payment.id);
  }

  async function confirmAuthorizedAction(input: ConfirmAuthorizedActionInput): Promise<AuthorizeActionResult> {
    if (!db || !provider) return { status: 'disabled' };
    if (!input.clientRequestId || !input.idempotencyKey || !input.intentFingerprint || !input.patronDeviceIdHash) {
      return { status: 'failed', reason: 'durable_action_link_required' };
    }

    const [payment] = await db
      .select()
      .from(payments)
      .where(eq(payments.processorPaymentIntentId, input.processorPaymentIntentId))
      .limit(1);
    if (!payment) return { status: 'failed', reason: 'payment_intent_not_found' };
    if (
      payment.gigId !== input.gigId
      || payment.actionType !== input.actionType
      || payment.idempotencyKey !== input.idempotencyKey
    ) return { status: 'failed', reason: 'payment_intent_mismatch' };

    const [reservedAction] = payment.requestBoostId
      ? await db
          .select({
            clientRequestId: requestBoosts.clientRequestId,
            idempotencyKey: requestBoosts.idempotencyKey,
            intentFingerprint: requestBoosts.intentFingerprint,
            patronDeviceIdHash: requestBoosts.patronDeviceIdHash
          })
          .from(requestBoosts)
          .where(eq(requestBoosts.id, payment.requestBoostId))
          .limit(1)
      : payment.requestId
        ? await db
            .select({
              clientRequestId: requests.clientRequestId,
              idempotencyKey: requests.idempotencyKey,
              intentFingerprint: requests.intentFingerprint,
              patronDeviceIdHash: requests.patronDeviceIdHash
            })
            .from(requests)
            .where(eq(requests.id, payment.requestId))
            .limit(1)
        : [];
    if (
      !reservedAction
      || reservedAction.clientRequestId !== input.clientRequestId
      || reservedAction.idempotencyKey !== input.idempotencyKey
      || reservedAction.intentFingerprint !== input.intentFingerprint
      || reservedAction.patronDeviceIdHash !== input.patronDeviceIdHash
    ) return { status: 'failed', reason: 'payment_intent_client_request_mismatch' };

    const operation = await loadAuthorizeOperation(payment.id);
    if (!operation) return { status: 'failed', reason: 'durable_authorization_operation_missing' };
    const payload = asRecord(operation.requestPayload);
    if (
      recordString(payload, 'clientRequestId') !== input.clientRequestId
      || recordString(payload, 'intentFingerprint') !== input.intentFingerprint
    ) {
      return { status: 'failed', reason: 'payment_intent_client_request_mismatch' };
    }

    if (['authorized', 'captured'].includes(payment.paymentStatus)) {
      return resultForExistingAuthorization(payment.id);
    }
    if (!['created', 'payment_pending', 'failed'].includes(payment.paymentStatus)) {
      return { status: 'failed', reason: `payment_intent_not_capturable_from_${payment.paymentStatus}` };
    }

    try {
      const authorization = await withCurrentLiveMoneyAdmission({
        phase: 'confirm',
        gigId: payment.gigId,
        destinationAccountId: operation.destinationAccountId,
        operation,
        requireLeasedOperation: false,
        expectedClientRequestId: input.clientRequestId,
        expectedIntentFingerprint: input.intentFingerprint,
        expectedPatronDeviceIdHash: input.patronDeviceIdHash,
        expectedProcessorPaymentIntentId: input.processorPaymentIntentId,
        execute: () => provider.retrievePaymentAuthorization(input.processorPaymentIntentId)
      });
      if (
        authorization.metadata?.sway_payment_id
        && authorization.metadata.sway_payment_id !== payment.id
      ) return { status: 'failed', reason: 'payment_intent_payment_id_mismatch' };
      if (
        authorization.metadata?.sway_client_request_id
        && authorization.metadata.sway_client_request_id !== input.clientRequestId
      ) return { status: 'failed', reason: 'payment_intent_client_request_mismatch' };

      await alignPaymentWithProviderTruth(payment.id, authorization, 'client_confirmation');
      if (['requires_capture', 'succeeded', 'canceled'].includes(authorization.status)) {
        await operationStore.markAuthorizeSucceeded(payment.id, {
          processorObjectId: authorization.processorPaymentIntentId,
          resultPayload: {
            clientSecret: authorization.clientSecret,
            providerStatus: authorization.status,
            ...feePolicyFromPayload(payload)
          }
        });
        return resultForExistingAuthorization(payment.id);
      }

      return {
        status: 'requires_confirmation',
        paymentId: payment.id,
        processorPaymentIntentId: authorization.processorPaymentIntentId,
        clientSecret: authorization.clientSecret,
        providerStatus: authorization.status,
        ...feePolicyFromPayload(payload)
      };
    } catch (error) {
      if (error instanceof Error && [
        'live_money_release_gate_closed',
        'live_money_admission_denied',
        'payment_operation_lease_lost',
        'payment_operation_identity_mismatch',
        'authorization_canceled_before_provider_call',
        'pending_action_expired_before_provider_call'
      ].includes(error.message)) {
        return { status: 'failed', reason: error.message };
      }
      return { status: 'processing', paymentId: payment.id, reason: operationRetryReason(error, 'payment_confirmation_reconciliation_pending') };
    }
  }

  async function ensureDurablePaymentBinding(
    payment: NonNullable<Awaited<ReturnType<typeof loadPayment>>>
  ) {
    if (!db) return payment;
    if (
      payment.performerId
      && payment.destinationAccountId
      && payment.idempotencyKey
      && (payment.requestId || payment.requestBoostId)
    ) return payment;
    if (!payment.legacyUnlinked) return payment;

    return db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(payments)
        .where(eq(payments.id, payment.id))
        .for('update')
        .limit(1);
      if (!locked) throw new Error('payment_not_found');
      if (
        locked.performerId
        && locked.destinationAccountId
        && locked.idempotencyKey
        && (locked.requestId || locked.requestBoostId)
      ) return locked;

      const [destination] = await tx
        .select({
          performerId: performers.id,
          destinationAccountId: performers.stripeConnectedAccountId
        })
        .from(gigSessions)
        .innerJoin(performers, eq(performers.id, gigSessions.performerId))
        .where(eq(gigSessions.id, locked.gigId))
        .limit(1);
      const destinationAccountId = destination?.destinationAccountId?.trim() || null;
      if (!destination?.performerId || !destinationAccountId) return locked;

      const [request] = await tx
        .select({
          id: requests.id,
          requestType: requests.requestType,
          idempotencyKey: requests.idempotencyKey,
          runtimeState: requests.runtimeRequestState
        })
        .from(requests)
        .where(sql`${requests.runtimeRequestState}->>'paymentId' = ${locked.id}`)
        .limit(1);
      const [boost] = request
        ? []
        : await tx
            .select({
              id: requestBoosts.id,
              idempotencyKey: requestBoosts.idempotencyKey,
              runtimeState: requestBoosts.runtimeBoostState
            })
            .from(requestBoosts)
            .where(sql`${requestBoosts.runtimeBoostState}->>'paymentId' = ${locked.id}`)
            .limit(1);
      const runtime = asRecord(request?.runtimeState ?? boost?.runtimeState);
      const idempotencyKey = request?.idempotencyKey
        ?? boost?.idempotencyKey
        ?? recordString(runtime, 'idempotencyKey')
        ?? `legacy-payment:${locked.id}`;
      const [repaired] = await tx
        .update(payments)
        .set({
          performerId: destination.performerId,
          requestId: request?.id ?? null,
          requestBoostId: boost?.id ?? null,
          actionType: boost ? 'boost' : request?.requestType === 'tip' ? 'tip' : 'request',
          idempotencyKey,
          destinationAccountId,
          updatedAt: new Date()
        })
        .where(eq(payments.id, locked.id))
        .returning();
      return repaired ?? locked;
    });
  }

  async function enqueueSettlement(payment: NonNullable<Awaited<ReturnType<typeof loadPayment>>>, operationType: 'capture' | 'reverse') {
    if (!provider || !payment.performerId || !payment.destinationAccountId) {
      throw new Error('durable_payment_binding_missing');
    }
    const reverseConnectedTransfer = operationType === 'reverse'
      && !isSwayTestPlatformBalanceDestination(payment.destinationAccountId);
    return operationStore.enqueue({
      paymentId: payment.id,
      gigId: payment.gigId,
      performerId: payment.performerId,
      requestId: payment.requestId,
      requestBoostId: payment.requestBoostId,
      operationType,
      processor: provider.processor,
      idempotencyKey: `${operationType}:${payment.id}`,
      destinationAccountId: payment.destinationAccountId,
      requestPayload: {
        processorPaymentIntentId: payment.processorPaymentIntentId,
        paymentStatus: payment.paymentStatus,
        reverseTransfer: reverseConnectedTransfer,
        refundApplicationFee: reverseConnectedTransfer
      }
    });
  }

  async function executeCaptureOperation(operation: typeof liveRoomPaymentOperations.$inferSelect) {
    if (!db || !provider) throw new Error('payment_service_disabled');
    const payment = await loadPayment(operation.paymentId);
    if (!payment) throw new Error('payment_not_found');
    if (payment.paymentStatus === 'captured') {
      await operationStore.markSucceeded(operation, {
        processorObjectId: payment.processorChargeId,
        resultPayload: { outcome: 'noop_already_captured' }
      });
      return;
    }
    if (payment.paymentStatus !== 'authorized' || !payment.processorPaymentIntentId) {
      throw new Error(`capture_not_ready_from:${payment.paymentStatus}`);
    }
    if (await hasExpiredUnresolvedPendingAction(payment)) {
      throw new Error('pending_action_expired_before_capture');
    }
    const [room] = await db
      .select({ status: gigSessions.status })
      .from(gigSessions)
      .where(eq(gigSessions.id, payment.gigId))
      .limit(1);
    const recoveryAttempt = operation.attemptCount > 1 || Boolean(operation.processorObjectId);
    const [committedRequest] = payment.requestId
      ? await db
          .select({ status: requests.status, runtimeState: requests.runtimeRequestState })
          .from(requests)
          .where(eq(requests.id, payment.requestId))
          .limit(1)
      : payment.requestBoostId
        ? await db
            .select({ status: requests.status, runtimeState: requests.runtimeRequestState })
            .from(requestBoosts)
            .innerJoin(requests, eq(requests.id, requestBoosts.requestId))
            .where(eq(requestBoosts.id, payment.requestBoostId))
            .limit(1)
        : [];
    const committedRuntime = asRecord(committedRequest?.runtimeState);
    const committedCaptureRequired = Boolean(
      committedRequest
      && ['approved', 'fulfilled'].includes(committedRequest.status)
      && !recordBoolean(committedRuntime, 'hidden')
      && !recordBoolean(committedRuntime, 'removed')
    );
    if (room?.status !== 'active' && !recoveryAttempt && !committedCaptureRequired) {
      throw new Error('capture_canceled_before_provider_call');
    }

    let result;
    try {
      result = await withCurrentLiveMoneyAdmission({
        phase: 'capture',
        gigId: payment.gigId,
        destinationAccountId: operation.destinationAccountId,
        operation,
        expectedProcessorPaymentIntentId: payment.processorPaymentIntentId,
        execute: ({ payment: admittedPayment, operation: admittedOperation }) => provider.capturePayment({
          processorPaymentIntentId: admittedPayment.processorPaymentIntentId!,
          idempotencyKey: admittedOperation.idempotencyKey
        })
      });
    } catch (error) {
      if (error instanceof Error && [
        'live_money_release_gate_closed',
        'live_money_admission_denied',
        'payment_operation_lease_lost',
        'payment_operation_identity_mismatch',
        'capture_canceled_before_provider_call',
        'pending_action_expired_before_capture'
      ].includes(error.message)) throw error;
      const providerTruth = await provider.retrievePaymentAuthorization(payment.processorPaymentIntentId);
      await alignPaymentWithProviderTruth(payment.id, providerTruth, `capture_recovery:${operation.id}`);
      if (providerTruth.status === 'canceled') {
        await operationStore.markSucceeded(operation, {
          processorObjectId: providerTruth.processorPaymentIntentId,
          resultPayload: { outcome: 'capture_lost_to_closeout_cancel', providerStatus: providerTruth.status }
        });
        return;
      }
      if (providerTruth.status !== 'succeeded') throw error;
      result = {
        processorPaymentIntentId: providerTruth.processorPaymentIntentId,
        processorChargeId: providerTruth.processorChargeId,
        status: providerTruth.status
      };
    }
    if (result.status !== 'succeeded') throw new Error(`capture_not_terminal:${result.status}`);
    const providerTruth = await provider.retrievePaymentAuthorization(payment.processorPaymentIntentId);
    if (providerTruth.status !== 'succeeded') throw new Error(`capture_provider_truth_not_terminal:${providerTruth.status}`);
    await alignPaymentWithProviderTruth(payment.id, providerTruth, `capture_operation:${operation.id}`);
    await operationStore.markSucceeded(operation, {
      processorObjectId: result.processorChargeId,
      resultPayload: { providerStatus: result.status, processorChargeId: result.processorChargeId }
    });
  }

  async function executeReverseOperation(operation: typeof liveRoomPaymentOperations.$inferSelect) {
    if (!db || !provider) throw new Error('payment_service_disabled');
    let payment = await loadPayment(operation.paymentId);
    if (!payment) throw new Error('payment_not_found');
    if (['voided', 'refunded'].includes(payment.paymentStatus)) {
      await operationStore.markSucceeded(operation, {
        processorObjectId: payment.processorPaymentIntentId,
        resultPayload: { outcome: `noop_already_${payment.paymentStatus}` }
      });
      return;
    }
    if (payment.paymentStatus === 'failed' && !payment.processorPaymentIntentId) {
      await operationStore.markSucceeded(operation, {
        processorObjectId: null,
        resultPayload: { outcome: 'noop_failed_before_provider' }
      });
      return;
    }
    if (!payment.processorPaymentIntentId) throw new Error('processor_payment_intent_missing');
    const reversalPayload = asRecord(operation.requestPayload);
    const reverseConnectedTransfer = recordBoolean(reversalPayload, 'reverseTransfer');
    if (
      reverseConnectedTransfer !== !isSwayTestPlatformBalanceDestination(operation.destinationAccountId)
      || recordBoolean(reversalPayload, 'refundApplicationFee') !== reverseConnectedTransfer
      || recordString(reversalPayload, 'processorPaymentIntentId') !== payment.processorPaymentIntentId
      || operation.destinationAccountId !== payment.destinationAccountId
    ) throw new Error('payment_operation_identity_mismatch');

    const completeVoid = async (providerTruth: Awaited<ReturnType<PaymentProviderAdapter['retrievePaymentAuthorization']>>) => {
      await alignPaymentWithProviderTruth(payment!.id, providerTruth, `reverse_void:${operation.id}`);
      const current = await loadPayment(payment!.id);
      if (current?.paymentStatus !== 'voided') throw new Error(`void_provider_truth_not_terminal:${current?.paymentStatus ?? 'missing'}`);
      await operationStore.markSucceeded(operation, {
        processorObjectId: providerTruth.processorPaymentIntentId,
        resultPayload: { providerStatus: providerTruth.status }
      });
    };

    const isFullRefundTruth = (
      providerTruth: Awaited<ReturnType<PaymentProviderAdapter['retrievePaymentAuthorization']>>
    ) => providerTruth.fullyRefunded === true
      && Number(providerTruth.amountRefundedCents ?? 0) >= payment!.amountTotal;

    const completeRefund = async (
      providerTruth: Awaited<ReturnType<PaymentProviderAdapter['retrievePaymentAuthorization']>>,
      result?: Awaited<ReturnType<PaymentProviderAdapter['refundPayment']>>
    ) => {
      if (!isFullRefundTruth(providerTruth)) {
        throw new Error(`refund_provider_truth_not_terminal:${providerTruth.amountRefundedCents ?? 'unknown'}`);
      }
      await alignPaymentWithProviderTruth(payment!.id, providerTruth, `reverse_refund:${operation.id}`);
      const current = await loadPayment(payment!.id);
      if (current?.paymentStatus !== 'refunded') {
        throw new Error(`refund_provider_truth_not_terminal:${current?.paymentStatus ?? 'missing'}`);
      }
      await db
        .update(payments)
        .set({
          refundStatus: 'refunded',
          processorChargeId: providerTruth.processorChargeId ?? result?.processorChargeId ?? null,
          updatedAt: new Date()
        })
        .where(eq(payments.id, payment!.id));
      await operationStore.markSucceeded(operation, {
        processorObjectId: result?.processorRefundId ?? providerTruth.processorPaymentIntentId,
        resultPayload: {
          outcome: result ? 'refund_completed' : 'noop_already_fully_refunded',
          providerStatus: providerTruth.status,
          amountRefundedCents: providerTruth.amountRefundedCents ?? null,
          processorRefundId: result?.processorRefundId ?? null,
          reverseTransfer: reverseConnectedTransfer,
          refundApplicationFee: reverseConnectedTransfer
        }
      });
    };

    const refundCaptured = async () => {
      await db.update(payments).set({ refundStatus: 'pending', updatedAt: new Date() }).where(eq(payments.id, payment!.id));
      const result = await provider.refundPayment({
        processorPaymentIntentId: payment!.processorPaymentIntentId!,
        idempotencyKey: `${operation.idempotencyKey}:refund`,
        reverseTransfer: reverseConnectedTransfer,
        refundApplicationFee: reverseConnectedTransfer
      });
      if (!isTerminalProviderReversalStatus('refund', result.status)) {
        throw new Error(`refund_not_terminal:${result.status}`);
      }
      const refundTruth = await provider.retrievePaymentAuthorization(payment!.processorPaymentIntentId!);
      await completeRefund(refundTruth, result);
    };

    let providerTruth = await provider.retrievePaymentAuthorization(payment.processorPaymentIntentId);
    await alignPaymentWithProviderTruth(payment.id, providerTruth, `reverse_preflight:${operation.id}`);
    payment = await loadPayment(payment.id);
    if (!payment) throw new Error('payment_not_found');
    if (providerTruth.status === 'canceled') {
      await completeVoid(providerTruth);
      return;
    }
    if (providerTruth.status === 'succeeded') {
      if (isFullRefundTruth(providerTruth)) await completeRefund(providerTruth);
      else await refundCaptured();
      return;
    }

    try {
      const result = await provider.voidPayment({
        processorPaymentIntentId: payment.processorPaymentIntentId!,
        idempotencyKey: `${operation.idempotencyKey}:void`
      });
      if (!isTerminalProviderReversalStatus('void', result.status)) {
        throw new Error(`void_not_terminal:${result.status}`);
      }
      providerTruth = await provider.retrievePaymentAuthorization(payment.processorPaymentIntentId!);
    } catch (error) {
      // Capture and closeout can cross at Stripe. Re-read remote truth before
      // classifying an invalid-state cancellation as terminal; if capture won,
      // this same reverse operation pivots to a destination-charge refund.
      providerTruth = await provider.retrievePaymentAuthorization(payment.processorPaymentIntentId!);
      if (!['succeeded', 'canceled'].includes(providerTruth.status)) throw error;
    }
    await alignPaymentWithProviderTruth(payment.id, providerTruth, `reverse_post_cancel:${operation.id}`);
    payment = await loadPayment(payment.id);
    if (providerTruth.status === 'succeeded') {
      if (isFullRefundTruth(providerTruth)) await completeRefund(providerTruth);
      else await refundCaptured();
      return;
    }
    if (providerTruth.status === 'canceled') {
      await completeVoid(providerTruth);
      return;
    }
    throw new Error(`reversal_provider_truth_not_terminal:${providerTruth.status}`);
  }

  async function executeClaimedOperation(operation: typeof liveRoomPaymentOperations.$inferSelect) {
    if (operation.operationType === 'authorize') return executeAuthorizeOperation(operation);
    if (operation.operationType === 'capture') return executeCaptureOperation(operation);
    return executeReverseOperation(operation);
  }

  async function markOperationFailure(
    operation: typeof liveRoomPaymentOperations.$inferSelect,
    error: unknown,
    forceTerminal = false
  ) {
    const admissionBlocked = error instanceof Error && [
      'live_money_release_gate_closed',
      'live_money_admission_denied',
      'payment_operation_lease_lost',
      'payment_operation_identity_mismatch'
    ].includes(error.message);
    const closeoutBlocked = error instanceof Error && [
      'capture_canceled_before_provider_call',
      'authorization_canceled_before_provider_call',
      'pending_action_expired_before_provider_call',
      'pending_action_expired_before_capture'
    ].includes(error.message);
    const terminalProcessorRejection = operation.operationType === 'authorize' && isTerminalProcessorError(error);
    const terminal = forceTerminal || closeoutBlocked || admissionBlocked || terminalProcessorRejection;
    const providerAmbiguousAuthorization = operation.operationType === 'authorize' && !terminal;
    const terminated = await operationStore.markFailed(
      operation,
      error,
      terminal,
      providerAmbiguousAuthorization
    );
    if (terminated && terminal && operation.operationType === 'authorize') {
      await lifecycle.transitionPaymentState({
        paymentId: operation.paymentId,
        processor: operation.processor,
        nextStatus: 'failed',
        eventType: 'payment.authorization.failed',
        processorEventId: `operation:${operation.id}:authorization_failed`,
        actorType: 'system',
        allowOutOfOrderNoop: true,
        metadata: { reason: operationRetryReason(error, 'authorization_failed') }
      });
    }
  }

  async function runSpecificOperation(operationId: string) {
    const operation = await operationStore.claim(workerId, operationId);
    if (!operation) return false;
    try {
      await executeClaimedOperation(operation);
      return true;
    } catch (error) {
      const forceTerminal = error instanceof Error && [
        'capture_canceled_before_provider_call',
        'authorization_canceled_before_provider_call'
      ].includes(error.message);
      await markOperationFailure(operation, error, forceTerminal);
      if (
        operation.operationType === 'capture'
        && error instanceof Error
        && ['live_money_release_gate_closed', 'live_money_admission_denied'].includes(error.message)
      ) {
        await voidOrRefund(operation.paymentId);
      }
      return false;
    }
  }

  async function captureAuthorization(paymentId: string): Promise<SettleResult> {
    if (!db || !provider) return { status: 'disabled' };
    let payment = await loadPayment(paymentId);
    if (!payment) return { status: 'failed', reason: 'payment_not_found' };
    payment = await ensureDurablePaymentBinding(payment);
    if (payment.paymentStatus === 'captured') return { status: 'captured', paymentId };
    if (payment.paymentStatus !== 'authorized') return { status: 'noop' };
    let operation;
    try {
      operation = await enqueueSettlement(payment, 'capture');
    } catch (error) {
      return { status: 'failed', reason: operationRetryReason(error, 'capture_operation_failed') };
    }
    if (!operation) return { status: 'failed', reason: 'capture_operation_unavailable' };
    if (operation.status === 'terminal_failed') {
      const reversal = await voidOrRefund(paymentId);
      return ['noop', 'voided', 'refunded'].includes(reversal.status)
        ? { status: 'failed', reason: 'capture_terminally_failed_and_payment_released' }
        : { status: 'pending', paymentId, reason: 'capture_terminally_failed_reversal_pending' };
    }
    await runSpecificOperation(operation.id);
    payment = await loadPayment(paymentId);
    if (payment?.paymentStatus === 'captured') return { status: 'captured', paymentId };
    if (payment && ['voided', 'refunded'].includes(payment.paymentStatus)) {
      return { status: 'failed', reason: 'capture_authority_revoked_payment_released' };
    }
    const [finishedOperation] = await db
      .select({ status: liveRoomPaymentOperations.status, lastError: liveRoomPaymentOperations.lastError })
      .from(liveRoomPaymentOperations)
      .where(eq(liveRoomPaymentOperations.id, operation.id))
      .limit(1);
    if (
      payment?.paymentStatus === 'authorized'
      && finishedOperation?.status === 'terminal_failed'
      && [
        'live_money_release_gate_closed',
        'live_money_admission_denied',
        'payment_operation_lease_lost'
      ].includes(finishedOperation.lastError ?? '')
    ) {
      const reversal = await voidOrRefund(paymentId);
      return ['voided', 'refunded', 'noop'].includes(reversal.status)
        ? { status: 'failed', reason: 'capture_authority_revoked_payment_released' }
        : { status: 'pending', paymentId, reason: 'capture_authority_revoked_reversal_pending' };
    }
    return { status: 'pending', paymentId, reason: 'capture_reconciliation_pending' };
  }

  async function voidOrRefund(paymentId: string): Promise<SettleResult> {
    if (!db || !provider) return { status: 'disabled' };
    let payment = await loadPayment(paymentId);
    if (!payment) return { status: 'failed', reason: 'payment_not_found' };
    if (['voided', 'refunded'].includes(payment.paymentStatus)) return { status: 'noop' };
    if (payment.paymentStatus === 'failed' && !payment.processorPaymentIntentId && !payment.legacyUnlinked) {
      return { status: 'noop' };
    }
    if (!payment.processorPaymentIntentId && ['created', 'failed'].includes(payment.paymentStatus)) {
      const preparation = await operationStore.prepareAuthorizationForCloseout(paymentId);
      if (preparation.status === 'in_flight') {
        return { status: 'pending', paymentId, reason: 'authorization_in_flight_during_closeout' };
      }
      if (preparation.status === 'reconcile') {
        await runSpecificOperation(preparation.operationId);
        payment = await loadPayment(paymentId);
        if (payment?.paymentStatus === 'voided') return { status: 'voided', paymentId };
        if (payment?.paymentStatus === 'refunded') return { status: 'refunded', paymentId };
        if (!payment?.processorPaymentIntentId) {
          return { status: 'pending', paymentId, reason: 'authorization_provider_truth_reconciliation_pending' };
        }
      } else if (preparation.status === 'provider_known') {
        const authorizeOperation = await loadAuthorizeOperation(paymentId);
        if (authorizeOperation?.processorObjectId) {
          await db
            .update(payments)
            .set({ processorPaymentIntentId: authorizeOperation.processorObjectId, updatedAt: new Date() })
            .where(eq(payments.id, paymentId));
          payment = await loadPayment(paymentId);
        }
        if (!payment?.processorPaymentIntentId) {
          return { status: 'pending', paymentId, reason: 'authorization_identity_repair_pending' };
        }
      } else if (preparation.status === 'canceled') {
        await lifecycle.transitionPaymentState({
          paymentId,
          processor: provider.processor,
          nextStatus: 'voided',
          eventType: 'payment.authorization.canceled_by_closeout',
          processorEventId: `closeout:${paymentId}:authorization_canceled`,
          actorType: 'system',
          allowOutOfOrderNoop: true
        });
        return { status: 'voided', paymentId };
      } else if (preparation.status === 'missing') {
        return { status: 'pending', paymentId, reason: payment.legacyUnlinked
          ? 'legacy_authorization_identity_quarantined'
          : 'authorization_operation_missing' };
      } else if (preparation.status === 'unavailable') {
        return { status: 'pending', paymentId, reason: 'authorization_store_unavailable' };
      }
    }
    payment = await ensureDurablePaymentBinding(payment);
    if (
      ['captured', 'paid_out'].includes(payment.paymentStatus)
      && payment.refundStatus !== 'refunded'
    ) {
      // Persist reversal intent before enqueue/provider work. If this process
      // dies or another worker owns the operation, closeout sees `pending` and
      // cannot count the charge as settled earnings.
      await db
        .update(payments)
        .set({ refundStatus: 'pending', updatedAt: new Date() })
        .where(eq(payments.id, paymentId));
      payment = await loadPayment(paymentId) ?? payment;
    }
    await operationStore.supersedePendingCaptureForCloseout(paymentId);
    let operation;
    try {
      operation = await enqueueSettlement(payment, 'reverse');
    } catch (error) {
      return { status: 'failed', reason: operationRetryReason(error, 'reversal_operation_failed') };
    }
    if (!operation) return { status: 'failed', reason: 'reversal_operation_unavailable' };
    await runSpecificOperation(operation.id);
    payment = await loadPayment(paymentId);
    if (payment?.paymentStatus === 'voided') return { status: 'voided', paymentId };
    if (payment?.paymentStatus === 'refunded') return { status: 'refunded', paymentId };
    return { status: 'pending', paymentId, reason: 'reversal_reconciliation_pending' };
  }

  async function voidOrRefundMany(paymentIds: string[]): Promise<PaymentReversalResult[]> {
    const results: PaymentReversalResult[] = [];
    for (const paymentId of [...new Set(paymentIds)]) {
      results.push({ paymentId, result: await voidOrRefund(paymentId) });
    }
    return results;
  }

  async function runDueOperations(input: { limit?: number } = {}) {
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit) || 25)));
    const result = { claimed: 0, succeeded: 0, failed: 0 };
    for (let index = 0; index < limit; index += 1) {
      const operation = await operationStore.claim(workerId);
      if (!operation) break;
      result.claimed += 1;
      try {
        await executeClaimedOperation(operation);
        result.succeeded += 1;
      } catch (error) {
        const forceTerminal = error instanceof Error && [
          'capture_canceled_before_provider_call',
          'authorization_canceled_before_provider_call',
          'pending_action_expired_before_provider_call',
          'pending_action_expired_before_capture'
        ].includes(error.message);
        await markOperationFailure(operation, error, forceTerminal);
        if (
          operation.operationType === 'capture'
          && error instanceof Error
          && ['live_money_release_gate_closed', 'live_money_admission_denied'].includes(error.message)
        ) {
          await voidOrRefund(operation.paymentId);
        }
        result.failed += 1;
      }
    }
    return result;
  }

  async function resolvePaymentIdByIntent(processorPaymentIntentId: string, metadataPaymentId?: string | null): Promise<string | null> {
    if (!db) return null;
    if (metadataPaymentId) {
      const [metadataRow] = await db
        .select({ id: payments.id, processorPaymentIntentId: payments.processorPaymentIntentId })
        .from(payments)
        .where(eq(payments.id, metadataPaymentId))
        .limit(1);
      if (
        metadataRow
        && (!processorPaymentIntentId
          || !metadataRow.processorPaymentIntentId
          || metadataRow.processorPaymentIntentId === processorPaymentIntentId)
      ) return metadataRow.id;
    }
    const [row] = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.processorPaymentIntentId, processorPaymentIntentId))
      .limit(1);
    return row?.id ?? null;
  }

  async function recordAuthorizationFromWebhook(
    paymentId: string,
    processorPaymentIntentId: string,
    providerStatus: string | null
  ) {
    await operationStore.markAuthorizeSucceeded(paymentId, {
      processorObjectId: processorPaymentIntentId,
      resultPayload: {
        clientSecret: null,
        providerStatus: providerStatus ?? 'requires_capture'
      }
    });
  }

  async function loadInvisibleActionTerminalOutcome(input: {
    clientRequestId: string;
    idempotencyKey: string;
  }) {
    if (!db) return null;
    const terminalInvisiblePayment = or(
      inArray(payments.paymentStatus, ['voided', 'refunded']),
      and(
        eq(payments.paymentStatus, 'failed'),
        isNull(payments.processorPaymentIntentId),
        eq(liveRoomPaymentOperations.operationType, 'authorize'),
        eq(liveRoomPaymentOperations.status, 'terminal_failed')
      )
    );
    const [requestOutcome] = await db
      .select({
        gigId: requests.gigId,
        actionType: payments.actionType,
        paymentId: payments.id,
        paymentStatus: payments.paymentStatus
      })
      .from(requests)
      .innerJoin(payments, eq(payments.requestId, requests.id))
      .leftJoin(liveRoomPaymentOperations, eq(liveRoomPaymentOperations.paymentId, payments.id))
      .where(and(
        eq(requests.clientRequestId, input.clientRequestId),
        eq(requests.idempotencyKey, input.idempotencyKey),
        isNull(requests.activatedAt),
        terminalInvisiblePayment
      ))
      .limit(1);
    if (requestOutcome) {
      return {
        gigId: requestOutcome.gigId,
        actionType: requestOutcome.actionType === 'tip' ? 'tip' as const : 'request' as const,
        paymentId: requestOutcome.paymentId,
        paymentStatus: requestOutcome.paymentStatus,
        outcome: requestOutcome.paymentStatus === 'failed' ? 'failed' as const : 'released' as const
      };
    }

    const [boostOutcome] = await db
      .select({
        gigId: requestBoosts.gigId,
        paymentId: payments.id,
        paymentStatus: payments.paymentStatus
      })
      .from(requestBoosts)
      .innerJoin(payments, eq(payments.requestBoostId, requestBoosts.id))
      .leftJoin(liveRoomPaymentOperations, eq(liveRoomPaymentOperations.paymentId, payments.id))
      .where(and(
        eq(requestBoosts.clientRequestId, input.clientRequestId),
        eq(requestBoosts.idempotencyKey, input.idempotencyKey),
        isNull(requestBoosts.activatedAt),
        terminalInvisiblePayment
      ))
      .limit(1);
    if (!boostOutcome) return null;
    return {
      gigId: boostOutcome.gigId,
      actionType: 'boost' as const,
      paymentId: boostOutcome.paymentId,
      paymentStatus: boostOutcome.paymentStatus,
      outcome: boostOutcome.paymentStatus === 'failed' ? 'failed' as const : 'released' as const
    };
  }

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

  async function listCloseoutReversalPaymentIds(gigId: string): Promise<string[]> {
    if (!db) return [];
    const paymentRows = await db
      .select({
        id: payments.id,
        actionType: payments.actionType,
        requestId: payments.requestId,
        requestBoostId: payments.requestBoostId,
        paymentStatus: payments.paymentStatus,
        refundStatus: payments.refundStatus,
        processorPaymentIntentId: payments.processorPaymentIntentId,
        legacyUnlinked: payments.legacyUnlinked
      })
      .from(payments)
      .where(eq(payments.gigId, gigId));

    const boostIds = paymentRows
      .map((row) => row.requestBoostId)
      .filter((id): id is string => Boolean(id));
    const boostRows = boostIds.length
      ? await db
          .select({ id: requestBoosts.id, requestId: requestBoosts.requestId })
          .from(requestBoosts)
          .where(inArray(requestBoosts.id, boostIds))
      : [];
    const parentByBoostId = new Map(boostRows.map((row) => [row.id, row.requestId]));
    const requestIds = [...new Set([
      ...paymentRows.map((row) => row.requestId).filter((id): id is string => Boolean(id)),
      ...boostRows.map((row) => row.requestId)
    ])];
    const requestRows = requestIds.length
      ? await db
          .select({ id: requests.id, status: requests.status })
          .from(requests)
          .where(inArray(requests.id, requestIds))
      : [];
    const statusByRequestId = new Map(requestRows.map((row) => [row.id, row.status]));
    const completedRequestStatuses = new Set(['fulfilled', 'captured', 'paid_out']);

    return paymentRows
      .filter((payment) => {
        if (['voided', 'refunded'].includes(payment.paymentStatus)) return false;
        // A partial refund is deliberately converged to a full destination-charge
        // reversal. Include it even when the linked action was completed so
        // closeout can revive/retry the durable reverse operation after outages.
        if (['captured', 'paid_out'].includes(payment.paymentStatus) && payment.refundStatus !== 'not_refunded') return true;
        if (payment.paymentStatus === 'paid_out') return false;
        if (payment.paymentStatus === 'failed' && !payment.legacyUnlinked && !payment.processorPaymentIntentId) return false;
        const linkedRequestId = payment.requestId
          ?? (payment.requestBoostId ? parentByBoostId.get(payment.requestBoostId) ?? null : null);
        // A mixed-version or pre-0028 orphan is not proof that no money exists.
        // Include it conservatively: reversal will repair the seller binding
        // and either reconcile provider truth or keep closeout quarantined.
        if (!linkedRequestId) return true;
        return !completedRequestStatuses.has(statusByRequestId.get(linkedRequestId) ?? 'payment_pending');
      })
      .map((payment) => payment.id);
  }

  async function listCloseoutBlockingPaymentIds(gigId: string): Promise<string[]> {
    if (!db) return [];
    const rows = await db
      .select({
        id: payments.id,
        paymentStatus: payments.paymentStatus,
        refundStatus: payments.refundStatus,
        processorPaymentIntentId: payments.processorPaymentIntentId,
        legacyUnlinked: payments.legacyUnlinked
      })
      .from(payments)
      .where(eq(payments.gigId, gigId));
    return rows
      .filter((payment) => {
        if (['voided', 'refunded'].includes(payment.paymentStatus)) return false;
        if (['captured', 'paid_out'].includes(payment.paymentStatus) && payment.refundStatus === 'not_refunded') return false;
        return !(payment.paymentStatus === 'failed' && !payment.legacyUnlinked && !payment.processorPaymentIntentId);
      })
      .map((payment) => payment.id);
  }

  async function reverseExpiredPendingPayments(paymentIds: string[]) {
    if (!db || !provider) return { attempted: 0, terminal: 0 };
    let terminal = 0;
    const uniquePaymentIds = [...new Set(paymentIds)];
    for (const paymentId of uniquePaymentIds) {
      const result = await voidOrRefund(paymentId);
      if (['noop', 'voided', 'refunded'].includes(result.status)) terminal += 1;
    }
    return { attempted: uniquePaymentIds.length, terminal };
  }

  async function reconcileActionVisibility(input: {
    limit?: number;
    ownedAction?: {
      clientRequestId: string;
      idempotencyKey: string;
      owner: PendingActionOwner;
    };
  } = {}) {
    if (!db) return {
      authorizationsReconciled: 0,
      requestsActivated: 0,
      boostsActivated: 0,
      paymentsConverged: 0,
      expiredPaymentsReversed: 0,
      expiredActionsTerminalized: 0
    };
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(input.limit) || 25)));
    const firstExpiryFence = await idempotencyStore.expireStalePendingActions({ limit });
    const expiredReversals = await reverseExpiredPendingPayments(firstExpiryFence.financiallyBlockedPaymentIds);
    const secondExpiryFence = await idempotencyStore.expireStalePendingActions({ limit });
    let authorizationsReconciled = 0;
    let requestsActivated = 0;
    let boostsActivated = 0;
    let paymentsConverged = 0;

    const loadInvisibleRequestDisposition = async (requestId: string) => {
      const [latest] = await db
        .select({
          activatedAt: requests.activatedAt,
          status: requests.status,
          runtimeState: requests.runtimeRequestState,
          roomStatus: gigSessions.status
        })
        .from(requests)
        .innerJoin(gigSessions, eq(gigSessions.id, requests.gigId))
        .where(eq(requests.id, requestId))
        .limit(1);
      const runtime = asRecord(latest?.runtimeState);
      const desiredStatus = recordString(runtime, 'status');
      return {
        stillInvisible: Boolean(latest && !latest.activatedAt),
        eligible: Boolean(
          latest
          && !latest.activatedAt
          && latest.status === 'payment_pending'
          && latest.roomStatus === 'active'
          && !recordBoolean(runtime, 'hidden')
          && !recordBoolean(runtime, 'removed')
        ),
        requiresCapture: recordString(runtime, 'type') === 'tip'
          || desiredStatus === 'approved'
          || desiredStatus === 'fulfilled'
      };
    };

    const loadInvisibleBoostDisposition = async (boostId: string) => {
      const [latest] = await db
        .select({
          activatedAt: requestBoosts.activatedAt,
          status: requestBoosts.status,
          roomStatus: gigSessions.status,
          parentStatus: requests.status,
          parentRuntime: requests.runtimeRequestState
        })
        .from(requestBoosts)
        .innerJoin(requests, eq(requests.id, requestBoosts.requestId))
        .innerJoin(gigSessions, eq(gigSessions.id, requestBoosts.gigId))
        .where(eq(requestBoosts.id, boostId))
        .limit(1);
      const parentRuntime = asRecord(latest?.parentRuntime);
      return {
        stillInvisible: Boolean(latest && !latest.activatedAt),
        eligible: Boolean(
          latest
          && !latest.activatedAt
          && latest.status === 'payment_pending'
          && latest.roomStatus === 'active'
          && latest.parentStatus === 'approved'
          && !recordBoolean(parentRuntime, 'hidden')
          && !recordBoolean(parentRuntime, 'removed')
          && !recordBoolean(parentRuntime, 'shadowBanned')
        )
      };
    };

    const fenceAndReverseOwnedInvisibleAction = async (input: {
      clientRequestId: string;
      idempotencyKey: string;
      gigId: string;
      actionType: 'request' | 'tip' | 'boost';
      paymentId: string;
      owner: PendingActionOwner;
      failureReason?: string;
    }) => {
      const fence = await idempotencyStore.fencePendingActionFailure(input);
      if (fence.status === 'already_visible' || fence.status === 'reconciled') return false;
      const reversal = await voidOrRefund(input.paymentId);
      if (!['noop', 'voided', 'refunded'].includes(reversal.status)) return false;
      await idempotencyStore.completePendingActionFailure({
        clientRequestId: input.clientRequestId,
        idempotencyKey: input.idempotencyKey,
        gigId: input.gigId,
        actionType: input.actionType,
        status: 403,
        body: {
          success: false,
          terminal: true,
          payment_status: 'voided_or_refunded',
          error: input.failureReason ?? 'The action could not be completed and its payment was reversed.'
        },
        owner: input.owner
      });
      return true;
    };

    const awaitingCustomerAuthorizations = provider
      ? await db
          .select({
            operationId: liveRoomPaymentOperations.id,
            paymentId: liveRoomPaymentOperations.paymentId,
            processorObjectId: liveRoomPaymentOperations.processorObjectId
          })
          .from(liveRoomPaymentOperations)
          .where(and(
            eq(liveRoomPaymentOperations.operationType, 'authorize'),
            eq(liveRoomPaymentOperations.status, 'awaiting_customer'),
            isNotNull(liveRoomPaymentOperations.processorObjectId)
          ))
          .orderBy(asc(liveRoomPaymentOperations.updatedAt))
          .limit(limit)
      : [];

    for (const row of awaitingCustomerAuthorizations) {
      if (!provider) break;
      try {
        const providerTruth = await provider.retrievePaymentAuthorization(row.processorObjectId!);
        await alignPaymentWithProviderTruth(row.paymentId, providerTruth, `awaiting_customer_reconcile:${row.operationId}`);
        if (['requires_capture', 'succeeded', 'canceled'].includes(providerTruth.status)) {
          await operationStore.markAuthorizeSucceeded(row.paymentId, {
            processorObjectId: providerTruth.processorPaymentIntentId,
            resultPayload: {
              providerStatus: providerTruth.status,
              clientSecret: providerTruth.clientSecret
            }
          });
          authorizationsReconciled += 1;
        } else {
          await db
            .update(liveRoomPaymentOperations)
            .set({ updatedAt: new Date() })
            .where(and(
              eq(liveRoomPaymentOperations.id, row.operationId),
              eq(liveRoomPaymentOperations.status, 'awaiting_customer')
            ));
        }
      } catch {
        // Provider uncertainty remains nonterminal; the next bounded pass uses
        // the same processor identity and cannot create another authorization.
        await db
          .update(liveRoomPaymentOperations)
          .set({ updatedAt: new Date() })
          .where(and(
            eq(liveRoomPaymentOperations.id, row.operationId),
            eq(liveRoomPaymentOperations.status, 'awaiting_customer')
          ));
      }
    }

    const pendingRequests = await db
      .select({
        requestId: requests.id,
        gigId: requests.gigId,
        idempotencyKey: requests.idempotencyKey,
        clientRequestId: requests.clientRequestId,
        stateRevision: requests.stateRevision,
        runtimeState: requests.runtimeRequestState,
        actorUserId: requests.patronUserId,
        patronDeviceIdHash: requests.patronDeviceIdHash,
        paymentId: payments.id,
        paymentStatus: payments.paymentStatus,
        paymentIntentId: payments.processorPaymentIntentId,
        platformFeeCents: payments.platformFee
      })
      .from(requests)
      .innerJoin(gigSessions, eq(gigSessions.id, requests.gigId))
      .leftJoin(payments, eq(payments.requestId, requests.id))
      .innerJoin(clientPendingActions, eq(clientPendingActions.idempotencyKey, requests.idempotencyKey))
      .where(and(
        isNull(requests.activatedAt),
        eq(requests.status, 'payment_pending'),
        eq(gigSessions.status, 'active'),
        inArray(clientPendingActions.status, ['pending', 'retrying']),
        gt(clientPendingActions.expiresAt, new Date()),
        gt(clientPendingActions.createdAt, new Date(Date.now() - 5 * 60 * 1000)),
        or(
          inArray(payments.paymentStatus, ['authorized', 'captured']),
          and(
            isNull(payments.id),
            sql`${requests.runtimeRequestState}->>'paymentStatus' = 'not_applicable'`
          )
        )
      ))
      .orderBy(asc(requests.createdAt))
      .limit(limit);

    for (const row of pendingRequests) {
      let recoveryOwner: PendingActionOwner | null = null;
      const suppliedOwner = input.ownedAction?.idempotencyKey === row.idempotencyKey
        && input.ownedAction.clientRequestId === row.clientRequestId
        ? input.ownedAction.owner
        : null;
      if (suppliedOwner) {
        recoveryOwner = suppliedOwner;
      } else {
        const ownership = await idempotencyStore.claimPendingActionOwner({
          clientRequestId: row.clientRequestId,
          idempotencyKey: row.idempotencyKey!
        });
        if (ownership.status !== 'acquired') continue;
        recoveryOwner = ownership.owner;
      }
      if (!recoveryOwner) continue;
      try {
        const runtime = asRecord(row.runtimeState);
        const senderName = recordString(runtime, 'senderName');
        const blockIdentities = moderationBlockIdentities({
          patronUserId: row.actorUserId,
          patronDeviceIdHash: row.patronDeviceIdHash,
          senderName
        });
        const blockDecision = await db.transaction(async (tx) => {
          await lockModerationBlockIdentities(tx, blockIdentities);
          const [activeBlock] = await tx
            .select({ id: activeBlocks.id })
            .from(activeBlocks)
            .where(and(
              eq(activeBlocks.status, 'active'),
              isNull(activeBlocks.revokedAt),
              or(...blockIdentities.map((identity) => and(
                eq(activeBlocks.scope, identity.scope),
                eq(activeBlocks.normalizedValue, identity.normalizedValue)
              )))
            ))
            .limit(1);
          return activeBlock ?? null;
        });
        if (blockDecision) {
          if (row.paymentId) {
            await fenceAndReverseOwnedInvisibleAction({
              clientRequestId: row.clientRequestId,
              idempotencyKey: row.idempotencyKey!,
              gigId: row.gigId,
              actionType: recordString(runtime, 'type') === 'tip' ? 'tip' : 'request',
              paymentId: row.paymentId,
              owner: recoveryOwner,
              failureReason: 'This submission is unavailable due to an active safety restriction.'
            });
          } else {
            await idempotencyStore.fencePendingActionFailure({
              clientRequestId: row.clientRequestId,
              idempotencyKey: row.idempotencyKey!,
              gigId: row.gigId,
              actionType: recordString(runtime, 'type') === 'tip' ? 'tip' : 'request',
              owner: recoveryOwner
            });
            await idempotencyStore.completePendingActionFailure({
              clientRequestId: row.clientRequestId,
              idempotencyKey: row.idempotencyKey!,
              gigId: row.gigId,
              actionType: recordString(runtime, 'type') === 'tip' ? 'tip' : 'request',
              status: 403,
              body: {
                success: false,
                terminal: true,
                payment_status: 'not_applicable',
                error: 'This submission is unavailable due to an active safety restriction.'
              },
              owner: recoveryOwner
            });
          }
          continue;
        }
        const desiredStatus = recordString(runtime, 'status');
        const actionType = recordString(runtime, 'type') === 'tip' ? 'tip' as const : 'request' as const;
        const requiresCapture = actionType === 'tip' || desiredStatus === 'approved' || desiredStatus === 'fulfilled';
        let paymentStatus = row.paymentStatus ?? recordString(runtime, 'paymentStatus');
        if (provider && row.paymentId && requiresCapture && paymentStatus === 'authorized') {
          const capture = await captureAuthorization(row.paymentId);
          if (capture.status === 'captured') paymentStatus = 'captured';
        }
        if (provider && row.paymentId && !requiresCapture && paymentStatus === 'captured') {
          const latest = await loadInvisibleRequestDisposition(row.requestId);
          if (latest.stillInvisible && (!latest.eligible || !latest.requiresCapture)) {
            await fenceAndReverseOwnedInvisibleAction({
              clientRequestId: row.clientRequestId,
              idempotencyKey: row.idempotencyKey!,
              gigId: row.gigId,
              actionType,
              paymentId: row.paymentId,
              owner: recoveryOwner
            });
          }
          continue;
        }
        const isFreeAction = !row.paymentId && paymentStatus === 'not_applicable';
        const mayActivate = isFreeAction || (requiresCapture
          ? paymentStatus === 'captured'
          : Boolean(paymentStatus && ['authorized', 'captured'].includes(paymentStatus)));
        if (!mayActivate) continue;
        const requestStatus = desiredStatus === 'approved'
          ? 'approved'
          : desiredStatus === 'fulfilled'
            ? 'fulfilled'
            : desiredStatus === 'denied'
              ? 'denied'
              : 'held_for_review';
        const now = new Date();
        const activationDecision = await db.transaction(async (tx) => {
        await lockModerationBlockIdentities(tx, blockIdentities);
        const [activeBlock] = await tx
          .select({ id: activeBlocks.id })
          .from(activeBlocks)
          .where(and(
            eq(activeBlocks.status, 'active'),
            isNull(activeBlocks.revokedAt),
            or(...blockIdentities.map((identity) => and(
              eq(activeBlocks.scope, identity.scope),
              eq(activeBlocks.normalizedValue, identity.normalizedValue)
            )))
          ))
          .limit(1);
        if (activeBlock) return { blocked: true, activated: [] as Array<{ id: string }> };
        if (!row.idempotencyKey) return { blocked: false, activated: [] as Array<{ id: string }> };
        const [room] = await tx
          .select({ status: gigSessions.status })
          .from(gigSessions)
          .where(eq(gigSessions.id, row.gigId))
          .for('update')
          .limit(1);
        if (room?.status !== 'active') return { blocked: false, activated: [] as Array<{ id: string }> };
        const [pending] = await tx
          .select({
            status: clientPendingActions.status,
            expiresAt: clientPendingActions.expiresAt,
            createdAt: clientPendingActions.createdAt,
            ownerToken: clientPendingActions.ownerToken,
            ownerGeneration: clientPendingActions.ownerGeneration,
            ownerLeaseExpiresAt: clientPendingActions.ownerLeaseExpiresAt
          })
          .from(clientPendingActions)
          .where(eq(clientPendingActions.idempotencyKey, row.idempotencyKey))
          .for('update')
          .limit(1);
        if (
          !pending
          || !['pending', 'retrying'].includes(pending.status)
          || Math.min(pending.expiresAt.getTime(), pending.createdAt.getTime() + 5 * 60 * 1000) <= Date.now()
          || pending.ownerToken !== recoveryOwner.token
          || pending.ownerGeneration !== recoveryOwner.generation
          || !pending.ownerLeaseExpiresAt
          || pending.ownerLeaseExpiresAt.getTime() <= Date.now()
        ) return { blocked: false, activated: [] as Array<{ id: string }> };
        const activated = await tx
          .update(requests)
          .set({
            status: requestStatus,
            activatedAt: now,
            runtimeRequestState: {
              ...runtime,
              durableRequestId: row.requestId,
              ...(row.paymentId ? { paymentId: row.paymentId } : {}),
              ...(row.paymentIntentId ? { paymentIntentId: row.paymentIntentId } : {}),
              paymentStatus,
              platformFee: Number(row.platformFeeCents ?? 0) / 100
            },
            stateRevision: sql`${requests.stateRevision} + 1`,
            updatedAt: now
          })
          .where(and(
            eq(requests.id, row.requestId),
            eq(requests.stateRevision, row.stateRevision),
            eq(requests.status, 'payment_pending'),
            isNull(requests.activatedAt)
          ))
          .returning({ id: requests.id });
        return { blocked: false, activated };
        });
        const activated = activationDecision.activated;
        if (activationDecision.blocked && row.paymentId) {
          await fenceAndReverseOwnedInvisibleAction({
            clientRequestId: row.clientRequestId,
            idempotencyKey: row.idempotencyKey!,
            gigId: row.gigId,
            actionType,
            paymentId: row.paymentId,
            owner: recoveryOwner,
            failureReason: 'This submission is unavailable due to an active safety restriction.'
          });
        } else if (activationDecision.blocked) {
          await idempotencyStore.fencePendingActionFailure({
            clientRequestId: row.clientRequestId,
            idempotencyKey: row.idempotencyKey!,
            gigId: row.gigId,
            actionType,
            owner: recoveryOwner
          });
          await idempotencyStore.completePendingActionFailure({
            clientRequestId: row.clientRequestId,
            idempotencyKey: row.idempotencyKey!,
            gigId: row.gigId,
            actionType,
            status: 403,
            body: {
              success: false,
              terminal: true,
              payment_status: 'not_applicable',
              error: 'This submission is unavailable due to an active safety restriction.'
            },
            owner: recoveryOwner
          });
        }
        if (!activated.length && row.paymentId) {
          const latest = await loadInvisibleRequestDisposition(row.requestId);
          if (provider && latest.stillInvisible && !latest.eligible) {
            await fenceAndReverseOwnedInvisibleAction({
              clientRequestId: row.clientRequestId,
              idempotencyKey: row.idempotencyKey!,
              gigId: row.gigId,
              actionType,
              paymentId: row.paymentId,
              owner: recoveryOwner
            });
          }
        }
        requestsActivated += activated.length;
      } finally {
        if (!suppliedOwner) {
          await idempotencyStore.releasePendingActionOwner({
            clientRequestId: row.clientRequestId,
            idempotencyKey: row.idempotencyKey!,
            owner: recoveryOwner
          });
        }
      }
    }

    const pendingBoosts = await db
      .select({
        boostId: requestBoosts.id,
        gigId: requestBoosts.gigId,
        idempotencyKey: requestBoosts.idempotencyKey,
        clientRequestId: requestBoosts.clientRequestId,
        parentId: requestBoosts.requestId,
        stateRevision: requestBoosts.stateRevision,
        runtimeState: requestBoosts.runtimeBoostState,
        actorUserId: requestBoosts.actorUserId,
        patronDeviceIdHash: requestBoosts.patronDeviceIdHash,
        parentStatus: requests.status,
        parentRuntime: requests.runtimeRequestState,
        paymentId: payments.id,
        paymentStatus: payments.paymentStatus,
        paymentIntentId: payments.processorPaymentIntentId
      })
      .from(requestBoosts)
      .innerJoin(requests, eq(requests.id, requestBoosts.requestId))
      .innerJoin(gigSessions, eq(gigSessions.id, requestBoosts.gigId))
      .leftJoin(payments, eq(payments.requestBoostId, requestBoosts.id))
      .innerJoin(clientPendingActions, eq(clientPendingActions.idempotencyKey, requestBoosts.idempotencyKey))
      .where(and(
        isNull(requestBoosts.activatedAt),
        eq(requestBoosts.status, 'payment_pending'),
        eq(gigSessions.status, 'active'),
        inArray(clientPendingActions.status, ['pending', 'retrying']),
        gt(clientPendingActions.expiresAt, new Date()),
        gt(clientPendingActions.createdAt, new Date(Date.now() - 5 * 60 * 1000)),
        or(
          inArray(payments.paymentStatus, ['authorized', 'captured']),
          and(
            isNull(payments.id),
            sql`${requestBoosts.runtimeBoostState}->>'paymentStatus' = 'not_applicable'`
          )
        )
      ))
      .orderBy(asc(requestBoosts.createdAt))
      .limit(limit);

    for (const row of pendingBoosts) {
      let recoveryOwner: PendingActionOwner | null = null;
      const suppliedOwner = input.ownedAction?.idempotencyKey === row.idempotencyKey
        && input.ownedAction.clientRequestId === row.clientRequestId
        ? input.ownedAction.owner
        : null;
      if (suppliedOwner) {
        recoveryOwner = suppliedOwner;
      } else {
        const ownership = await idempotencyStore.claimPendingActionOwner({
          clientRequestId: row.clientRequestId,
          idempotencyKey: row.idempotencyKey!
        });
        if (ownership.status !== 'acquired') continue;
        recoveryOwner = ownership.owner;
      }
      if (!recoveryOwner) continue;
      try {
        const runtime = asRecord(row.runtimeState);
        const patronName = recordString(runtime, 'patronName');
        const blockIdentities = moderationBlockIdentities({
          patronUserId: row.actorUserId,
          patronDeviceIdHash: row.patronDeviceIdHash,
          senderName: patronName
        });
        const blockDecision = await db.transaction(async (tx) => {
          await lockModerationBlockIdentities(tx, blockIdentities);
          const [activeBlock] = await tx
            .select({ id: activeBlocks.id })
            .from(activeBlocks)
            .where(and(
              eq(activeBlocks.status, 'active'),
              isNull(activeBlocks.revokedAt),
              or(...blockIdentities.map((identity) => and(
                eq(activeBlocks.scope, identity.scope),
                eq(activeBlocks.normalizedValue, identity.normalizedValue)
              )))
            ))
            .limit(1);
          return activeBlock ?? null;
        });
        if (blockDecision) {
          if (row.paymentId) {
            await fenceAndReverseOwnedInvisibleAction({
              clientRequestId: row.clientRequestId,
              idempotencyKey: row.idempotencyKey!,
              gigId: row.gigId,
              actionType: 'boost',
              paymentId: row.paymentId,
              owner: recoveryOwner
            });
          } else {
            await idempotencyStore.fencePendingActionFailure({
              clientRequestId: row.clientRequestId,
              idempotencyKey: row.idempotencyKey!,
              gigId: row.gigId,
              actionType: 'boost',
              owner: recoveryOwner
            });
            await idempotencyStore.completePendingActionFailure({
              clientRequestId: row.clientRequestId,
              idempotencyKey: row.idempotencyKey!,
              gigId: row.gigId,
              actionType: 'boost',
              status: 403,
              body: {
                success: false,
                terminal: true,
                payment_status: 'not_applicable',
                error: 'This submission is unavailable due to an active safety restriction.'
              },
              owner: recoveryOwner
            });
          }
          continue;
        }
        const parentRuntime = asRecord(row.parentRuntime);
        const targetEligible = row.parentStatus === 'approved'
          && !recordBoolean(parentRuntime, 'hidden')
          && !recordBoolean(parentRuntime, 'removed')
          && !recordBoolean(parentRuntime, 'shadowBanned');
        let paymentStatus = row.paymentStatus ?? recordString(runtime, 'paymentStatus');
        if (!targetEligible) {
          if (provider && row.paymentId && paymentStatus && !['voided', 'refunded', 'paid_out'].includes(paymentStatus)) {
            const latest = await loadInvisibleBoostDisposition(row.boostId);
            if (latest.stillInvisible && !latest.eligible) {
              await fenceAndReverseOwnedInvisibleAction({
                clientRequestId: row.clientRequestId,
                idempotencyKey: row.idempotencyKey!,
                gigId: row.gigId,
                actionType: 'boost',
                paymentId: row.paymentId,
                owner: recoveryOwner
              });
            }
          }
          continue;
        }
        if (provider && row.paymentId && paymentStatus === 'authorized') {
          const capture = await captureAuthorization(row.paymentId);
          if (capture.status === 'captured') paymentStatus = 'captured';
        }
        if (paymentStatus !== 'captured' && !(paymentStatus === 'not_applicable' && !row.paymentId)) continue;
        const now = new Date();
        const activationDecision = await db.transaction(async (tx) => {
        await lockModerationBlockIdentities(tx, blockIdentities);
        const [activeBlock] = await tx
          .select({ id: activeBlocks.id })
          .from(activeBlocks)
          .where(and(
            eq(activeBlocks.status, 'active'),
            isNull(activeBlocks.revokedAt),
            or(...blockIdentities.map((identity) => and(
              eq(activeBlocks.scope, identity.scope),
              eq(activeBlocks.normalizedValue, identity.normalizedValue)
            )))
          ))
          .limit(1);
        if (activeBlock) return { blocked: true, activated: [] as Array<{ id: string }> };
        if (!row.idempotencyKey) return { blocked: false, activated: [] as Array<{ id: string }> };
        const [room] = await tx
          .select({ status: gigSessions.status })
          .from(gigSessions)
          .where(eq(gigSessions.id, row.gigId))
          .for('update')
          .limit(1);
        if (room?.status !== 'active') return { blocked: false, activated: [] as Array<{ id: string }> };
        const [pending] = await tx
          .select({
            status: clientPendingActions.status,
            expiresAt: clientPendingActions.expiresAt,
            createdAt: clientPendingActions.createdAt,
            ownerToken: clientPendingActions.ownerToken,
            ownerGeneration: clientPendingActions.ownerGeneration,
            ownerLeaseExpiresAt: clientPendingActions.ownerLeaseExpiresAt
          })
          .from(clientPendingActions)
          .where(eq(clientPendingActions.idempotencyKey, row.idempotencyKey))
          .for('update')
          .limit(1);
        if (
          !pending
          || !['pending', 'retrying'].includes(pending.status)
          || Math.min(pending.expiresAt.getTime(), pending.createdAt.getTime() + 5 * 60 * 1000) <= Date.now()
          || pending.ownerToken !== recoveryOwner.token
          || pending.ownerGeneration !== recoveryOwner.generation
          || !pending.ownerLeaseExpiresAt
          || pending.ownerLeaseExpiresAt.getTime() <= Date.now()
        ) return { blocked: false, activated: [] as Array<{ id: string }> };
        const [parent] = await tx
          .select({ status: requests.status, runtimeState: requests.runtimeRequestState })
          .from(requests)
          .where(eq(requests.id, row.parentId))
          .for('update')
          .limit(1);
        const latestParentRuntime = asRecord(parent?.runtimeState);
        const stillEligible = parent?.status === 'approved'
          && !recordBoolean(latestParentRuntime, 'hidden')
          && !recordBoolean(latestParentRuntime, 'removed')
          && !recordBoolean(latestParentRuntime, 'shadowBanned');
        if (!stillEligible) return { blocked: false, activated: [] as Array<{ id: string }> };
        const activated = await tx
          .update(requestBoosts)
          .set({
            status: 'approved',
            activatedAt: now,
            runtimeBoostState: {
              ...runtime,
              durableBoostId: row.boostId,
              ...(row.paymentId ? { paymentId: row.paymentId } : {}),
              ...(row.paymentIntentId ? { paymentIntentId: row.paymentIntentId } : {}),
              paymentStatus
            },
            stateRevision: sql`${requestBoosts.stateRevision} + 1`,
            updatedAt: now
          })
          .where(and(
            eq(requestBoosts.id, row.boostId),
            eq(requestBoosts.stateRevision, row.stateRevision),
            eq(requestBoosts.status, 'payment_pending'),
            isNull(requestBoosts.activatedAt)
          ))
          .returning({ id: requestBoosts.id });
        return { blocked: false, activated };
        });
        const activated = activationDecision.activated;
        if (activationDecision.blocked && row.paymentId) {
          await fenceAndReverseOwnedInvisibleAction({
            clientRequestId: row.clientRequestId,
            idempotencyKey: row.idempotencyKey!,
            gigId: row.gigId,
            actionType: 'boost',
            paymentId: row.paymentId,
            owner: recoveryOwner,
            failureReason: 'This submission is unavailable due to an active safety restriction.'
          });
        } else if (activationDecision.blocked) {
          await idempotencyStore.fencePendingActionFailure({
            clientRequestId: row.clientRequestId,
            idempotencyKey: row.idempotencyKey!,
            gigId: row.gigId,
            actionType: 'boost',
            owner: recoveryOwner
          });
          await idempotencyStore.completePendingActionFailure({
            clientRequestId: row.clientRequestId,
            idempotencyKey: row.idempotencyKey!,
            gigId: row.gigId,
            actionType: 'boost',
            status: 403,
            body: {
              success: false,
              terminal: true,
              payment_status: 'not_applicable',
              error: 'This submission is unavailable due to an active safety restriction.'
            },
            owner: recoveryOwner
          });
        }
        if (!activated.length && row.paymentId) {
          const latest = await loadInvisibleBoostDisposition(row.boostId);
          if (provider && latest.stillInvisible && !latest.eligible) {
            await fenceAndReverseOwnedInvisibleAction({
              clientRequestId: row.clientRequestId,
              idempotencyKey: row.idempotencyKey!,
              gigId: row.gigId,
              actionType: 'boost',
              paymentId: row.paymentId,
              owner: recoveryOwner
            });
          }
        }
        boostsActivated += activated.length;
      } finally {
        if (!suppliedOwner) {
          await idempotencyStore.releasePendingActionOwner({
            clientRequestId: row.clientRequestId,
            idempotencyKey: row.idempotencyKey!,
            owner: recoveryOwner
          });
        }
      }
    }

    // Performer decisions are persisted before their processor side effect.
    // If the process dies between those boundaries, this pass converges the
    // payment to the already-durable request decision instead of leaving a
    // captured-but-held or hidden-but-charged action behind.
    const activeRequestPayments = await db
      .select({
        requestId: requests.id,
        stateRevision: requests.stateRevision,
        requestStatus: requests.status,
        requestRuntime: requests.runtimeRequestState,
        paymentId: payments.id,
        paymentStatus: payments.paymentStatus
      })
      .from(requests)
      .innerJoin(payments, eq(payments.requestId, requests.id))
      .where(and(
        isNotNull(requests.activatedAt),
        sql`(
          (${requests.status} in ('approved', 'fulfilled') and ${payments.paymentStatus} in ('authorized', 'failed', 'voided', 'refunded'))
          or (
            (
              ${requests.status} = 'denied'
              or coalesce(${requests.runtimeRequestState}->>'hidden', 'false') = 'true'
              or coalesce(${requests.runtimeRequestState}->>'removed', 'false') = 'true'
              or (${payments.paymentStatus} = 'captured' and ${requests.status} not in ('approved', 'fulfilled'))
            )
            and ${payments.paymentStatus} not in ('voided', 'refunded', 'paid_out')
          )
          or coalesce(${requests.runtimeRequestState}->>'paymentStatus', '') is distinct from
            case when ${payments.paymentStatus} in ('voided', 'refunded') then 'voided_or_refunded' else ${payments.paymentStatus}::text end
        )`
      ))
      .orderBy(asc(requests.updatedAt))
      .limit(limit);

    for (const row of activeRequestPayments) {
      const runtime = asRecord(row.requestRuntime);
      let paymentStatus = row.paymentStatus;
      const shouldReverse = row.requestStatus === 'denied'
        || recordBoolean(runtime, 'hidden')
        || recordBoolean(runtime, 'removed')
        || (paymentStatus === 'captured' && !['approved', 'fulfilled'].includes(row.requestStatus));
      const shouldCapture = !shouldReverse && ['approved', 'fulfilled'].includes(row.requestStatus);

      if (provider && shouldReverse && !['voided', 'refunded', 'paid_out'].includes(paymentStatus)) {
        await voidOrRefund(row.paymentId);
        paymentStatus = (await loadPayment(row.paymentId))?.paymentStatus ?? paymentStatus;
      } else if (provider && shouldCapture && paymentStatus === 'authorized') {
        await captureAuthorization(row.paymentId);
        paymentStatus = (await loadPayment(row.paymentId))?.paymentStatus ?? paymentStatus;
      }

      const paymentTerminalWithoutCapture = shouldCapture && ['failed', 'voided', 'refunded'].includes(paymentStatus);
      const nextRequestStatus = paymentTerminalWithoutCapture ? 'denied' : row.requestStatus;
      const runtimePaymentStatus = ['voided', 'refunded'].includes(paymentStatus)
        ? 'voided_or_refunded'
        : paymentStatus;
      if (
        nextRequestStatus === row.requestStatus
        && recordString(runtime, 'paymentStatus') === runtimePaymentStatus
      ) continue;

      const updated = await db
        .update(requests)
        .set({
          status: nextRequestStatus,
          runtimeRequestState: paymentTerminalWithoutCapture
            ? sql`jsonb_set(jsonb_set(coalesce(${requests.runtimeRequestState}, '{}'::jsonb), '{paymentStatus}', to_jsonb(${runtimePaymentStatus}::text), true), '{status}', to_jsonb('denied'::text), true)`
            : sql`jsonb_set(coalesce(${requests.runtimeRequestState}, '{}'::jsonb), '{paymentStatus}', to_jsonb(${runtimePaymentStatus}::text), true)`,
          stateRevision: sql`${requests.stateRevision} + 1`,
          updatedAt: new Date()
        })
        .where(and(
          eq(requests.id, row.requestId),
          eq(requests.stateRevision, row.stateRevision),
          isNotNull(requests.activatedAt)
        ))
        .returning({ id: requests.id });
      paymentsConverged += updated.length;
    }

    const activeBoostPayments = await db
      .select({
        boostId: requestBoosts.id,
        stateRevision: requestBoosts.stateRevision,
        boostRuntime: requestBoosts.runtimeBoostState,
        parentStatus: requests.status,
        parentRuntime: requests.runtimeRequestState,
        paymentId: payments.id,
        paymentStatus: payments.paymentStatus
      })
      .from(requestBoosts)
      .innerJoin(requests, eq(requests.id, requestBoosts.requestId))
      .innerJoin(payments, eq(payments.requestBoostId, requestBoosts.id))
      .where(and(
        isNotNull(requestBoosts.activatedAt),
        sql`(
          ${requests.status} = 'denied'
          or coalesce(${requests.runtimeRequestState}->>'hidden', 'false') = 'true'
          or coalesce(${requests.runtimeRequestState}->>'removed', 'false') = 'true'
        )`,
        sql`(
          ${payments.paymentStatus} not in ('voided', 'refunded', 'paid_out')
          or coalesce(${requestBoosts.runtimeBoostState}->>'paymentStatus', '') is distinct from
            case when ${payments.paymentStatus} in ('voided', 'refunded') then 'voided_or_refunded' else ${payments.paymentStatus}::text end
        )`
      ))
      .orderBy(asc(requestBoosts.updatedAt))
      .limit(limit);

    for (const row of activeBoostPayments) {
      const parentRuntime = asRecord(row.parentRuntime);
      const shouldReverse = row.parentStatus === 'denied'
        || recordBoolean(parentRuntime, 'hidden')
        || recordBoolean(parentRuntime, 'removed');
      if (!shouldReverse) continue;

      if (provider && !['voided', 'refunded', 'paid_out'].includes(row.paymentStatus)) {
        await voidOrRefund(row.paymentId);
      }
      const paymentStatus = (await loadPayment(row.paymentId))?.paymentStatus ?? row.paymentStatus;
      const runtime = asRecord(row.boostRuntime);
      const runtimePaymentStatus = ['voided', 'refunded'].includes(paymentStatus)
        ? 'voided_or_refunded'
        : paymentStatus;
      const updated = await db
        .update(requestBoosts)
        .set({
          status: ['voided', 'refunded'].includes(paymentStatus) ? 'voided_or_refunded' : 'denied',
          runtimeBoostState: sql`jsonb_set(coalesce(${requestBoosts.runtimeBoostState}, '{}'::jsonb), '{paymentStatus}', to_jsonb(${runtimePaymentStatus}::text), true)`,
          stateRevision: sql`${requestBoosts.stateRevision} + 1`,
          updatedAt: new Date()
        })
        .where(and(
          eq(requestBoosts.id, row.boostId),
          eq(requestBoosts.stateRevision, row.stateRevision),
          isNotNull(requestBoosts.activatedAt)
        ))
        .returning({ id: requestBoosts.id });
      paymentsConverged += updated.length;
    }

    // Time can cross the deadline while a provider call or activation CAS is
    // in flight. Finish with the same fence -> reverse -> canonicalize order
    // so one reconciliation pass cannot leave newly expired work chargeable.
    const finalExpiryFence = await idempotencyStore.expireStalePendingActions({ limit });
    const finalExpiredReversals = await reverseExpiredPendingPayments(finalExpiryFence.financiallyBlockedPaymentIds);
    const finalExpiryCompletion = await idempotencyStore.expireStalePendingActions({ limit });

    return {
      authorizationsReconciled,
      requestsActivated,
      boostsActivated,
      paymentsConverged,
      expiredPaymentsReversed: expiredReversals.terminal + finalExpiredReversals.terminal,
      expiredActionsTerminalized: firstExpiryFence.terminalized
        + secondExpiryFence.terminalized
        + finalExpiryFence.terminalized
        + finalExpiryCompletion.terminalized
    };
  }

  async function dispose() {
    if (!config.databaseUrl) return;
    await closeDisposableSwayDbProof(config.databaseUrl);
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
    runDueOperations,
    resolvePaymentIdByIntent,
    recordAuthorizationFromWebhook,
    loadInvisibleActionTerminalOutcome,
    aggregateCapturedTotals,
    listCloseoutReversalPaymentIds,
    listCloseoutBlockingPaymentIds,
    reconcileActionVisibility,
    dispose,
    transitionPaymentState: lifecycle.transitionPaymentState
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
