import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, and } from 'drizzle-orm';
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
import { createDistributionDeliveryService } from '../src/server/distribution-delivery-service.ts';

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
    .where(eq(musicDistributionDeliveryEvents.deliveryId, deliveryId));
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
  const rightsDocumentBody = Buffer.from('delivery proof rights terms version one');
  const rightsDocumentVersion = await sealFile({
    title: 'delivery-proof-rights.txt',
    assetKind: 'document',
    mimeType: 'text/plain',
    body: rightsDocumentBody
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

  const requiredDeclarations = [
    { declarationType: 'master_control', recordingId: releaseDraft.recording.id },
    { declarationType: 'composition_control', recordingId: releaseDraft.recording.id },
    { declarationType: 'artwork_control', recordingId: null },
    { declarationType: 'distribution_authorization', recordingId: null }
  ];
  for (const required of requiredDeclarations) {
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
  const readyRelease = workspace.releases.find((release) => release.id === releaseId);
  assert.equal(readyRelease?.status, 'ready', 'Release must reach ready before a delivery can be created.');

  // --- Distribution delivery engine proofs ---

  let submitCount = 0;
  const sandboxSecret = 'distribution-delivery-proof-secret';
  const baseAdapter = createSandboxDistributionAdapter({ secret: sandboxSecret });
  const countedAdapter = {
    ...baseAdapter,
    async submit(payload) {
      submitCount += 1;
      return baseAdapter.submit(payload);
    }
  };
  const deliveryService = createDistributionDeliveryService({ db, adapters: { sway_sandbox: countedAdapter } });

  // Unauthorized denial: an actor with no grant on this project cannot create a delivery.
  await assert.rejects(
    deliveryService.createDelivery({
      releaseId,
      actorUserId: outsiderId,
      providerKey: 'sway_sandbox',
      destinationKey: 'spotify'
    }),
    /release-management authority/i
  );

  // Cross-account denial: a reviewer has real access (canApprove) but not
  // manage-release authority, so delivery creation must still be denied.
  await assert.rejects(
    deliveryService.createDelivery({
      releaseId,
      actorUserId: reviewerId,
      providerKey: 'sway_sandbox',
      destinationKey: 'spotify'
    }),
    /release-management authority/i
  );
  assert.equal((await db.select().from(musicDistributionDeliveries)).length, 0, 'Denied attempts must not create a delivery row.');

  // Authorized success.
  const delivery = await deliveryService.createDelivery({
    releaseId,
    actorUserId: ownerId,
    providerKey: 'sway_sandbox',
    destinationKey: 'spotify'
  });
  assert.equal(delivery.deliveryStatus, 'draft');
  const createdEvents = await eventsFor(delivery.id);
  assert.equal(createdEvents.length, 1);
  assert.equal(createdEvents[0].eventType, 'delivery_created');
  assert.equal(createdEvents[0].actorUserId, ownerId);

  // Submission drives draft -> queued -> submitted and calls the adapter exactly once.
  const submitted = await deliveryService.submitDelivery({ deliveryId: delivery.id, actorUserId: ownerId });
  assert.equal(submitted.alreadySubmitted, false);
  assert.equal(submitted.delivery.deliveryStatus, 'submitted');
  assert.match(submitted.delivery.metadataFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(submitted.delivery.providerReleaseId?.startsWith(`sandbox-${releaseId}-`));
  assert.equal(submitCount, 1);
  const afterSubmitEvents = await eventsFor(delivery.id);
  assert.equal(afterSubmitEvents.length, 3, 'delivery_created + queued status_changed + submitted status_changed.');

  // Duplicate retry safety: resubmitting an already-submitted delivery is a no-op.
  const resubmitted = await deliveryService.submitDelivery({ deliveryId: delivery.id, actorUserId: ownerId });
  assert.equal(resubmitted.alreadySubmitted, true);
  assert.equal(submitCount, 1, 'A retried submit must never call the provider a second time.');
  assert.equal((await eventsFor(delivery.id)).length, 3, 'A retried submit must not record extra events.');

  // Partial external failure: an adapter that throws on submit must leave the
  // delivery exactly where it started, with no partial transition applied.
  const failingAdapter = {
    ...baseAdapter,
    async submit() {
      throw new Error('Simulated provider outage.');
    }
  };
  const failingService = createDistributionDeliveryService({ db, adapters: { sway_sandbox_failing: failingAdapter } });
  const failingDelivery = await failingService.createDelivery({
    releaseId,
    actorUserId: ownerId,
    providerKey: 'sway_sandbox_failing',
    destinationKey: 'apple_music'
  });
  await assert.rejects(
    failingService.submitDelivery({ deliveryId: failingDelivery.id, actorUserId: ownerId }),
    /Simulated provider outage/
  );
  const [failingRow] = await db.select().from(musicDistributionDeliveries).where(eq(musicDistributionDeliveries.id, failingDelivery.id));
  assert.equal(failingRow.deliveryStatus, 'draft', 'A provider failure must roll back the queued transition too.');
  assert.equal((await eventsFor(failingDelivery.id)).length, 1, 'A provider failure must leave only the original delivery_created event.');

  // Webhook: valid signed acceptance, then replay defense, then live.
  const acceptedEvent = {
    providerEventId: 'evt-accepted-1',
    providerReleaseId: submitted.delivery.providerReleaseId,
    destinationKey: 'spotify',
    status: 'accepted',
    destinationReleaseId: 'spotify-track-abc',
    error: null
  };
  const signedAccepted = baseAdapter.signWebhookEvent(acceptedEvent);
  const firstIngest = await deliveryService.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: signedAccepted.rawBody,
    signatureHeader: signedAccepted.signatureHeader
  });
  assert.deepEqual(firstIngest, { processed: true, duplicate: false });
  const [afterAccepted] = await db.select().from(musicDistributionDeliveries).where(eq(musicDistributionDeliveries.id, delivery.id));
  assert.equal(afterAccepted.deliveryStatus, 'accepted');
  assert.equal(afterAccepted.destinationReleaseId, 'spotify-track-abc');
  assert.ok(afterAccepted.acceptedAt);

  // Replay: same event, same signature -- must be a no-op, not a second transition.
  const replayIngest = await deliveryService.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: signedAccepted.rawBody,
    signatureHeader: signedAccepted.signatureHeader
  });
  assert.deepEqual(replayIngest, { processed: false, duplicate: true });
  const [afterReplay] = await db.select().from(musicDistributionDeliveries).where(eq(musicDistributionDeliveries.id, delivery.id));
  assert.equal(afterReplay.deliveryStatus, 'accepted', 'A replayed webhook must not change delivery state.');
  assert.equal(
    (await db.select().from(musicDistributionDeliveryEvents).where(and(
      eq(musicDistributionDeliveryEvents.deliveryId, delivery.id),
      eq(musicDistributionDeliveryEvents.providerEventId, 'evt-accepted-1')
    ))).length,
    1,
    'A replayed providerEventId must never be recorded twice.'
  );

  await assert.rejects(
    deliveryService.requestCorrection({
      deliveryId: failingDelivery.id,
      actorUserId: ownerId,
      reason: 'Draft delivery cannot be corrected.'
    }),
    /cannot be sent for correction/i
  );

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
  const correctionAccepted = {
    providerEventId: 'evt-accepted-correction',
    providerReleaseId: correctionSubmitted.delivery.providerReleaseId,
    destinationKey: 'youtube_music',
    status: 'accepted',
    destinationReleaseId: 'yt-music-track-1',
    error: null
  };
  const signedCorrectionAccepted = baseAdapter.signWebhookEvent(correctionAccepted);
  await deliveryService.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: signedCorrectionAccepted.rawBody,
    signatureHeader: signedCorrectionAccepted.signatureHeader
  });

  const correction = await deliveryService.requestCorrection({
    deliveryId: correctionDelivery.id,
    actorUserId: ownerId,
    reason: 'Release metadata needs a late adjustment.'
  });
  assert.equal(correction.delivery.deliveryStatus, 'correction_pending');
  assert.equal(correction.alreadyRequested, false);
  const correctionReplay = await deliveryService.requestCorrection({
    deliveryId: correctionDelivery.id,
    actorUserId: ownerId,
    reason: 'Release metadata needs a late adjustment.'
  });
  assert.equal(correctionReplay.alreadyRequested, true);
  assert.equal(correctionReplay.delivery.deliveryStatus, 'correction_pending');

  // Tampered signature must be rejected before any DB write.
  await assert.rejects(
    deliveryService.ingestWebhook({
      providerKey: 'sway_sandbox',
      rawBody: signedAccepted.rawBody,
      signatureHeader: `${signedAccepted.signatureHeader.slice(0, -1)}${signedAccepted.signatureHeader.at(-1) === '0' ? '1' : '0'}`
    }),
    /signature verification failed/i
  );

  // Live confirmation.
  const liveEvent = { ...acceptedEvent, providerEventId: 'evt-live-1', status: 'live' };
  const signedLive = baseAdapter.signWebhookEvent(liveEvent);
  await deliveryService.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: signedLive.rawBody,
    signatureHeader: signedLive.signatureHeader
  });
  const [afterLive] = await db.select().from(musicDistributionDeliveries).where(eq(musicDistributionDeliveries.id, delivery.id));
  assert.equal(afterLive.deliveryStatus, 'live');
  assert.ok(afterLive.liveAt);

  // Truthful public projection: a sandbox-only delivery, however far it
  // advances, must never be surfaced as a real provider-confirmed status.
  const publicRelease = await publishing.getPublicRelease({ releaseId });
  assert.deepEqual(publicRelease?.destinations, [], 'Sandbox deliveries must never appear in the public release projection.');

  // Takedown: manual request, then provider confirmation.
  const takedownRequested = await deliveryService.requestTakedown({
    deliveryId: delivery.id,
    actorUserId: ownerId,
    reason: 'Testing takedown proof.'
  });
  assert.equal(takedownRequested.delivery.deliveryStatus, 'takedown_requested');
  const takenDownEvent = { ...acceptedEvent, providerEventId: 'evt-taken-down-1', status: 'taken_down' };
  const signedTakenDown = baseAdapter.signWebhookEvent(takenDownEvent);
  await deliveryService.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: signedTakenDown.rawBody,
    signatureHeader: signedTakenDown.signatureHeader
  });
  const [finalDelivery] = await db.select().from(musicDistributionDeliveries).where(eq(musicDistributionDeliveries.id, delivery.id));
  assert.equal(finalDelivery.deliveryStatus, 'taken_down');
  assert.ok(finalDelivery.takenDownAt);

  console.log('Distribution delivery integration proof passed.');
  process.exit(0);
} catch (error) {
  console.error('Distribution delivery integration proof failed:', error);
  process.exit(1);
}
