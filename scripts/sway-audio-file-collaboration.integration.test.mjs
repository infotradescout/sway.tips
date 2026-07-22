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
  auditEvents,
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

  const actorIds = [randomUUID(), randomUUID(), randomUUID()].sort();
  const [ownerId, reviewerId, outsiderId] = actorIds;
  await db.insert(users).values([
    { id: ownerId, email: `owner-${ownerId}@example.test`, emailVerifiedAt: new Date() },
    { id: reviewerId, email: `reviewer-${reviewerId}@example.test`, emailVerifiedAt: new Date() },
    { id: outsiderId, email: `outsider-${outsiderId}@example.test`, emailVerifiedAt: new Date() }
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

  const [connection] = await db.insert(audioFileConnections).values({
    memberOneUserId: ownerId,
    memberTwoUserId: reviewerId,
    createdByUserId: ownerId,
    createdFromPurpose: 'send_files'
  }).returning();

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
  assert.equal(openOriginalCount, 0, 'Denied download must not reach object storage.');

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
  assert.equal(openOriginalCount, 1);

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
  assert.equal(openOriginalCount, 1, 'Revoked replay must fail before object storage.');

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
  assert.equal(openOriginalCount, 1);

  const collaborationAudit = await db
    .select({ eventType: auditEvents.eventType })
    .from(auditEvents);
  for (const eventType of [
    'audio_file_access.share',
    'audio_file_access.download',
    'audio_review.comment',
    'audio_review.approved',
    'audio_file_access.revoke',
    'audio_file_pairing.connection_revoked'
  ]) {
    assert.ok(collaborationAudit.some((event) => event.eventType === eventType), `Missing audit event: ${eventType}`);
  }

  console.log('Audio file collaboration integration passed: selected-version share, exact download, review, approval, revoke, cascade, replay denial, and audit are durable.');
} finally {
  await db.$client.end();
  rmSync(objectRoot, { recursive: true, force: true });
}
