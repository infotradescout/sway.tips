import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { and, eq, sql } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client.ts';
import {
  audioFileAccessGrants,
  audioFileConnections,
  audioProjectAccessGrants,
  audioShareGrants,
  audioReviewEvents,
  auditEvents,
  musicRecordingCredits,
  musicRecordings,
  musicReleases,
  musicReleaseStorageManifests,
  musicRightsDeclarationEvents,
  musicRightsDeclarations,
  performers,
  users
} from '../src/db/schema.ts';
import { createLocalAudioObjectStore } from '../src/server/audio-object-storage-local.ts';
import { createAudioFileCollaborationService } from '../src/server/audio-file-collaboration-service.ts';
import { createAudioFilePairingService } from '../src/server/audio-file-pairing-service.ts';
import { createAudioPublishingService } from '../src/server/audio-publishing-service.ts';
import { assertDisposableDatabaseTarget } from './lib/disposable-database-guard.mjs';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const embeddedRequested = process.argv.includes('--embedded-postgres');
const configuredDatabaseUrl = process.env.DATABASE_URL?.trim();
if (embeddedRequested && configuredDatabaseUrl) {
  throw new Error('Embedded audio collaboration proof refuses generic DATABASE_URL.');
}
if (!embeddedRequested && process.env.SWAY_DISPOSABLE_MIGRATION_PROOF !== '1') {
  throw new Error('Configured audio collaboration integration requires SWAY_DISPOSABLE_MIGRATION_PROOF=1.');
}
const embeddedProof = embeddedRequested
  ? await startEmbeddedPostgresProof('audio_file_collaboration')
  : null;
const databaseUrl = embeddedProof?.databaseUrl || configuredDatabaseUrl;
if (!databaseUrl) throw new Error('A disposable collaboration database is required.');
assertDisposableDatabaseTarget({ databaseUrl, approval: 'true', label: 'Audio collaboration integration proof' });

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function wavFixture(label) {
  const dataSize = 800;
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

function pngFixture() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
}

const db = createSwayDb(databaseUrl);
const objectRoot = mkdtempSync(join(tmpdir(), 'sway-file-collaboration-'));

try {
  if (!embeddedProof) await migrate(db, { migrationsFolder: 'drizzle' });

  const actorIds = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID()
  ].sort();
  const [
    ownerId,
    reviewerId,
    outsiderId,
    noAccessUserId,
    expiredReviewerId,
    nonGrantorManagerId
  ] = actorIds;
  await db.insert(users).values([
    { id: ownerId, email: `owner-${ownerId}@example.test`, emailVerifiedAt: new Date() },
    { id: reviewerId, email: `reviewer-${reviewerId}@example.test`, emailVerifiedAt: new Date() },
    { id: outsiderId, email: `outsider-${outsiderId}@example.test`, emailVerifiedAt: new Date() },
    { id: noAccessUserId, email: `no-access-${noAccessUserId}@example.test`, emailVerifiedAt: new Date() },
    { id: expiredReviewerId, email: `expired-reviewer-${expiredReviewerId}@example.test`, emailVerifiedAt: new Date() },
    { id: nonGrantorManagerId, email: `non-grantor-manager-${nonGrantorManagerId}@example.test`, emailVerifiedAt: new Date() }
  ]);
  const [performer] = await db.insert(performers).values({
    ownerUserId: ownerId,
    displayName: 'Collaboration proof'
  }).returning();

  const localStore = createLocalAudioObjectStore({
    SWAY_AUDIO_LOCAL_OBJECT_DIR: objectRoot,
    SWAY_AUDIO_LOCAL_BUCKET: 'collaboration-proof'
  });
  let openOriginalCount = 0;
  let failNextOriginalOpen = false;
  let waitAfterOriginalOpen = null;
  const openedOriginalStreams = [];
  const countedStore = {
    ...localStore,
    async openOriginal(identity) {
      openOriginalCount += 1;
      if (failNextOriginalOpen) {
        failNextOriginalOpen = false;
        throw new Error('forced object storage open failure');
      }
      const object = await localStore.openOriginal(identity);
      openedOriginalStreams.push(object.stream);
      if (waitAfterOriginalOpen) await waitAfterOriginalOpen();
      return object;
    }
  };
  await countedStore.verifyReady();

  const publishing = createAudioPublishingService({ db, store: countedStore });
  const project = await publishing.createProject({
    performerId: performer.id,
    actorUserId: ownerId,
    title: 'Selected file collaboration proof'
  });
  const [connection] = await db.insert(audioFileConnections).values({
    memberOneUserId: ownerId,
    memberTwoUserId: reviewerId,
    createdByUserId: ownerId,
    createdFromPurpose: 'send_files'
  }).returning();
  await db.insert(audioProjectAccessGrants).values({
    projectId: project.id,
    granteeUserId: nonGrantorManagerId,
    role: 'collaborator',
    canComment: true,
    canManageAccess: true,
    grantedByUserId: ownerId
  });
  const reviewerGrant = await publishing.grantReleaseReviewer({
    projectId: project.id,
    connectionId: connection.id,
    actorUserId: ownerId
  });
  assert.equal(reviewerGrant.reviewerUserId, reviewerId);
  assert.equal(reviewerGrant.grant.canApprove, true);
  assert.equal(reviewerGrant.grant.canManageRelease, false, 'Rights review must not grant release-management authority.');
  const repeatedReviewerGrant = await publishing.grantReleaseReviewer({
    projectId: project.id,
    connectionId: connection.id,
    actorUserId: ownerId
  });
  assert.equal(repeatedReviewerGrant.reused, true);
  assert.equal(repeatedReviewerGrant.grant.id, reviewerGrant.grant.id);

  const [outsiderConnection] = await db.insert(audioFileConnections).values({
    memberOneUserId: ownerId,
    memberTwoUserId: outsiderId,
    createdByUserId: ownerId,
    createdFromPurpose: 'send_files'
  }).returning();
  const [expiredGrant] = await db.insert(audioProjectAccessGrants).values({
    projectId: project.id,
    granteeUserId: outsiderId,
    role: 'collaborator',
    canDownloadOriginals: true,
    canComment: true,
    grantedByUserId: ownerId,
    expiresAt: new Date(Date.now() - 60_000)
  }).returning();
  await db.insert(audioProjectAccessGrants).values({
    projectId: project.id,
    granteeUserId: expiredReviewerId,
    role: 'reviewer',
    canApprove: true,
    canManageAccess: true,
    grantedByUserId: ownerId,
    expiresAt: new Date(Date.now() - 60_000)
  });
  const [expiredManagerConnection] = await db.insert(audioFileConnections).values({
    memberOneUserId: ownerId,
    memberTwoUserId: expiredReviewerId,
    createdByUserId: ownerId,
    createdFromPurpose: 'send_files'
  }).returning();
  await assert.rejects(
    publishing.listProjectAssets({ projectId: project.id, actorUserId: outsiderId }),
    /Project access required/
  );
  const renewedReviewerGrant = await publishing.grantReleaseReviewer({
    projectId: project.id,
    connectionId: outsiderConnection.id,
    actorUserId: ownerId
  });
  assert.equal(renewedReviewerGrant.reused, false);
  assert.equal(renewedReviewerGrant.replaced, true);
  assert.equal(renewedReviewerGrant.grant.canApprove, true);
  assert.equal(renewedReviewerGrant.grant.canDownloadOriginals, true, 'Replacement must preserve existing permissions.');
  assert.equal(renewedReviewerGrant.grant.canManageRelease, false);
  assert.equal(renewedReviewerGrant.grant.expiresAt, null);
  assert.ok((await db.select().from(audioProjectAccessGrants).where(eq(audioProjectAccessGrants.id, expiredGrant.id)))[0].revokedAt);
  const body = wavFixture('selected-file collaboration exact original proof');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const upload = await publishing.initiateUpload({
    projectId: project.id,
    actorUserId: ownerId,
    title: 'collaboration-proof.wav',
    assetKind: 'master_audio',
    originalFilename: 'collaboration-proof.wav',
    mimeType: 'audio/wav',
    expectedByteSize: body.byteLength,
    expectedSha256: sha256,
    idempotencyKey: `collaboration-proof:${sha256}`
  });
  await publishing.writeUploadPart({
    uploadSessionId: upload.id,
    actorUserId: ownerId,
    partNumber: 1,
    body
  });
  const version = await publishing.completeAndSealUpload({
    uploadSessionId: upload.id,
    actorUserId: ownerId,
    performerId: performer.id
  });

  const oneTimeShare = await publishing.createShareGrant({
    versionId: version.id,
    actorUserId: ownerId,
    maxUses: 1,
    recipientLabel: 'single-use recovery proof'
  });
  const oneTimeDownloadAuditWhere = and(
    eq(auditEvents.entityType, 'audio_share_grant'),
    eq(auditEvents.entityId, oneTimeShare.grant.id),
    eq(auditEvents.eventType, 'audio_share_grant.download')
  );
  failNextOriginalOpen = true;
  await assert.rejects(
    publishing.downloadSharedOriginal({ rawToken: oneTimeShare.rawToken, actorUserId: ownerId }),
    /forced object storage open failure/
  );
  assert.equal(
    (await db.select({ useCount: audioShareGrants.useCount })
      .from(audioShareGrants)
      .where(eq(audioShareGrants.id, oneTimeShare.grant.id)))[0]?.useCount,
    0,
    'A storage-provider failure must not consume the only permitted download.'
  );
  assert.equal(
    (await db.select().from(auditEvents).where(oneTimeDownloadAuditWhere)).length,
    0,
    'A storage-provider failure must not record a completed download.'
  );

  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION sway_test_reject_share_download_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $test$
    BEGIN
      IF NEW.event_type = 'audio_share_grant.download' THEN
        RAISE EXCEPTION 'forced share download audit failure';
      END IF;
      RETURN NEW;
    END;
    $test$
  `));
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS sway_test_reject_share_download_audit_trigger ON audit_events'));
  await db.execute(sql.raw(`
    CREATE TRIGGER sway_test_reject_share_download_audit_trigger
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION sway_test_reject_share_download_audit()
  `));
  const failedAuditStreamIndex = openedOriginalStreams.length;
  try {
    await assert.rejects(
      publishing.downloadSharedOriginal({ rawToken: oneTimeShare.rawToken, actorUserId: ownerId }),
      (error) => {
        assert.match(`${error?.message || ''} ${error?.cause?.message || ''}`, /forced share download audit failure/);
        return true;
      }
    );
  } finally {
    await db.execute(sql.raw('DROP TRIGGER IF EXISTS sway_test_reject_share_download_audit_trigger ON audit_events'));
    await db.execute(sql.raw('DROP FUNCTION IF EXISTS sway_test_reject_share_download_audit()'));
  }
  assert.equal(openedOriginalStreams[failedAuditStreamIndex]?.destroyed, true, 'Rolled-back downloads must close the opened object stream.');
  assert.equal(
    (await db.select({ useCount: audioShareGrants.useCount })
      .from(audioShareGrants)
      .where(eq(audioShareGrants.id, oneTimeShare.grant.id)))[0]?.useCount,
    0,
    'A failed audit write must roll back the use increment.'
  );
  assert.equal((await db.select().from(auditEvents).where(oneTimeDownloadAuditWhere)).length, 0);

  const oneTimeDownload = await publishing.downloadSharedOriginal({
    rawToken: oneTimeShare.rawToken,
    actorUserId: ownerId
  });
  assert.deepEqual(await streamToBuffer(oneTimeDownload.stream), body);
  assert.equal(oneTimeDownload.version.sha256, sha256);
  assert.equal(
    (await db.select({ useCount: audioShareGrants.useCount })
      .from(audioShareGrants)
      .where(eq(audioShareGrants.id, oneTimeShare.grant.id)))[0]?.useCount,
    1
  );
  assert.equal((await db.select().from(auditEvents).where(oneTimeDownloadAuditWhere)).length, 1);
  const exhaustedOpenBaseline = openOriginalCount;
  await assert.rejects(
    publishing.downloadSharedOriginal({ rawToken: oneTimeShare.rawToken, actorUserId: ownerId }),
    /Share grant exhausted/
  );
  assert.equal(openOriginalCount, exhaustedOpenBaseline, 'An exhausted token must fail before object storage.');

  const concurrentShare = await publishing.createShareGrant({
    versionId: version.id,
    actorUserId: ownerId,
    maxUses: 1,
    recipientLabel: 'concurrent single-use proof'
  });
  let concurrentOpenArrivals = 0;
  let releaseConcurrentOpens = () => {};
  const concurrentOpensReleased = new Promise((resolve) => {
    releaseConcurrentOpens = resolve;
  });
  waitAfterOriginalOpen = async () => {
    concurrentOpenArrivals += 1;
    if (concurrentOpenArrivals === 2) releaseConcurrentOpens();
    await concurrentOpensReleased;
  };
  const concurrentStreamBaseline = openedOriginalStreams.length;
  let concurrentAttempts;
  const concurrentBarrierTimeout = setTimeout(releaseConcurrentOpens, 5_000);
  try {
    concurrentAttempts = await Promise.allSettled([
      publishing.downloadSharedOriginal({ rawToken: concurrentShare.rawToken, actorUserId: ownerId }),
      publishing.downloadSharedOriginal({ rawToken: concurrentShare.rawToken, actorUserId: ownerId })
    ]);
  } finally {
    clearTimeout(concurrentBarrierTimeout);
    waitAfterOriginalOpen = null;
  }
  assert.equal(concurrentOpenArrivals, 2, 'Both concurrent attempts must reach the storage-open barrier.');
  assert.equal(concurrentAttempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(concurrentAttempts.filter((attempt) => attempt.status === 'rejected').length, 1);
  assert.equal(
    openedOriginalStreams.slice(concurrentStreamBaseline).filter((stream) => stream.destroyed).length,
    1,
    'The losing concurrent attempt must close its opened object stream.'
  );
  const concurrentSuccess = concurrentAttempts.find((attempt) => attempt.status === 'fulfilled');
  assert.deepEqual(await streamToBuffer(concurrentSuccess.value.stream), body);
  assert.match(
    String(concurrentAttempts.find((attempt) => attempt.status === 'rejected').reason),
    /Share grant could not be consumed/
  );
  assert.equal(
    (await db.select({ useCount: audioShareGrants.useCount })
      .from(audioShareGrants)
      .where(eq(audioShareGrants.id, concurrentShare.grant.id)))[0]?.useCount,
    1,
    'Concurrent one-time downloads must consume exactly one use.'
  );
  assert.equal(
    (await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityType, 'audio_share_grant'),
      eq(auditEvents.entityId, concurrentShare.grant.id),
      eq(auditEvents.eventType, 'audio_share_grant.download')
    ))).length,
    1,
    'Concurrent one-time downloads must commit exactly one audit event.'
  );

  async function sealSupportingFile({ title, assetKind, mimeType, body }) {
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
      idempotencyKey: `supporting:${digest}`
    });
    await publishing.writeUploadPart({ uploadSessionId: session.id, actorUserId: ownerId, partNumber: 1, body });
    return publishing.completeAndSealUpload({ uploadSessionId: session.id, actorUserId: ownerId, performerId: performer.id });
  }

  const artworkBody = pngFixture('verified artwork bytes');
  const artworkVersion = await sealSupportingFile({
    title: 'release-artwork.png',
    assetKind: 'artwork',
    mimeType: 'image/png',
    body: artworkBody
  });
  const rightsDocumentBody = Buffer.from('immutable rights terms version one');
  const rightsDocumentVersion = await sealSupportingFile({
    title: 'distribution-rights.txt',
    assetKind: 'document',
    mimeType: 'text/plain',
    body: rightsDocumentBody
  });
  const secondMasterVersion = await sealSupportingFile({
    title: 'second-track.wav',
    assetKind: 'master_audio',
    mimeType: 'audio/wav',
    body: wavFixture('second immutable album master')
  });
  const thirdMasterVersion = await sealSupportingFile({
    title: 'third-track.wav',
    assetKind: 'master_audio',
    mimeType: 'audio/wav',
    body: wavFixture('third immutable album master')
  });
  const postRightsMasterVersion = await sealSupportingFile({
    title: 'post-rights-track.wav',
    assetKind: 'master_audio',
    mimeType: 'audio/wav',
    body: wavFixture('unused master for sealed-release denial')
  });

  const releaseId = randomUUID();
  const releaseDraft = await publishing.createReleaseDraft({
    clientReleaseId: releaseId,
    performerId: performer.id,
    actorUserId: ownerId,
    projectId: project.id,
    masterAssetVersionId: version.id,
    title: 'Durable Release Proof',
    trackTitle: 'Durable Release Proof',
    primaryArtistName: 'Collaboration proof',
    releaseType: 'album',
    territories: ['US'],
    languageCode: 'en'
  });
  assert.equal(releaseDraft.created, true);
  assert.equal(releaseDraft.release.distributionMode, 'private');
  assert.equal(releaseDraft.release.status, 'draft');
  assert.equal(releaseDraft.recording.masterAssetVersionId, version.id);

  let releaseWorkspace = await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId });
  assert.equal(releaseWorkspace.releases[0].readiness.ready, false);
  assert.ok(releaseWorkspace.releases[0].readiness.issues.includes('Verified release artwork is required.'));
  assert.ok(releaseWorkspace.releases[0].readiness.issues.includes('The ℗ sound-recording copyright line is required.'));
  assert.ok(releaseWorkspace.releases[0].readiness.issues.includes('The © artwork/release copyright line is required.'));

  const incompleteEdit = await publishing.updateReleaseDraft({
    releaseId,
    performerId: performer.id,
    actorUserId: ownerId,
    expectedUpdatedAt: releaseDraft.release.updatedAt.toISOString(),
    title: 'Incomplete proposed edit',
    trackTitle: 'Incomplete proposed edit',
    primaryArtistName: 'Collaboration proof',
    releaseType: 'album',
    distributionMode: 'private',
    territories: ['US'],
    languageCode: 'en',
    credits: [{ displayName: 'Collaboration proof', role: 'primary_artist' }]
  });
  assert.equal(incompleteEdit.release.title, 'Incomplete proposed edit');
  assert.equal(incompleteEdit.readiness.ready, false, 'A progressive draft edit must retain fail-closed readiness.');
  assert.ok(incompleteEdit.readiness.issues.includes('Verified release artwork is required.'));
  await assert.rejects(
    publishing.createRightsDeclaration({
      releaseId,
      performerId: performer.id,
      actorUserId: ownerId,
      declarationType: 'master_control',
      termsDocumentAssetVersionId: rightsDocumentVersion.id,
      termsVersion: '1',
      declarationText: 'This must not start rights review early.',
      evidenceNote: 'Metadata is still incomplete.',
      recordingId: releaseDraft.recording.id
    }),
    /Complete release metadata before rights review:.*release artwork.*sound-recording copyright line.*artwork\/release copyright line.*Original release date.*songwriter or composer/i
  );
  assert.equal((await db.select().from(musicRightsDeclarations)).length, 0);

  const editedRelease = await publishing.updateReleaseDraft({
    releaseId,
    performerId: performer.id,
    actorUserId: ownerId,
    expectedUpdatedAt: incompleteEdit.release.updatedAt.toISOString(),
    artworkAssetVersionId: artworkVersion.id,
    title: 'Durable Release Proof',
    trackTitle: 'Durable Release Proof',
    primaryArtistName: 'Collaboration proof',
    releaseType: 'album',
    distributionMode: 'sway_first',
    labelName: 'Independent proof',
    pLine: '℗ 2026 Collaboration proof',
    cLine: '© 2026 Collaboration proof',
    originalReleaseDate: '2026-07-22',
    scheduledReleaseAt: '2026-08-22T12:00:00.000Z',
    territories: ['US', 'CA'],
    languageCode: 'en',
    credits: [
      { displayName: 'Collaboration proof', role: 'primary_artist' },
      { displayName: 'Proof Writer', role: 'songwriter' },
      { displayName: 'Proof Producer', role: 'producer' }
    ]
  });
  assert.equal(editedRelease.release.artworkAssetVersionId, artworkVersion.id);
  assert.equal(editedRelease.credits.length, 3);
  assert.equal((await db.select().from(musicRecordingCredits).where(eq(musicRecordingCredits.recordingId, releaseDraft.recording.id))).length, 3);

  await assert.rejects(
    publishing.updateReleaseDraft({
      releaseId,
      performerId: performer.id,
      actorUserId: ownerId,
      expectedUpdatedAt: incompleteEdit.release.updatedAt.toISOString(),
      artworkAssetVersionId: artworkVersion.id,
      title: 'Stale overwrite',
      trackTitle: 'Stale overwrite',
      primaryArtistName: 'Collaboration proof',
      releaseType: 'single',
      distributionMode: 'private',
      territories: ['US'],
      credits: [{ displayName: 'Collaboration proof', role: 'primary_artist' }]
    }),
    /changed in another session/
  );
  assert.equal((await db.select().from(musicReleases).where(eq(musicReleases.id, releaseId)))[0].title, 'Durable Release Proof');

  const releaseReplay = await publishing.createReleaseDraft({
    clientReleaseId: releaseId,
    performerId: performer.id,
    actorUserId: ownerId,
    projectId: project.id,
    masterAssetVersionId: version.id,
    title: 'A retry must not duplicate this release',
    trackTitle: 'A retry must not duplicate this recording',
    primaryArtistName: 'Collaboration proof',
    releaseType: 'single'
  });
  assert.equal(releaseReplay.created, false, 'Release creation must be idempotent by client release UUID.');
  assert.equal((await db.select().from(musicReleases).where(eq(musicReleases.id, releaseId))).length, 1);
  assert.equal((await db.select().from(musicRecordings).where(eq(musicRecordings.masterAssetVersionId, version.id))).length, 1);

  await assert.rejects(
    publishing.createReleaseDraft({
      clientReleaseId: randomUUID(),
      performerId: performer.id,
      actorUserId: outsiderId,
      projectId: project.id,
      masterAssetVersionId: version.id,
      title: 'Unauthorized release',
      trackTitle: 'Unauthorized release',
      primaryArtistName: 'Outsider',
      releaseType: 'single'
    }),
    /Release management permission required/
  );

  const secondRecordingId = randomUUID();
  const secondRecordingInput = {
    releaseId,
    clientRecordingId: secondRecordingId,
    performerId: performer.id,
    actorUserId: ownerId,
    expectedUpdatedAt: editedRelease.release.updatedAt.toISOString(),
    masterAssetVersionId: secondMasterVersion.id,
    title: 'Second Track',
    primaryArtistName: 'Collaboration proof',
    isrc: 'USAAA2600002',
    languageCode: 'en',
    originalReleaseDate: '2026-07-22',
    credits: [
      { displayName: 'Collaboration proof', role: 'primary_artist' },
      { displayName: 'Second Track Writer', role: 'songwriter' }
    ]
  };
  const addedSecond = await publishing.addReleaseRecording(secondRecordingInput);
  assert.equal(addedSecond.created, true);
  assert.equal(addedSecond.recording.id, secondRecordingId);
  assert.equal(addedSecond.trackNumber, 2);

  const replayedSecond = await publishing.addReleaseRecording(secondRecordingInput);
  assert.equal(replayedSecond.created, false, 'A retried client recording UUID must not duplicate a track.');
  assert.equal(replayedSecond.recording.id, secondRecordingId);
  assert.equal(replayedSecond.trackNumber, 2);
  assert.equal(
    (await db.select().from(musicRecordings).where(eq(musicRecordings.id, secondRecordingId))).length,
    1,
    'A recording retry must leave exactly one durable recording.'
  );

  await assert.rejects(
    publishing.addReleaseRecording({
      ...secondRecordingInput,
      clientRecordingId: randomUUID(),
      expectedUpdatedAt: addedSecond.release.updatedAt.toISOString()
    }),
    /verified master is already part of the release/i
  );

  const thirdRecordingId = randomUUID();
  const thirdRecordingInput = {
    releaseId,
    clientRecordingId: thirdRecordingId,
    performerId: performer.id,
    actorUserId: ownerId,
    masterAssetVersionId: thirdMasterVersion.id,
    title: 'Third Track',
    primaryArtistName: 'Collaboration proof',
    isrc: 'USAAA2600003',
    languageCode: 'en',
    originalReleaseDate: '2026-07-22',
    credits: [
      { displayName: 'Collaboration proof', role: 'primary_artist' },
      { displayName: 'Third Track Composer', role: 'composer' }
    ]
  };
  await assert.rejects(
    publishing.addReleaseRecording({
      ...thirdRecordingInput,
      expectedUpdatedAt: editedRelease.release.updatedAt.toISOString()
    }),
    /changed in another session/
  );
  await assert.rejects(
    publishing.addReleaseRecording({
      ...thirdRecordingInput,
      actorUserId: outsiderId,
      expectedUpdatedAt: addedSecond.release.updatedAt.toISOString()
    }),
    /Release management permission required/
  );
  const addedThird = await publishing.addReleaseRecording({
    ...thirdRecordingInput,
    expectedUpdatedAt: addedSecond.release.updatedAt.toISOString()
  });
  assert.equal(addedThird.created, true);
  assert.equal(addedThird.trackNumber, 3);

  const updatedThird = await publishing.updateReleaseRecording({
    releaseId,
    recordingId: thirdRecordingId,
    performerId: performer.id,
    actorUserId: ownerId,
    expectedUpdatedAt: addedThird.release.updatedAt.toISOString(),
    title: 'Third Track Revised',
    versionTitle: 'Album version',
    primaryArtistName: 'Collaboration proof',
    isrc: 'USAAA2600003',
    isExplicit: true,
    languageCode: 'en',
    originalReleaseDate: '2026-07-22',
    credits: [
      { displayName: 'Collaboration proof', role: 'primary_artist' },
      { displayName: 'Third Track Composer', role: 'composer' },
      { displayName: 'Third Track Producer', role: 'producer' }
    ]
  });
  assert.equal(updatedThird.recording.title, 'Third Track Revised');
  assert.equal(updatedThird.recording.versionTitle, 'Album version');
  assert.equal(updatedThird.recording.isExplicit, true);
  assert.equal(updatedThird.credits.length, 3);
  assert.equal(
    (await db.select().from(musicRecordingCredits).where(eq(musicRecordingCredits.recordingId, thirdRecordingId))).length,
    3,
    'Per-track credit editing must replace the durable credit set.'
  );

  const reordered = await publishing.reorderReleaseRecordings({
    releaseId,
    performerId: performer.id,
    actorUserId: ownerId,
    expectedUpdatedAt: updatedThird.release.updatedAt.toISOString(),
    recordingIds: [thirdRecordingId, releaseDraft.recording.id, secondRecordingId]
  });
  assert.deepEqual(reordered.recordingIds, [thirdRecordingId, releaseDraft.recording.id, secondRecordingId]);
  releaseWorkspace = await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId });
  let mainRelease = releaseWorkspace.releases.find((candidate) => candidate.id === releaseId);
  assert.deepEqual(
    mainRelease?.recordings.map((recording) => [recording.recordingId, recording.trackNumber]),
    [[thirdRecordingId, 1], [releaseDraft.recording.id, 2], [secondRecordingId, 3]],
    'Reorder must persist one contiguous track order.'
  );

  const removedOriginal = await publishing.removeReleaseRecording({
    releaseId,
    recordingId: releaseDraft.recording.id,
    performerId: performer.id,
    actorUserId: ownerId,
    expectedUpdatedAt: reordered.release.updatedAt.toISOString()
  });
  assert.equal(removedOriginal.removedRecordingId, releaseDraft.recording.id);
  assert.deepEqual(removedOriginal.recordingIds, [thirdRecordingId, secondRecordingId]);
  assert.equal(
    (await db.select().from(musicRecordings).where(eq(musicRecordings.id, releaseDraft.recording.id))).length,
    1,
    'Removing a draft track from the manifest must preserve its durable recording row.'
  );

  releaseWorkspace = await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId });
  mainRelease = releaseWorkspace.releases.find((candidate) => candidate.id === releaseId);
  assert.equal(releaseWorkspace.masters.length, 4);
  assert.equal(releaseWorkspace.artworks.length, 1);
  assert.equal(releaseWorkspace.rightsDocuments.length, 1);
  assert.equal(releaseWorkspace.releases.length, 1);
  assert.equal(mainRelease?.recordings.length, 2);
  assert.deepEqual(
    mainRelease?.recordings.map((recording) => [recording.recordingId, recording.trackNumber]),
    [[thirdRecordingId, 1], [secondRecordingId, 2]],
    'Removing a middle track must renumber the remaining manifest contiguously.'
  );
  assert.equal(mainRelease?.readiness.ready, false, 'Complete multi-track metadata must not bypass rights readiness.');
  assert.deepEqual(mainRelease?.readiness.metadataIssues, []);
  assert.deepEqual(mainRelease?.readiness.rightsIssues, [
    'Third Track Revised: verified master control rights evidence is required.',
    'Third Track Revised: verified composition control rights evidence is required.',
    'Second Track: verified master control rights evidence is required.',
    'Second Track: verified composition control rights evidence is required.',
    'Verified artwork control rights evidence is required for the release.',
    'Verified distribution authorization rights evidence is required for the release.'
  ]);

  const requiredDeclarations = [
    { declarationType: 'master_control', recordingId: thirdRecordingId },
    { declarationType: 'composition_control', recordingId: thirdRecordingId },
    { declarationType: 'master_control', recordingId: secondRecordingId },
    { declarationType: 'composition_control', recordingId: secondRecordingId },
    { declarationType: 'artwork_control', recordingId: null },
    { declarationType: 'distribution_authorization', recordingId: null }
  ];
  const rightsEvidenceOpenBaseline = openOriginalCount;
  for (const [declarationIndex, requiredDeclaration] of requiredDeclarations.entries()) {
    const declaration = await publishing.createRightsDeclaration({
      releaseId,
      performerId: performer.id,
      actorUserId: ownerId,
      declarationType: requiredDeclaration.declarationType,
      termsDocumentAssetVersionId: rightsDocumentVersion.id,
      termsVersion: '1',
      declarationText: `Owner attests ${requiredDeclaration.declarationType} for the declared scope.`,
      evidenceNote: 'Bound to the sealed proof document.',
      recordingId: requiredDeclaration.recordingId
    });
    assert.equal(
      declaration.recordingId,
      requiredDeclaration.recordingId,
      `${requiredDeclaration.declarationType} must retain its intended release or recording scope.`
    );
    await assert.rejects(
      publishing.reviewRightsDeclaration({
        declarationId: declaration.id,
        actorUserId: ownerId,
        outcome: 'verified',
        reason: 'Self review must fail.'
      }),
      /independent project reviewer/
    );
    await assert.rejects(
      publishing.reviewRightsDeclaration({
        declarationId: declaration.id,
        actorUserId: reviewerId,
        outcome: 'verified',
        reason: 'A blind review must fail before evidence access.'
      }),
      /Open the exact sealed rights document/
    );
    if (declarationIndex === 0) {
      const deniedRightsOpenBaseline = openOriginalCount;
      await assert.rejects(
        publishing.openRightsReviewDocument({ declarationId: declaration.id, actorUserId: ownerId }),
        /independent project reviewer/
      );
      await assert.rejects(
        publishing.openRightsReviewDocument({ declarationId: declaration.id, actorUserId: noAccessUserId }),
        /Release review permission required/
      );
      await assert.rejects(
        publishing.openRightsReviewDocument({ declarationId: declaration.id, actorUserId: expiredReviewerId }),
        /Release review permission required/
      );
      assert.equal(openOriginalCount, deniedRightsOpenBaseline, 'Denied rights-document access must not reach object storage.');
    }
    const openedEvidence = await publishing.openRightsReviewDocument({
      declarationId: declaration.id,
      actorUserId: reviewerId
    });
    const openedEvidenceBody = await streamToBuffer(openedEvidence.stream);
    assert.deepEqual(openedEvidenceBody, rightsDocumentBody);
    assert.equal(createHash('sha256').update(openedEvidenceBody).digest('hex'), declaration.termsHash);
    assert.equal(openedEvidence.version.id, declaration.termsDocumentAssetVersionId);
    await publishing.reviewRightsDeclaration({
      declarationId: declaration.id,
      actorUserId: reviewerId,
      outcome: 'verified',
      reason: 'Checked against the sealed source document.'
    });
    const reviewProgress = await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId });
    const reviewedRelease = reviewProgress.releases.find((candidate) => candidate.id === releaseId);
    const finalRequiredDeclaration = declarationIndex === requiredDeclarations.length - 1;
    assert.equal(reviewedRelease?.readiness.ready, finalRequiredDeclaration);
    assert.equal(reviewedRelease?.status, finalRequiredDeclaration ? 'ready' : 'rights_review');
  }
  releaseWorkspace = await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId });
  mainRelease = releaseWorkspace.releases.find((candidate) => candidate.id === releaseId);
  assert.equal(mainRelease?.readiness.ready, true);
  assert.equal(mainRelease?.status, 'ready');
  assert.deepEqual(mainRelease?.recordings.map((recording) => recording.rightsStatus), ['cleared', 'cleared']);
  assert.equal((await db.select().from(musicRightsDeclarations)).length, 6);
  assert.equal((await db.select().from(musicRightsDeclarationEvents)).filter((event) => event.eventType === 'verified').length, 6);
  const [storageManifest] = await db.select().from(musicReleaseStorageManifests)
    .where(eq(musicReleaseStorageManifests.releaseId, releaseId));
  assert.ok(storageManifest, 'Final readiness must atomically append an immutable exact storage manifest.');
  assert.equal(storageManifest.sourceType, 'readiness_pass');
  assert.equal(storageManifest.packageRevision, 1);
  assert.deepEqual(
    storageManifest.assets.map((asset) => asset.assetVersionId).sort(),
    [artworkVersion.id, rightsDocumentVersion.id, secondMasterVersion.id, thirdMasterVersion.id].sort()
  );
  assert.equal(
    storageManifest.assets.find((asset) => asset.assetVersionId === rightsDocumentVersion.id)?.roles.length,
    requiredDeclarations.length,
    'A shared rights document must be retained once with exact declaration roles, not blanket document fan-out.'
  );
  assert.equal(
    storageManifest.assets.some((asset) => asset.assetVersionId === postRightsMasterVersion.id),
    false,
    'Unattached working files must not enter the release storage manifest.'
  );
  const protectedUsage = await publishing.getStorageUsage({ performerId: performer.id });
  assert.equal(
    protectedUsage.releaseProtectedBytes,
    artworkVersion.byteSize + rightsDocumentVersion.byteSize + secondMasterVersion.byteSize + thirdMasterVersion.byteSize
  );
  await assert.rejects(
    db.delete(musicReleaseStorageManifests)
      .where(eq(musicReleaseStorageManifests.id, storageManifest.id)),
    (error) => /immutable/i.test(`${error?.message ?? ''} ${error?.cause?.message ?? ''}`)
  );
  assert.equal((await publishing.listRightsReviewQueue({ actorUserId: reviewerId })).length, 0);
  const evidenceOpenCount = openOriginalCount;
  const releaseValidationOpenCount = storageManifest.assets.length
    + storageManifest.assets.filter((asset) => (
      asset.roles.some((role) => role.startsWith('recording_master:'))
    )).length;
  assert.equal(
    evidenceOpenCount,
    rightsEvidenceOpenBaseline + requiredDeclarations.length + releaseValidationOpenCount,
    'Each declaration must open its evidence once, and final readiness must reopen every exact package object for parsing.'
  );
  const publicRelease = await publishing.getPublicRelease({ releaseId });
  assert.equal(publicRelease?.status, 'ready');
  assert.deepEqual(
    publicRelease?.recordings.map((recording) => [recording.recordingId, recording.trackNumber, recording.title]),
    [[thirdRecordingId, 1, 'Third Track Revised'], [secondRecordingId, 2, 'Second Track']],
    'The public release must preserve the reviewed manifest order.'
  );
  assert.deepEqual(publicRelease?.recordings.map((recording) => recording.credits.length), [3, 2]);
  const publicArtwork = await publishing.openPublicReleaseArtwork({ releaseId });
  assert.deepEqual(await streamToBuffer(publicArtwork.stream), artworkBody);
  assert.equal(openOriginalCount, evidenceOpenCount + 1, 'Public artwork must open exactly one stored original.');

  const sealedUpdatedAt = mainRelease?.updatedAt;
  assert.ok(sealedUpdatedAt, 'A ready multi-track release must retain its durable revision timestamp.');
  await assert.rejects(
    publishing.addReleaseRecording({
      releaseId,
      clientRecordingId: randomUUID(),
      performerId: performer.id,
      actorUserId: ownerId,
      expectedUpdatedAt: sealedUpdatedAt.toISOString(),
      masterAssetVersionId: postRightsMasterVersion.id,
      title: 'Too Late To Add',
      primaryArtistName: 'Collaboration proof',
      languageCode: 'en',
      credits: [
        { displayName: 'Collaboration proof', role: 'primary_artist' },
        { displayName: 'Late Writer', role: 'songwriter' }
      ]
    }),
    /sealed after rights review starts/
  );
  await assert.rejects(
    publishing.updateReleaseRecording({
      releaseId,
      recordingId: thirdRecordingId,
      performerId: performer.id,
      actorUserId: ownerId,
      expectedUpdatedAt: sealedUpdatedAt.toISOString(),
      title: 'Too Late To Edit',
      primaryArtistName: 'Collaboration proof',
      languageCode: 'en',
      credits: [
        { displayName: 'Collaboration proof', role: 'primary_artist' },
        { displayName: 'Late Writer', role: 'songwriter' }
      ]
    }),
    /sealed after rights review starts/
  );
  await assert.rejects(
    publishing.reorderReleaseRecordings({
      releaseId,
      performerId: performer.id,
      actorUserId: ownerId,
      expectedUpdatedAt: sealedUpdatedAt.toISOString(),
      recordingIds: [secondRecordingId, thirdRecordingId]
    }),
    /sealed after rights review starts/
  );
  await assert.rejects(
    publishing.removeReleaseRecording({
      releaseId,
      recordingId: secondRecordingId,
      performerId: performer.id,
      actorUserId: ownerId,
      expectedUpdatedAt: sealedUpdatedAt.toISOString()
    }),
    /sealed after rights review starts/
  );

  const oneTrackRelease = await publishing.createReleaseDraft({
    clientReleaseId: randomUUID(),
    performerId: performer.id,
    actorUserId: ownerId,
    projectId: project.id,
    masterAssetVersionId: postRightsMasterVersion.id,
    title: 'Final Track Guard',
    trackTitle: 'Only Track',
    primaryArtistName: 'Collaboration proof',
    releaseType: 'single',
    territories: ['US'],
    languageCode: 'en'
  });
  await assert.rejects(
    publishing.removeReleaseRecording({
      releaseId: oneTrackRelease.release.id,
      recordingId: oneTrackRelease.recording.id,
      performerId: performer.id,
      actorUserId: ownerId,
      expectedUpdatedAt: oneTrackRelease.release.updatedAt.toISOString()
    }),
    /must keep at least one recording/
  );
  assert.equal(
    (await db.select().from(musicRecordings).where(eq(musicRecordings.id, oneTrackRelease.recording.id))).length,
    1,
    'Final-track removal denial must leave the recording intact.'
  );
  const collaborationDownloadBaseline = openOriginalCount;

  const collaboration = createAudioFileCollaborationService({ db, store: countedStore });
  await assert.rejects(
    collaboration.shareVersion({
      connectionId: connection.id,
      versionId: version.id,
      grantedByUserId: outsiderId
    }),
    /Only connection members can share files/
  );
  await assert.rejects(
    collaboration.shareVersion({
      connectionId: expiredManagerConnection.id,
      versionId: version.id,
      grantedByUserId: expiredReviewerId
    }),
    /Project access management permission required/,
    'Expired project-management grants must not authorize selected-file sharing.'
  );

  const shared = await collaboration.shareVersion({
    connectionId: connection.id,
    versionId: version.id,
    grantedByUserId: ownerId,
    canDownloadOriginal: true,
    canComment: true,
    canApprove: true
  });
  assert.equal(shared.reused, false);
  const repeatedShare = await collaboration.shareVersion({
    connectionId: connection.id,
    versionId: version.id,
    grantedByUserId: ownerId
  });
  assert.equal(repeatedShare.reused, true, 'Selected-file sharing must be idempotent while the grant is active.');

  const reviewerFiles = await collaboration.listSharedWithMe({ userId: reviewerId });
  assert.equal(reviewerFiles.length, 1);
  assert.equal(reviewerFiles[0].sha256, sha256);
  assert.equal((await collaboration.listSharedByMe({ userId: ownerId })).length, 1);
  assert.equal(
    (await collaboration.listSharedByMe({ userId: nonGrantorManagerId })).length,
    0,
    'A non-grantor project manager must not receive metadata or controls for an ordinary review share.'
  );
  assert.equal((await collaboration.listSharedWithMe({ userId: outsiderId })).length, 0);

  await assert.rejects(
    collaboration.downloadGrantedOriginal({ grantId: shared.grant.id, userId: outsiderId }),
    /File grant access denied/
  );
  assert.equal(openOriginalCount, collaborationDownloadBaseline, 'Denied download must not reach object storage.');

  const comment = await collaboration.addReviewEvent({
    grantId: shared.grant.id,
    userId: reviewerId,
    eventType: 'comment',
    body: 'Bring the vocal up slightly.',
    timecodeMs: 12_000
  });
  await collaboration.addReviewEvent({
    grantId: shared.grant.id,
    userId: reviewerId,
    eventType: 'approved',
    body: 'Approved for the next step.'
  });
  await collaboration.addReviewEvent({
    grantId: shared.grant.id,
    userId: ownerId,
    eventType: 'resolved',
    supersedesEventId: comment.id
  });
  const firstGrantReviewEvents = await collaboration.listReviewEvents({ grantId: shared.grant.id, userId: ownerId });
  assert.equal(firstGrantReviewEvents.length, 3);
  const [legacyAttributedReviewAudit] = await db
    .update(auditEvents)
    .set({ actorType: 'performer' })
    .where(and(
      eq(auditEvents.entityType, 'audio_review_event'),
      eq(auditEvents.entityId, comment.id),
      eq(auditEvents.eventType, 'audio_review.comment')
    ))
    .returning({ eventId: auditEvents.eventId, actorType: auditEvents.actorType });
  assert.equal(legacyAttributedReviewAudit?.actorType, 'performer');
  assert.ok(
    (await collaboration.listReviewEvents({ grantId: shared.grant.id, userId: ownerId }))
      .some((event) => event.id === comment.id),
    'Grant-scoped review history must retain correctly bound legacy performer-attributed audits.'
  );

  const [secondReviewConnection] = await db.insert(audioFileConnections).values({
    memberOneUserId: ownerId,
    memberTwoUserId: noAccessUserId,
    createdByUserId: ownerId,
    createdFromPurpose: 'send_files'
  }).returning();
  const secondShared = await collaboration.shareVersion({
    connectionId: secondReviewConnection.id,
    versionId: version.id,
    grantedByUserId: ownerId,
    canDownloadOriginal: false,
    canComment: true,
    canApprove: false
  });
  const secondGrantComment = await collaboration.addReviewEvent({
    grantId: secondShared.grant.id,
    userId: noAccessUserId,
    eventType: 'comment',
    body: 'This note belongs only to the second file grant.'
  });
  const secondGrantResolved = await collaboration.addReviewEvent({
    grantId: secondShared.grant.id,
    userId: ownerId,
    eventType: 'resolved',
    supersedesEventId: secondGrantComment.id
  });
  const ownerFirstThread = await collaboration.listReviewEvents({ grantId: shared.grant.id, userId: ownerId });
  const ownerSecondThread = await collaboration.listReviewEvents({ grantId: secondShared.grant.id, userId: ownerId });
  const firstReviewerThread = await collaboration.listReviewEvents({ grantId: shared.grant.id, userId: reviewerId });
  const secondReviewerThread = await collaboration.listReviewEvents({ grantId: secondShared.grant.id, userId: noAccessUserId });
  assert.deepEqual(ownerFirstThread.map((event) => event.id), firstGrantReviewEvents.map((event) => event.id));
  assert.deepEqual(firstReviewerThread.map((event) => event.id), firstGrantReviewEvents.map((event) => event.id));
  assert.deepEqual(ownerSecondThread.map((event) => event.id), [secondGrantComment.id, secondGrantResolved.id]);
  assert.deepEqual(secondReviewerThread.map((event) => event.id), [secondGrantComment.id, secondGrantResolved.id]);
  await assert.rejects(
    collaboration.listReviewEvents({ grantId: secondShared.grant.id, userId: reviewerId }),
    /File grant access denied/
  );

  const reviewCountBeforeCrossGrantAttempt = (await db.select().from(audioReviewEvents)).length;
  const auditCountBeforeCrossGrantAttempt = (await db.select().from(auditEvents)).length;
  await assert.rejects(
    collaboration.addReviewEvent({
      grantId: secondShared.grant.id,
      userId: ownerId,
      eventType: 'resolved',
      supersedesEventId: comment.id
    }),
    /Superseded review event must belong to this file grant/,
    'Cross-grant supersede must fail.'
  );
  await assert.rejects(
    collaboration.addReviewEvent({
      grantId: secondShared.grant.id,
      userId: noAccessUserId,
      eventType: 'comment',
      body: 'Malformed supersede must fail.',
      supersedesEventId: 'not-a-uuid'
    }),
    /supersedesEventId must be a UUID/
  );
  await assert.rejects(
    collaboration.addReviewEvent({
      grantId: secondShared.grant.id,
      userId: noAccessUserId,
      eventType: 'comment',
      body: 'Unknown supersede must fail.',
      supersedesEventId: randomUUID()
    }),
    /Superseded review event must belong to this file grant/
  );
  assert.equal((await db.select().from(audioReviewEvents)).length, reviewCountBeforeCrossGrantAttempt);
  assert.equal((await db.select().from(auditEvents)).length, auditCountBeforeCrossGrantAttempt);

  await db.insert(audioReviewEvents).values({
    assetVersionId: version.id,
    actorUserId: noAccessUserId,
    eventType: 'comment',
    body: 'Orphan row without a grant audit binding.'
  });
  assert.deepEqual(
    (await collaboration.listReviewEvents({ grantId: secondShared.grant.id, userId: noAccessUserId }))
      .map((event) => event.id),
    [secondGrantComment.id, secondGrantResolved.id],
    'Review rows without the exact durable grant audit binding must remain invisible.'
  );
  const secondCommentAudit = await db
    .select()
    .from(auditEvents)
    .where(and(
      eq(auditEvents.entityType, 'audio_review_event'),
      eq(auditEvents.entityId, secondGrantComment.id)
    ));
  assert.equal(secondCommentAudit.length, 1, 'A successful review event must have exactly one grant audit binding.');
  assert.equal(secondCommentAudit[0].metadata?.grantId, secondShared.grant.id);
  assert.equal(secondCommentAudit[0].metadata?.versionId, version.id);

  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION sway_test_reject_review_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $test$
    BEGIN
      IF NEW.entity_type = 'audio_review_event' THEN
        RAISE EXCEPTION 'forced review audit failure';
      END IF;
      RETURN NEW;
    END;
    $test$
  `));
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS sway_test_reject_review_audit_trigger ON audit_events'));
  await db.execute(sql.raw(`
    CREATE TRIGGER sway_test_reject_review_audit_trigger
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION sway_test_reject_review_audit()
  `));
  const reviewCountBeforeForcedAuditFailure = (await db.select().from(audioReviewEvents)).length;
  const auditCountBeforeForcedAuditFailure = (await db.select().from(auditEvents)).length;
  try {
    await assert.rejects(
      collaboration.addReviewEvent({
        grantId: secondShared.grant.id,
        userId: noAccessUserId,
        eventType: 'comment',
        body: 'The review insert must roll back with its failed audit.'
      }),
      (error) => {
        assert.match(error?.cause?.message || '', /forced review audit failure/);
        return true;
      }
    );
  } finally {
    await db.execute(sql.raw('DROP TRIGGER IF EXISTS sway_test_reject_review_audit_trigger ON audit_events'));
    await db.execute(sql.raw('DROP FUNCTION IF EXISTS sway_test_reject_review_audit()'));
  }
  assert.equal((await db.select().from(audioReviewEvents)).length, reviewCountBeforeForcedAuditFailure);
  assert.equal((await db.select().from(auditEvents)).length, auditCountBeforeForcedAuditFailure);

  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION sway_test_reject_grant_revoke_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $test$
    BEGIN
      IF NEW.event_type = 'audio_file_access.revoke' THEN
        RAISE EXCEPTION 'forced grant revoke audit failure';
      END IF;
      RETURN NEW;
    END;
    $test$
  `));
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS sway_test_reject_grant_revoke_audit_trigger ON audit_events'));
  await db.execute(sql.raw(`
    CREATE TRIGGER sway_test_reject_grant_revoke_audit_trigger
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION sway_test_reject_grant_revoke_audit()
  `));
  const revokeAuditWhere = and(
    eq(auditEvents.entityType, 'audio_file_access_grant'),
    eq(auditEvents.entityId, secondShared.grant.id),
    eq(auditEvents.eventType, 'audio_file_access.revoke')
  );
  const revokeAuditCountBeforeForcedFailure = (await db.select().from(auditEvents).where(revokeAuditWhere)).length;
  assert.equal(revokeAuditCountBeforeForcedFailure, 0);
  try {
    await assert.rejects(
      collaboration.revokeGrant({
        grantId: secondShared.grant.id,
        userId: ownerId,
        reason: 'This revoke must roll back with its failed audit.'
      }),
      (error) => {
        assert.match(error?.cause?.message || '', /forced grant revoke audit failure/);
        return true;
      }
    );
  } finally {
    await db.execute(sql.raw('DROP TRIGGER IF EXISTS sway_test_reject_grant_revoke_audit_trigger ON audit_events'));
    await db.execute(sql.raw('DROP FUNCTION IF EXISTS sway_test_reject_grant_revoke_audit()'));
  }
  const [grantAfterForcedRevokeAuditFailure] = await db
    .select({
      revokedAt: audioFileAccessGrants.revokedAt,
      revokedByUserId: audioFileAccessGrants.revokedByUserId,
      revocationReason: audioFileAccessGrants.revocationReason
    })
    .from(audioFileAccessGrants)
    .where(eq(audioFileAccessGrants.id, secondShared.grant.id))
    .limit(1);
  assert.ok(grantAfterForcedRevokeAuditFailure, 'The rollback proof grant must still exist.');
  assert.equal(grantAfterForcedRevokeAuditFailure.revokedAt, null, 'Failed revoke audit must roll back revokedAt.');
  assert.equal(grantAfterForcedRevokeAuditFailure.revokedByUserId, null, 'Failed revoke audit must roll back revokedByUserId.');
  assert.equal(grantAfterForcedRevokeAuditFailure.revocationReason, null, 'Failed revoke audit must roll back its reason.');
  assert.equal(
    (await db.select().from(auditEvents).where(revokeAuditWhere)).length,
    revokeAuditCountBeforeForcedFailure,
    'Failed revoke audit must leave no durable revoke audit row.'
  );
  assert.ok(
    (await collaboration.listSharedByMe({ userId: ownerId }))
      .some((file) => file.grantId === secondShared.grant.id),
    'The rolled-back grant must remain active and visible to its grantor.'
  );
  await collaboration.revokeGrant({
    grantId: secondShared.grant.id,
    userId: ownerId,
    reason: 'Second grant isolation proof complete.'
  });

  const downloaded = await collaboration.downloadGrantedOriginal({ grantId: shared.grant.id, userId: reviewerId });
  assert.equal(downloaded.byteSize, body.byteLength);
  assert.deepEqual(await streamToBuffer(downloaded.stream), body);
  assert.equal(downloaded.version.sha256, sha256);
  assert.equal(openOriginalCount, collaborationDownloadBaseline + 1);

  await collaboration.revokeGrant({ grantId: shared.grant.id, userId: ownerId, reason: 'Proof complete.' });
  assert.equal((await collaboration.listSharedByMe({ userId: ownerId })).length, 0);
  await assert.rejects(
    collaboration.downloadGrantedOriginal({ grantId: shared.grant.id, userId: reviewerId }),
    /Active file grant required/
  );
  await assert.rejects(
    collaboration.addReviewEvent({
      grantId: shared.grant.id,
      userId: reviewerId,
      eventType: 'approved'
    }),
    /Active file grant required/
  );
  assert.equal(openOriginalCount, collaborationDownloadBaseline + 1, 'Revoked replay must fail before object storage.');

  const reshared = await collaboration.shareVersion({
    connectionId: connection.id,
    versionId: version.id,
    grantedByUserId: ownerId
  });
  assert.equal(reshared.reused, false);
  assert.deepEqual(
    await collaboration.listReviewEvents({ grantId: reshared.grant.id, userId: ownerId }),
    [],
    'Revoking and re-sharing the same immutable version must begin a new empty review thread.'
  );
  const pairing = createAudioFilePairingService({ db });
  await pairing.revokeConnection({ userId: reviewerId, connectionId: connection.id, reason: 'Connection proof complete.' });
  await assert.rejects(
    collaboration.downloadGrantedOriginal({ grantId: reshared.grant.id, userId: reviewerId }),
    /Active file grant required/
  );
  const [cascadedGrant] = await db
    .select({ revokedAt: audioFileAccessGrants.revokedAt })
    .from(audioFileAccessGrants)
    .where(eq(audioFileAccessGrants.id, reshared.grant.id))
    .limit(1);
  assert.ok(cascadedGrant?.revokedAt, 'Connection revocation must cascade to active selected-file grants.');
  assert.equal(openOriginalCount, collaborationDownloadBaseline + 1);

  const collaborationAudit = await db
    .select({ eventType: auditEvents.eventType, actorType: auditEvents.actorType })
    .from(auditEvents);
  for (const eventType of [
    'audio_file_access.share',
    'audio_file_access.download',
    'audio_review.comment',
    'audio_review.approved',
    'audio_file_access.revoke',
    'audio_file_pairing.connection_revoked',
    'music_release.draft_create',
    'music_recording.create',
    'music_release.draft_update',
    'music_release.recording_add',
    'music_release.recording_update',
    'music_release.recordings_reorder',
    'music_release.recording_remove',
    'audio_project.release_reviewer_grant',
    'music_rights_declaration.create',
    'music_rights_declaration.evidence_access',
    'music_rights_declaration.verified',
    'music_release.readiness_pass'
  ]) {
    assert.ok(collaborationAudit.some((event) => event.eventType === eventType), `Missing audit event: ${eventType}`);
  }
  for (const [eventType, expectedCount] of [
    ['music_release.recording_add', 2],
    ['music_release.recording_update', 1],
    ['music_release.recordings_reorder', 1],
    ['music_release.recording_remove', 1]
  ]) {
    assert.equal(
      collaborationAudit.filter((event) => event.eventType === eventType).length,
      expectedCount,
      `${eventType} must be emitted exactly once per successful manifest mutation.`
    );
  }
  for (const [eventType, expectedActorType] of [
    ['audio_file_access.share', 'performer'],
    ['audio_file_access.download', 'account'],
    ['audio_review.approved', 'account'],
    ['audio_review.resolved', 'account'],
    ['audio_file_access.revoke', 'account'],
    ['audio_file_pairing.connection_revoked', 'account']
  ]) {
    const matchingEvents = collaborationAudit.filter((event) => event.eventType === eventType);
    assert.ok(matchingEvents.length > 0, `Missing actor-attribution proof for ${eventType}.`);
    assert.ok(
      matchingEvents.every((event) => event.actorType === expectedActorType),
      `${eventType} must identify its actor as ${expectedActorType}.`
    );
  }
  const reviewCommentActorTypes = collaborationAudit
    .filter((event) => event.eventType === 'audio_review.comment')
    .map((event) => event.actorType);
  assert.ok(reviewCommentActorTypes.includes('account'), 'New review comments must use account attribution.');
  assert.ok(reviewCommentActorTypes.includes('performer'), 'Legacy performer-attributed review comments must remain readable.');
  assert.ok(
    reviewCommentActorTypes.every((actorType) => actorType === 'account' || actorType === 'performer'),
    'Review comment attribution must remain within the supported account and legacy performer values.'
  );
  for (const eventType of [
    'music_rights_declaration.evidence_access',
    'music_rights_declaration.verified',
    'music_release.readiness_pass'
  ]) {
    assert.ok(
      collaborationAudit.filter((event) => event.eventType === eventType).every((event) => event.actorType === 'account'),
      `${eventType} must identify the non-Pro reviewer as an account actor.`
    );
  }

  console.log('Audio file collaboration integration passed: multi-track add/retry, duplicate/stale/unauthorized denial, metadata and credits, reorder, non-destructive removal and renumbering, scoped rights, parsed immutable storage manifest, readiness/public order, post-rights mutation denial, final-track protection, selected-version sharing, grant-isolated review threads, audit rollback, and exact audit behavior are durable.');
} finally {
  if (embeddedProof) await embeddedProof.close();
  else await db.$client.end();
  rmSync(objectRoot, { recursive: true, force: true });
}
