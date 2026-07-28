import { createHash } from 'node:crypto';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  auditEvents,
  audioProjectAccessGrants,
  musicDistributionDeliveries,
  musicDistributionDeliveryEvents,
  musicReleaseRecordings,
  musicReleases,
  musicRecordings
} from '../db/schema';
import {
  SANDBOX_DISTRIBUTION_PROVIDER_KEY,
  type DistributionAdapter,
  type DistributionReleasePayload,
  type DistributionWebhookEvent
} from './distribution-adapter';

const DELIVERY_UNAVAILABLE_MESSAGE = 'Distribution delivery not found or unavailable.';
const RELEASE_UNAVAILABLE_MESSAGE = 'Release not found or unavailable.';

const TERMINAL_OR_IN_FLIGHT_STATUSES = new Set([
  'submitted', 'accepted', 'live', 'correction_pending', 'takedown_requested', 'taken_down'
]);

const WEBHOOK_ALLOWED_NEXT_STATUSES: Readonly<Record<string, ReadonlySet<DistributionWebhookEvent['status']>>> = {
  draft: new Set(['failed']),
  queued: new Set(['failed']),
  submitted: new Set(['accepted', 'correction_pending', 'failed']),
  accepted: new Set(['live', 'correction_pending', 'failed']),
  live: new Set(['correction_pending']),
  correction_pending: new Set(['failed']),
  takedown_requested: new Set(['taken_down', 'failed']),
  failed: new Set(['correction_pending'])
};

export type DistributionWebhookRequestErrorCode =
  | 'unknown_provider'
  | 'invalid_signature'
  | 'invalid_payload'
  | 'unknown_delivery'
  | 'invalid_transition';

export class DistributionWebhookRequestError extends Error {
  readonly code: DistributionWebhookRequestErrorCode;
  readonly statusCode: 400 | 404 | 409;

  constructor(
    code: DistributionWebhookRequestErrorCode,
    message: string,
    statusCode: 400 | 404 | 409 = 400
  ) {
    super(message);
    this.name = 'DistributionWebhookRequestError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function classifyDistributionWebhookFailure(error: unknown): {
  statusCode: 400 | 404 | 409 | 503;
  message: string;
  retryable: boolean;
} {
  if (error instanceof DistributionWebhookRequestError) {
    return {
      statusCode: error.statusCode,
      message: error.message,
      retryable: false
    };
  }
  return {
    statusCode: 503,
    message: 'Distribution webhook processing is temporarily unavailable.',
    retryable: true
  };
}

type SwayTx = Parameters<Parameters<SwayDb['transaction']>[0]>[0];

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function isProviderEventUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (
      record.code === '23505'
      && (
        record.constraint === 'music_distribution_delivery_events_provider_event_idx'
        || String(record.message ?? '').includes('music_distribution_delivery_events_provider_event_idx')
      )
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

async function setSessionConfig(tx: SwayTx, key: string, value: string): Promise<void> {
  await tx.execute(sql`select set_config(${key}, ${value}, true)`);
}

export function createDistributionDeliveryService(config: {
  db: SwayDb;
  adapters: Record<string, DistributionAdapter>;
}) {
  const { db, adapters } = config;
  const registeredAdapters = Object.entries(adapters);

  // This slice is deliberately sandbox-only. Rejecting any other registration
  // at construction time keeps provider network side effects and lost-response
  // recovery out of a runtime that has no durable provider outbox yet.
  if (
    registeredAdapters.length !== 1
    || registeredAdapters[0][0] !== SANDBOX_DISTRIBUTION_PROVIDER_KEY
    || registeredAdapters[0][1].providerKey !== SANDBOX_DISTRIBUTION_PROVIDER_KEY
  ) {
    throw new Error('Distribution delivery runtime permits only the sway_sandbox adapter.');
  }

  function requireAdapter(providerKey: string): DistributionAdapter {
    const adapter = adapters[providerKey];
    if (!adapter) throw new Error(`No distribution adapter is registered for provider "${providerKey}".`);
    return adapter;
  }

  function requireWebhookAdapter(providerKey: string): DistributionAdapter {
    const adapter = adapters[providerKey];
    if (!adapter) {
      throw new DistributionWebhookRequestError(
        'unknown_provider',
        `No distribution webhook adapter is registered for provider "${providerKey}".`
      );
    }
    return adapter;
  }

  function classifyProviderEventReplay(
    existing: { deliveryId: string; payloadSha256: string | null },
    expected: { deliveryId: string; payloadSha256: string }
  ): { processed: false; duplicate: true } {
    if (
      existing.deliveryId === expected.deliveryId
      && existing.payloadSha256 === expected.payloadSha256
    ) {
      return { processed: false, duplicate: true };
    }
    throw new DistributionWebhookRequestError(
      'invalid_transition',
      'Distribution webhook event conflicts with existing provider evidence.',
      409
    );
  }

  async function requireReleaseManagementAuthority(tx: SwayTx, releaseId: string, actorUserId: string) {
    const [grant] = await tx
      .select({ authority: audioProjectAccessGrants.id })
      .from(musicReleases)
      .innerJoin(audioProjectAccessGrants, and(
        eq(audioProjectAccessGrants.projectId, musicReleases.projectId),
        eq(audioProjectAccessGrants.granteeUserId, actorUserId),
        eq(audioProjectAccessGrants.canManageRelease, true),
        isNull(audioProjectAccessGrants.revokedAt),
        or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
      ))
      .where(eq(musicReleases.id, releaseId))
      .limit(1);
    if (!grant) throw new Error(RELEASE_UNAVAILABLE_MESSAGE);
  }

  async function loadAuthorizedDelivery(
    tx: SwayTx,
    deliveryId: string,
    actorUserId: string
  ): Promise<typeof musicDistributionDeliveries.$inferSelect> {
    const [row] = await tx
      .select({ delivery: musicDistributionDeliveries })
      .from(musicDistributionDeliveries)
      .innerJoin(musicReleases, eq(musicReleases.id, musicDistributionDeliveries.releaseId))
      .innerJoin(audioProjectAccessGrants, and(
        eq(audioProjectAccessGrants.projectId, musicReleases.projectId),
        eq(audioProjectAccessGrants.granteeUserId, actorUserId),
        eq(audioProjectAccessGrants.canManageRelease, true),
        isNull(audioProjectAccessGrants.revokedAt),
        or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
      ))
      .where(eq(musicDistributionDeliveries.id, deliveryId))
      .for('update')
      .limit(1);
    if (!row) throw new Error(DELIVERY_UNAVAILABLE_MESSAGE);
    return row.delivery;
  }

  async function loadReleasePayload(tx: SwayTx, input: {
    releaseId: string;
    providerKey: string;
    destinationKey: string;
  }): Promise<{ release: typeof musicReleases.$inferSelect; performerId: string; payload: DistributionReleasePayload }> {
    const [release] = await tx.select().from(musicReleases).where(eq(musicReleases.id, input.releaseId)).limit(1);
    if (!release) throw new Error(RELEASE_UNAVAILABLE_MESSAGE);
    if (!['ready', 'scheduled', 'published'].includes(release.status)) {
      throw new Error('Release must pass independent rights review before a distribution delivery can be created.');
    }
    const recordingRows = await tx
      .select({
        recordingId: musicRecordings.id,
        isrc: musicRecordings.isrc,
        title: musicRecordings.title,
        primaryArtistName: musicRecordings.primaryArtistName,
        trackNumber: musicReleaseRecordings.trackNumber,
        discNumber: musicReleaseRecordings.discNumber
      })
      .from(musicReleaseRecordings)
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
      .where(eq(musicReleaseRecordings.releaseId, release.id))
      .orderBy(asc(musicReleaseRecordings.discNumber), asc(musicReleaseRecordings.trackNumber));
    if (!recordingRows.length) throw new Error('A release requires at least one recording before delivery.');
    if (!release.originalReleaseDate) throw new Error('Release requires an original release date before delivery.');

    return {
      release,
      performerId: release.performerId,
      payload: {
        releaseId: release.id,
        providerKey: input.providerKey,
        destinationKey: input.destinationKey,
        title: release.title,
        primaryArtistName: release.primaryArtistName,
        releaseType: release.releaseType,
        upc: release.upc,
        originalReleaseDate: release.originalReleaseDate,
        territories: release.territories ?? ['US'],
        recordings: recordingRows
      }
    };
  }

  async function createDelivery(input: {
    releaseId: string;
    actorUserId: string;
    providerKey: string;
    destinationKey: string;
  }) {
    requireAdapter(input.providerKey);
    return db.transaction(async (tx) => {
      await requireReleaseManagementAuthority(tx, input.releaseId, input.actorUserId);
      await loadReleasePayload(tx, {
        releaseId: input.releaseId,
        providerKey: input.providerKey,
        destinationKey: input.destinationKey
      });
      await setSessionConfig(tx, 'sway.actor_user_id', input.actorUserId);
      const [delivery] = await tx.insert(musicDistributionDeliveries).values({
        releaseId: input.releaseId,
        providerKey: input.providerKey,
        destinationKey: input.destinationKey
      }).returning();
      return delivery;
    });
  }

  /**
   * Idempotent after a successful sandbox submission. The adapter is
   * process-local and has no external side effect, so retrying after a lost
   * response cannot create an untracked real-provider delivery.
   */
  async function submitDelivery(input: { deliveryId: string; actorUserId: string }) {
    return db.transaction(async (tx) => {
      const delivery = await loadAuthorizedDelivery(tx, input.deliveryId, input.actorUserId);
      if (delivery.deliveryStatus === 'correction_pending') {
        throw new Error(
          'Correction-request intake is pending; provider transmission and resubmission are not implemented.'
        );
      }
      if (TERMINAL_OR_IN_FLIGHT_STATUSES.has(delivery.deliveryStatus)) {
        return { delivery, alreadySubmitted: true };
      }
      if (!['draft', 'queued', 'failed'].includes(delivery.deliveryStatus)) {
        throw new Error(`Delivery in status "${delivery.deliveryStatus}" cannot be submitted.`);
      }

      const adapter = requireAdapter(delivery.providerKey);
      const { payload } = await loadReleasePayload(tx, {
        releaseId: delivery.releaseId,
        providerKey: delivery.providerKey,
        destinationKey: delivery.destinationKey
      });

      const retryAttemptToken = delivery.deliveryStatus === 'failed'
        ? delivery.updatedAt.toISOString()
        : null;
      if (delivery.deliveryStatus === 'draft' || retryAttemptToken) {
        await setSessionConfig(tx, 'sway.actor_user_id', input.actorUserId);
        await setSessionConfig(
          tx,
          'sway.delivery_transition_reason',
          retryAttemptToken ? 'Retrying failed sandbox submission' : 'Queued for sandbox submission'
        );
        await setSessionConfig(
          tx,
          'sway.delivery_transition_idempotency_key',
          retryAttemptToken
            ? `retry-queue:${delivery.id}:${retryAttemptToken}`
            : `queue:${delivery.id}`
        );
        await tx.update(musicDistributionDeliveries)
          .set({ deliveryStatus: 'queued' })
          .where(eq(musicDistributionDeliveries.id, delivery.id));
      }

      const submission = await adapter.submit(payload);
      const metadataFingerprint = adapter.buildMetadataFingerprint(payload);

      await setSessionConfig(tx, 'sway.actor_user_id', input.actorUserId);
      await setSessionConfig(tx, 'sway.delivery_transition_reason', 'Submitted to sandbox provider');
      await setSessionConfig(
        tx,
        'sway.delivery_transition_idempotency_key',
        retryAttemptToken
          ? `retry-submit:${delivery.id}:${retryAttemptToken}`
          : `submit:${delivery.id}`
      );
      await setSessionConfig(tx, 'sway.delivery_transition_payload_sha256', metadataFingerprint);
      const [updated] = await tx.update(musicDistributionDeliveries)
        .set({
          deliveryStatus: 'submitted',
          providerReleaseId: submission.providerReleaseId,
          metadataFingerprint,
          lastError: null
        })
        .where(eq(musicDistributionDeliveries.id, delivery.id))
        .returning();

      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'music_distribution_delivery',
        entityId: delivery.id,
        eventType: 'music_distribution_delivery.submitted',
        previousStatus: delivery.deliveryStatus,
        nextStatus: 'submitted',
        metadata: { providerKey: delivery.providerKey, destinationKey: delivery.destinationKey, sandbox: true }
      });

      return { delivery: updated, alreadySubmitted: false };
    });
  }

  async function requestTakedown(input: { deliveryId: string; actorUserId: string; reason: string }) {
    const reason = input.reason.trim();
    if (!reason) throw new Error('Takedown reason is required.');
    return db.transaction(async (tx) => {
      const delivery = await loadAuthorizedDelivery(tx, input.deliveryId, input.actorUserId);
      if (delivery.deliveryStatus === 'takedown_requested' || delivery.deliveryStatus === 'taken_down') {
        return { delivery, alreadyRequested: true };
      }
      if (!['accepted', 'live'].includes(delivery.deliveryStatus)) {
        throw new Error(`Delivery in status "${delivery.deliveryStatus}" cannot be taken down.`);
      }
      await setSessionConfig(tx, 'sway.actor_user_id', input.actorUserId);
      await setSessionConfig(tx, 'sway.delivery_transition_reason', reason);
      await setSessionConfig(tx, 'sway.delivery_transition_idempotency_key', `takedown-request:${delivery.id}`);
      const [updated] = await tx.update(musicDistributionDeliveries)
        .set({ deliveryStatus: 'takedown_requested' })
        .where(eq(musicDistributionDeliveries.id, delivery.id))
        .returning();
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'music_distribution_delivery',
        entityId: delivery.id,
        eventType: 'music_distribution_delivery.takedown_requested',
        previousStatus: delivery.deliveryStatus,
        nextStatus: 'takedown_requested',
        metadata: { reason, sandbox: true }
      });
      return { delivery: updated, alreadyRequested: false };
    });
  }

  async function requestCorrection(input: { deliveryId: string; actorUserId: string; reason: string }) {
    const reason = input.reason.trim();
    if (!reason) throw new Error('Correction reason is required.');
    return db.transaction(async (tx) => {
      const delivery = await loadAuthorizedDelivery(tx, input.deliveryId, input.actorUserId);
      if (delivery.deliveryStatus === 'correction_pending') {
        return { delivery, alreadyRequested: true };
      }
      if (!['accepted', 'live'].includes(delivery.deliveryStatus)) {
        throw new Error(`Delivery in status "${delivery.deliveryStatus}" cannot accept a correction request.`);
      }
      const transitionPayloadSha256 = delivery.metadataFingerprint
        ?? requireAdapter(delivery.providerKey).buildMetadataFingerprint(
          (await loadReleasePayload(tx, {
            releaseId: delivery.releaseId,
            providerKey: delivery.providerKey,
            destinationKey: delivery.destinationKey
          })).payload
        );
      await setSessionConfig(tx, 'sway.actor_user_id', input.actorUserId);
      await setSessionConfig(tx, 'sway.delivery_transition_reason', reason);
      await setSessionConfig(tx, 'sway.delivery_transition_idempotency_key', `correction-request:${delivery.id}`);
      await setSessionConfig(tx, 'sway.delivery_transition_payload_sha256', transitionPayloadSha256);
      const [updated] = await tx.update(musicDistributionDeliveries)
        .set({
          deliveryStatus: 'correction_pending',
          lastError: reason
        })
        .where(eq(musicDistributionDeliveries.id, delivery.id))
        .returning();
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'music_distribution_delivery',
        entityId: delivery.id,
        eventType: 'music_distribution_delivery.correction_requested',
        previousStatus: delivery.deliveryStatus,
        nextStatus: 'correction_pending',
        metadata: { reason, sandbox: true }
      });
      return { delivery: updated, alreadyRequested: false };
    });
  }

  async function ingestWebhook(input: {
    providerKey: string;
    rawBody: Buffer;
    signatureHeader: string | undefined;
  }): Promise<{ processed: boolean; duplicate: boolean }> {
    const adapter = requireWebhookAdapter(input.providerKey);
    let signatureValid = false;
    try {
      signatureValid = adapter.verifyWebhookSignature(input.rawBody, input.signatureHeader);
    } catch {
      throw new DistributionWebhookRequestError(
        'invalid_signature',
        'Distribution webhook signature verification failed.'
      );
    }
    if (!signatureValid) {
      throw new DistributionWebhookRequestError(
        'invalid_signature',
        'Distribution webhook signature verification failed.'
      );
    }
    let event: DistributionWebhookEvent;
    try {
      event = adapter.parseWebhookEvent(input.rawBody);
    } catch {
      throw new DistributionWebhookRequestError(
        'invalid_payload',
        'Distribution webhook payload is invalid.'
      );
    }
    const payloadSha256 = sha256Hex(input.rawBody);
    let matchedDeliveryId: string | null = null;

    try {
      return await db.transaction(async (tx) => {
        const [delivery] = await tx
          .select()
          .from(musicDistributionDeliveries)
          .where(and(
            eq(musicDistributionDeliveries.providerKey, input.providerKey),
            eq(musicDistributionDeliveries.providerReleaseId, event.providerReleaseId),
            eq(musicDistributionDeliveries.destinationKey, event.destinationKey)
          ))
          .for('update')
          .limit(1);
        if (!delivery) {
          throw new DistributionWebhookRequestError(
            'unknown_delivery',
            'Distribution webhook references an unknown delivery.',
            404
          );
        }
        matchedDeliveryId = delivery.id;

        const [existingProviderEvent] = await tx
          .select({
            deliveryId: musicDistributionDeliveryEvents.deliveryId,
            payloadSha256: musicDistributionDeliveryEvents.payloadSha256
          })
          .from(musicDistributionDeliveryEvents)
          .where(eq(musicDistributionDeliveryEvents.providerEventId, event.providerEventId))
          .limit(1);
        if (existingProviderEvent) {
          return classifyProviderEventReplay(existingProviderEvent, {
            deliveryId: delivery.id,
            payloadSha256
          });
        }

        const [createdEvent] = await tx
          .select({ actorUserId: musicDistributionDeliveryEvents.actorUserId })
          .from(musicDistributionDeliveryEvents)
          .where(and(
            eq(musicDistributionDeliveryEvents.deliveryId, delivery.id),
            eq(musicDistributionDeliveryEvents.eventType, 'delivery_created')
          ))
          .limit(1);
        if (!createdEvent?.actorUserId) throw new Error('Delivery is missing its originating actor.');

        if (
          delivery.deliveryStatus !== event.status
          && !WEBHOOK_ALLOWED_NEXT_STATUSES[delivery.deliveryStatus]?.has(event.status)
        ) {
          throw new DistributionWebhookRequestError(
            'invalid_transition',
            `Distribution webhook cannot transition delivery from "${delivery.deliveryStatus}" to "${event.status}".`,
            409
          );
        }

        await setSessionConfig(tx, 'sway.provider_webhook_verified', 'true');
        await setSessionConfig(tx, 'sway.provider_webhook_provider_key', input.providerKey);
        await tx.insert(musicDistributionDeliveryEvents).values({
          deliveryId: delivery.id,
          eventType: 'provider_webhook',
          idempotencyKey: `webhook:${event.providerEventId}`,
          providerEventId: event.providerEventId,
          payloadSha256,
          metadata: { status: event.status, error: event.error, destinationReleaseId: event.destinationReleaseId }
        });

        if (delivery.deliveryStatus === event.status) {
          return { processed: true, duplicate: false };
        }

        await setSessionConfig(tx, 'sway.actor_user_id', createdEvent.actorUserId);
        await setSessionConfig(tx, 'sway.delivery_transition_reason', 'Sandbox webhook confirmed status');
        await setSessionConfig(tx, 'sway.delivery_transition_idempotency_key', `webhook-status:${event.providerEventId}`);
        await setSessionConfig(tx, 'sway.delivery_transition_payload_sha256', payloadSha256);
        await tx.update(musicDistributionDeliveries)
          .set({
            deliveryStatus: event.status,
            destinationReleaseId: event.destinationReleaseId ?? delivery.destinationReleaseId,
            lastError: event.status === 'failed' ? (event.error ?? 'Sandbox reported failure.') : delivery.lastError
          })
          .where(eq(musicDistributionDeliveries.id, delivery.id));

        return { processed: true, duplicate: false };
      });
    } catch (error) {
      if (matchedDeliveryId && isProviderEventUniqueViolation(error)) {
        const [existingProviderEvent] = await db
          .select({
            deliveryId: musicDistributionDeliveryEvents.deliveryId,
            payloadSha256: musicDistributionDeliveryEvents.payloadSha256
          })
          .from(musicDistributionDeliveryEvents)
          .where(eq(musicDistributionDeliveryEvents.providerEventId, event.providerEventId))
          .limit(1);
        if (existingProviderEvent) {
          return classifyProviderEventReplay(existingProviderEvent, {
            deliveryId: matchedDeliveryId,
            payloadSha256
          });
        }
      }
      throw error;
    }
  }

  return {
    createDelivery,
    submitDelivery,
    requestTakedown,
    requestCorrection,
    ingestWebhook
  };
}

export type DistributionDeliveryService = ReturnType<typeof createDistributionDeliveryService>;
