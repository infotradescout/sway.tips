import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client.ts';
import {
  audioFileAccessGrants,
  audioFileConnections,
  audioProjectAccessGrants,
  auditEvents,
  musicRecordingCredits,
  musicRecordings,
  musicReleases,
  musicRightsDeclarationEvents,
  musicRightsDeclarations,
  performers,
  users
} from '../src/db/schema.ts';
import { createLocalAudioObjectStore } from '../src/server/audio-object-storage-local.ts';
import { createAudioFileCollaborationService } from '../src/server/audio-file-collaboration-service.ts';
import { createAudioFilePairingService } from '../src/server/audio-file-pairing-service.ts';
import { createAudioPublishingService } from '../src/server/audio-publishing-service.ts';

if (process.env.SWAY_DISPOSABLE_MIGRATION_PROOF !== '1') {
  throw new Error('Audio collaboration integration requires SWAY_DISPOSABLE_MIGRATION_PROOF=1.');
}
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required.');

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const db = createSwayDb(databaseUrl);
const objectRoot = mkdtempSync(join(tmpdir(), 'sway-file-collaboration-'));

try {
  await migrate(db, { migrationsFolder: 'drizzle' });

  const actorIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
  const [ownerId, reviewerId, outsiderId, noAccessUserId, expiredReviewerId] = actorIds;
  await db.insert(users).values([
    { id: ownerId, email: `owner-${ownerId}@example.test`, emailVerifiedAt: new Date() },
    { id: reviewerId, email: `reviewer-${reviewerId}@example.test`, emailVerifiedAt: new Date() },
    { id: outsiderId, email: `outsider-${outsiderId}@example.test`, emailVerifiedAt: new Date() },
    { id: noAccessUserId, email: `no-access-${noAccessUserId}@example.test`, emailVerifiedAt: new Date() },
    { id: expiredReviewerId, email: `expired-reviewer-${expiredReviewerId}@example.test`, emailVerifiedAt: new Date() }
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
  const countedStore = {
    ...localStore,
    async openOriginal(identity) {
      openOriginalCount += 1;
      return localStore.openOriginal(identity);
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
    grantedByUserId: ownerId,
    expiresAt: new Date(Date.now() - 60_000)
  });
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
  const body = Buffer.from('RIFF selected-file collaboration exact original proof');
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

  const artworkVersion = await sealSupportingFile({
    title: 'release-artwork.png',
    assetKind: 'artwork',
    mimeType: 'image/png',
    body: Buffer.from('verified artwork bytes')
  });
  const rightsDocumentBody = Buffer.from('immutable rights terms version one');
  const rightsDocumentVersion = await sealSupportingFile({
    title: 'distribution-rights.txt',
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
    masterAssetVersionId: version.id,
    title: 'Durable Release Proof',
    trackTitle: 'Durable Release Proof',
    primaryArtistName: 'Collaboration proof',
    releaseType: 'single',
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
    releaseType: 'single',
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
    releaseType: 'single',
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

  releaseWorkspace = await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId });
  assert.equal(releaseWorkspace.releases[0].readiness.ready, false, 'Complete metadata must not bypass rights readiness.');
  assert.deepEqual(
    releaseWorkspace.releases[0].readiness.issues,
    [
      'Verified master control rights evidence is required.',
      'Verified composition control rights evidence is required.',
      'Verified artwork control rights evidence is required.',
      'Verified distribution authorization rights evidence is required.'
    ]
  );

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

  releaseWorkspace = await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId });
  assert.equal(releaseWorkspace.masters.length, 1);
  assert.equal(releaseWorkspace.artworks.length, 1);
  assert.equal(releaseWorkspace.rightsDocuments.length, 1);
  assert.equal(releaseWorkspace.releases.length, 1);
  assert.equal(releaseWorkspace.releases[0].recordings.length, 1);
  assert.equal(releaseWorkspace.releases[0].readiness.ready, false);

  const requiredDeclarationTypes = ['master_control', 'composition_control', 'artwork_control', 'distribution_authorization'];
  for (const [declarationIndex, declarationType] of requiredDeclarationTypes.entries()) {
    const declaration = await publishing.createRightsDeclaration({
      releaseId,
      performerId: performer.id,
      actorUserId: ownerId,
      declarationType,
      termsDocumentAssetVersionId: rightsDocumentVersion.id,
      termsVersion: '1',
      declarationText: `Owner attests ${declarationType} for this release.`,
      evidenceNote: 'Bound to the sealed proof document.',
      recordingId: releaseDraft.recording.id
    });
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
      assert.equal(openOriginalCount, 0, 'Denied rights-document access must not reach object storage.');
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
    const finalRequiredDeclaration = declarationIndex === requiredDeclarationTypes.length - 1;
    assert.equal(reviewProgress.releases[0].readiness.ready, finalRequiredDeclaration);
    assert.equal(reviewProgress.releases[0].status, finalRequiredDeclaration ? 'ready' : 'rights_review');
  }
  releaseWorkspace = await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId });
  assert.equal(releaseWorkspace.releases[0].readiness.ready, true);
  assert.equal(releaseWorkspace.releases[0].status, 'ready');
  assert.equal(releaseWorkspace.releases[0].recordings[0].rightsStatus, 'cleared');
  assert.equal((await db.select().from(musicRightsDeclarations)).length, 4);
  assert.equal((await db.select().from(musicRightsDeclarationEvents)).filter((event) => event.eventType === 'verified').length, 4);
  assert.equal((await publishing.listRightsReviewQueue({ actorUserId: reviewerId })).length, 0);
  const evidenceOpenCount = openOriginalCount;
  assert.equal(evidenceOpenCount, 4, 'Each declaration review must open its exact sealed evidence once.');
  const publicRelease = await publishing.getPublicRelease({ releaseId });
  assert.equal(publicRelease?.status, 'ready');
  assert.equal(publicRelease?.recordings[0].credits.length, 3);
  const publicArtwork = await publishing.openPublicReleaseArtwork({ releaseId });
  assert.deepEqual(await streamToBuffer(publicArtwork.stream), Buffer.from('verified artwork bytes'));

  const collaboration = createAudioFileCollaborationService({ db, store: countedStore });
  await assert.rejects(
    collaboration.shareVersion({
      connectionId: connection.id,
      versionId: version.id,
      grantedByUserId: outsiderId
    }),
    /Only connection members can share files/
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
  assert.equal((await collaboration.listSharedWithMe({ userId: outsiderId })).length, 0);

  await assert.rejects(
    collaboration.downloadGrantedOriginal({ grantId: shared.grant.id, userId: outsiderId }),
    /File grant access denied/
  );
  assert.equal(openOriginalCount, evidenceOpenCount, 'Denied download must not reach object storage.');

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
  assert.equal((await collaboration.listReviewEvents({ grantId: shared.grant.id, userId: ownerId })).length, 3);

  const downloaded = await collaboration.downloadGrantedOriginal({ grantId: shared.grant.id, userId: reviewerId });
  assert.equal(downloaded.byteSize, body.byteLength);
  assert.deepEqual(await streamToBuffer(downloaded.stream), body);
  assert.equal(downloaded.version.sha256, sha256);
  assert.equal(openOriginalCount, evidenceOpenCount + 1);

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
  assert.equal(openOriginalCount, evidenceOpenCount + 1, 'Revoked replay must fail before object storage.');

  const reshared = await collaboration.shareVersion({
    connectionId: connection.id,
    versionId: version.id,
    grantedByUserId: ownerId
  });
  assert.equal(reshared.reused, false);
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
  assert.equal(openOriginalCount, evidenceOpenCount + 1);

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
    'audio_project.release_reviewer_grant',
    'music_rights_declaration.create',
    'music_rights_declaration.evidence_access',
    'music_rights_declaration.verified',
    'music_release.readiness_pass'
  ]) {
    assert.ok(collaborationAudit.some((event) => event.eventType === eventType), `Missing audit event: ${eventType}`);
  }
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

  console.log('Audio file collaboration integration passed: release draft idempotency/edit conflicts, artwork, credits, immutable independently-reviewed rights, readiness, selected-version share, exact download, review, approval, revoke, cascade, replay denial, and audit are durable.');
} finally {
  await db.$client.end();
  rmSync(objectRoot, { recursive: true, force: true });
}
