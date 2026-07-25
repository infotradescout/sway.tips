import { createHash } from 'node:crypto';
import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
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
import type { DistributionAdapter, DistributionReleasePayload } from './distribution-adapter';

const TERMINAL_OR_IN_FLIGHT_STATUSES = new Set([
  'submitted', 'accepted', 'live', 'correction_pending', 'takedown_requested', 'taken_down'
]);

type SwayTx = Parameters<Parameters<SwayDb['transaction']>[0]>[0];

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasDuplicateKeyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause instanceof Error ? error.cause : null;
  const message = `${error.message}\n${cause?.message ?? ''}`;
  return /duplicate key value/i.test(message);
}

async function setSessionConfig(tx: SwayTx, key: string, value: string): Promise<void> {
  await tx.execute(sql`select set_config(${key}, ${value}, true)`);
}

export function createDistributionDeliveryService(config: {
  db: SwayDb;
  adapters: Record<string, DistributionAdapter>;
}) {
  const { db, adapters } = config;

  function requireAdapter(providerKey: string): DistributionAdapter {
    const adapter = adapters[providerKey];
    if (!adapter) throw new Error(`No distribution adapter is registered for provider "${providerKey}".`);
    return adapter;
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
    if (!grant) {
      throw new Error('Distribution delivery creation requires active release-management authority.');
    }
  }

  async function loadReleasePayload(tx: SwayTx, input: {
    releaseId: string;
    providerKey: string;
    destinationKey: string;
  }): Promise<{ release: typeof musicReleases.$inferSelect; performerId: string; payload: DistributionReleasePayload }> {
    const [release] = await tx.select().from(musicReleases).where(eq(musicReleases.id, input.releaseId)).limit(1);
    if (!release) throw new Error('Release not found.');
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
   * Idempotent: if the delivery has already left "draft"/"queued", this
   * returns the existing row untouched instead of calling the adapter again.
   * The provider is only ever called once per successful submission.
   */
  async function submitDelivery(input: { deliveryId: string; actorUserId: string }) {
    return db.transaction(async (tx) => {
      const [delivery] = await tx
        .select()
        .from(musicDistributionDeliveries)
        .where(eq(musicDistributionDeliveries.id, input.deliveryId))
        .for('update')
        .limit(1);
      if (!delivery) throw new Error('Delivery not found.');
      await requireReleaseManagementAuthority(tx, delivery.releaseId, input.actorUserId);
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
          retryAttemptToken ? 'Retrying failed provider submission' : 'Queued for provider submission'
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
      await setSessionConfig(tx, 'sway.delivery_transition_reason', 'Submitted to provider');
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
        metadata: { providerKey: delivery.providerKey, destinationKey: delivery.destinationKey }
      });

      return { delivery: updated, alreadySubmitted: false };
    });
  }

  async function requestTakedown(input: { deliveryId: string; actorUserId: string; reason: string }) {
    const reason = input.reason.trim();
    if (!reason) throw new Error('Takedown reason is required.');
    return db.transaction(async (tx) => {
      const [delivery] = await tx
        .select()
        .from(musicDistributionDeliveries)
        .where(eq(musicDistributionDeliveries.id, input.deliveryId))
        .for('update')
        .limit(1);
      if (!delivery) throw new Error('Delivery not found.');
      await requireReleaseManagementAuthority(tx, delivery.releaseId, input.actorUserId);
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
        metadata: { reason }
      });
      return { delivery: updated, alreadyRequested: false };
    });
  }

  async function requestCorrection(input: { deliveryId: string; actorUserId: string; reason: string }) {
    const reason = input.reason.trim();
    if (!reason) throw new Error('Correction reason is required.');
    return db.transaction(async (tx) => {
      const [delivery] = await tx
        .select()
        .from(musicDistributionDeliveries)
        .where(eq(musicDistributionDeliveries.id, input.deliveryId))
        .for('update')
        .limit(1);
      if (!delivery) throw new Error('Delivery not found.');
      await requireReleaseManagementAuthority(tx, delivery.releaseId, input.actorUserId);
      if (delivery.deliveryStatus === 'correction_pending') {
        return { delivery, alreadyRequested: true };
      }
      if (!['accepted', 'live'].includes(delivery.deliveryStatus)) {
        throw new Error(`Delivery in status "${delivery.deliveryStatus}" cannot be sent for correction.`);
      }
      const transitionPayloadSha256 = delivery.metadataFingerprint ??
        requireAdapter(delivery.providerKey).buildMetadataFingerprint(
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
        metadata: { reason }
      });
      return { delivery: updated, alreadyRequested: false };
    });
  }

  /**
   * Verifies the provider's signature, then persists the webhook event and
   * (if it maps to a new delivery status) applies the transition in the
   * same database transaction that the DB trigger enforces. A replayed
   * providerEventId is detected via the unique index on
   * music_distribution_delivery_events.provider_event_id and is a no-op —
   * the whole transaction rolls back to before the duplicate insert and no
   * second transition is attempted.
   */
  async function ingestWebhook(input: {
    providerKey: string;
    rawBody: Buffer;
    signatureHeader: string | undefined;
  }): Promise<{ processed: boolean; duplicate: boolean }> {
    const adapter = requireAdapter(input.providerKey);
    if (!adapter.verifyWebhookSignature(input.rawBody, input.signatureHeader)) {
      throw new Error('Distribution webhook signature verification failed.');
    }
    const event = adapter.parseWebhookEvent(input.rawBody);
    const payloadSha256 = sha256Hex(input.rawBody);

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
        if (!delivery) throw new Error('Distribution webhook references an unknown delivery.');

        const [createdEvent] = await tx
          .select({ actorUserId: musicDistributionDeliveryEvents.actorUserId })
          .from(musicDistributionDeliveryEvents)
          .where(and(
            eq(musicDistributionDeliveryEvents.deliveryId, delivery.id),
            eq(musicDistributionDeliveryEvents.eventType, 'delivery_created')
          ))
          .limit(1);
        if (!createdEvent?.actorUserId) throw new Error('Delivery is missing its originating actor.');

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
        await setSessionConfig(tx, 'sway.delivery_transition_reason', 'Provider webhook confirmed status');
        await setSessionConfig(tx, 'sway.delivery_transition_idempotency_key', `webhook-status:${event.providerEventId}`);
        await setSessionConfig(tx, 'sway.delivery_transition_payload_sha256', payloadSha256);
        await tx.update(musicDistributionDeliveries)
          .set({
            deliveryStatus: event.status,
            destinationReleaseId: event.destinationReleaseId ?? delivery.destinationReleaseId,
            lastError: event.status === 'failed' ? (event.error ?? 'Provider reported failure.') : delivery.lastError
          })
          .where(eq(musicDistributionDeliveries.id, delivery.id));

        return { processed: true, duplicate: false };
      });
    } catch (error) {
      if (hasDuplicateKeyError(error)) {
        return { processed: false, duplicate: true };
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
