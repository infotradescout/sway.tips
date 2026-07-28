import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { asc, eq, and } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client.ts';
import {
  audioFileConnections,
  musicDistributionDeliveries,
  musicDistributionDeliveryEvents,
  performers,
  users
} from '../src/db/schema.ts';
import { createLocalAudioObjectStore } from '../src/server/audio-object-storage-local.ts';
import { createAudioPublishingService } from '../src/server/audio-publishing-service.ts';
import { createSandboxDistributionAdapter } from '../src/server/distribution-adapter.ts';
import {
  classifyDistributionWebhookFailure,
  createDistributionDeliveryService
} from '../src/server/distribution-delivery-service.ts';

if (process.env.SWAY_DISPOSABLE_MIGRATION_PROOF !== '1') {
  throw new Error('Distribution delivery integration requires SWAY_DISPOSABLE_MIGRATION_PROOF=1.');
}
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, '');
if (!['127.0.0.1', 'localhost', '::1'].includes(parsedDatabaseUrl.hostname)) {
  throw new Error('Distribution delivery proof refuses non-local database hosts.');
}
if (!/^sway_distribution_delivery_proof_[a-z0-9_]+$/i.test(databaseName)) {
  throw new Error('Distribution delivery proof requires a database named sway_distribution_delivery_proof_* .');
}
const proofDbClient = new Client({ connectionString: databaseUrl });
await proofDbClient.connect();
const proofDbTables = await proofDbClient.query(
  `SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'`
);
await proofDbClient.end();
if (proofDbTables.rows[0].count !== 0) {
  throw new Error('Distribution delivery proof database must be empty.');
}

const db = createSwayDb(databaseUrl);
const objectRoot = mkdtempSync(join(tmpdir(), 'sway-distribution-delivery-'));

async function eventsFor(deliveryId) {
  return db
    .select()
    .from(musicDistributionDeliveryEvents)
    .where(eq(musicDistributionDeliveryEvents.deliveryId, deliveryId))
    .orderBy(
      asc(musicDistributionDeliveryEvents.createdAt),
      asc(musicDistributionDeliveryEvents.id)
    );
}

try {
  await migrate(db, { migrationsFolder: 'drizzle' });

  const [ownerId, reviewerId, outsiderId] = [randomUUID(), randomUUID(), randomUUID()].sort();
  await db.insert(users).values([
    { id: ownerId, email: `owner-${ownerId}@example.test`, emailVerifiedAt: new Date() },
    { id: reviewerId, email: `reviewer-${reviewerId}@example.test`, emailVerifiedAt: new Date() },
    { id: outsiderId, email: `outsider-${outsiderId}@example.test`, emailVerifiedAt: new Date() }
  ]);
  const [performer] = await db.insert(performers).values({
    ownerUserId: ownerId,
    displayName: 'Distribution delivery proof'
  }).returning();

  const localStore = createLocalAudioObjectStore({
    SWAY_AUDIO_LOCAL_OBJECT_DIR: objectRoot,
    SWAY_AUDIO_LOCAL_BUCKET: 'distribution-delivery-proof'
  });
  await localStore.verifyReady();
  const publishing = createAudioPublishingService({ db, store: localStore });

  const project = await publishing.createProject({
    performerId: performer.id,
    actorUserId: ownerId,
    title: 'Distribution delivery proof project'
  });

  const [connection] = await db.insert(audioFileConnections).values({
    memberOneUserId: ownerId,
    memberTwoUserId: reviewerId,
    createdByUserId: ownerId,
    createdFromPurpose: 'send_files'
  }).returning();
  await publishing.grantReleaseReviewer({ projectId: project.id, connectionId: connection.id, actorUserId: ownerId });

  async function sealFile({ title, assetKind, mimeType, body }) {
    const digest = createHash('sha256').update(body).digest('hex');
    const session = await publishing.initiateUpload({
      projectId: project.id,
      actorUserId: ownerId,
      title,
      assetKind,
      originalFilename: title,
      mimeType,
      expectedByteSize: body.byteLength,
      expectedSha256: digest,
      idempotencyKey: `distribution-proof:${digest}`
    });
    await publishing.writeUploadPart({ uploadSessionId: session.id, actorUserId: ownerId, partNumber: 1, body });
    return publishing.completeAndSealUpload({ uploadSessionId: session.id, actorUserId: ownerId, performerId: performer.id });
  }

  const masterVersion = await sealFile({
    title: 'delivery-proof-master.wav',
    assetKind: 'master_audio',
    mimeType: 'audio/wav',
    body: Buffer.from('RIFF distribution delivery proof master')
  });
  const artworkVersion = await sealFile({
    title: 'delivery-proof-artwork.png',
    assetKind: 'artwork',
    mimeType: 'image/png',
    body: Buffer.from('delivery proof artwork bytes')
  });
  const rightsDocumentVersion = await sealFile({
    title: 'delivery-proof-rights.txt',
    assetKind: 'document',
    mimeType: 'text/plain',
    body: Buffer.from('delivery proof rights terms version one')
  });

  const releaseId = randomUUID();
  const releaseDraft = await publishing.createReleaseDraft({
    clientReleaseId: releaseId,
    performerId: performer.id,
    actorUserId: ownerId,
    projectId: project.id,
    masterAssetVersionId: masterVersion.id,
    title: 'Distribution Delivery Proof',
    trackTitle: 'Distribution Delivery Proof',
    primaryArtistName: 'Delivery Proof Artist',
    releaseType: 'single',
    territories: ['US'],
    languageCode: 'en'
  });

  const edited = await publishing.updateReleaseDraft({
    releaseId,
    performerId: performer.id,
    actorUserId: ownerId,
    expectedUpdatedAt: releaseDraft.release.updatedAt.toISOString(),
    artworkAssetVersionId: artworkVersion.id,
    title: 'Distribution Delivery Proof',
    trackTitle: 'Distribution Delivery Proof',
    primaryArtistName: 'Delivery Proof Artist',
    releaseType: 'single',
    distributionMode: 'sway_first',
    scheduledReleaseAt: '2026-07-22T12:00:00Z',
    pLine: '℗ 2026 Delivery Proof Artist',
    cLine: '© 2026 Delivery Proof Artist',
    originalReleaseDate: '2026-07-22',
    territories: ['US'],
    languageCode: 'en',
    credits: [
      { displayName: 'Delivery Proof Artist', role: 'primary_artist' },
      { displayName: 'Delivery Proof Writer', role: 'songwriter' }
    ]
  });
  assert.equal(edited.readiness.ready, false);

  for (const required of [
    { declarationType: 'master_control', recordingId: releaseDraft.recording.id },
    { declarationType: 'composition_control', recordingId: releaseDraft.recording.id },
    { declarationType: 'artwork_control', recordingId: null },
    { declarationType: 'distribution_authorization', recordingId: null }
  ]) {
    const declaration = await publishing.createRightsDeclaration({
      releaseId,
      performerId: performer.id,
      actorUserId: ownerId,
      declarationType: required.declarationType,
      termsDocumentAssetVersionId: rightsDocumentVersion.id,
      termsVersion: '1',
      declarationText: `Owner attests ${required.declarationType}.`,
      evidenceNote: 'Bound to sealed proof document.',
      recordingId: required.recordingId
    });
    await publishing.openRightsReviewDocument({ declarationId: declaration.id, actorUserId: reviewerId });
    await publishing.reviewRightsDeclaration({
      declarationId: declaration.id,
      actorUserId: reviewerId,
      outcome: 'verified',
      reason: 'Checked against the sealed source document.'
    });
  }
  const workspace = await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId });
  assert.equal(
    workspace.releases.find((release) => release.id === releaseId)?.status,
    'ready',
    'Release must reach ready before a delivery can be created.'
  );

  let submitCount = 0;
  const baseAdapter = createSandboxDistributionAdapter({ secret: 'distribution-delivery-proof-secret' });
  const countedAdapter = {
    ...baseAdapter,
    async submit(payload) {
      submitCount += 1;
      return baseAdapter.submit(payload);
    }
  };
  const deliveryService = createDistributionDeliveryService({ db, adapters: { sway_sandbox: countedAdapter } });

  for (const actorUserId of [outsiderId, reviewerId]) {
    await assert.rejects(
      deliveryService.createDelivery({
        releaseId,
        actorUserId,
        providerKey: 'sway_sandbox',
        destinationKey: 'spotify'
      }),
      /Release not found or unavailable/i
    );
  }
  assert.equal((await db.select().from(musicDistributionDeliveries)).length, 0);

  const delivery = await deliveryService.createDelivery({
    releaseId,
    actorUserId: ownerId,
    providerKey: 'sway_sandbox',
    destinationKey: 'spotify'
  });
  assert.equal(delivery.deliveryStatus, 'draft');
  assert.equal((await eventsFor(delivery.id))[0].eventType, 'delivery_created');

  for (const actorUserId of [reviewerId, outsiderId]) {
    await assert.rejects(
      deliveryService.submitDelivery({ deliveryId: delivery.id, actorUserId }),
      /Distribution delivery not found or unavailable/i
    );
    await assert.rejects(
      deliveryService.submitDelivery({ deliveryId: randomUUID(), actorUserId }),
      /Distribution delivery not found or unavailable/i
    );
  }
  assert.equal(submitCount, 0);

  async function findDeliveryAsSeenByPerformer(deliveryId) {
    const performerWorkspace = await publishing.listReleaseWorkspace({
      performerId: performer.id,
      actorUserId: ownerId
    });
    const release = performerWorkspace.releases.find((candidate) => candidate.id === releaseId);
    const found = release?.deliveries.find((candidate) => candidate.id === deliveryId);
    assert.ok(found, `Performer workspace must surface delivery ${deliveryId}.`);
    return found;
  }

  assert.equal((await findDeliveryAsSeenByPerformer(delivery.id)).isSandbox, true);

  const submitted = await deliveryService.submitDelivery({ deliveryId: delivery.id, actorUserId: ownerId });
  assert.equal(submitted.alreadySubmitted, false);
  assert.equal(submitted.delivery.deliveryStatus, 'submitted');
  assert.match(submitted.delivery.metadataFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(submitCount, 1);
  assert.equal((await findDeliveryAsSeenByPerformer(delivery.id)).deliveryStatus, 'submitted');

  const resubmitted = await deliveryService.submitDelivery({ deliveryId: delivery.id, actorUserId: ownerId });
  assert.equal(resubmitted.alreadySubmitted, true);
  assert.equal(submitCount, 1);

  const retryDelivery = await deliveryService.createDelivery({
    releaseId,
    actorUserId: ownerId,
    providerKey: 'sway_sandbox',
    destinationKey: 'amazon_music'
  });
  const retryInitialSubmit = await deliveryService.submitDelivery({
    deliveryId: retryDelivery.id,
    actorUserId: ownerId
  });
  const signedRetryFailure = baseAdapter.signWebhookEvent({
    providerEventId: 'evt-failed-before-retry',
    providerReleaseId: retryInitialSubmit.delivery.providerReleaseId,
    destinationKey: 'amazon_music',
    status: 'failed',
    destinationReleaseId: null,
    error: 'Sandbox rejected metadata.'
  });
  await deliveryService.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: signedRetryFailure.rawBody,
    signatureHeader: signedRetryFailure.signatureHeader
  });
  const retrySubmitted = await deliveryService.submitDelivery({
    deliveryId: retryDelivery.id,
    actorUserId: ownerId
  });
  assert.equal(retrySubmitted.delivery.deliveryStatus, 'submitted');
  assert.equal(retrySubmitted.delivery.lastError, null);
  assert.equal(submitCount, 3);
  assert.equal(
    (await deliveryService.submitDelivery({ deliveryId: retryDelivery.id, actorUserId: ownerId })).alreadySubmitted,
    true
  );
  assert.equal(submitCount, 3);

  const retryTransitions = (await eventsFor(retryDelivery.id))
    .filter((event) => event.eventType === 'status_changed')
    .map((event) => `${event.previousStatus}->${event.nextStatus}`);
  assert.deepEqual(retryTransitions, [
    'draft->queued',
    'queued->submitted',
    'submitted->failed',
    'failed->queued',
    'queued->submitted'
  ]);

  const acceptedEvent = {
    providerEventId: 'evt-accepted-1',
    providerReleaseId: submitted.delivery.providerReleaseId,
    destinationKey: 'spotify',
    status: 'accepted',
    destinationReleaseId: 'sandbox-track-abc',
    error: null
  };
  const invalidLiveEvent = { ...acceptedEvent, providerEventId: 'evt-live-before-accepted', status: 'live' };
  const signedInvalidLive = baseAdapter.signWebhookEvent(invalidLiveEvent);
  let invalidTransitionFailure;
  try {
    await deliveryService.ingestWebhook({
      providerKey: 'sway_sandbox',
      rawBody: signedInvalidLive.rawBody,
      signatureHeader: signedInvalidLive.signatureHeader
    });
  } catch (error) {
    invalidTransitionFailure = classifyDistributionWebhookFailure(error);
  }
  assert.equal(invalidTransitionFailure?.statusCode, 409);
  assert.equal(invalidTransitionFailure?.retryable, false);

  const signedAccepted = baseAdapter.signWebhookEvent(acceptedEvent);
  assert.deepEqual(
    await deliveryService.ingestWebhook({
      providerKey: 'sway_sandbox',
      rawBody: signedAccepted.rawBody,
      signatureHeader: signedAccepted.signatureHeader
    }),
    { processed: true, duplicate: false }
  );
  const acceptedAsSeenByPerformer = await findDeliveryAsSeenByPerformer(delivery.id);
  assert.equal(acceptedAsSeenByPerformer.deliveryStatus, 'accepted');
  assert.ok(acceptedAsSeenByPerformer.acceptedAt);

  assert.deepEqual(
    await deliveryService.ingestWebhook({
      providerKey: 'sway_sandbox',
      rawBody: signedAccepted.rawBody,
      signatureHeader: signedAccepted.signatureHeader
    }),
    { processed: false, duplicate: true }
  );

  const conflictingPayload = baseAdapter.signWebhookEvent({
    ...acceptedEvent,
    destinationReleaseId: 'different-destination-for-same-event'
  });
  let conflictingPayloadFailure;
  try {
    await deliveryService.ingestWebhook({
      providerKey: 'sway_sandbox',
      rawBody: conflictingPayload.rawBody,
      signatureHeader: conflictingPayload.signatureHeader
    });
  } catch (error) {
    conflictingPayloadFailure = classifyDistributionWebhookFailure(error);
  }
  assert.equal(conflictingPayloadFailure?.statusCode, 409);
  assert.equal(conflictingPayloadFailure?.retryable, false);

  const conflictingDelivery = baseAdapter.signWebhookEvent({
    providerEventId: acceptedEvent.providerEventId,
    providerReleaseId: retrySubmitted.delivery.providerReleaseId,
    destinationKey: 'amazon_music',
    status: 'accepted',
    destinationReleaseId: 'different-delivery-for-same-event',
    error: null
  });
  let conflictingDeliveryFailure;
  try {
    await deliveryService.ingestWebhook({
      providerKey: 'sway_sandbox',
      rawBody: conflictingDelivery.rawBody,
      signatureHeader: conflictingDelivery.signatureHeader
    });
  } catch (error) {
    conflictingDeliveryFailure = classifyDistributionWebhookFailure(error);
  }
  assert.equal(conflictingDeliveryFailure?.statusCode, 409);
  assert.equal(conflictingDeliveryFailure?.retryable, false);

  const correctionDelivery = await deliveryService.createDelivery({
    releaseId,
    actorUserId: ownerId,
    providerKey: 'sway_sandbox',
    destinationKey: 'youtube_music'
  });
  const correctionSubmitted = await deliveryService.submitDelivery({
    deliveryId: correctionDelivery.id,
    actorUserId: ownerId
  });
  const signedCorrectionAccepted = baseAdapter.signWebhookEvent({
    providerEventId: 'evt-accepted-correction',
    providerReleaseId: correctionSubmitted.delivery.providerReleaseId,
    destinationKey: 'youtube_music',
    status: 'accepted',
    destinationReleaseId: 'sandbox-youtube-track-1',
    error: null
  });
  await deliveryService.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: signedCorrectionAccepted.rawBody,
    signatureHeader: signedCorrectionAccepted.signatureHeader
  });
  await assert.rejects(
    deliveryService.requestCorrection({
      deliveryId: correctionDelivery.id,
      actorUserId: reviewerId,
      reason: 'Review-only access cannot request a correction.'
    }),
    /Distribution delivery not found or unavailable/i
  );
  const correction = await deliveryService.requestCorrection({
    deliveryId: correctionDelivery.id,
    actorUserId: ownerId,
    reason: 'Release metadata needs a late adjustment.'
  });
  assert.equal(correction.delivery.deliveryStatus, 'correction_pending');
  assert.equal(
    (await deliveryService.requestCorrection({
      deliveryId: correctionDelivery.id,
      actorUserId: ownerId,
      reason: 'Release metadata needs a late adjustment.'
    })).alreadyRequested,
    true
  );
  await assert.rejects(
    deliveryService.submitDelivery({
      deliveryId: correctionDelivery.id,
      actorUserId: ownerId
    }),
    /Correction-request intake is pending; provider transmission and resubmission are not implemented\./
  );
  assert.equal(submitCount, 4, 'Correction-request intake must not transmit or resubmit to a provider.');

  let invalidSignatureFailure;
  try {
    await deliveryService.ingestWebhook({
      providerKey: 'sway_sandbox',
      rawBody: signedAccepted.rawBody,
      signatureHeader: `${signedAccepted.signatureHeader.slice(0, -1)}${signedAccepted.signatureHeader.at(-1) === '0' ? '1' : '0'}`
    });
  } catch (error) {
    invalidSignatureFailure = classifyDistributionWebhookFailure(error);
  }
  assert.equal(invalidSignatureFailure?.statusCode, 400);
  assert.equal(invalidSignatureFailure?.retryable, false);

  const signedLive = baseAdapter.signWebhookEvent({
    ...acceptedEvent,
    providerEventId: 'evt-live-1',
    status: 'live'
  });
  await deliveryService.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: signedLive.rawBody,
    signatureHeader: signedLive.signatureHeader
  });
  const liveAsSeenByPerformer = await findDeliveryAsSeenByPerformer(delivery.id);
  assert.equal(liveAsSeenByPerformer.deliveryStatus, 'live');
  assert.ok(liveAsSeenByPerformer.liveAt);
  assert.equal(liveAsSeenByPerformer.isSandbox, true);

  assert.deepEqual(
    (await publishing.getPublicRelease({ releaseId }))?.destinations,
    [],
    'Sandbox delivery must never appear as a public real-store destination.'
  );

  await assert.rejects(
    deliveryService.requestTakedown({
      deliveryId: delivery.id,
      actorUserId: outsiderId,
      reason: 'Another performer cannot request this takedown.'
    }),
    /Distribution delivery not found or unavailable/i
  );
  assert.equal(
    (await deliveryService.requestTakedown({
      deliveryId: delivery.id,
      actorUserId: ownerId,
      reason: 'Testing takedown proof.'
    })).delivery.deliveryStatus,
    'takedown_requested'
  );
  const signedTakenDown = baseAdapter.signWebhookEvent({
    ...acceptedEvent,
    providerEventId: 'evt-taken-down-1',
    status: 'taken_down'
  });
  await deliveryService.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: signedTakenDown.rawBody,
    signatureHeader: signedTakenDown.signatureHeader
  });
  const [finalDelivery] = await db
    .select()
    .from(musicDistributionDeliveries)
    .where(eq(musicDistributionDeliveries.id, delivery.id));
  assert.equal(finalDelivery.deliveryStatus, 'taken_down');
  assert.ok(finalDelivery.takenDownAt);

  console.log('Distribution delivery integration proof passed.');
  process.exit(0);
} catch (error) {
  console.error('Distribution delivery integration proof failed:', error);
  process.exit(1);
}
