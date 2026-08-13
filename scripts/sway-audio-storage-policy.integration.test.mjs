import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, sql } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client.ts';
import {
  audioAssets,
  audioCreatorDeals,
  audioProjectAccessGrants,
  audioProjectAssetVersions,
  audioProjects,
  audioUploadParts,
  audioUploadSessions,
  auditEvents,
  musicDistributionDeliveries,
  musicRecordings,
  musicReleaseRecordings,
  musicReleases,
  musicReleaseStorageManifests,
  musicRightsDeclarationEvents,
  musicRightsDeclarations,
  performers,
  users
} from '../src/db/schema.ts';
import {
  AudioStorageObjectLimitError,
  AudioStorageQuotaError,
  createAudioPublishingService
} from '../src/server/audio-publishing-service.ts';
import {
  createAudioStoragePolicy,
  DEFAULT_AUDIO_WORKSPACE_LIMIT_BYTES
} from '../src/server/audio-storage-policy.ts';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const MIB = 1024 * 1024;
const DEFAULT_PART_SIZE = 5 * MIB;

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function wavBody(label, size = 64) {
  const dataSize = Math.max(800, size - 44);
  const body = Buffer.alloc(44 + dataSize, 0x80);
  body.write('RIFF', 0, 'ascii');
  body.writeUInt32LE(body.byteLength - 8, 4);
  body.write('WAVE', 8, 'ascii');
  body.write('fmt ', 12, 'ascii');
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8_000, 24);
  body.writeUInt32LE(8_000, 28);
  body.writeUInt16LE(1, 32);
  body.writeUInt16LE(8, 34);
  body.write('data', 36, 'ascii');
  body.writeUInt32LE(dataSize, 40);
  Buffer.from(label).copy(body, 44, 0, dataSize);
  return body;
}

function pngBody() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
}

class CountingAudioObjectStore {
  provider = 'local_private_fs';
  bucket = 'bounded-storage-proof';
  isEnabled = true;
  durability = 'development';
  beginCount = 0;
  writeCount = 0;
  assembleCount = 0;
  abortCount = 0;
  discardCount = 0;
  abortedUploadIds = [];
  discardedUploadIds = [];
  beginDelayMs = 0;
  assembleDelayMs = 0;
  onAssembleStart = null;
  uploads = new Map();
  objects = new Map();
  abortFailuresRemaining = new Map();
  integrityFailuresRemaining = new Map();

  async verifyReady() {}

  async beginUpload({ projectId, uploadSessionId, filename }) {
    this.beginCount += 1;
    if (this.beginDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.beginDelayMs));
    }
    const identity = {
      storageProvider: 'local_private_fs',
      storageBucket: this.bucket,
      storageKey: `proof/${projectId}/${uploadSessionId}/${filename}`,
      providerUploadId: uploadSessionId
    };
    this.uploads.set(uploadSessionId, { identity, parts: new Map() });
    return identity;
  }

  async abortUpload(identity) {
    this.abortCount += 1;
    this.abortedUploadIds.push(identity.providerUploadId);
    const remaining = this.abortFailuresRemaining.get(identity.providerUploadId) ?? 0;
    if (remaining > 0) {
      this.abortFailuresRemaining.set(identity.providerUploadId, remaining - 1);
      throw new Error('forced provider abort failure');
    }
    this.uploads.delete(identity.providerUploadId);
  }

  async discardUpload(identity) {
    this.discardCount += 1;
    this.discardedUploadIds.push(identity.providerUploadId);
    const remaining = this.abortFailuresRemaining.get(identity.providerUploadId) ?? 0;
    if (remaining > 0) {
      this.abortFailuresRemaining.set(identity.providerUploadId, remaining - 1);
      throw new Error('forced provider discard failure');
    }
    this.uploads.delete(identity.providerUploadId);
    this.objects.delete(identity.storageKey);
  }

  async writePart({ identity, partNumber, body }) {
    this.writeCount += 1;
    const upload = this.uploads.get(identity.providerUploadId);
    if (!upload) throw new Error('Proof multipart upload not found.');
    const checksum = sha256(body);
    upload.parts.set(partNumber, Buffer.from(body));
    return { etag: checksum, checksum, byteSize: body.byteLength };
  }

  async assembleParts({ identity, parts, expectedByteSize, expectedSha256 }) {
    this.assembleCount += 1;
    this.onAssembleStart?.();
    if (this.assembleDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.assembleDelayMs));
    }
    const upload = this.uploads.get(identity.providerUploadId);
    if (!upload) throw new Error('Proof multipart upload not found.');
    const body = Buffer.concat(parts.map((part) => {
      const value = upload.parts.get(part.partNumber);
      if (!value) throw new Error(`Proof upload part ${part.partNumber} not found.`);
      return value;
    }));
    const forcedFailures = this.integrityFailuresRemaining.get(identity.providerUploadId) ?? 0;
    if (forcedFailures > 0) {
      this.integrityFailuresRemaining.set(identity.providerUploadId, forcedFailures - 1);
      this.objects.set(identity.storageKey, body);
      throw new Error('forced post-assembly hash failure');
    }
    if (body.byteLength !== expectedByteSize || sha256(body) !== expectedSha256) {
      throw new Error('Proof upload integrity mismatch.');
    }
    this.objects.set(identity.storageKey, body);
    this.uploads.delete(identity.providerUploadId);
    return { byteSize: body.byteLength, sha256: expectedSha256 };
  }

  async openOriginal(identity) {
    const body = this.objects.get(identity.storageKey);
    if (!body) throw new Error('Proof sealed original not found.');
    return { stream: Readable.from(body), byteSize: body.byteLength };
  }
}

const proof = await startEmbeddedPostgresProof('audio_storage_policy');
if (process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF === 'true') {
  assert.equal(proof.kind, 'real-postgres', 'Strict concurrency evidence requires standalone PostgreSQL.');
}
const db = createSwayDb(proof.databaseUrl);
const store = new CountingAudioObjectStore();

async function createPerformerWorkspace(service, label) {
  const ownerUserId = randomUUID();
  await db.insert(users).values({
    id: ownerUserId,
    email: `${label}-${ownerUserId}@example.test`,
    emailVerifiedAt: new Date()
  });
  const [performer] = await db.insert(performers).values({
    ownerUserId,
    displayName: `${label} performer`
  }).returning();
  const project = await service.createProject({
    performerId: performer.id,
    actorUserId: ownerUserId,
    title: `${label} project`
  });
  return { ownerUserId, performer, project };
}

async function sealFile(service, workspace, input) {
  const session = await service.initiateUpload({
    projectId: workspace.project.id,
    actorUserId: workspace.ownerUserId,
    title: input.filename,
    assetKind: input.assetKind,
    originalFilename: input.filename,
    mimeType: input.mimeType,
    expectedByteSize: input.body.byteLength,
    expectedSha256: sha256(input.body),
    idempotencyKey: `seal:${input.filename}:${sha256(input.body)}`
  });
  await service.writeUploadPart({
    uploadSessionId: session.id,
    actorUserId: workspace.ownerUserId,
    partNumber: 1,
    body: input.body
  });
  return service.completeAndSealUpload({
    uploadSessionId: session.id,
    actorUserId: workspace.ownerUserId,
    performerId: workspace.performer.id
  });
}

async function countProjectRows(table, projectId) {
  return (await db.select().from(table).where(eq(table.projectId, projectId))).length;
}

async function createStaleSession(workspace, status, storageIdentityOverride = null) {
  const sessionId = randomUUID();
  const [asset] = await db.insert(audioAssets).values({
    projectId: workspace.project.id,
    createdByUserId: workspace.ownerUserId,
    title: `stale-${status}.txt`,
    assetKind: 'document',
    provenanceType: 'user_upload',
    status: 'active'
  }).returning();
  const begunIdentity = await store.beginUpload({
    projectId: workspace.project.id,
    uploadSessionId: sessionId,
    filename: `stale-${status}.txt`,
    mimeType: 'text/plain'
  });
  const identity = storageIdentityOverride
    ? { ...storageIdentityOverride, providerUploadId: begunIdentity.providerUploadId }
    : begunIdentity;
  await db.insert(audioUploadSessions).values({
    id: sessionId,
    projectId: workspace.project.id,
    assetId: asset.id,
    initiatedByUserId: workspace.ownerUserId,
    idempotencyKey: `stale:${status}:${sessionId}`,
    storageProvider: identity.storageProvider,
    storageBucket: identity.storageBucket,
    providerUploadId: identity.providerUploadId,
    storageKey: identity.storageKey,
    originalFilename: `stale-${status}.txt`,
    expectedMimeType: 'text/plain',
    expectedByteSize: 1,
    expectedSha256: sha256(Buffer.from('x')),
    partSizeBytes: DEFAULT_PART_SIZE,
    uploadStatus: 'initiated',
    expiresAt: new Date(Date.now() - 60_000)
  });
  if (['uploading', 'uploaded', 'verifying', 'quarantined'].includes(status)) {
    await db.update(audioUploadSessions).set({ uploadStatus: 'uploading' }).where(eq(audioUploadSessions.id, sessionId));
  }
  if (['uploaded', 'verifying', 'quarantined'].includes(status)) {
    await db.update(audioUploadSessions).set({ uploadStatus: 'uploaded' }).where(eq(audioUploadSessions.id, sessionId));
  }
  if (['verifying', 'quarantined'].includes(status)) {
    await db.update(audioUploadSessions).set({ uploadStatus: 'verifying' }).where(eq(audioUploadSessions.id, sessionId));
  }
  if (status === 'quarantined') {
    await db.update(audioUploadSessions).set({ uploadStatus: 'quarantined' }).where(eq(audioUploadSessions.id, sessionId));
    store.objects.set(identity.storageKey, Buffer.from('retained quarantined provider bytes'));
  }
  return { sessionId, identity };
}

async function createDelivery(workspace, releaseId, metadataFingerprint) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('sway.actor_user_id', ${workspace.ownerUserId}, true)`);
    const [delivery] = await tx.insert(musicDistributionDeliveries).values({
      releaseId,
      providerKey: 'proof-provider',
      destinationKey: 'proof-destination',
      deliveryStatus: 'draft',
      metadataFingerprint
    }).returning();
    return delivery;
  });
}

async function transitionDelivery(workspace, deliveryId, nextStatus, values = {}) {
  const payloadSha256 = values.payloadSha256 ?? sha256(Buffer.from(`${deliveryId}:${nextStatus}`));
  const { payloadSha256: _payloadSha256, ...deliveryValues } = values;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('sway.actor_user_id', ${workspace.ownerUserId}, true)`);
    await tx.execute(sql`select set_config('sway.delivery_transition_reason', ${`proof transition to ${nextStatus}`}, true)`);
    await tx.execute(sql`select set_config('sway.delivery_transition_idempotency_key', ${`proof:${deliveryId}:${nextStatus}`}, true)`);
    await tx.execute(sql`select set_config('sway.delivery_transition_payload_sha256', ${payloadSha256}, true)`);
    const [delivery] = await tx
      .update(musicDistributionDeliveries)
      .set({ deliveryStatus: nextStatus, ...deliveryValues })
      .where(eq(musicDistributionDeliveries.id, deliveryId))
      .returning();
    return delivery;
  });
}

try {
  const defaultPolicy = createAudioStoragePolicy({ env: {} });
  assert.equal(DEFAULT_AUDIO_WORKSPACE_LIMIT_BYTES, 5368709120);
  assert.equal(defaultPolicy.workspaceLimitBytes, 5368709120);
  assert.equal(defaultPolicy.workingObjectLimit, 10_000);
  assert.equal(defaultPolicy.releaseCountLimit, null);
  assert.equal(createAudioStoragePolicy({ env: { SWAY_AUDIO_WORKSPACE_LIMIT_BYTES: '777' } }).workspaceLimitBytes, 777);
  assert.throws(() => createAudioStoragePolicy({ workspaceLimitBytes: 0 }), /positive safe integer/);
  assert.throws(() => createAudioStoragePolicy({ workspaceLimitBytes: 1.5 }), /positive safe integer/);
  assert.throws(() => createAudioStoragePolicy({ workingObjectLimit: 0 }), /positive safe integer/);
  assert.equal(createAudioStoragePolicy({ workingObjectLimit: 25 }).workingObjectLimit, 25);
  assert.throws(
    () => createAudioStoragePolicy({ env: { SWAY_AUDIO_WORKSPACE_LIMIT_BYTES: '5 GiB' } }),
    /positive base-10 integer/
  );

  // Two independent service calls race for one performer's last 100 bytes.
  // The performer-scoped PostgreSQL advisory lock must let exactly one reserve.
  const concurrencyServiceA = createAudioPublishingService({ db, store, workspaceLimitBytes: 100 });
  const concurrencyServiceB = createAudioPublishingService({ db, store, workspaceLimitBytes: 100 });
  const concurrencyWorkspace = await createPerformerWorkspace(concurrencyServiceA, 'concurrency');
  const reservationBody = Buffer.alloc(60, 0x61);
  const uploadInput = (suffix) => ({
    projectId: concurrencyWorkspace.project.id,
    actorUserId: concurrencyWorkspace.ownerUserId,
    title: `reservation-${suffix}.txt`,
    assetKind: 'document',
    originalFilename: `reservation-${suffix}.txt`,
    mimeType: 'text/plain',
    expectedByteSize: reservationBody.byteLength,
    expectedSha256: sha256(reservationBody),
    idempotencyKey: `concurrency:${suffix}`
  });
  store.beginDelayMs = 75;
  const beginBeforeConcurrency = store.beginCount;
  const concurrentResults = await Promise.allSettled([
    concurrencyServiceA.initiateUpload(uploadInput('a')),
    concurrencyServiceB.initiateUpload(uploadInput('b'))
  ]);
  store.beginDelayMs = 0;
  const successfulReservation = concurrentResults.find((result) => result.status === 'fulfilled');
  const deniedReservation = concurrentResults.find((result) => result.status === 'rejected');
  assert.ok(successfulReservation, 'Exactly one concurrent reservation must succeed.');
  assert.ok(deniedReservation, 'Exactly one concurrent reservation must be denied.');
  assert.ok(deniedReservation.reason instanceof AudioStorageQuotaError);
  assert.equal(store.beginCount, beginBeforeConcurrency + 1, 'Quota loser must not start provider upload.');
  assert.equal(await countProjectRows(audioAssets, concurrencyWorkspace.project.id), 1);
  assert.equal(await countProjectRows(audioUploadSessions, concurrencyWorkspace.project.id), 1);

  const winningSuffix = successfulReservation.value.idempotencyKey.split(':').at(-1);
  const replay = await concurrencyServiceB.initiateUpload(uploadInput(winningSuffix));
  assert.equal(replay.id, successfulReservation.value.id, 'Idempotent replay must return the existing session.');
  assert.equal(store.beginCount, beginBeforeConcurrency + 1, 'Replay must not start a second provider upload.');

  const sameKeyServiceA = createAudioPublishingService({ db, store, workspaceLimitBytes: 1_000 });
  const sameKeyServiceB = createAudioPublishingService({ db, store, workspaceLimitBytes: 1_000 });
  const sameKeyWorkspace = await createPerformerWorkspace(sameKeyServiceA, 'same-key');
  const sameKeyBody = Buffer.from('same-key-idempotency');
  const sameKeyInput = {
    projectId: sameKeyWorkspace.project.id,
    actorUserId: sameKeyWorkspace.ownerUserId,
    title: 'same-key.txt',
    assetKind: 'document',
    originalFilename: 'same-key.txt',
    mimeType: 'text/plain',
    expectedByteSize: sameKeyBody.byteLength,
    expectedSha256: sha256(sameKeyBody),
    idempotencyKey: 'same-key-concurrent-proof'
  };
  store.beginDelayMs = 75;
  const beginBeforeSameKey = store.beginCount;
  const sameKeyResults = await Promise.all([
    sameKeyServiceA.initiateUpload(sameKeyInput),
    sameKeyServiceB.initiateUpload(sameKeyInput)
  ]);
  store.beginDelayMs = 0;
  assert.equal(sameKeyResults[0].id, sameKeyResults[1].id);
  assert.equal(store.beginCount, beginBeforeSameKey + 1);
  assert.equal(await countProjectRows(audioAssets, sameKeyWorkspace.project.id), 1);
  assert.equal(await countProjectRows(audioUploadSessions, sameKeyWorkspace.project.id), 1);

  const concurrencyUsage = await concurrencyServiceA.getStorageUsage({
    performerId: concurrencyWorkspace.performer.id
  });
  assert.deepEqual(Object.keys(concurrencyUsage).sort(), [
    'availableWorkspaceBytes',
    'releaseCountLimit',
    'releaseProtectedBytes',
    'reservedBytes',
    'sealedWorkingBytes',
    'workingObjectCount',
    'workingObjectLimit',
    'workingBytes',
    'workspaceLimitBytes'
  ].sort());
  assert.deepEqual(concurrencyUsage, {
    workspaceLimitBytes: 100,
    workingBytes: 60,
    sealedWorkingBytes: 0,
    reservedBytes: 60,
    releaseProtectedBytes: 0,
    availableWorkspaceBytes: 40,
    workingObjectCount: 1,
    workingObjectLimit: 10_000,
    releaseCountLimit: null
  });

  const assetsBeforeDenied = await countProjectRows(audioAssets, concurrencyWorkspace.project.id);
  const sessionsBeforeDenied = await countProjectRows(audioUploadSessions, concurrencyWorkspace.project.id);
  const beginBeforeDenied = store.beginCount;
  await assert.rejects(
    concurrencyServiceA.initiateUpload(uploadInput('explicit-denial')),
    (error) => error instanceof AudioStorageQuotaError
  );
  assert.equal(await countProjectRows(audioAssets, concurrencyWorkspace.project.id), assetsBeforeDenied);
  assert.equal(await countProjectRows(audioUploadSessions, concurrencyWorkspace.project.id), sessionsBeforeDenied);
  assert.equal(store.beginCount, beginBeforeDenied, 'Denied initiation must have no provider side effect.');

  // Tiny objects cannot bypass the byte ceiling indefinitely. This is a
  // working-object guard only; it never limits releases.
  const objectLimitServiceA = createAudioPublishingService({
    db,
    store,
    workspaceLimitBytes: 1_000,
    workingObjectLimit: 1
  });
  const objectLimitServiceB = createAudioPublishingService({
    db,
    store,
    workspaceLimitBytes: 1_000,
    workingObjectLimit: 1
  });
  const objectLimitWorkspace = await createPerformerWorkspace(objectLimitServiceA, 'object-limit');
  const tinyUpload = (suffix) => ({
    projectId: objectLimitWorkspace.project.id,
    actorUserId: objectLimitWorkspace.ownerUserId,
    title: `tiny-${suffix}.txt`,
    assetKind: 'document',
    originalFilename: `tiny-${suffix}.txt`,
    mimeType: 'text/plain',
    expectedByteSize: 1,
    expectedSha256: sha256(Buffer.from('x')),
    idempotencyKey: `tiny:${suffix}`
  });
  store.beginDelayMs = 75;
  const objectLimitBeginBeforeRace = store.beginCount;
  const objectLimitResults = await Promise.allSettled([
    objectLimitServiceA.initiateUpload(tinyUpload('first')),
    objectLimitServiceB.initiateUpload(tinyUpload('second'))
  ]);
  store.beginDelayMs = 0;
  const objectLimitWinners = objectLimitResults.filter((result) => result.status === 'fulfilled');
  const objectLimitLosers = objectLimitResults.filter((result) => result.status === 'rejected');
  assert.equal(objectLimitWinners.length, 1);
  assert.equal(objectLimitLosers.length, 1);
  assert.ok(objectLimitLosers[0].reason instanceof AudioStorageObjectLimitError);
  assert.equal(objectLimitLosers[0].reason.workingObjectCount, 1);
  assert.equal(objectLimitLosers[0].reason.workingObjectLimit, 1);
  assert.equal(store.beginCount, objectLimitBeginBeforeRace + 1);
  assert.equal(await countProjectRows(audioAssets, objectLimitWorkspace.project.id), 1);
  assert.equal(await countProjectRows(audioUploadSessions, objectLimitWorkspace.project.id), 1);
  const objectLimitUsage = await objectLimitServiceA.getStorageUsage({ performerId: objectLimitWorkspace.performer.id });
  assert.equal(objectLimitUsage.workingObjectCount, 1);
  assert.equal(objectLimitUsage.workingObjectLimit, 1);
  assert.equal(objectLimitUsage.releaseCountLimit, null);

  // Draft references remain working bytes. Ready/takedown releases protect the
  // complete package. Server-only restricted originals remain retained and
  // charged as working bytes/objects unless a release independently protects them.
  const classificationService = createAudioPublishingService({ db, store, workspaceLimitBytes: 100_000 });
  const classificationWorkspace = await createPerformerWorkspace(classificationService, 'classification');
  const master = await sealFile(classificationService, classificationWorkspace, {
    filename: 'master.wav', assetKind: 'master_audio', mimeType: 'audio/wav', body: wavBody('master', 71)
  });
  const artwork = await sealFile(classificationService, classificationWorkspace, {
    filename: 'artwork.png', assetKind: 'artwork', mimeType: 'image/png', body: pngBody('artwork')
  });
  const rightsDocument = await sealFile(classificationService, classificationWorkspace, {
    filename: 'rights.txt', assetKind: 'document', mimeType: 'text/plain', body: Buffer.from('immutable rights evidence')
  });
  const dealDocument = await sealFile(classificationService, classificationWorkspace, {
    filename: 'deal.pdf', assetKind: 'document', mimeType: 'application/pdf', body: Buffer.from('%PDF-1.7\nrelease deal evidence')
  });
  const spareMaster = await sealFile(classificationService, classificationWorkspace, {
    filename: 'spare.wav', assetKind: 'master_audio', mimeType: 'audio/wav', body: wavBody('spare', 83)
  });
  const restrictedDocument = await sealFile(classificationService, classificationWorkspace, {
    filename: 'restricted.txt', assetKind: 'document', mimeType: 'text/plain', body: Buffer.from('moderation legal retention')
  });
  await db.update(audioAssets)
    .set({ status: 'restricted' })
    .where(eq(audioAssets.id, restrictedDocument.assetId));

  const releaseDraft = await classificationService.createReleaseDraft({
    clientReleaseId: randomUUID(),
    performerId: classificationWorkspace.performer.id,
    actorUserId: classificationWorkspace.ownerUserId,
    projectId: classificationWorkspace.project.id,
    masterAssetVersionId: master.id,
    title: 'Bounded Storage Release',
    trackTitle: 'Bounded Storage Track',
    primaryArtistName: 'Classification performer',
    releaseType: 'single',
    territories: ['US'],
    languageCode: 'en'
  });
  await db.update(musicReleases)
    .set({ artworkAssetVersionId: artwork.id })
    .where(eq(musicReleases.id, releaseDraft.release.id));
  const rightsReviewerUserId = randomUUID();
  await db.insert(users).values({
    id: rightsReviewerUserId,
    email: `rights-reviewer-${rightsReviewerUserId}@example.test`,
    emailVerifiedAt: new Date()
  });
  await db.insert(audioProjectAccessGrants).values({
    projectId: classificationWorkspace.project.id,
    granteeUserId: rightsReviewerUserId,
    role: 'reviewer',
    canApprove: true,
    canManageRelease: true,
    grantedByUserId: classificationWorkspace.ownerUserId
  });
  const rightsDeclarations = [];
  const rightsReviewEvents = [];
  for (const declarationSpec of [
    { recordingId: releaseDraft.recording.id, declarationType: 'master_control' },
    { recordingId: releaseDraft.recording.id, declarationType: 'composition_control' },
    { recordingId: null, declarationType: 'artwork_control' },
    { recordingId: null, declarationType: 'distribution_authorization' }
  ]) {
    const declarationText = `I verify ${declarationSpec.declarationType} for this proof release.`;
    const [declaration] = await db.insert(musicRightsDeclarations).values({
      projectId: classificationWorkspace.project.id,
      releaseId: releaseDraft.release.id,
      recordingId: declarationSpec.recordingId,
      declaredByUserId: classificationWorkspace.ownerUserId,
      declarationType: declarationSpec.declarationType,
      termsDocumentAssetVersionId: rightsDocument.id,
      termsVersion: `proof-v1-${declarationSpec.declarationType}`,
      termsHash: rightsDocument.sha256,
      declarationText,
      declarationSha256: sha256(Buffer.from(declarationText)),
      evidence: { source: 'disposable-postgres-proof' }
    }).returning();
    const [reviewEvent] = await db.insert(musicRightsDeclarationEvents).values({
      declarationId: declaration.id,
      actorUserId: rightsReviewerUserId,
      eventType: 'verified',
      declarationSha256: declaration.declarationSha256,
      evidence: { independentReview: true, reviewerUserId: rightsReviewerUserId },
      reason: 'Disposable policy proof verified the exact sealed document.'
    }).returning();
    rightsDeclarations.push(declaration);
    rightsReviewEvents.push(reviewEvent);
  }
  await db.insert(audioCreatorDeals).values({
    projectId: classificationWorkspace.project.id,
    releaseId: releaseDraft.release.id,
    recordingId: null,
    proposedByUserId: classificationWorkspace.ownerUserId,
    dealType: 'license',
    title: 'Release-scoped proof deal',
    termsDocumentAssetVersionId: dealDocument.id,
    termsSha256: dealDocument.sha256,
    termsVersion: 'proof-v1'
  });

  const allClassificationBytes = [master, artwork, rightsDocument, dealDocument, spareMaster, restrictedDocument]
    .reduce((sum, version) => sum + version.byteSize, 0);
  const draftUsage = await classificationService.getStorageUsage({ performerId: classificationWorkspace.performer.id });
  assert.equal(draftUsage.releaseProtectedBytes, 0);
  assert.equal(draftUsage.sealedWorkingBytes, allClassificationBytes);
  assert.equal(draftUsage.workingObjectCount, 6);

  await db.update(musicReleases).set({ status: 'ready' }).where(eq(musicReleases.id, releaseDraft.release.id));
  const statusOnlyUsage = await classificationService.getStorageUsage({
    performerId: classificationWorkspace.performer.id
  });
  assert.equal(statusOnlyUsage.releaseProtectedBytes, 0, 'Mutable ready status alone must not graduate bytes.');
  assert.equal(statusOnlyUsage.sealedWorkingBytes, allClassificationBytes);

  const manifestAssets = [
    {
      assetVersionId: master.id,
      sha256: master.sha256,
      byteSize: master.byteSize,
      roles: [`recording_master:${releaseDraft.recording.id}`]
    },
    {
      assetVersionId: artwork.id,
      sha256: artwork.sha256,
      byteSize: artwork.byteSize,
      roles: ['release_artwork']
    },
    {
      assetVersionId: rightsDocument.id,
      sha256: rightsDocument.sha256,
      byteSize: rightsDocument.byteSize,
      roles: rightsDeclarations.map((declaration) => `rights_document:${declaration.id}`).sort()
    }
  ].sort((left, right) => left.assetVersionId.localeCompare(right.assetVersionId));
  const forgedDocumentManifestAssets = manifestAssets.map((asset) => (
    asset.assetVersionId === rightsDocument.id
      ? {
          assetVersionId: dealDocument.id,
          sha256: dealDocument.sha256,
          byteSize: dealDocument.byteSize,
          roles: asset.roles
        }
      : asset
  ));
  await assert.rejects(
    db.insert(musicReleaseStorageManifests).values({
      releaseId: releaseDraft.release.id,
      performerId: classificationWorkspace.performer.id,
      createdByUserId: rightsReviewerUserId,
      sourceType: 'readiness_pass',
      sourceEventId: rightsReviewEvents.at(-1).id,
      packageRevision: 1,
      packageFingerprint: sha256(Buffer.from(JSON.stringify(forgedDocumentManifestAssets))),
      assets: forgedDocumentManifestAssets,
      metadata: { schemaVersion: 1, forged: true }
    }),
    (error) => /exact latest verified declarations|verified master and composition rights|verified artwork and distribution authorization/i
      .test(`${error?.message ?? ''} ${error?.cause?.message ?? ''}`)
  );
  const [releaseStorageManifest] = await db.insert(musicReleaseStorageManifests).values({
    releaseId: releaseDraft.release.id,
    performerId: classificationWorkspace.performer.id,
    createdByUserId: rightsReviewerUserId,
    sourceType: 'readiness_pass',
    sourceEventId: rightsReviewEvents.at(-1).id,
    packageRevision: 1,
    packageFingerprint: sha256(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      releaseId: releaseDraft.release.id,
      performerId: classificationWorkspace.performer.id,
      assets: manifestAssets
    }))),
    assets: manifestAssets,
    metadata: { schemaVersion: 1, source: 'disposable-postgres-proof' }
  }).returning();

  const readyProtectedBytes = master.byteSize + artwork.byteSize + rightsDocument.byteSize;
  const readyUsage = await classificationService.getStorageUsage({ performerId: classificationWorkspace.performer.id });
  assert.equal(readyUsage.releaseProtectedBytes, readyProtectedBytes);
  assert.equal(readyUsage.sealedWorkingBytes, spareMaster.byteSize + restrictedDocument.byteSize + dealDocument.byteSize);
  assert.equal(readyUsage.workingBytes, spareMaster.byteSize + restrictedDocument.byteSize + dealDocument.byteSize);
  assert.equal(readyUsage.workingObjectCount, 3);

  await assert.rejects(
    db.update(musicReleaseStorageManifests)
      .set({ packageRevision: 2 })
      .where(eq(musicReleaseStorageManifests.id, releaseStorageManifest.id)),
    (error) => /immutable/i.test(`${error?.message ?? ''} ${error?.cause?.message ?? ''}`)
  );
  await assert.rejects(
    db.delete(musicReleaseStorageManifests)
      .where(eq(musicReleaseStorageManifests.id, releaseStorageManifest.id)),
    (error) => /immutable/i.test(`${error?.message ?? ''} ${error?.cause?.message ?? ''}`)
  );

  const laterArtwork = await sealFile(classificationService, classificationWorkspace, {
    filename: 'later-artwork.png', assetKind: 'artwork', mimeType: 'image/png', body: pngBody('later artwork')
  });
  await db.update(musicReleases)
    .set({ artworkAssetVersionId: laterArtwork.id })
    .where(eq(musicReleases.id, releaseDraft.release.id));
  const laterAttachmentUsage = await classificationService.getStorageUsage({
    performerId: classificationWorkspace.performer.id
  });
  assert.equal(laterAttachmentUsage.releaseProtectedBytes, readyProtectedBytes);
  assert.equal(
    laterAttachmentUsage.workingBytes,
    spareMaster.byteSize + restrictedDocument.byteSize + dealDocument.byteSize + laterArtwork.byteSize,
    'Files attached after the immutable package was recorded must remain working storage.'
  );

  await db.update(musicReleases).set({ status: 'taken_down' }).where(eq(musicReleases.id, releaseDraft.release.id));
  const takenDownUsage = await classificationService.getStorageUsage({ performerId: classificationWorkspace.performer.id });
  assert.equal(takenDownUsage.releaseProtectedBytes, readyProtectedBytes);
  assert.equal(
    takenDownUsage.sealedWorkingBytes,
    spareMaster.byteSize + restrictedDocument.byteSize + dealDocument.byteSize + laterArtwork.byteSize
  );
  assert.equal(takenDownUsage.workingObjectCount, 4);

  // Release creation remains unlimited even when unprotected working bytes are
  // already over the constructor's one-byte workspace ceiling.
  const noCountCapService = createAudioPublishingService({ db, store, workspaceLimitBytes: 1 });
  const releaseCountBefore = (await db.select({ id: musicReleases.id })
    .from(musicReleases)
    .where(eq(musicReleases.performerId, classificationWorkspace.performer.id))).length;
  for (let index = 0; index < 12; index += 1) {
    const result = await noCountCapService.createReleaseDraft({
      clientReleaseId: randomUUID(),
      performerId: classificationWorkspace.performer.id,
      actorUserId: classificationWorkspace.ownerUserId,
      projectId: classificationWorkspace.project.id,
      masterAssetVersionId: spareMaster.id,
      title: `Unlimited release ${index + 1}`,
      trackTitle: `Unlimited track ${index + 1}`,
      primaryArtistName: 'Classification performer',
      releaseType: 'single',
      territories: ['US'],
      languageCode: 'en'
    });
    assert.equal(result.created, true);
  }
  const releaseCountAfter = (await db.select({ id: musicReleases.id })
    .from(musicReleases)
    .where(eq(musicReleases.performerId, classificationWorkspace.performer.id))).length;
  assert.equal(releaseCountAfter, releaseCountBefore + 12);
  const unlimitedUsage = await noCountCapService.getStorageUsage({ performerId: classificationWorkspace.performer.id });
  assert.equal(unlimitedUsage.releaseCountLimit, null);
  assert.equal(
    unlimitedUsage.sealedWorkingBytes,
    spareMaster.byteSize + restrictedDocument.byteSize + dealDocument.byteSize + laterArtwork.byteSize,
    'Draft attachments, provisional deals, and restricted status must not graduate bytes.'
  );
  assert.equal(unlimitedUsage.workingObjectCount, 4);

  // Mutable delivery state never protects storage by itself. A future delivery
  // integration must append an exact immutable package manifest from the
  // coupled provider-submission event before these bytes can graduate.
  const deliveryWorkspace = await createPerformerWorkspace(classificationService, 'delivery');
  const deliveryMaster = await sealFile(classificationService, deliveryWorkspace, {
    filename: 'delivery-master.wav', assetKind: 'master_audio', mimeType: 'audio/wav', body: wavBody('delivery master', 67)
  });
  const deliveryArtwork = await sealFile(classificationService, deliveryWorkspace, {
    filename: 'delivery-art.png', assetKind: 'artwork', mimeType: 'image/png', body: pngBody('delivery artwork')
  });
  const deliveryRelease = await classificationService.createReleaseDraft({
    clientReleaseId: randomUUID(),
    performerId: deliveryWorkspace.performer.id,
    actorUserId: deliveryWorkspace.ownerUserId,
    projectId: deliveryWorkspace.project.id,
    masterAssetVersionId: deliveryMaster.id,
    title: 'Delivery lifecycle release',
    trackTitle: 'Delivery lifecycle track',
    primaryArtistName: 'Delivery performer',
    releaseType: 'single',
    territories: ['US'],
    languageCode: 'en'
  });
  await db.update(musicReleases)
    .set({ artworkAssetVersionId: deliveryArtwork.id })
    .where(eq(musicReleases.id, deliveryRelease.release.id));
  const deliveryFingerprint = sha256(Buffer.from('delivery-package-v1'));
  const delivery = await createDelivery(deliveryWorkspace, deliveryRelease.release.id, deliveryFingerprint);
  await transitionDelivery(deliveryWorkspace, delivery.id, 'queued');
  const queuedUsage = await classificationService.getStorageUsage({ performerId: deliveryWorkspace.performer.id });
  assert.equal(queuedUsage.releaseProtectedBytes, 0, 'Queued planning must not graduate release bytes.');
  await transitionDelivery(deliveryWorkspace, delivery.id, 'submitted', {
    providerReleaseId: 'provider-release-proof',
    payloadSha256: deliveryFingerprint
  });
  const submittedUsage = await classificationService.getStorageUsage({ performerId: deliveryWorkspace.performer.id });
  assert.equal(submittedUsage.releaseProtectedBytes, 0, 'Submitted status alone must not graduate release bytes.');
  assert.equal(submittedUsage.sealedWorkingBytes, deliveryMaster.byteSize + deliveryArtwork.byteSize);

  // MIME and signature gates reject arbitrary-storage disguises before any
  // provider bytes are written. Unsupported combinations fail before begin.
  const guardService = createAudioPublishingService({ db, store, workspaceLimitBytes: 30 * MIB });
  const guardWorkspace = await createPerformerWorkspace(guardService, 'guards');
  const beginBeforeUnsupported = store.beginCount;
  const assetsBeforeUnsupported = await countProjectRows(audioAssets, guardWorkspace.project.id);
  for (const unsupported of [
    { assetKind: 'session', mimeType: 'application/zip', filename: 'session.zip', body: Buffer.from('PK arbitrary') },
    {
      assetKind: 'document',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: 'terms.docx',
      body: Buffer.from('PK arbitrary')
    },
    { assetKind: 'master_audio', mimeType: 'application/octet-stream', filename: 'blob.bin', body: Buffer.from('blob') }
  ]) {
    await assert.rejects(guardService.initiateUpload({
      projectId: guardWorkspace.project.id,
      actorUserId: guardWorkspace.ownerUserId,
      title: unsupported.filename,
      assetKind: unsupported.assetKind,
      originalFilename: unsupported.filename,
      mimeType: unsupported.mimeType,
      expectedByteSize: unsupported.body.byteLength,
      expectedSha256: sha256(unsupported.body),
      idempotencyKey: `unsupported:${unsupported.filename}`
    }), /Unsupported audio asset kind\/MIME combination/);
  }
  assert.equal(store.beginCount, beginBeforeUnsupported);
  assert.equal(await countProjectRows(audioAssets, guardWorkspace.project.id), assetsBeforeUnsupported);

  for (const invalidWav of [
    Buffer.from('{"not":"audio"}'),
    Buffer.from('RIFF not actually a WAVE file')
  ]) {
    const session = await guardService.initiateUpload({
      projectId: guardWorkspace.project.id,
      actorUserId: guardWorkspace.ownerUserId,
      title: `disguised-${randomUUID()}.wav`,
      assetKind: 'master_audio',
      originalFilename: 'disguised.wav',
      mimeType: 'audio/wav',
      expectedByteSize: invalidWav.byteLength,
      expectedSha256: sha256(invalidWav),
      idempotencyKey: `disguised:${randomUUID()}`
    });
    const writesBeforeSignatureDenial = store.writeCount;
    await assert.rejects(guardService.writeUploadPart({
      uploadSessionId: session.id,
      actorUserId: guardWorkspace.ownerUserId,
      partNumber: 1,
      body: invalidWav
    }), /does not match declared master_audio MIME type audio\/wav/);
    assert.equal(store.writeCount, writesBeforeSignatureDenial);
  }

  const prefixedJunk = Buffer.alloc(96, 0x4a);
  prefixedJunk.write('RIFF', 0, 'ascii');
  prefixedJunk.writeUInt32LE(prefixedJunk.byteLength - 8, 4);
  prefixedJunk.write('WAVE', 8, 'ascii');
  const prefixedJunkVersion = await sealFile(guardService, guardWorkspace, {
    filename: 'valid-prefix-junk.wav',
    assetKind: 'master_audio',
    mimeType: 'audio/wav',
    body: prefixedJunk
  });
  await assert.rejects(
    guardService.validateReleasePackageAsset({
      version: prefixedJunkVersion,
      roles: [`recording_master:${randomUUID()}`]
    }),
    /did not parse as complete playable audio/i
  );

  // Exact part geometry prevents a tiny reservation from becoming large
  // staging storage and rejects every malformed part before store.writePart.
  const finalPart = Buffer.from('1234567');
  const exactFirstPart = Buffer.alloc(DEFAULT_PART_SIZE, 0x41);
  exactFirstPart.write('RIFF', 0, 'ascii');
  exactFirstPart.write('WAVE', 8, 'ascii');
  const geometryBody = Buffer.concat([exactFirstPart, finalPart]);
  const geometrySession = await guardService.initiateUpload({
    projectId: guardWorkspace.project.id,
    actorUserId: guardWorkspace.ownerUserId,
    title: 'geometry.wav',
    assetKind: 'master_audio',
    originalFilename: 'geometry.wav',
    mimeType: 'audio/wav',
    expectedByteSize: geometryBody.byteLength,
    expectedSha256: sha256(geometryBody),
    idempotencyKey: 'geometry-proof',
    partSizeBytes: DEFAULT_PART_SIZE
  });
  const writesBeforeGeometryDenials = store.writeCount;
  await assert.rejects(guardService.writeUploadPart({
    uploadSessionId: geometrySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    partNumber: 1,
    body: exactFirstPart.subarray(0, exactFirstPart.length - 1)
  }), /must contain exactly 5242880 bytes/);
  await assert.rejects(guardService.writeUploadPart({
    uploadSessionId: geometrySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    partNumber: 1,
    body: Buffer.concat([exactFirstPart, Buffer.from('x')])
  }), /must contain exactly 5242880 bytes/);
  await assert.rejects(guardService.writeUploadPart({
    uploadSessionId: geometrySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    partNumber: 3,
    body: Buffer.from('x')
  }), /partNumber must be from 1 through 2/);
  await assert.rejects(guardService.writeUploadPart({
    uploadSessionId: geometrySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    partNumber: 2,
    body: finalPart
  }), /part 1 must pass file-signature validation/i);
  assert.equal(store.writeCount, writesBeforeGeometryDenials);

  await guardService.writeUploadPart({
    uploadSessionId: geometrySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    partNumber: 1,
    body: exactFirstPart
  });
  const writesAfterFirstPart = store.writeCount;
  await assert.rejects(guardService.writeUploadPart({
    uploadSessionId: geometrySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    partNumber: 2,
    body: finalPart.subarray(0, finalPart.length - 1)
  }), /must contain exactly 7 bytes/);
  await assert.rejects(guardService.writeUploadPart({
    uploadSessionId: geometrySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    partNumber: 2,
    body: Buffer.concat([finalPart, Buffer.from('x')])
  }), /must contain exactly 7 bytes/);
  assert.equal(store.writeCount, writesAfterFirstPart);
  await guardService.writeUploadPart({
    uploadSessionId: geometrySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    partNumber: 2,
    body: finalPart
  });
  await guardService.completeAndSealUpload({
    uploadSessionId: geometrySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    performerId: guardWorkspace.performer.id
  });

  const oneByteSession = await guardService.initiateUpload({
    projectId: guardWorkspace.project.id,
    actorUserId: guardWorkspace.ownerUserId,
    title: 'one-byte.txt',
    assetKind: 'document',
    originalFilename: 'one-byte.txt',
    mimeType: 'text/plain',
    expectedByteSize: 1,
    expectedSha256: sha256(Buffer.from('x')),
    idempotencyKey: 'one-byte-geometry-proof'
  });
  const writesBeforeOneByteBypass = store.writeCount;
  await assert.rejects(guardService.writeUploadPart({
    uploadSessionId: oneByteSession.id,
    actorUserId: guardWorkspace.ownerUserId,
    partNumber: 2,
    body: Buffer.alloc(DEFAULT_PART_SIZE, 0x78)
  }), /partNumber must be from 1 through 1/);
  assert.equal(store.writeCount, writesBeforeOneByteBypass);

  // Completion and stale cleanup share the upload-session row lock. A second
  // completion and an expiry sweep started while assembly is in flight must
  // observe the one sealed version after commit, never delete its object.
  const sealingRaceWorkspace = await createPerformerWorkspace(guardService, 'sealing-cleanup-race');
  const sealingRaceBody = wavBody('sealing cleanup race', 1_200);
  const sealingRaceSession = await guardService.initiateUpload({
    projectId: sealingRaceWorkspace.project.id,
    actorUserId: sealingRaceWorkspace.ownerUserId,
    title: 'sealing-cleanup-race.wav',
    assetKind: 'master_audio',
    originalFilename: 'sealing-cleanup-race.wav',
    mimeType: 'audio/wav',
    expectedByteSize: sealingRaceBody.byteLength,
    expectedSha256: sha256(sealingRaceBody),
    idempotencyKey: 'sealing-cleanup-race-proof'
  });
  await guardService.writeUploadPart({
    uploadSessionId: sealingRaceSession.id,
    actorUserId: sealingRaceWorkspace.ownerUserId,
    partNumber: 1,
    body: sealingRaceBody
  });
  let signalAssemblyStarted;
  const assemblyStarted = new Promise((resolve) => { signalAssemblyStarted = resolve; });
  store.assembleDelayMs = 100;
  store.onAssembleStart = () => {
    store.onAssembleStart = null;
    signalAssemblyStarted();
  };
  const assembleBeforeSealingRace = store.assembleCount;
  const firstCompletion = guardService.completeAndSealUpload({
    uploadSessionId: sealingRaceSession.id,
    actorUserId: sealingRaceWorkspace.ownerUserId,
    performerId: sealingRaceWorkspace.performer.id
  });
  await Promise.race([
    assemblyStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Sealing race assembly did not start.')), 2_000))
  ]);
  const secondCompletion = guardService.completeAndSealUpload({
    uploadSessionId: sealingRaceSession.id,
    actorUserId: sealingRaceWorkspace.ownerUserId,
    performerId: sealingRaceWorkspace.performer.id
  });
  const cleanupDuringCompletion = guardService.expireStaleUploadSessions({
    limit: 500,
    now: new Date(sealingRaceSession.expiresAt.getTime() + 1)
  });
  const [sealedFirst, sealedSecond, sealingRaceCleanup] = await Promise.all([
    firstCompletion,
    secondCompletion,
    cleanupDuringCompletion
  ]);
  store.assembleDelayMs = 0;
  store.onAssembleStart = null;
  assert.equal(sealedFirst.id, sealedSecond.id, 'Concurrent completion must reuse the one immutable version.');
  assert.equal(store.assembleCount, assembleBeforeSealingRace + 1);
  assert.equal(store.discardedUploadIds.includes(sealingRaceSession.id), false);
  assert.equal(store.abortedUploadIds.includes(sealingRaceSession.id), false);
  assert.equal(
    sealingRaceCleanup.failures.some((failure) => failure.uploadSessionId === sealingRaceSession.id),
    false
  );
  assert.equal(
    sealingRaceCleanup.expiredSessionIds.includes(sealingRaceSession.id)
      || sealingRaceCleanup.staleAbortedSessionIds.includes(sealingRaceSession.id),
    false,
    'Cleanup must not transition a session that sealed while its row lock was held.'
  );
  const [completedSealingRace] = await db.select({ uploadStatus: audioUploadSessions.uploadStatus })
    .from(audioUploadSessions)
    .where(eq(audioUploadSessions.id, sealingRaceSession.id));
  assert.equal(completedSealingRace.uploadStatus, 'completed');
  assert.equal(store.objects.has(sealingRaceSession.storageKey), true);
  assert.equal(
    (await db.select({ id: audioProjectAssetVersions.id })
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.uploadSessionId, sealingRaceSession.id))).length,
    1
  );

  // A post-assembly integrity failure may leave provider bytes. Failed
  // immediate discard keeps the session quarantined and charged; the stale
  // worker retries until both provider cleanup and a terminal transition pass.
  const integrityBody = wavBody('integrity-discard', 96);
  const integritySession = await guardService.initiateUpload({
    projectId: guardWorkspace.project.id,
    actorUserId: guardWorkspace.ownerUserId,
    title: 'integrity-discard.wav',
    assetKind: 'master_audio',
    originalFilename: 'integrity-discard.wav',
    mimeType: 'audio/wav',
    expectedByteSize: integrityBody.byteLength,
    expectedSha256: sha256(integrityBody),
    idempotencyKey: 'integrity-discard-proof'
  });
  await guardService.writeUploadPart({
    uploadSessionId: integritySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    partNumber: 1,
    body: integrityBody
  });
  store.integrityFailuresRemaining.set(integritySession.providerUploadId, 1);
  store.abortFailuresRemaining.set(integritySession.providerUploadId, 1);
  await assert.rejects(guardService.completeAndSealUpload({
    uploadSessionId: integritySession.id,
    actorUserId: guardWorkspace.ownerUserId,
    performerId: guardWorkspace.performer.id
  }), /forced post-assembly hash failure/);
  const [quarantinedIntegrity] = await db.select().from(audioUploadSessions)
    .where(eq(audioUploadSessions.id, integritySession.id));
  assert.equal(quarantinedIntegrity.uploadStatus, 'quarantined');
  assert.equal(store.objects.has(integritySession.storageKey), true);
  const [integrityAudit] = await db.select().from(auditEvents).where(and(
    eq(auditEvents.entityType, 'audio_upload_session'),
    eq(auditEvents.entityId, integritySession.id),
    eq(auditEvents.eventType, 'audio_upload_session.integrity_failed')
  ));
  assert.equal(integrityAudit.metadata.providerDiscardSucceeded, false);
  const afterIntegrityExpiry = new Date(integritySession.expiresAt.getTime() + 1);
  const usageWithStaleQuarantine = await guardService.getStorageUsage({
    performerId: guardWorkspace.performer.id
  });
  store.abortFailuresRemaining.set(integritySession.providerUploadId, 1);
  const failedQuarantineCleanup = await guardService.expireStaleUploadSessions({
    limit: 500,
    now: afterIntegrityExpiry
  });
  assert.equal(failedQuarantineCleanup.failedCount, 1);
  const usageAfterFailedQuarantineCleanup = await guardService.getStorageUsage({
    performerId: guardWorkspace.performer.id
  });
  assert.ok(usageAfterFailedQuarantineCleanup.reservedBytes >= integrityBody.byteLength);
  assert.ok(usageAfterFailedQuarantineCleanup.workingObjectCount >= 1);
  const [stillQuarantinedIntegrity] = await db.select().from(audioUploadSessions)
    .where(eq(audioUploadSessions.id, integritySession.id));
  assert.equal(stillQuarantinedIntegrity.uploadStatus, 'quarantined');
  const retriedQuarantineCleanup = await guardService.expireStaleUploadSessions({
    limit: 500,
    now: afterIntegrityExpiry
  });
  assert.equal(retriedQuarantineCleanup.staleAbortedCount, 1);
  const [abortedIntegrity] = await db.select().from(audioUploadSessions)
    .where(eq(audioUploadSessions.id, integritySession.id));
  assert.equal(abortedIntegrity.uploadStatus, 'aborted');
  assert.equal(store.objects.has(integritySession.storageKey), false);
  assert.equal(store.uploads.has(integritySession.providerUploadId), false);
  const usageAfterQuarantineCleanup = await guardService.getStorageUsage({
    performerId: guardWorkspace.performer.id
  });
  assert.ok(usageAfterQuarantineCleanup.reservedBytes < usageWithStaleQuarantine.reservedBytes);

  // Stale cleanup retries provider discard without changing state or auditing a
  // failure. Successful retry marks supported states expired. The existing DB
  // transition law requires stale verifying rows to become aborted instead.
  const versionsBeforeCleanup = (await db.select({ id: audioProjectAssetVersions.id })
    .from(audioProjectAssetVersions)).length;
  const staleUploading = await createStaleSession(guardWorkspace, 'uploading');
  store.abortFailuresRemaining.set(staleUploading.identity.providerUploadId, 1);
  const firstCleanup = await guardService.expireStaleUploadSessions({ limit: 1 });
  assert.equal(firstCleanup.expiredCount, 0);
  assert.equal(firstCleanup.failedCount, 1);
  assert.match(firstCleanup.failures[0].error, /forced provider discard failure/);
  const [afterFailedAbort] = await db.select({ uploadStatus: audioUploadSessions.uploadStatus })
    .from(audioUploadSessions)
    .where(eq(audioUploadSessions.id, staleUploading.sessionId));
  assert.equal(afterFailedAbort.uploadStatus, 'uploading');
  const usageAfterFailedCleanup = await guardService.getStorageUsage({
    performerId: guardWorkspace.performer.id
  });
  assert.ok(
    usageAfterFailedCleanup.reservedBytes >= 1,
    'Expired nonterminal reservations must remain charged until provider cleanup succeeds.'
  );
  assert.equal((await db.select().from(auditEvents).where(and(
    eq(auditEvents.entityType, 'audio_upload_session'),
    eq(auditEvents.entityId, staleUploading.sessionId)
  ))).length, 0);

  const retryCleanup = await guardService.expireStaleUploadSessions({ limit: 1 });
  assert.equal(retryCleanup.expiredCount, 1);
  assert.deepEqual(retryCleanup.expiredSessionIds, [staleUploading.sessionId]);
  const [afterSuccessfulAbort] = await db.select({ uploadStatus: audioUploadSessions.uploadStatus })
    .from(audioUploadSessions)
    .where(eq(audioUploadSessions.id, staleUploading.sessionId));
  assert.equal(afterSuccessfulAbort.uploadStatus, 'expired');
  const usageAfterSuccessfulCleanup = await guardService.getStorageUsage({
    performerId: guardWorkspace.performer.id
  });
  assert.ok(
    usageAfterSuccessfulCleanup.reservedBytes < usageAfterFailedCleanup.reservedBytes,
    'Quota may reopen only after provider cleanup and a terminal session transition succeed.'
  );
  const [expiryAudit] = await db.select().from(auditEvents).where(and(
    eq(auditEvents.entityType, 'audio_upload_session'),
    eq(auditEvents.entityId, staleUploading.sessionId),
    eq(auditEvents.eventType, 'audio_upload_session.expired')
  ));
  assert.equal(expiryAudit.nextStatus, 'expired');
  assert.equal(expiryAudit.metadata.providerDiscardSucceeded, true);

  const staleVerifying = await createStaleSession(guardWorkspace, 'verifying');
  const verifyingCleanup = await guardService.expireStaleUploadSessions({ limit: 1 });
  assert.equal(verifyingCleanup.staleAbortedCount, 1);
  assert.deepEqual(verifyingCleanup.staleAbortedSessionIds, [staleVerifying.sessionId]);
  const [afterVerifyingAbort] = await db.select({ uploadStatus: audioUploadSessions.uploadStatus })
    .from(audioUploadSessions)
    .where(eq(audioUploadSessions.id, staleVerifying.sessionId));
  assert.equal(afterVerifyingAbort.uploadStatus, 'aborted');
  const [staleAbortAudit] = await db.select().from(auditEvents).where(and(
    eq(auditEvents.entityType, 'audio_upload_session'),
    eq(auditEvents.entityId, staleVerifying.sessionId),
    eq(auditEvents.eventType, 'audio_upload_session.stale_abort')
  ));
  assert.equal(staleAbortAudit.previousStatus, 'verifying');
  assert.equal(staleAbortAudit.nextStatus, 'aborted');
  assert.equal(
    (await db.select({ id: audioProjectAssetVersions.id }).from(audioProjectAssetVersions)).length,
    versionsBeforeCleanup,
    'Stale multipart cleanup must never delete sealed originals.'
  );

  const sealedBodyBeforeCleanupGuard = Buffer.from(store.objects.get(master.storageKey));
  const staleSealedIdentity = await createStaleSession(classificationWorkspace, 'uploading', {
    storageProvider: master.storageProvider,
    storageBucket: master.storageBucket,
    storageKey: master.storageKey
  });
  const sealedGuardCleanup = await guardService.expireStaleUploadSessions({ limit: 500 });
  const sealedGuardFailure = sealedGuardCleanup.failures.find(
    (failure) => failure.uploadSessionId === staleSealedIdentity.sessionId
  );
  assert.ok(sealedGuardFailure, 'Cleanup must refuse a storage identity already bound to a sealed version.');
  assert.match(sealedGuardFailure.error, /Refusing to discard an object referenced by a sealed preserved asset version/);
  const [stillReservedAgainstSealed] = await db.select({ uploadStatus: audioUploadSessions.uploadStatus })
    .from(audioUploadSessions)
    .where(eq(audioUploadSessions.id, staleSealedIdentity.sessionId));
  assert.equal(stillReservedAgainstSealed.uploadStatus, 'uploading');
  assert.deepEqual(store.objects.get(master.storageKey), sealedBodyBeforeCleanupGuard);

  console.log(
    `Audio storage policy integration passed on ${proof.kind}: default/config validation, `
    + 'performer-lock byte/object concurrency, synchronized idempotent replay, denied side-effect absence, exact usage JSON, '
    + 'immutable release manifests, status-forgery resistance, exact rights-document cardinality, takedown retention, '
    + 'unlimited releases, MIME/signature/archive bypass denial, completed-object media parsing, exact multipart geometry, '
    + 'completion/cleanup race fencing, integrity cleanup retry/audit, and sealed-object cleanup refusal.'
  );
} finally {
  await proof.close();
}
