import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { audioProviderOperations } from '../db/schema';
import type { AudioObjectIdentity } from './audio-object-storage';

export type AudioProviderOperationType =
  | 'initiate_multipart'
  | 'upload_part'
  | 'complete_multipart'
  | 'discard_upload'
  | 'abort_upload';

export type AudioProviderOperationStatus =
  | 'pending'
  | 'leased'
  | 'reconcile_required'
  | 'awaiting_client_retry'
  | 'succeeded'
  | 'canceled'
  | 'dead_letter';

export type AudioProviderOperationRow = typeof audioProviderOperations.$inferSelect;
export type AudioProviderOperationTransaction = Parameters<Parameters<SwayDb['transaction']>[0]>[0];

export type AudioProviderOperationLease = Readonly<{
  operationId: string;
  token: string;
  owner: string;
  mode: 'execute' | 'reconcile';
  expiresAt: Date;
}>;

export type AudioProviderOperationClaim =
  | { kind: 'leased'; operation: AudioProviderOperationRow; lease: AudioProviderOperationLease }
  | { kind: 'busy' | 'fenced' | 'terminal' | 'unavailable' | 'exhausted'; operation: AudioProviderOperationRow };

type AudioProviderOperationExecutor = Pick<AudioProviderOperationTransaction, 'insert' | 'select'>;

export type ReserveAudioProviderOperationInput = {
  projectId: string;
  performerId: string;
  requestedByUserId: string | null;
  uploadSessionId?: string | null;
  plannedUploadSessionId: string;
  operationType: AudioProviderOperationType;
  requestOrigin?: 'user' | 'system_cleanup' | 'system_recovery';
  identity: AudioObjectIdentity;
  partNumber?: number | null;
  bodySha256?: string | null;
  bodyMd5?: string | null;
  bodyByteSize?: number | null;
  reservedByteSize?: number;
  reservedObjectCount?: number;
  requestPayload: Record<string, unknown>;
  maxAttempts?: number;
};

export class AudioProviderOperationConflictError extends Error {
  readonly code = 'audio_provider_operation_intent_conflict';
  readonly status = 409;

  constructor(message = 'The durable provider operation is already bound to a different intent.') {
    super(message);
    this.name = 'AudioProviderOperationConflictError';
  }
}

export class AudioProviderOperationBusyError extends Error {
  readonly code = 'audio_provider_operation_in_progress';
  readonly status = 409;

  constructor(message = 'The durable provider operation is already in progress.') {
    super(message);
    this.name = 'AudioProviderOperationBusyError';
  }
}

export class AudioProviderCallTimeoutError extends Error {
  readonly code = 'audio_provider_call_timed_out';
  readonly status = 503;
  readonly preservesActiveLease = true;

  constructor(message = 'The provider call exceeded its bounded request deadline and is still durably fenced.') {
    super(message);
    this.name = 'AudioProviderCallTimeoutError';
  }
}

export class AudioProviderLeaseHeartbeatError extends Error {
  readonly code = 'audio_provider_lease_heartbeat_failed';
  readonly status = 503;
  readonly preservesActiveLease = true;
  readonly heartbeatCause: unknown;

  constructor(cause: unknown) {
    super('The provider lease heartbeat failed while provider I/O may still be running; the operation remains durably fenced.');
    this.name = 'AudioProviderLeaseHeartbeatError';
    this.heartbeatCause = cause;
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Provider-operation evidence cannot contain non-finite numbers.');
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(record[key])])
    );
  }
  throw new Error('Provider-operation evidence must be JSON-compatible.');
}

export function canonicalAudioProviderValue(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

export function fingerprintAudioProviderValue(value: unknown) {
  return createHash('sha256').update(canonicalAudioProviderValue(value)).digest('hex');
}

export function buildAudioProviderOperationKey(input: {
  projectId: string;
  plannedUploadSessionId: string;
  operationType: AudioProviderOperationType;
  partNumber?: number | null;
}) {
  return `audio-provider:v1:${input.projectId}:${input.plannedUploadSessionId}:${input.operationType}:${input.partNumber ?? 0}`;
}

function normalizeNullable<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function assertReservedOperationMatches(
  operation: AudioProviderOperationRow,
  input: ReserveAudioProviderOperationInput,
  operationKey: string,
  intentFingerprint: string
) {
  const expected = {
    projectId: input.projectId,
    performerId: input.performerId,
    requestedByUserId: input.requestedByUserId,
    uploadSessionId: normalizeNullable(input.uploadSessionId),
    plannedUploadSessionId: input.plannedUploadSessionId,
    operationType: input.operationType,
    operationKey,
    intentFingerprint,
    requestOrigin: input.requestOrigin ?? 'user',
    storageProvider: input.identity.storageProvider,
    storageBucket: input.identity.storageBucket,
    storageKey: input.identity.storageKey,
    providerUploadId: normalizeNullable(input.identity.providerUploadId),
    partNumber: normalizeNullable(input.partNumber),
    bodySha256: normalizeNullable(input.bodySha256),
    bodyMd5: normalizeNullable(input.bodyMd5),
    bodyByteSize: normalizeNullable(input.bodyByteSize),
    reservedByteSize: input.reservedByteSize ?? 0,
    reservedObjectCount: input.reservedObjectCount ?? 0,
    maxAttempts: input.maxAttempts ?? 20,
    requestPayload: canonicalAudioProviderValue(input.requestPayload)
  };
  const observed = {
    projectId: operation.projectId,
    performerId: operation.performerId,
    requestedByUserId: operation.requestedByUserId,
    uploadSessionId: operation.uploadSessionId,
    plannedUploadSessionId: operation.plannedUploadSessionId,
    operationType: operation.operationType,
    operationKey: operation.operationKey,
    intentFingerprint: operation.intentFingerprint,
    requestOrigin: operation.requestOrigin,
    storageProvider: operation.storageProvider,
    storageBucket: operation.storageBucket,
    storageKey: operation.storageKey,
    providerUploadId: operation.providerUploadId,
    partNumber: operation.partNumber,
    bodySha256: operation.bodySha256,
    bodyMd5: operation.bodyMd5,
    bodyByteSize: operation.bodyByteSize,
    reservedByteSize: operation.reservedByteSize,
    reservedObjectCount: operation.reservedObjectCount,
    maxAttempts: operation.maxAttempts,
    requestPayload: canonicalAudioProviderValue(operation.requestPayload)
  };
  if (canonicalAudioProviderValue(observed) !== canonicalAudioProviderValue(expected)) {
    throw new AudioProviderOperationConflictError();
  }
}

function boundedError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return message.trim().slice(0, 4000) || fallback;
}

function assertEvidence(evidence: Record<string, unknown>) {
  if (!evidence || Object.keys(evidence).length === 0) {
    throw new Error('Provider-operation result evidence must be a non-empty object.');
  }
}

export function createAudioProviderOperationCoordinator(config: {
  db: SwayDb;
  leaseOwner?: string;
  leaseDurationMs?: number;
  providerCallTimeoutMs?: number;
}) {
  const { db } = config;
  const leaseOwner = (config.leaseOwner ?? `sway-audio-${process.pid}`).trim();
  const leaseDurationMs = config.leaseDurationMs ?? 4 * 60 * 1000;
  if (!leaseOwner || leaseOwner.length > 160) {
    throw new Error('Audio provider-operation lease owner must contain 1 through 160 characters.');
  }
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 5 * 60 * 1000) {
    throw new Error('Audio provider-operation lease duration must be from 1 second through 5 minutes.');
  }
  const providerCallTimeoutMs = config.providerCallTimeoutMs ?? Math.floor(leaseDurationMs * 0.75);
  if (!Number.isSafeInteger(providerCallTimeoutMs)
    || providerCallTimeoutMs < 250
    || providerCallTimeoutMs > leaseDurationMs - 100) {
    throw new Error('Audio provider-call timeout must be at least 250ms and remain below its operation lease.');
  }

  async function reserveOperation(
    executor: AudioProviderOperationExecutor,
    input: ReserveAudioProviderOperationInput
  ) {
    assertEvidence(input.requestPayload);
    const operationKey = buildAudioProviderOperationKey(input);
    const intentFingerprint = fingerprintAudioProviderValue(input.requestPayload);
    const inserted = await executor
      .insert(audioProviderOperations)
      .values({
        projectId: input.projectId,
        performerId: input.performerId,
        requestedByUserId: input.requestedByUserId,
        uploadSessionId: input.uploadSessionId ?? null,
        plannedUploadSessionId: input.plannedUploadSessionId,
        operationType: input.operationType,
        operationKey,
        intentFingerprint,
        requestOrigin: input.requestOrigin ?? 'user',
        storageProvider: input.identity.storageProvider,
        storageBucket: input.identity.storageBucket,
        storageKey: input.identity.storageKey,
        providerUploadId: input.identity.providerUploadId ?? null,
        partNumber: input.partNumber ?? null,
        bodySha256: input.bodySha256 ?? null,
        bodyMd5: input.bodyMd5 ?? null,
        bodyByteSize: input.bodyByteSize ?? null,
        reservedByteSize: input.reservedByteSize ?? 0,
        reservedObjectCount: input.reservedObjectCount ?? 0,
        requestPayload: input.requestPayload,
        maxAttempts: input.maxAttempts ?? 20
      })
      .onConflictDoNothing()
      .returning();
    const operation = inserted[0] ?? (await executor
      .select()
      .from(audioProviderOperations)
      .where(eq(audioProviderOperations.operationKey, operationKey))
      .limit(1))[0];
    if (!operation) {
      throw new AudioProviderOperationConflictError('A conflicting provider operation already owns this upload subject.');
    }
    assertReservedOperationMatches(operation, input, operationKey, intentFingerprint);
    return { operation, created: inserted.length === 1 };
  }

  async function loadOperation(operationId: string) {
    return (await db
      .select()
      .from(audioProviderOperations)
      .where(eq(audioProviderOperations.id, operationId))
      .limit(1))[0] ?? null;
  }

  async function claimOperation(operationId: string): Promise<AudioProviderOperationClaim> {
    return db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(audioProviderOperations)
        .where(eq(audioProviderOperations.id, operationId))
        .for('update')
        .limit(1);
      if (!operation) throw new Error('Durable audio provider operation not found.');
      const status = operation.status as AudioProviderOperationStatus;
      if (['succeeded', 'canceled', 'dead_letter'].includes(status)) {
        return { kind: 'terminal' as const, operation };
      }
      if (operation.uploadSessionId
        && ['upload_part', 'complete_multipart'].includes(operation.operationType)) {
        const [cleanupFence] = await tx
          .select({ id: audioProviderOperations.id })
          .from(audioProviderOperations)
          .where(and(
            eq(audioProviderOperations.uploadSessionId, operation.uploadSessionId),
            inArray(audioProviderOperations.operationType, ['discard_upload', 'abort_upload'])
          ))
          .limit(1);
        if (cleanupFence) {
          return { kind: 'fenced' as const, operation };
        }
      }
      const now = new Date();
      if (operation.availableAt.getTime() > now.getTime()) {
        return { kind: 'unavailable' as const, operation };
      }
      if (status === 'leased' && operation.leaseExpiresAt && operation.leaseExpiresAt.getTime() > now.getTime()) {
        return { kind: 'busy' as const, operation };
      }
      if (operation.attemptCount >= operation.maxAttempts) {
        const [deadLetter] = await tx
          .update(audioProviderOperations)
          .set({
            status: 'dead_letter',
            leaseToken: null,
            leaseOwner: null,
            leaseMode: null,
            leaseExpiresAt: null,
            lastError: 'Provider operation exhausted its bounded attempt budget.',
            lastErrorCode: 'attempt_budget_exhausted'
          })
          .where(eq(audioProviderOperations.id, operation.id))
          .returning();
        if (!deadLetter) throw new AudioProviderOperationBusyError('Provider attempt exhaustion was fenced by another worker.');
        return { kind: 'exhausted' as const, operation: deadLetter };
      }
      const mode: 'execute' | 'reconcile' = status === 'reconcile_required'
        || (status === 'leased' && operation.providerStartedAt !== null)
        ? 'reconcile'
        : 'execute';
      const token = randomUUID();
      const expiresAt = new Date(now.getTime() + leaseDurationMs);
      const [leased] = await tx
        .update(audioProviderOperations)
        .set({
          status: 'leased',
          leaseToken: token,
          leaseOwner,
          leaseMode: mode,
          leaseExpiresAt: expiresAt,
          attemptCount: operation.attemptCount + 1
        })
        .where(eq(audioProviderOperations.id, operation.id))
        .returning();
      if (!leased) throw new AudioProviderOperationBusyError();
      return {
        kind: 'leased' as const,
        operation: leased,
        lease: { operationId: leased.id, token, owner: leaseOwner, mode, expiresAt }
      };
    });
  }

  async function requireActiveLease(
    executor: Pick<AudioProviderOperationTransaction, 'select'>,
    lease: AudioProviderOperationLease,
    lock = false
  ) {
    let query = executor
      .select()
      .from(audioProviderOperations)
      .where(and(
        eq(audioProviderOperations.id, lease.operationId),
        eq(audioProviderOperations.status, 'leased'),
        eq(audioProviderOperations.leaseToken, lease.token),
        gt(audioProviderOperations.leaseExpiresAt, new Date())
      ));
    if (lock) query = query.for('update') as typeof query;
    const [operation] = await query.limit(1);
    if (!operation) throw new AudioProviderOperationBusyError('The provider-operation lease expired or was fenced by another worker.');
    return operation;
  }

  async function markProviderStarted(lease: AudioProviderOperationLease) {
    if (lease.mode !== 'execute') throw new Error('Only an execute lease may dispatch provider I/O.');
    const [operation] = await db
      .update(audioProviderOperations)
      .set({ providerStartedAt: new Date() })
      .where(and(
        eq(audioProviderOperations.id, lease.operationId),
        eq(audioProviderOperations.status, 'leased'),
        eq(audioProviderOperations.leaseToken, lease.token),
        gt(audioProviderOperations.leaseExpiresAt, new Date())
      ))
      .returning();
    if (!operation) throw new AudioProviderOperationBusyError('Provider dispatch was fenced before it started.');
    return operation;
  }

  async function markReconcileRequired(
    lease: AudioProviderOperationLease,
    error: unknown,
    errorCode = 'provider_result_ambiguous'
  ) {
    if ((error instanceof AudioProviderCallTimeoutError
      || error instanceof AudioProviderLeaseHeartbeatError)
      && error.preservesActiveLease) {
      const current = await loadOperation(lease.operationId);
      if (current?.status === 'leased' && current.leaseToken === lease.token) return current;
      if (current?.status === 'reconcile_required') return current;
      throw new AudioProviderOperationBusyError('Unsettled provider I/O no longer owns its durable lease.');
    }
    const [operation] = await db
      .update(audioProviderOperations)
      .set({
        status: 'reconcile_required',
        leaseToken: null,
        leaseOwner: null,
        leaseMode: null,
        leaseExpiresAt: null,
        lastError: boundedError(error, 'Provider result is ambiguous and requires reconciliation.'),
        lastErrorCode: errorCode
      })
      .where(and(
        eq(audioProviderOperations.id, lease.operationId),
        eq(audioProviderOperations.status, 'leased'),
        eq(audioProviderOperations.leaseToken, lease.token),
        gt(audioProviderOperations.leaseExpiresAt, new Date())
      ))
      .returning();
    if (!operation) throw new AudioProviderOperationBusyError('Provider reconciliation state was fenced by another worker.');
    return operation;
  }

  async function renewLease(lease: AudioProviderOperationLease) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseDurationMs);
    const [operation] = await db
      .update(audioProviderOperations)
      .set({ leaseExpiresAt: expiresAt })
      .where(and(
        eq(audioProviderOperations.id, lease.operationId),
        eq(audioProviderOperations.status, 'leased'),
        eq(audioProviderOperations.leaseToken, lease.token),
        gt(audioProviderOperations.leaseExpiresAt, now)
      ))
      .returning();
    if (!operation) {
      throw new AudioProviderOperationBusyError('Provider I/O lost its active lease heartbeat fence.');
    }
    return operation;
  }

  async function runLeasedProviderCall<T>(
    lease: AudioProviderOperationLease,
    call: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutError = new AudioProviderCallTimeoutError();
    const heartbeatIntervalMs = Math.max(100, Math.floor(leaseDurationMs / 3));
    let heartbeatRunning = false;
    let heartbeatFenceError: AudioProviderLeaseHeartbeatError | null = null;
    let heartbeatReject!: (error: unknown) => void;
    const heartbeatFailure = new Promise<never>((_resolve, reject) => {
      heartbeatReject = reject;
    });
    const heartbeatTimer = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void renewLease(lease)
        .catch((error) => {
          const fenceError = heartbeatFenceError ?? new AudioProviderLeaseHeartbeatError(error);
          heartbeatFenceError = fenceError;
          controller.abort(fenceError);
          heartbeatReject(fenceError);
        })
        .finally(() => {
          heartbeatRunning = false;
        });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, providerCallTimeoutMs);
      timeoutTimer.unref?.();
    });
    const providerCall = Promise.resolve().then(() => call(controller.signal));
    let detachedUntilProviderSettlement = false;
    const stopFences = () => {
      clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };
    const detachUntilProviderSettles = (errorCode: string, message: string) => {
      detachedUntilProviderSettlement = true;
      void providerCall
        .then(() => undefined, () => undefined)
        .then(() => markReconcileRequired(lease, new Error(message), errorCode))
        .catch(() => undefined)
        .finally(stopFences);
    };

    try {
      return await Promise.race([providerCall, heartbeatFailure, timeout]);
    } catch (error) {
      if (error === timeoutError) {
        detachUntilProviderSettles(
          'provider_call_timed_out',
          'Provider call settled after its request deadline; exact reconciliation is required.'
        );
      } else if (error === heartbeatFenceError) {
        detachUntilProviderSettles(
          'provider_lease_heartbeat_failed',
          'Provider call settled after a lease-heartbeat failure; exact reconciliation is required.'
        );
      } else {
        controller.abort(error);
      }
      throw error;
    } finally {
      if (!detachedUntilProviderSettlement) stopFences();
    }
  }

  async function resetAfterSafeReconciliation(input: {
    lease: AudioProviderOperationLease;
    evidence: Record<string, unknown>;
    awaitClientRetry?: boolean;
  }) {
    if (input.lease.mode !== 'reconcile') throw new Error('Safe retry evidence requires a reconcile lease.');
    assertEvidence(input.evidence);
    const resultFingerprint = fingerprintAudioProviderValue(input.evidence);
    const [operation] = await db
      .update(audioProviderOperations)
      .set({
        status: input.awaitClientRetry ? 'awaiting_client_retry' : 'pending',
        providerStartedAt: null,
        resultPayload: input.evidence,
        resultFingerprint,
        leaseToken: null,
        leaseOwner: null,
        leaseMode: null,
        leaseExpiresAt: null,
        lastError: null,
        lastErrorCode: null
      })
      .where(and(
        eq(audioProviderOperations.id, input.lease.operationId),
        eq(audioProviderOperations.status, 'leased'),
        eq(audioProviderOperations.leaseToken, input.lease.token),
        gt(audioProviderOperations.leaseExpiresAt, new Date())
      ))
      .returning();
    if (!operation) throw new AudioProviderOperationBusyError('Safe-retry reconciliation was fenced by another worker.');
    return operation;
  }

  async function finalizeSuccess<T>(input: {
    lease: AudioProviderOperationLease;
    evidence?: Record<string, unknown>;
    providerUploadId?: string;
    uploadSessionId?: string;
    applyDomain: (
      tx: AudioProviderOperationTransaction,
      operation: AudioProviderOperationRow
    ) => Promise<T>;
  }) {
    return db.transaction(async (tx) => {
      const operation = await requireActiveLease(tx, input.lease, true);
      let evidence = input.evidence;
      let resultFingerprint: string;
      if (operation.providerConfirmedAt) {
        if (!operation.resultPayload || !operation.resultFingerprint) {
          throw new Error('Confirmed provider operation is missing immutable result evidence.');
        }
        if (evidence && fingerprintAudioProviderValue(evidence) !== operation.resultFingerprint) {
          throw new AudioProviderOperationConflictError('Recovered provider evidence differs from the confirmed durable result.');
        }
        evidence = operation.resultPayload;
        resultFingerprint = operation.resultFingerprint;
      } else {
        if (!evidence) throw new Error('Provider success requires result evidence.');
        assertEvidence(evidence);
        resultFingerprint = fingerprintAudioProviderValue(evidence);
      }

      const domainResult = await input.applyDomain(tx, operation);
      const [completed] = await tx
        .update(audioProviderOperations)
        .set({
          status: 'succeeded',
          uploadSessionId: input.uploadSessionId ?? operation.uploadSessionId,
          providerUploadId: input.providerUploadId ?? operation.providerUploadId,
          providerConfirmedAt: operation.providerConfirmedAt ?? new Date(),
          resultPayload: evidence,
          resultFingerprint,
          completedAt: new Date(),
          leaseToken: null,
          leaseOwner: null,
          leaseMode: null,
          leaseExpiresAt: null,
          lastError: null,
          lastErrorCode: null
        })
        .where(and(
          eq(audioProviderOperations.id, operation.id),
          eq(audioProviderOperations.status, 'leased'),
          eq(audioProviderOperations.leaseToken, input.lease.token),
          gt(audioProviderOperations.leaseExpiresAt, new Date())
        ))
        .returning();
      if (!completed) throw new AudioProviderOperationBusyError('Provider success finalization was fenced by another worker.');
      return { operation: completed, result: domainResult };
    });
  }

  async function finalizeCanceledAfterCleanup<T>(input: {
    lease: AudioProviderOperationLease;
    evidence: Record<string, unknown>;
    providerUploadId?: string;
    applyDomain: (
      tx: AudioProviderOperationTransaction,
      operation: AudioProviderOperationRow
    ) => Promise<T>;
  }) {
    assertEvidence(input.evidence);
    const resultFingerprint = fingerprintAudioProviderValue(input.evidence);
    return db.transaction(async (tx) => {
      const operation = await requireActiveLease(tx, input.lease, true);
      if (operation.providerConfirmedAt) {
        throw new AudioProviderOperationConflictError('Confirmed provider result cannot be replaced by cleanup evidence.');
      }
      const domainResult = await input.applyDomain(tx, operation);
      const [completed] = await tx
        .update(audioProviderOperations)
        .set({
          status: 'canceled',
          providerUploadId: input.providerUploadId ?? operation.providerUploadId,
          providerConfirmedAt: new Date(),
          resultPayload: input.evidence,
          resultFingerprint,
          completedAt: new Date(),
          leaseToken: null,
          leaseOwner: null,
          leaseMode: null,
          leaseExpiresAt: null,
          lastError: null,
          lastErrorCode: null
        })
        .where(and(
          eq(audioProviderOperations.id, operation.id),
          eq(audioProviderOperations.status, 'leased'),
          eq(audioProviderOperations.leaseToken, input.lease.token),
          gt(audioProviderOperations.leaseExpiresAt, new Date())
        ))
        .returning();
      if (!completed) throw new AudioProviderOperationBusyError('Provider cancellation finalization was fenced by another worker.');
      return { operation: completed, result: domainResult };
    });
  }

  async function finalizeCanceledBeforeProviderStart<T>(input: {
    lease: AudioProviderOperationLease;
    reason: string;
    applyDomain: (
      tx: AudioProviderOperationTransaction,
      operation: AudioProviderOperationRow
    ) => Promise<T>;
  }) {
    const evidence = {
      providerNotStarted: true,
      cancellationReason: input.reason.trim().slice(0, 200) || 'durable_intent_canceled'
    };
    const resultFingerprint = fingerprintAudioProviderValue(evidence);
    return db.transaction(async (tx) => {
      const operation = await requireActiveLease(tx, input.lease, true);
      if (operation.providerStartedAt || operation.providerUploadId) {
        throw new AudioProviderOperationConflictError('A started provider operation requires exact cleanup evidence before cancellation.');
      }
      const domainResult = await input.applyDomain(tx, operation);
      const [completed] = await tx
        .update(audioProviderOperations)
        .set({
          status: 'canceled',
          resultPayload: evidence,
          resultFingerprint,
          completedAt: new Date(),
          leaseToken: null,
          leaseOwner: null,
          leaseMode: null,
          leaseExpiresAt: null,
          lastError: null,
          lastErrorCode: null
        })
        .where(and(
          eq(audioProviderOperations.id, operation.id),
          eq(audioProviderOperations.status, 'leased'),
          eq(audioProviderOperations.leaseToken, input.lease.token),
          gt(audioProviderOperations.leaseExpiresAt, new Date())
        ))
        .returning();
      if (!completed) throw new AudioProviderOperationBusyError('Provider pre-start cancellation was fenced by another worker.');
      return { operation: completed, result: domainResult };
    });
  }

  return {
    reserveOperation,
    loadOperation,
    claimOperation,
    markProviderStarted,
    markReconcileRequired,
    renewLease,
    runLeasedProviderCall,
    resetAfterSafeReconciliation,
    finalizeSuccess,
    finalizeCanceledAfterCleanup,
    finalizeCanceledBeforeProviderStart
  };
}

export type AudioProviderOperationCoordinator = ReturnType<typeof createAudioProviderOperationCoordinator>;
