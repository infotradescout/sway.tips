import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createSwayDb } from '../src/db/client.ts';
import {
  audioCandidateRevisions,
  audioFileAccessGrants,
  audioFileConnections,
  audioObjectCleanupReceipts,
  audioProviderOperationAttempts,
  audioProviderOperations,
  audioProjectAccessGrants,
  audioProjectAssetVersions,
  audioUploadSessions,
  auditEvents,
  performerCapabilityGrantEvents,
  performers,
  users
} from '../src/db/schema.ts';
import { createAudioFileCollaborationService } from '../src/server/audio-file-collaboration-service.ts';
import { createLocalAudioObjectStore } from '../src/server/audio-object-storage-local.ts';
import {
  AudioStorageQuotaError,
  createAudioPublishingService
} from '../src/server/audio-publishing-service.ts';
import { assertDisposableDatabaseTarget } from './lib/disposable-database-guard.mjs';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const MIB = 1024 * 1024;
const PART_SIZE_BYTES = 5 * MIB;
const MAX_CANDIDATE_BYTES = 8 * MIB;
const WORKSPACE_LIMIT_BYTES = 12 * MIB;
const strictRealPostgresProof = process.argv.includes('--strict-real-postgres')
  || process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF === 'true';
const embeddedPostgresProof = process.argv.includes('--embedded-postgres');

if (strictRealPostgresProof && embeddedPostgresProof) {
  throw new Error('Choose either the embedded candidate proof or the strict real-PostgreSQL proof, not both.');
}

const realDatabaseUrl = process.env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL?.trim();
const genericDatabaseUrl = process.env.DATABASE_URL?.trim();
if (strictRealPostgresProof && !realDatabaseUrl) {
  throw new Error('SWAY_REAL_POSTGRES_PROOF_DATABASE_URL is required for the strict real-PostgreSQL candidate proof.');
}
if (strictRealPostgresProof && process.env.SWAY_ALLOW_DISPOSABLE_DATABASE_RESET !== 'true') {
  throw new Error('SWAY_ALLOW_DISPOSABLE_DATABASE_RESET=true is required for the strict real-PostgreSQL candidate proof.');
}
if (!strictRealPostgresProof && realDatabaseUrl) {
  throw new Error('SWAY_REAL_POSTGRES_PROOF_DATABASE_URL may be used only with the strict real-PostgreSQL candidate proof.');
}
if (embeddedPostgresProof && genericDatabaseUrl) {
  throw new Error('The embedded candidate proof refuses DATABASE_URL; use the strict real-PostgreSQL proof for an external database.');
}
if (!strictRealPostgresProof && genericDatabaseUrl && process.env.SWAY_DISPOSABLE_MIGRATION_PROOF !== '1') {
  throw new Error('Configured candidate integration requires SWAY_DISPOSABLE_MIGRATION_PROOF=1.');
}

const managedDatabaseProof = strictRealPostgresProof || !genericDatabaseUrl
  ? await startEmbeddedPostgresProof('audio_candidate_revisions')
  : null;
if (strictRealPostgresProof && managedDatabaseProof?.kind !== 'real-postgres') {
  throw new Error('Strict candidate evidence requires an attested standalone PostgreSQL server.');
}
if (!strictRealPostgresProof && managedDatabaseProof?.kind !== 'embedded-postgres') {
  throw new Error('The local candidate integration must use its isolated embedded PostgreSQL fixture.');
}
const databaseUrl = managedDatabaseProof?.databaseUrl || genericDatabaseUrl;
if (!databaseUrl) throw new Error('A disposable candidate-revision database is required.');
if (!managedDatabaseProof) {
  assertDisposableDatabaseTarget({
    databaseUrl,
    label: 'Audio candidate revision integration proof'
  });
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function wavFixture(label, byteSize = 844) {
  const dataSize = Math.max(800, byteSize - 44);
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

function malformedWavFixture() {
  const body = Buffer.alloc(44);
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
  body.writeUInt32LE(0, 40);
  return body;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function errorChainMatches(error, pattern) {
  let current = error;
  while (current) {
    if (pattern.test(current instanceof Error ? current.message : String(current))) return true;
    current = typeof current === 'object' && current !== null ? current.cause : null;
  }
  return false;
}

function createProviderBarrier() {
  let signalStarted;
  let release;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  return {
    started,
    release: () => release(),
    async wait(identity) {
      signalStarted(identity);
      await blocked;
    }
  };
}

const db = createSwayDb(databaseUrl);
const objectRoot = mkdtempSync(join(tmpdir(), 'sway-audio-candidates-'));

try {
  if (!managedDatabaseProof) await migrate(db, { migrationsFolder: 'drizzle' });

  const [ownerUserId, managerUserId, collaboratorUserId, outsiderUserId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID()
  ].sort();
  await db.insert(users).values([
    { id: ownerUserId, email: `candidate-owner-${ownerUserId}@example.test`, emailVerifiedAt: new Date() },
    { id: managerUserId, email: `candidate-manager-${managerUserId}@example.test`, emailVerifiedAt: new Date() },
    { id: collaboratorUserId, email: `candidate-collaborator-${collaboratorUserId}@example.test`, emailVerifiedAt: new Date() },
    { id: outsiderUserId, email: `candidate-outsider-${outsiderUserId}@example.test`, emailVerifiedAt: new Date() }
  ]);
  const [performer] = await db.insert(performers).values({
    ownerUserId,
    displayName: 'Candidate revision proof'
  }).returning();

  const localStore = createLocalAudioObjectStore({
    SWAY_AUDIO_LOCAL_OBJECT_DIR: objectRoot,
    SWAY_AUDIO_LOCAL_BUCKET: 'candidate-proof'
  });
  let failNextDiscard = false;
  let beginAfterSuccessBarrier = null;
  let writeBeforeProviderBarrier = null;
  let assemblyAfterSuccessBarrier = null;
  const store = {
    ...localStore,
    async beginUpload(input) {
      const identity = await localStore.beginUpload(input);
      if (beginAfterSuccessBarrier) await beginAfterSuccessBarrier.wait(identity);
      return identity;
    },
    async writePart(input) {
      if (writeBeforeProviderBarrier) await writeBeforeProviderBarrier.wait(input.identity);
      return localStore.writePart(input);
    },
    async assembleParts(input) {
      const result = await localStore.assembleParts(input);
      if (assemblyAfterSuccessBarrier) await assemblyAfterSuccessBarrier.wait(input.identity);
      return result;
    },
    async discardUpload(identity) {
      if (failNextDiscard) {
        failNextDiscard = false;
        throw new Error('forced candidate object cleanup failure');
      }
      return localStore.discardUpload(identity);
    }
  };
  await store.verifyReady();

  const publishing = createAudioPublishingService({
    db,
    store,
    collaboratorRevisionUploadsEnabled: true,
    workspaceLimitBytes: WORKSPACE_LIMIT_BYTES,
    workingObjectLimit: 10
  });
  const disabledPublishing = createAudioPublishingService({ db, store });
  const collaboration = createAudioFileCollaborationService({
    db,
    store,
    collaboratorRevisionUploadsEnabled: true,
    beforeGrantRevocation: (tx, input) => publishing
      .reserveCollaboratorRevisionAuthorityCleanupIntent(tx, {
        actorUserId: input.actorUserId,
        grantId: input.grantId,
        cleanupReason: 'candidate_grant_revoked'
      })
      .then(() => undefined)
  });
  const disabledCollaboration = createAudioFileCollaborationService({ db, store });

  await assert.rejects(
    disabledPublishing.initiateCollaboratorRevisionUpload({
      grantId: randomUUID(),
      actorUserId: collaboratorUserId,
      originalFilename: 'disabled.wav',
      mimeType: 'audio/wav',
      expectedByteSize: 1,
      expectedSha256: '0'.repeat(64),
      idempotencyKey: 'disabled'
    }),
    /Private candidate uploads are disabled/
  );
  await assert.rejects(
    disabledCollaboration.grantCandidateRevisionUpload({
      connectionId: randomUUID(),
      versionId: randomUUID(),
      grantedByUserId: ownerUserId,
      idempotencyKey: 'disabled',
      maxCandidateBytes: MAX_CANDIDATE_BYTES
    }),
    /Private candidate uploads are disabled/
  );

  const project = await publishing.createProject({
    performerId: performer.id,
    actorUserId: ownerUserId,
    title: 'Private candidate proof'
  });
  const sourceBody = wavFixture('source version');
  const sourceUpload = await publishing.initiateUpload({
    projectId: project.id,
    actorUserId: ownerUserId,
    title: 'source.wav',
    assetKind: 'master_audio',
    originalFilename: 'source.wav',
    mimeType: 'audio/wav',
    expectedByteSize: sourceBody.byteLength,
    expectedSha256: sha256(sourceBody),
    idempotencyKey: `source:${sha256(sourceBody)}`
  });
  await publishing.writeUploadPart({
    uploadSessionId: sourceUpload.id,
    actorUserId: ownerUserId,
    partNumber: 1,
    body: sourceBody
  });
  const sourceVersion = await publishing.completeAndSealUpload({
    uploadSessionId: sourceUpload.id,
    actorUserId: ownerUserId,
    performerId: performer.id
  });
  const [connection] = await db.insert(audioFileConnections).values({
    memberOneUserId: ownerUserId,
    memberTwoUserId: collaboratorUserId,
    createdByUserId: ownerUserId,
    createdFromPurpose: 'request_files'
  }).returning();
  const [managerConnectionMemberOneUserId, managerConnectionMemberTwoUserId] = [
    managerUserId,
    collaboratorUserId
  ].sort();
  const [managerConnection] = await db.insert(audioFileConnections).values({
    memberOneUserId: managerConnectionMemberOneUserId,
    memberTwoUserId: managerConnectionMemberTwoUserId,
    createdByUserId: managerUserId,
    createdFromPurpose: 'request_files'
  }).returning();

  const recordCapability = async (decision, label) => {
    const key = `candidate-capability:${decision}:${label}:${randomUUID()}`;
    await db.insert(performerCapabilityGrantEvents).values({
      performerId: performer.id,
      capability: 'private_collaboration',
      decision,
      actorType: 'system',
      actorUserId: null,
      reason: `Disposable private collaboration ${decision} proof`,
      evidence: { environment: 'test', reference: key },
      expiresAt: null,
      idempotencyKeyHash: sha256(Buffer.from(key))
    });
  };
  const createManagerAuthority = async (label, expiresAt = null) => {
    const [authority] = await db.insert(audioProjectAccessGrants).values({
      projectId: project.id,
      granteeUserId: managerUserId,
      role: 'collaborator',
      canUploadVersions: false,
      canDownloadOriginals: false,
      canComment: true,
      canApprove: false,
      canManageRelease: false,
      canManageAccess: true,
      grantedByUserId: ownerUserId,
      expiresAt
    }).returning();
    assert.ok(authority, `${label} project authority must be persisted.`);
    return authority;
  };
  const revokeManagerAuthority = async (authorityId, reason) => {
    const [revoked] = await db
      .update(audioProjectAccessGrants)
      .set({
        revokedAt: new Date(),
        revokedByUserId: ownerUserId,
        revocationReason: reason
      })
      .where(eq(audioProjectAccessGrants.id, authorityId))
      .returning();
    assert.ok(revoked?.revokedAt, 'Manager project authority must be durably revoked.');
  };
  const waitPast = async (expiresAt) => {
    const waitMs = Math.max(0, expiresAt.getTime() - Date.now() + 100);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  };

  await assert.rejects(
    collaboration.grantCandidateRevisionUpload({
      connectionId: connection.id,
      versionId: sourceVersion.id,
      grantedByUserId: ownerUserId,
      idempotencyKey: 'capability-required',
      maxCandidateBytes: MAX_CANDIDATE_BYTES,
      expiresInHours: 24
    }),
    (error) => errorChainMatches(error, /Current private_collaboration capability authorization is required/)
  );
  await recordCapability('granted', 'initial');

  const initiationAuthority = await createManagerAuthority('initiation-revocation');
  const initiationAuthorityGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: managerConnection.id,
    versionId: sourceVersion.id,
    grantedByUserId: managerUserId,
    idempotencyKey: 'project-authority-revoked-before-initiation',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  await revokeManagerAuthority(initiationAuthority.id, 'Prove project authority revocation before candidate initiation.');
  await assert.rejects(
    publishing.initiateCollaboratorRevisionUpload({
      grantId: initiationAuthorityGrant.grant.id,
      actorUserId: collaboratorUserId,
      originalFilename: 'authority-revoked-before-initiation.wav',
      mimeType: 'audio/wav',
      expectedByteSize: 844,
      expectedSha256: sha256(wavFixture('authority initiation revoke')),
      idempotencyKey: 'authority-revoked-before-initiation-upload'
    }),
    (error) => errorChainMatches(error, /issuing project authority to remain active/i)
  );
  await collaboration.revokeGrant({
    grantId: initiationAuthorityGrant.grant.id,
    userId: managerUserId,
    reason: 'Close initiation authority proof.'
  });

  const initiationAuthorityExpiry = new Date(Date.now() + 2_000);
  const expiringInitiationAuthority = await createManagerAuthority('initiation-expiry', initiationAuthorityExpiry);
  const expiringInitiationGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: managerConnection.id,
    versionId: sourceVersion.id,
    grantedByUserId: managerUserId,
    idempotencyKey: 'project-authority-expires-before-initiation',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  await waitPast(initiationAuthorityExpiry);
  const expiringInitiationBody = wavFixture('authority expires before initiation');
  await assert.rejects(
    publishing.initiateCollaboratorRevisionUpload({
      grantId: expiringInitiationGrant.grant.id,
      actorUserId: collaboratorUserId,
      originalFilename: 'authority-expires-before-initiation.wav',
      mimeType: 'audio/wav',
      expectedByteSize: expiringInitiationBody.byteLength,
      expectedSha256: sha256(expiringInitiationBody),
      idempotencyKey: 'authority-expires-before-initiation-upload'
    }),
    (error) => errorChainMatches(error, /issuing project authority to remain active/i)
  );
  await collaboration.revokeGrant({
    grantId: expiringInitiationGrant.grant.id,
    userId: managerUserId,
    reason: 'Close initiation authority expiry proof.'
  });
  await revokeManagerAuthority(expiringInitiationAuthority.id, 'Close expired initiation authority proof.');

  const partAuthorityExpiry = new Date(Date.now() + 2_000);
  const partAuthority = await createManagerAuthority('part-expiry', partAuthorityExpiry);
  const partAuthorityGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: managerConnection.id,
    versionId: sourceVersion.id,
    grantedByUserId: managerUserId,
    idempotencyKey: 'project-authority-expires-before-part',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const partAuthorityBody = wavFixture('authority expires before part');
  const partAuthoritySession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: partAuthorityGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'authority-expires-before-part.wav',
    mimeType: 'audio/wav',
    expectedByteSize: partAuthorityBody.byteLength,
    expectedSha256: sha256(partAuthorityBody),
    idempotencyKey: 'authority-expires-before-part-upload'
  });
  await waitPast(partAuthorityExpiry);
  await assert.rejects(
    publishing.writeUploadPart({
      grantId: partAuthorityGrant.grant.id,
      uploadSessionId: partAuthoritySession.id,
      actorUserId: collaboratorUserId,
      partNumber: 1,
      body: partAuthorityBody
    }),
    (error) => errorChainMatches(error, /issuing project authority to remain active/i)
  );
  await collaboration.revokeGrant({
    grantId: partAuthorityGrant.grant.id,
    userId: managerUserId,
    reason: 'Close part authority expiry proof.'
  });
  const partAuthorityCleanup = await publishing.abortCollaboratorRevisionUploadSessions({
    actorUserId: managerUserId,
    grantId: partAuthorityGrant.grant.id,
    cleanupReason: 'candidate_grant_revoked'
  });
  assert.deepEqual(partAuthorityCleanup.abortedSessionIds, [partAuthoritySession.id]);
  await revokeManagerAuthority(partAuthority.id, 'Close expired project authority proof.');

  const revokedPartAuthority = await createManagerAuthority('part-revocation');
  const revokedPartGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: managerConnection.id,
    versionId: sourceVersion.id,
    grantedByUserId: managerUserId,
    idempotencyKey: 'project-authority-revoked-before-part',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const revokedPartBody = wavFixture('authority revoked before part');
  const revokedPartSession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: revokedPartGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'authority-revoked-before-part.wav',
    mimeType: 'audio/wav',
    expectedByteSize: revokedPartBody.byteLength,
    expectedSha256: sha256(revokedPartBody),
    idempotencyKey: 'authority-revoked-before-part-upload'
  });
  await revokeManagerAuthority(revokedPartAuthority.id, 'Prove project authority revocation before part upload.');
  await assert.rejects(
    publishing.writeUploadPart({
      grantId: revokedPartGrant.grant.id,
      uploadSessionId: revokedPartSession.id,
      actorUserId: collaboratorUserId,
      partNumber: 1,
      body: revokedPartBody
    }),
    (error) => errorChainMatches(error, /issuing project authority to remain active/i)
  );
  await collaboration.revokeGrant({
    grantId: revokedPartGrant.grant.id,
    userId: managerUserId,
    reason: 'Close part authority revocation proof.'
  });
  const revokedPartCleanup = await publishing.abortCollaboratorRevisionUploadSessions({
    actorUserId: managerUserId,
    grantId: revokedPartGrant.grant.id,
    cleanupReason: 'candidate_grant_revoked'
  });
  assert.deepEqual(revokedPartCleanup.abortedSessionIds, [revokedPartSession.id]);

  const completionAuthority = await createManagerAuthority('completion-revocation');
  const completionAuthorityGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: managerConnection.id,
    versionId: sourceVersion.id,
    grantedByUserId: managerUserId,
    idempotencyKey: 'project-authority-revoked-before-completion',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const completionAuthorityBody = wavFixture('authority revoked before completion');
  const completionAuthoritySession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: completionAuthorityGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'authority-revoked-before-completion.wav',
    mimeType: 'audio/wav',
    expectedByteSize: completionAuthorityBody.byteLength,
    expectedSha256: sha256(completionAuthorityBody),
    idempotencyKey: 'authority-revoked-before-completion-upload'
  });
  await publishing.writeUploadPart({
    grantId: completionAuthorityGrant.grant.id,
    uploadSessionId: completionAuthoritySession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: completionAuthorityBody
  });
  await revokeManagerAuthority(completionAuthority.id, 'Prove project authority revocation before completion.');
  await assert.rejects(
    publishing.completeAndSealCollaboratorRevision({
      grantId: completionAuthorityGrant.grant.id,
      uploadSessionId: completionAuthoritySession.id,
      actorUserId: collaboratorUserId
    }),
    (error) => errorChainMatches(error, /issuing project authority to remain active/i)
  );
  await collaboration.revokeGrant({
    grantId: completionAuthorityGrant.grant.id,
    userId: managerUserId,
    reason: 'Close completion authority proof.'
  });
  const completionAuthorityCleanup = await publishing.abortCollaboratorRevisionUploadSessions({
    actorUserId: managerUserId,
    grantId: completionAuthorityGrant.grant.id,
    cleanupReason: 'candidate_grant_revoked'
  });
  assert.deepEqual(completionAuthorityCleanup.abortedSessionIds, [completionAuthoritySession.id]);

  const completionAuthorityExpiry = new Date(Date.now() + 2_000);
  const expiringCompletionAuthority = await createManagerAuthority('completion-expiry', completionAuthorityExpiry);
  const expiringCompletionGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: managerConnection.id,
    versionId: sourceVersion.id,
    grantedByUserId: managerUserId,
    idempotencyKey: 'project-authority-expires-before-completion',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const expiringCompletionBody = wavFixture('authority expires before completion');
  const expiringCompletionSession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: expiringCompletionGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'authority-expires-before-completion.wav',
    mimeType: 'audio/wav',
    expectedByteSize: expiringCompletionBody.byteLength,
    expectedSha256: sha256(expiringCompletionBody),
    idempotencyKey: 'authority-expires-before-completion-upload'
  });
  await publishing.writeUploadPart({
    grantId: expiringCompletionGrant.grant.id,
    uploadSessionId: expiringCompletionSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: expiringCompletionBody
  });
  await waitPast(completionAuthorityExpiry);
  await assert.rejects(
    publishing.completeAndSealCollaboratorRevision({
      grantId: expiringCompletionGrant.grant.id,
      uploadSessionId: expiringCompletionSession.id,
      actorUserId: collaboratorUserId
    }),
    (error) => errorChainMatches(error, /issuing project authority to remain active/i)
  );
  await collaboration.revokeGrant({
    grantId: expiringCompletionGrant.grant.id,
    userId: managerUserId,
    reason: 'Close completion authority expiry proof.'
  });
  const expiringCompletionCleanup = await publishing.abortCollaboratorRevisionUploadSessions({
    actorUserId: managerUserId,
    grantId: expiringCompletionGrant.grant.id,
    cleanupReason: 'candidate_grant_revoked'
  });
  assert.deepEqual(expiringCompletionCleanup.abortedSessionIds, [expiringCompletionSession.id]);
  await revokeManagerAuthority(expiringCompletionAuthority.id, 'Close expired completion authority proof.');

  const firstGrantResult = await collaboration.grantCandidateRevisionUpload({
    connectionId: connection.id,
    versionId: sourceVersion.id,
    grantedByUserId: ownerUserId,
    idempotencyKey: 'first-candidate-window',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  assert.equal(firstGrantResult.reused, false);
  assert.equal(firstGrantResult.grant.grantPurpose, 'collaborator_revision_upload');
  assert.equal(firstGrantResult.grant.canUploadNewVersion, true);
  assert.equal(firstGrantResult.grant.canDownloadOriginal, false);
  assert.equal(firstGrantResult.grant.maxCandidateBytes, MAX_CANDIDATE_BYTES);
  const firstGrantReplay = await collaboration.grantCandidateRevisionUpload({
    connectionId: connection.id,
    versionId: sourceVersion.id,
    grantedByUserId: ownerUserId,
    idempotencyKey: 'first-candidate-window',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  assert.equal(firstGrantReplay.reused, true);
  assert.equal(firstGrantReplay.grant.id, firstGrantResult.grant.id);
  await assert.rejects(
    collaboration.listReviewEvents({
      grantId: firstGrantResult.grant.id,
      userId: collaboratorUserId
    }),
    (error) => error?.status === 403 && /review-share grant required/i.test(error.message)
  );
  await assert.rejects(
    collaboration.addReviewEvent({
      grantId: firstGrantResult.grant.id,
      userId: collaboratorUserId,
      eventType: 'comment',
      body: 'Candidate grants must not enter ordinary review threads.'
    }),
    (error) => error?.status === 403 && /review-share grant required/i.test(error.message)
  );
  await assert.rejects(
    collaboration.grantCandidateRevisionUpload({
      connectionId: connection.id,
      versionId: sourceVersion.id,
      grantedByUserId: ownerUserId,
      idempotencyKey: 'first-candidate-window',
      maxCandidateBytes: MAX_CANDIDATE_BYTES,
      expiresInHours: 48
    }),
    (error) => error?.status === 409 && error?.code === 'candidate_grant_intent_conflict'
  );
  await assert.rejects(
    collaboration.grantCandidateRevisionUpload({
      connectionId: connection.id,
      versionId: sourceVersion.id,
      grantedByUserId: ownerUserId,
      idempotencyKey: 'different-key-same-active-intent',
      maxCandidateBytes: MAX_CANDIDATE_BYTES,
      expiresInHours: 24
    }),
    (error) => error?.status === 409 && error?.code === 'active_candidate_grant_idempotency_conflict'
  );
  await assert.rejects(
    collaboration.grantCandidateRevisionUpload({
      connectionId: connection.id,
      versionId: sourceVersion.id,
      grantedByUserId: ownerUserId,
      idempotencyKey: 'different-key-different-active-intent',
      maxCandidateBytes: MAX_CANDIDATE_BYTES,
      expiresInHours: 48
    }),
    (error) => error?.status === 409 && error?.code === 'active_candidate_grant_idempotency_conflict'
  );

  const firstBody = wavFixture('revoked candidate');
  await assert.rejects(
    publishing.initiateCollaboratorRevisionUpload({
      grantId: firstGrantResult.grant.id,
      actorUserId: outsiderUserId,
      originalFilename: 'outsider.wav',
      mimeType: 'audio/wav',
      expectedByteSize: firstBody.byteLength,
      expectedSha256: sha256(firstBody),
      idempotencyKey: 'outsider-denied'
    }),
    (error) => error?.status === 403
  );
  await assert.rejects(
    publishing.initiateCollaboratorRevisionUpload({
      grantId: firstGrantResult.grant.id,
      actorUserId: collaboratorUserId,
      originalFilename: 'over-creator-cap.wav',
      mimeType: 'audio/wav',
      expectedByteSize: MAX_CANDIDATE_BYTES + 1,
      expectedSha256: 'b'.repeat(64),
      idempotencyKey: 'creator-byte-cap-denied'
    }),
    (error) => error?.status === 413
      && error?.code === 'candidate_byte_ceiling_exceeded'
      && error?.maxCandidateBytes === MAX_CANDIDATE_BYTES
      && error?.requestedBytes === MAX_CANDIDATE_BYTES + 1
  );
  assert.equal(
    (await db.select().from(audioUploadSessions).where(eq(audioUploadSessions.collaboratorFileGrantId, firstGrantResult.grant.id))).length,
    0,
    'A candidate above the creator-approved byte ceiling must not reserve storage or create an upload session.'
  );
  const firstSession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: firstGrantResult.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'revoked-candidate.wav',
    mimeType: 'audio/wav',
    expectedByteSize: firstBody.byteLength,
    expectedSha256: sha256(firstBody),
    idempotencyKey: 'first-candidate-upload'
  });
  const firstSessionReplay = await publishing.initiateCollaboratorRevisionUpload({
    grantId: firstGrantResult.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'revoked-candidate.wav',
    mimeType: 'audio/wav',
    expectedByteSize: firstBody.byteLength,
    expectedSha256: sha256(firstBody),
    idempotencyKey: 'first-candidate-upload'
  });
  assert.equal(firstSessionReplay.id, firstSession.id);
  await assert.rejects(
    publishing.initiateCollaboratorRevisionUpload({
      grantId: firstGrantResult.grant.id,
      actorUserId: collaboratorUserId,
      originalFilename: 'changed-intent.wav',
      mimeType: 'audio/wav',
      expectedByteSize: firstBody.byteLength,
      expectedSha256: sha256(firstBody),
      idempotencyKey: 'changed-intent'
    }),
    (error) => error?.status === 409 && error?.code === 'candidate_upload_intent_conflict'
  );

  await recordCapability('revoked', 'part-denial');
  await assert.rejects(
    publishing.writeUploadPart({
      grantId: firstGrantResult.grant.id,
      uploadSessionId: firstSession.id,
      actorUserId: collaboratorUserId,
      partNumber: 1,
      body: firstBody
    }),
    (error) => errorChainMatches(error, /Current private_collaboration capability authorization is required/)
  );
  await recordCapability('granted', 'part-reenabled');
  await assert.rejects(
    publishing.writeUploadPart({
      grantId: randomUUID(),
      uploadSessionId: firstSession.id,
      actorUserId: collaboratorUserId,
      partNumber: 1,
      body: firstBody
    }),
    (error) => error?.status === 403 && /Exact collaborator revision upload authority required/.test(error.message)
  );
  const firstPart = await publishing.writeUploadPart({
    grantId: firstGrantResult.grant.id,
    uploadSessionId: firstSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: firstBody
  });
  const exactReplay = await publishing.writeUploadPart({
    grantId: firstGrantResult.grant.id,
    uploadSessionId: firstSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: firstBody
  });
  assert.deepEqual(exactReplay, firstPart, 'Exact part replay must return the original durable receipt.');
  const changedReplay = Buffer.from(firstBody);
  changedReplay[changedReplay.length - 1] ^= 0xff;
  await assert.rejects(
    publishing.writeUploadPart({
      grantId: firstGrantResult.grant.id,
      uploadSessionId: firstSession.id,
      actorUserId: collaboratorUserId,
      partNumber: 1,
      body: changedReplay
    }),
    (error) => error?.status === 409 && error?.code === 'upload_part_replay_conflict'
  );

  const usageBeforeGrantRevocationCleanup = await publishing.getStorageUsage({ performerId: performer.id });
  assert.equal(usageBeforeGrantRevocationCleanup.reservedBytes, firstBody.byteLength);
  await collaboration.revokeGrant({
    grantId: firstGrantResult.grant.id,
    userId: ownerUserId,
    reason: 'Disposable finalize-after-revoke denial.'
  });
  const grantRevocationCleanup = await publishing.abortCollaboratorRevisionUploadSessions({
    actorUserId: ownerUserId,
    grantId: firstGrantResult.grant.id,
    cleanupReason: 'candidate_grant_revoked'
  });
  assert.deepEqual(grantRevocationCleanup.abortedSessionIds, [firstSession.id]);
  assert.equal(grantRevocationCleanup.pendingReceiptCount, 0);
  assert.equal(
    (await db.select().from(audioUploadSessions).where(eq(audioUploadSessions.id, firstSession.id)))[0].uploadStatus,
    'aborted'
  );
  const usageAfterGrantRevocationCleanup = await publishing.getStorageUsage({ performerId: performer.id });
  assert.equal(usageAfterGrantRevocationCleanup.reservedBytes, 0);
  assert.equal(usageAfterGrantRevocationCleanup.workingBytes, sourceBody.byteLength);
  await assert.rejects(
    publishing.completeAndSealCollaboratorRevision({
      grantId: firstGrantResult.grant.id,
      uploadSessionId: firstSession.id,
      actorUserId: collaboratorUserId
    }),
    (error) => errorChainMatches(error, /active exact-file upload grant/i)
  );

  // If CreateMultipart succeeds but grant authority ends before the session
  // transaction commits, the durable worker reconciles the exact sessionless
  // intent, deletes provider state, terminalizes the attempt, and releases its
  // reservation without requiring the revoked collaborator to replay.
  const initiationRaceGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: connection.id,
    versionId: sourceVersion.id,
    grantedByUserId: ownerUserId,
    idempotencyKey: 'initiation-finalization-revocation-race',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const initiationRaceBody = wavFixture('sessionless initiation authority race', 1_300);
  beginAfterSuccessBarrier = createProviderBarrier();
  const initiationRacePromise = publishing.initiateCollaboratorRevisionUpload({
    grantId: initiationRaceGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'sessionless-race.wav',
    mimeType: 'audio/wav',
    expectedByteSize: initiationRaceBody.byteLength,
    expectedSha256: sha256(initiationRaceBody),
    idempotencyKey: 'sessionless-race-upload'
  });
  const initiationRaceIdentity = await beginAfterSuccessBarrier.started;
  const usageWithSessionlessReservation = await publishing.getStorageUsage({ performerId: performer.id });
  await collaboration.revokeGrant({
    grantId: initiationRaceGrant.grant.id,
    userId: ownerUserId,
    reason: 'Revoke after provider initiation but before DB finalization.'
  });
  const [sessionlessReceiptBeforeRecovery] = await db
    .select()
    .from(audioObjectCleanupReceipts)
    .where(eq(audioObjectCleanupReceipts.storageKey, initiationRaceIdentity.storageKey));
  assert.equal(sessionlessReceiptBeforeRecovery.cleanupStatus, 'pending');
  assert.equal(sessionlessReceiptBeforeRecovery.uploadSessionId, null);
  beginAfterSuccessBarrier.release();
  beginAfterSuccessBarrier = null;
  await assert.rejects(initiationRacePromise, (error) => errorChainMatches(error, /authority is no longer active/i));
  const [sessionlessOperationBeforeRecovery] = await db
    .select()
    .from(audioProviderOperations)
    .where(and(
      eq(audioProviderOperations.operationType, 'initiate_multipart'),
      sql`${audioProviderOperations.requestPayload}->>'collaboratorFileGrantId' = ${initiationRaceGrant.grant.id}`
    ));
  assert.equal(sessionlessOperationBeforeRecovery.status, 'reconcile_required');
  assert.equal(sessionlessOperationBeforeRecovery.uploadSessionId, null);
  const sessionlessRecovery = await publishing.reconcileDueAudioProviderOperations({ limit: 100 });
  assert.ok(sessionlessRecovery.canceledOperationIds.includes(sessionlessOperationBeforeRecovery.id));
  const [sessionlessOperationAfterRecovery] = await db
    .select()
    .from(audioProviderOperations)
    .where(eq(audioProviderOperations.id, sessionlessOperationBeforeRecovery.id));
  assert.equal(sessionlessOperationAfterRecovery.status, 'canceled');
  const [sessionlessReceiptAfterRecovery] = await db
    .select()
    .from(audioObjectCleanupReceipts)
    .where(eq(audioObjectCleanupReceipts.id, sessionlessReceiptBeforeRecovery.id));
  assert.equal(sessionlessReceiptAfterRecovery.cleanupStatus, 'completed');
  assert.deepEqual(await store.reconcileCleanup(initiationRaceIdentity), {
    status: 'absent',
    multipartPresent: false,
    stagingPresent: false,
    sealedPresent: false
  });
  const sessionlessAttempts = await db
    .select()
    .from(audioProviderOperationAttempts)
    .where(eq(audioProviderOperationAttempts.operationId, sessionlessOperationBeforeRecovery.id));
  assert.ok(sessionlessAttempts.length >= 2);
  assert.ok(sessionlessAttempts.every((attempt) => attempt.outcome !== 'active'));
  const usageAfterSessionlessRecovery = await publishing.getStorageUsage({ performerId: performer.id });
  assert.ok(usageAfterSessionlessRecovery.reservedBytes < usageWithSessionlessReservation.reservedBytes);

  // Grant revocation installs a durable cleanup operation and receipt while a
  // part provider call is already leased. The late provider write cannot be
  // retried after the fence; cleanup then removes it and terminalizes the part.
  const partRaceGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: connection.id,
    versionId: sourceVersion.id,
    grantedByUserId: ownerUserId,
    idempotencyKey: 'part-revocation-cleanup-barrier',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const partRaceBody = wavFixture('part authority cleanup barrier', 1_400);
  const partRaceSession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: partRaceGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'part-race.wav',
    mimeType: 'audio/wav',
    expectedByteSize: partRaceBody.byteLength,
    expectedSha256: sha256(partRaceBody),
    idempotencyKey: 'part-race-upload'
  });
  writeBeforeProviderBarrier = createProviderBarrier();
  const latePartPromise = publishing.writeUploadPart({
    grantId: partRaceGrant.grant.id,
    uploadSessionId: partRaceSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: partRaceBody
  });
  await writeBeforeProviderBarrier.started;
  await collaboration.revokeGrant({
    grantId: partRaceGrant.grant.id,
    userId: ownerUserId,
    reason: 'Revoke while part provider I/O is leased.'
  });
  const usageBeforePartRaceCleanup = await publishing.getStorageUsage({ performerId: performer.id });
  const deferredPartCleanup = await publishing.abortCollaboratorRevisionUploadSessions({
    actorUserId: ownerUserId,
    grantId: partRaceGrant.grant.id,
    cleanupReason: 'candidate_grant_revoked'
  });
  assert.equal(deferredPartCleanup.abortedCount, 0);
  assert.equal(deferredPartCleanup.pendingReceiptCount, 1);
  const [partCleanupFence] = await db
    .select()
    .from(audioProviderOperations)
    .where(and(
      eq(audioProviderOperations.uploadSessionId, partRaceSession.id),
      eq(audioProviderOperations.operationType, 'discard_upload')
    ));
  assert.equal(partCleanupFence.status, 'pending');
  writeBeforeProviderBarrier.release();
  writeBeforeProviderBarrier = null;
  await assert.rejects(latePartPromise, (error) => errorChainMatches(error, /authority is no longer active/i));
  const retriedPartCleanup = await publishing.retryPendingAudioObjectCleanupReceipts({ limit: 100 });
  assert.ok(retriedPartCleanup.completedCount >= 1);
  assert.equal((await db.select().from(audioUploadSessions).where(eq(audioUploadSessions.id, partRaceSession.id)))[0].uploadStatus, 'aborted');
  assert.deepEqual(await store.reconcileCleanup({
    storageProvider: partRaceSession.storageProvider,
    storageBucket: partRaceSession.storageBucket,
    storageKey: partRaceSession.storageKey,
    providerUploadId: partRaceSession.providerUploadId
  }), {
    status: 'absent',
    multipartPresent: false,
    stagingPresent: false,
    sealedPresent: false
  });
  const partRaceOperations = await db
    .select()
    .from(audioProviderOperations)
    .where(eq(audioProviderOperations.uploadSessionId, partRaceSession.id));
  assert.ok(partRaceOperations.every((operation) => ['succeeded', 'canceled', 'dead_letter'].includes(operation.status)));
  const partRaceAttempts = await db
    .select()
    .from(audioProviderOperationAttempts)
    .where(inArray(audioProviderOperationAttempts.operationId, partRaceOperations.map((operation) => operation.id)));
  assert.ok(partRaceAttempts.every((attempt) => attempt.outcome !== 'active'));
  const usageAfterPartRaceCleanup = await publishing.getStorageUsage({ performerId: performer.id });
  assert.ok(usageAfterPartRaceCleanup.reservedBytes < usageBeforePartRaceCleanup.reservedBytes);

  // CompleteMultipart may succeed before revocation wins the atomic DB
  // authorization recheck. The pending receipt owns the session immediately;
  // the retry worker then deletes assembled bytes and cancels the assembly op.
  const assemblyRaceGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: connection.id,
    versionId: sourceVersion.id,
    grantedByUserId: ownerUserId,
    idempotencyKey: 'assembly-finalization-revocation-race',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const assemblyRaceBody = wavFixture('assembly finalization authority race', 1_500);
  const assemblyRaceSession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: assemblyRaceGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'assembly-race.wav',
    mimeType: 'audio/wav',
    expectedByteSize: assemblyRaceBody.byteLength,
    expectedSha256: sha256(assemblyRaceBody),
    idempotencyKey: 'assembly-race-upload'
  });
  await publishing.writeUploadPart({
    grantId: assemblyRaceGrant.grant.id,
    uploadSessionId: assemblyRaceSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: assemblyRaceBody
  });
  assemblyAfterSuccessBarrier = createProviderBarrier();
  const assemblyRacePromise = publishing.completeAndSealCollaboratorRevision({
    grantId: assemblyRaceGrant.grant.id,
    uploadSessionId: assemblyRaceSession.id,
    actorUserId: collaboratorUserId
  });
  await assemblyAfterSuccessBarrier.started;
  await collaboration.revokeGrant({
    grantId: assemblyRaceGrant.grant.id,
    userId: ownerUserId,
    reason: 'Revoke after CompleteMultipart but before DB finalization.'
  });
  const usageBeforeAssemblyRaceCleanup = await publishing.getStorageUsage({ performerId: performer.id });
  const [atomicAssemblyReceipt] = await db
    .select()
    .from(audioObjectCleanupReceipts)
    .where(eq(audioObjectCleanupReceipts.uploadSessionId, assemblyRaceSession.id));
  assert.equal(atomicAssemblyReceipt.cleanupStatus, 'pending');
  const [atomicAssemblyCleanup] = await db
    .select()
    .from(audioProviderOperations)
    .where(and(
      eq(audioProviderOperations.uploadSessionId, assemblyRaceSession.id),
      eq(audioProviderOperations.operationType, 'discard_upload')
    ));
  assert.equal(atomicAssemblyCleanup.status, 'pending');
  assemblyAfterSuccessBarrier.release();
  assemblyAfterSuccessBarrier = null;
  await assert.rejects(assemblyRacePromise, (error) => errorChainMatches(error, /authority is no longer active/i));
  const [assemblyBeforeCleanup] = await db
    .select()
    .from(audioProviderOperations)
    .where(and(
      eq(audioProviderOperations.uploadSessionId, assemblyRaceSession.id),
      eq(audioProviderOperations.operationType, 'complete_multipart')
    ));
  assert.equal(assemblyBeforeCleanup.status, 'reconcile_required');
  assert.equal(assemblyBeforeCleanup.lastErrorCode, 'assembly_finalization_failed');
  const retriedAssemblyCleanup = await publishing.retryPendingAudioObjectCleanupReceipts({ limit: 100 });
  assert.ok(retriedAssemblyCleanup.completedCount >= 1);
  const [assemblyAfterCleanup] = await db
    .select()
    .from(audioProviderOperations)
    .where(eq(audioProviderOperations.id, assemblyBeforeCleanup.id));
  assert.equal(assemblyAfterCleanup.status, 'canceled');
  const [atomicAssemblyReceiptAfterCleanup] = await db
    .select()
    .from(audioObjectCleanupReceipts)
    .where(eq(audioObjectCleanupReceipts.id, atomicAssemblyReceipt.id));
  assert.equal(atomicAssemblyReceiptAfterCleanup.cleanupStatus, 'completed');
  assert.equal((await db.select().from(audioUploadSessions).where(eq(audioUploadSessions.id, assemblyRaceSession.id)))[0].uploadStatus, 'aborted');
  assert.deepEqual(await store.reconcileCleanup({
    storageProvider: assemblyRaceSession.storageProvider,
    storageBucket: assemblyRaceSession.storageBucket,
    storageKey: assemblyRaceSession.storageKey,
    providerUploadId: assemblyRaceSession.providerUploadId
  }), {
    status: 'absent',
    multipartPresent: false,
    stagingPresent: false,
    sealedPresent: false
  });
  const assemblyAttempts = await db
    .select()
    .from(audioProviderOperationAttempts)
    .where(eq(audioProviderOperationAttempts.operationId, assemblyBeforeCleanup.id));
  assert.ok(assemblyAttempts.every((attempt) => attempt.outcome !== 'active'));
  const usageAfterAssemblyRaceCleanup = await publishing.getStorageUsage({ performerId: performer.id });
  assert.ok(usageAfterAssemblyRaceCleanup.reservedBytes < usageBeforeAssemblyRaceCleanup.reservedBytes);

  const sealedGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: connection.id,
    versionId: sourceVersion.id,
    grantedByUserId: ownerUserId,
    idempotencyKey: 'sealed-candidate-window',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const candidateBody = wavFixture('sealed two-part candidate revision', PART_SIZE_BYTES + 1_024);
  assert.ok(candidateBody.byteLength > PART_SIZE_BYTES, 'Candidate proof must exercise more than one multipart chunk.');
  const candidateSession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: sealedGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'sealed-candidate.wav',
    mimeType: 'audio/wav',
    expectedByteSize: candidateBody.byteLength,
    expectedSha256: sha256(candidateBody),
    idempotencyKey: 'sealed-candidate-upload'
  });
  assert.equal(candidateSession.partSizeBytes, PART_SIZE_BYTES);
  const candidatePartOne = candidateBody.subarray(0, candidateSession.partSizeBytes);
  const candidatePartTwo = candidateBody.subarray(candidateSession.partSizeBytes);
  const candidatePartOneReceipt = await publishing.writeUploadPart({
    grantId: sealedGrant.grant.id,
    uploadSessionId: candidateSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: candidatePartOne
  });
  const candidatePartOneReplay = await publishing.writeUploadPart({
    grantId: sealedGrant.grant.id,
    uploadSessionId: candidateSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: candidatePartOne
  });
  assert.deepEqual(candidatePartOneReplay, candidatePartOneReceipt);
  const conflictingCandidatePartOne = Buffer.from(candidatePartOne);
  conflictingCandidatePartOne[conflictingCandidatePartOne.length - 1] ^= 0xff;
  await assert.rejects(
    publishing.writeUploadPart({
      grantId: sealedGrant.grant.id,
      uploadSessionId: candidateSession.id,
      actorUserId: collaboratorUserId,
      partNumber: 1,
      body: conflictingCandidatePartOne
    }),
    (error) => error?.status === 409 && error?.code === 'upload_part_replay_conflict'
  );
  await assert.rejects(
    publishing.completeAndSealCollaboratorRevision({
      grantId: sealedGrant.grant.id,
      uploadSessionId: candidateSession.id,
      actorUserId: collaboratorUserId
    }),
    /Every declared upload part is required/
  );
  await publishing.writeUploadPart({
    grantId: sealedGrant.grant.id,
    uploadSessionId: candidateSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 2,
    body: candidatePartTwo
  });
  const candidate = await publishing.completeAndSealCollaboratorRevision({
    grantId: sealedGrant.grant.id,
    uploadSessionId: candidateSession.id,
    actorUserId: collaboratorUserId
  });
  assert.equal(candidate.intakeStatus, 'private_review');
  assert.equal(candidate.sourceAssetVersionId, sourceVersion.id);
  assert.equal(candidate.sha256, sha256(candidateBody));
  assert.ok(candidate.durationMs > 0);
  const completionReplay = await publishing.completeAndSealCollaboratorRevision({
    grantId: sealedGrant.grant.id,
    uploadSessionId: candidateSession.id,
    actorUserId: collaboratorUserId
  });
  assert.equal(completionReplay.id, candidate.id);
  assert.equal(
    (await db.select().from(audioCandidateRevisions).where(eq(audioCandidateRevisions.fileAccessGrantId, sealedGrant.grant.id))).length,
    1,
    'One grant must produce at most one candidate.'
  );

  await assert.rejects(
    db.execute(sql`
      insert into audio_project_asset_versions (
        project_id, performer_id, asset_id, uploaded_by_user_id, upload_session_id,
        version_number, original_filename, storage_provider, storage_bucket, storage_key,
        mime_type, byte_size, sha256, integrity_status, integrity_verifier_key,
        integrity_verified_at, integrity_evidence, original_preserved, sealed_at
      )
      select project_id, performer_id, asset_id, uploaded_by_user_id, upload_session_id,
        99, original_filename, storage_provider, storage_bucket, storage_key,
        mime_type, byte_size, sha256, integrity_status, integrity_verifier_key,
        integrity_verified_at, integrity_evidence, original_preserved, sealed_at
      from audio_candidate_revisions where id = ${candidate.id}::uuid
    `),
    (error) => errorChainMatches(error, /cannot seal ordinary project versions/i)
  );
  await assert.rejects(
    db.update(audioCandidateRevisions)
      .set({ originalFilename: 'mutated.wav' })
      .where(eq(audioCandidateRevisions.id, candidate.id)),
    (error) => errorChainMatches(error, /immutable/i)
  );
  await assert.rejects(
    db.delete(audioCandidateRevisions).where(eq(audioCandidateRevisions.id, candidate.id)),
    (error) => errorChainMatches(error, /immutable/i)
  );

  const incomingBeforeRevoke = await collaboration.listSharedWithMe({ userId: collaboratorUserId });
  const outgoingBeforeRevoke = await collaboration.listSharedByMe({ userId: ownerUserId });
  assert.equal(incomingBeforeRevoke.find((file) => file.grantId === sealedGrant.grant.id)?.candidateId, candidate.id);
  assert.equal(outgoingBeforeRevoke.find((file) => file.grantId === sealedGrant.grant.id)?.candidateId, candidate.id);
  assert.equal(
    (await disabledCollaboration.listSharedWithMe({ userId: collaboratorUserId }))
      .some((file) => file.grantId === sealedGrant.grant.id),
    false,
    'A flag-off service must not expose candidate metadata to the collaborator list.'
  );
  const collaboratorOpen = await collaboration.openCandidateRevision({
    grantId: sealedGrant.grant.id,
    candidateId: candidate.id,
    userId: collaboratorUserId
  });
  assert.deepEqual(await streamToBuffer(collaboratorOpen.stream), candidateBody);
  await assert.rejects(
    collaboration.openCandidateRevision({
      grantId: sealedGrant.grant.id,
      candidateId: candidate.id,
      userId: outsiderUserId
    }),
    (error) => error?.status === 404 && /unavailable/i.test(error.message)
  );

  await collaboration.revokeGrant({
    grantId: sealedGrant.grant.id,
    userId: ownerUserId,
    reason: 'End collaborator candidate access.'
  });
  const completionReplayAfterGrantRevocation = await publishing.completeAndSealCollaboratorRevision({
    grantId: sealedGrant.grant.id,
    uploadSessionId: candidateSession.id,
    actorUserId: collaboratorUserId
  });
  assert.equal(
    completionReplayAfterGrantRevocation.id,
    candidate.id,
    'A lost successful completion response must remain replayable after upload authority ends.'
  );
  await assert.rejects(
    collaboration.openCandidateRevision({
      grantId: sealedGrant.grant.id,
      candidateId: candidate.id,
      userId: collaboratorUserId
    }),
    (error) => error?.status === 410
  );
  const creatorOpen = await collaboration.openCandidateRevision({
    grantId: sealedGrant.grant.id,
    candidateId: candidate.id,
    userId: ownerUserId
  });
  assert.deepEqual(await streamToBuffer(creatorOpen.stream), candidateBody);
  const incomingAfterRevoke = await collaboration.listSharedWithMe({ userId: collaboratorUserId });
  const outgoingAfterRevoke = await collaboration.listSharedByMe({ userId: ownerUserId });
  assert.equal(incomingAfterRevoke.some((file) => file.grantId === sealedGrant.grant.id), false);
  assert.equal(outgoingAfterRevoke.find((file) => file.grantId === sealedGrant.grant.id)?.candidateId, candidate.id);

  const replacementManagerAuthority = await createManagerAuthority('replacement-manager-candidate-read');
  const replacementManagerOutgoing = await collaboration.listSharedByMe({ userId: managerUserId });
  assert.equal(
    replacementManagerOutgoing.find((file) => file.grantId === sealedGrant.grant.id)?.candidateId,
    candidate.id,
    'A current replacement project manager must retain creator-side visibility of sealed candidates.'
  );
  const replacementManagerOpen = await collaboration.openCandidateRevision({
    grantId: sealedGrant.grant.id,
    candidateId: candidate.id,
    userId: managerUserId
  });
  assert.deepEqual(await streamToBuffer(replacementManagerOpen.stream), candidateBody);
  await revokeManagerAuthority(
    replacementManagerAuthority.id,
    'End replacement-manager candidate read proof.'
  );
  const formerManagerOutgoing = await collaboration.listSharedByMe({ userId: managerUserId });
  assert.equal(
    formerManagerOutgoing.some((file) => file.grantId === sealedGrant.grant.id),
    false,
    'A former project manager must lose creator-side candidate visibility.'
  );
  await assert.rejects(
    collaboration.openCandidateRevision({
      grantId: sealedGrant.grant.id,
      candidateId: candidate.id,
      userId: managerUserId
    }),
    (error) => error?.status === 404 && /unavailable/i.test(error.message)
  );

  const usage = await publishing.getStorageUsage({ performerId: performer.id });
  assert.equal(usage.releaseCountLimit, null);
  assert.equal(usage.reservedBytes, 0);
  assert.equal(usage.sealedWorkingBytes, sourceBody.byteLength + candidateBody.byteLength);
  assert.equal(usage.workingBytes, sourceBody.byteLength + candidateBody.byteLength);
  assert.equal(usage.workingObjectCount, 2);

  const successfulCleanupGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: connection.id,
    versionId: sourceVersion.id,
    grantedByUserId: ownerUserId,
    idempotencyKey: 'successful-cleanup-candidate-window',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const successfulCleanupBody = malformedWavFixture();
  const successfulCleanupSession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: successfulCleanupGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'successful-cleanup-malformed.wav',
    mimeType: 'audio/wav',
    expectedByteSize: successfulCleanupBody.byteLength,
    expectedSha256: sha256(successfulCleanupBody),
    idempotencyKey: 'successful-cleanup-candidate-upload'
  });
  await publishing.writeUploadPart({
    grantId: successfulCleanupGrant.grant.id,
    uploadSessionId: successfulCleanupSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: successfulCleanupBody
  });
  const usageBeforeSuccessfulCleanup = await publishing.getStorageUsage({ performerId: performer.id });
  assert.equal(usageBeforeSuccessfulCleanup.reservedBytes, successfulCleanupBody.byteLength);
  assert.equal(usageBeforeSuccessfulCleanup.workingBytes, usage.workingBytes + successfulCleanupBody.byteLength);
  await assert.rejects(
    publishing.completeAndSealCollaboratorRevision({
      grantId: successfulCleanupGrant.grant.id,
      uploadSessionId: successfulCleanupSession.id,
      actorUserId: collaboratorUserId
    }),
    (error) => errorChainMatches(error, /playable|duration|parse|audio/i)
  );
  assert.equal(
    (await db.select().from(audioUploadSessions).where(eq(audioUploadSessions.id, successfulCleanupSession.id)))[0].uploadStatus,
    'rejected'
  );
  assert.equal(
    (await db.select().from(audioObjectCleanupReceipts).where(eq(audioObjectCleanupReceipts.uploadSessionId, successfulCleanupSession.id))).length,
    0,
    'Successful provider discard must not leave a cleanup receipt.'
  );
  const usageAfterSuccessfulCleanup = await publishing.getStorageUsage({ performerId: performer.id });
  assert.equal(usageAfterSuccessfulCleanup.reservedBytes, 0);
  assert.equal(usageAfterSuccessfulCleanup.workingBytes, usage.workingBytes);
  await collaboration.revokeGrant({
    grantId: successfulCleanupGrant.grant.id,
    userId: ownerUserId,
    reason: 'End successful cleanup candidate grant.'
  });

  const malformedGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: connection.id,
    versionId: sourceVersion.id,
    grantedByUserId: ownerUserId,
    idempotencyKey: 'malformed-candidate-window',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const malformedBody = malformedWavFixture();
  const malformedSession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: malformedGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'malformed.wav',
    mimeType: 'audio/wav',
    expectedByteSize: malformedBody.byteLength,
    expectedSha256: sha256(malformedBody),
    idempotencyKey: 'malformed-candidate-upload'
  });
  await publishing.writeUploadPart({
    grantId: malformedGrant.grant.id,
    uploadSessionId: malformedSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: malformedBody
  });
  const usageBeforeFailedCleanup = await publishing.getStorageUsage({ performerId: performer.id });
  assert.equal(usageBeforeFailedCleanup.reservedBytes, malformedBody.byteLength);
  assert.equal(usageBeforeFailedCleanup.workingBytes, usage.workingBytes + malformedBody.byteLength);
  failNextDiscard = true;
  await assert.rejects(
    publishing.completeAndSealCollaboratorRevision({
      grantId: malformedGrant.grant.id,
      uploadSessionId: malformedSession.id,
      actorUserId: collaboratorUserId
    }),
    (error) => errorChainMatches(error, /playable|duration|parse|audio/i)
  );
  const [pendingReceipt] = await db
    .select()
    .from(audioObjectCleanupReceipts)
    .where(eq(audioObjectCleanupReceipts.uploadSessionId, malformedSession.id));
  assert.equal(pendingReceipt.cleanupStatus, 'pending');
  assert.equal(pendingReceipt.cleanupReason, 'candidate_technical_validation_failed');
  await assert.rejects(
    db
      .update(audioObjectCleanupReceipts)
      .set({ storageKey: `${pendingReceipt.storageKey}.rewritten` })
      .where(eq(audioObjectCleanupReceipts.id, pendingReceipt.id)),
    (error) => errorChainMatches(error, /target identity is immutable/i)
  );
  await assert.rejects(
    db
      .update(audioObjectCleanupReceipts)
      .set({ cleanupReason: 'candidate_grant_revoked' })
      .where(eq(audioObjectCleanupReceipts.id, pendingReceipt.id)),
    (error) => errorChainMatches(error, /target identity is immutable/i)
  );
  await assert.rejects(
    db.delete(audioObjectCleanupReceipts).where(eq(audioObjectCleanupReceipts.id, pendingReceipt.id)),
    (error) => errorChainMatches(error, /append-only evidence/i)
  );
  const [unchangedPendingReceipt] = await db
    .select()
    .from(audioObjectCleanupReceipts)
    .where(eq(audioObjectCleanupReceipts.id, pendingReceipt.id));
  assert.equal(unchangedPendingReceipt.storageKey, pendingReceipt.storageKey);
  assert.equal(unchangedPendingReceipt.cleanupReason, pendingReceipt.cleanupReason);
  assert.equal(unchangedPendingReceipt.cleanupStatus, 'pending');
  assert.equal(
    (await db.select().from(audioUploadSessions).where(eq(audioUploadSessions.id, malformedSession.id)))[0].uploadStatus,
    'quarantined'
  );
  const usageWhileCleanupPending = await publishing.getStorageUsage({ performerId: performer.id });
  assert.equal(usageWhileCleanupPending.reservedBytes, malformedBody.byteLength);
  assert.equal(usageWhileCleanupPending.workingBytes, usage.workingBytes + malformedBody.byteLength);
  const cleanup = await publishing.retryPendingAudioObjectCleanupReceipts({ limit: 10 });
  assert.deepEqual(cleanup.completedReceiptIds, [pendingReceipt.id]);
  assert.equal(cleanup.failedCount, 0);
  assert.equal(
    (await db.select().from(audioObjectCleanupReceipts).where(eq(audioObjectCleanupReceipts.id, pendingReceipt.id)))[0].cleanupStatus,
    'completed'
  );
  await assert.rejects(
    db
      .update(audioObjectCleanupReceipts)
      .set({ cleanupStatus: 'pending', completedAt: null })
      .where(eq(audioObjectCleanupReceipts.id, pendingReceipt.id)),
    (error) => errorChainMatches(error, /terminal/i)
  );
  assert.equal(
    (await db.select().from(audioUploadSessions).where(eq(audioUploadSessions.id, malformedSession.id)))[0].uploadStatus,
    'aborted'
  );
  const usageAfterFailedCleanupRetry = await publishing.getStorageUsage({ performerId: performer.id });
  assert.equal(usageAfterFailedCleanupRetry.reservedBytes, 0);
  assert.equal(usageAfterFailedCleanupRetry.workingBytes, usage.workingBytes);
  assert.equal(
    (await db.select().from(auditEvents).where(and(
      eq(auditEvents.entityType, 'audio_object_cleanup_receipt'),
      eq(auditEvents.entityId, pendingReceipt.id),
      eq(auditEvents.eventType, 'audio_object_cleanup.completed')
    ))).length,
    1
  );

  await collaboration.revokeGrant({
    grantId: malformedGrant.grant.id,
    userId: ownerUserId,
    reason: 'End malformed candidate grant.'
  });
  const quotaGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: connection.id,
    versionId: sourceVersion.id,
    grantedByUserId: ownerUserId,
    idempotencyKey: 'quota-candidate-window',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  await assert.rejects(
    publishing.initiateCollaboratorRevisionUpload({
      grantId: quotaGrant.grant.id,
      actorUserId: collaboratorUserId,
      originalFilename: 'too-large.wav',
      mimeType: 'audio/wav',
      expectedByteSize: MAX_CANDIDATE_BYTES,
      expectedSha256: 'f'.repeat(64),
      idempotencyKey: 'quota-candidate-upload'
    }),
    (error) => error instanceof AudioStorageQuotaError && error.code === 'audio_workspace_limit_exceeded'
  );
  await collaboration.revokeGrant({
    grantId: quotaGrant.grant.id,
    userId: ownerUserId,
    reason: 'End quota denial candidate grant.'
  });

  const sealedAuthority = await createManagerAuthority('sealed-candidate-issuer-revocation');
  const sealedAuthorityGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: managerConnection.id,
    versionId: sourceVersion.id,
    grantedByUserId: managerUserId,
    idempotencyKey: 'issuing-authority-revoked-after-seal',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const issuingManagerPending = (await collaboration.listSharedByMe({ userId: managerUserId }))
    .find((file) => file.grantId === sealedAuthorityGrant.grant.id);
  assert.equal(issuingManagerPending?.candidateId, null);
  assert.equal(issuingManagerPending?.managedByCurrentUser, true);
  assert.equal(issuingManagerPending?.canRevoke, true);
  const sealedAuthorityBody = wavFixture('sealed before issuing authority revocation');
  const sealedAuthoritySession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: sealedAuthorityGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'sealed-before-authority-revocation.wav',
    mimeType: 'audio/wav',
    expectedByteSize: sealedAuthorityBody.byteLength,
    expectedSha256: sha256(sealedAuthorityBody),
    idempotencyKey: 'issuing-authority-revoked-after-seal-upload'
  });
  await publishing.writeUploadPart({
    grantId: sealedAuthorityGrant.grant.id,
    uploadSessionId: sealedAuthoritySession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: sealedAuthorityBody
  });
  const sealedAuthorityCandidate = await publishing.completeAndSealCollaboratorRevision({
    grantId: sealedAuthorityGrant.grant.id,
    uploadSessionId: sealedAuthoritySession.id,
    actorUserId: collaboratorUserId
  });
  assert.equal(
    (await collaboration.listSharedWithMe({ userId: collaboratorUserId }))
      .find((file) => file.grantId === sealedAuthorityGrant.grant.id)?.candidateId,
    sealedAuthorityCandidate.id,
    'The collaborator may read the sealed candidate while the exact issuing authority remains current.'
  );
  await revokeManagerAuthority(
    sealedAuthority.id,
    'Prove collaborator read denial after exact issuing authority revocation.'
  );
  assert.equal(
    (await collaboration.listSharedWithMe({ userId: collaboratorUserId }))
      .some((file) => file.grantId === sealedAuthorityGrant.grant.id),
    false,
    'Revoking the exact issuing project authority must remove collaborator list visibility.'
  );
  await assert.rejects(
    collaboration.openCandidateRevision({
      grantId: sealedAuthorityGrant.grant.id,
      candidateId: sealedAuthorityCandidate.id,
      userId: collaboratorUserId
    }),
    (error) => error?.status === 410 && error?.code === 'candidate_upload_authority_ended'
  );
  assert.equal(
    (await collaboration.listSharedByMe({ userId: managerUserId }))
      .some((file) => file.grantId === sealedAuthorityGrant.grant.id),
    false,
    'A former issuing manager must lose outgoing candidate metadata after project authority revocation.'
  );
  const ownerManagedCandidate = (await collaboration.listSharedByMe({ userId: ownerUserId }))
    .find((file) => file.grantId === sealedAuthorityGrant.grant.id);
  assert.equal(ownerManagedCandidate?.candidateId, sealedAuthorityCandidate.id);
  assert.equal(ownerManagedCandidate?.managedByCurrentUser, true);
  assert.equal(ownerManagedCandidate?.canRevoke, false);
  const ownerManagedOpen = await collaboration.openCandidateRevision({
    grantId: sealedAuthorityGrant.grant.id,
    candidateId: sealedAuthorityCandidate.id,
    userId: ownerUserId
  });
  assert.deepEqual(await streamToBuffer(ownerManagedOpen.stream), sealedAuthorityBody);
  await collaboration.revokeGrant({
    grantId: sealedAuthorityGrant.grant.id,
    userId: managerUserId,
    reason: 'Close sealed issuing-authority revocation proof.'
  });

  const connectionMatrixGrant = await collaboration.grantCandidateRevisionUpload({
    connectionId: connection.id,
    versionId: sourceVersion.id,
    grantedByUserId: ownerUserId,
    idempotencyKey: 'connection-revocation-access-matrix',
    maxCandidateBytes: MAX_CANDIDATE_BYTES,
    expiresInHours: 24
  });
  const connectionMatrixBody = wavFixture('sealed before connection revocation');
  const connectionMatrixSession = await publishing.initiateCollaboratorRevisionUpload({
    grantId: connectionMatrixGrant.grant.id,
    actorUserId: collaboratorUserId,
    originalFilename: 'sealed-before-connection-revocation.wav',
    mimeType: 'audio/wav',
    expectedByteSize: connectionMatrixBody.byteLength,
    expectedSha256: sha256(connectionMatrixBody),
    idempotencyKey: 'connection-revocation-access-matrix-upload'
  });
  await publishing.writeUploadPart({
    grantId: connectionMatrixGrant.grant.id,
    uploadSessionId: connectionMatrixSession.id,
    actorUserId: collaboratorUserId,
    partNumber: 1,
    body: connectionMatrixBody
  });
  const connectionMatrixCandidate = await publishing.completeAndSealCollaboratorRevision({
    grantId: connectionMatrixGrant.grant.id,
    uploadSessionId: connectionMatrixSession.id,
    actorUserId: collaboratorUserId
  });
  const [revokedConnection] = await db
    .update(audioFileConnections)
    .set({
      revokedAt: new Date(),
      revokedByUserId: ownerUserId,
      revocationReason: 'Prove sealed-candidate access after connection revocation.'
    })
    .where(eq(audioFileConnections.id, connection.id))
    .returning();
  assert.ok(revokedConnection?.revokedAt);
  const connectionRevocationCleanup = await publishing.abortCollaboratorRevisionUploadSessions({
    actorUserId: ownerUserId,
    connectionId: connection.id,
    cleanupReason: 'candidate_connection_revoked'
  });
  assert.equal(connectionRevocationCleanup.examinedCount, 0, 'Connection cleanup must not delete a sealed candidate.');
  await assert.rejects(
    collaboration.openCandidateRevision({
      grantId: connectionMatrixGrant.grant.id,
      candidateId: connectionMatrixCandidate.id,
      userId: collaboratorUserId
    }),
    (error) => error?.status === 410
  );
  const incomingAfterConnectionRevoke = await collaboration.listSharedWithMe({ userId: collaboratorUserId });
  assert.equal(incomingAfterConnectionRevoke.some((file) => file.grantId === connectionMatrixGrant.grant.id), false);
  const creatorAfterConnectionRevoke = await collaboration.openCandidateRevision({
    grantId: connectionMatrixGrant.grant.id,
    candidateId: connectionMatrixCandidate.id,
    userId: ownerUserId
  });
  assert.deepEqual(await streamToBuffer(creatorAfterConnectionRevoke.stream), connectionMatrixBody);
  const outgoingAfterConnectionRevoke = await collaboration.listSharedByMe({ userId: ownerUserId });
  assert.equal(
    outgoingAfterConnectionRevoke.find((file) => file.grantId === connectionMatrixGrant.grant.id)?.candidateId,
    connectionMatrixCandidate.id
  );

  const ordinaryVersions = await db
    .select({ id: audioProjectAssetVersions.id })
    .from(audioProjectAssetVersions)
    .where(eq(audioProjectAssetVersions.assetId, candidate.assetId));
  assert.equal(ordinaryVersions.length, 1, 'Candidate intake must not create another ordinary asset version.');
  const grantRows = await db
    .select()
    .from(audioFileAccessGrants)
    .where(eq(audioFileAccessGrants.grantPurpose, 'collaborator_revision_upload'));
  assert.ok(grantRows.every((grant) => grant.canUploadNewVersion
    && !grant.canDownloadOriginal
    && !grant.canComment
    && !grant.canApprove
    && grant.maxCandidateBytes === MAX_CANDIDATE_BYTES));

  console.log(`Audio candidate revision integration passed on ${managedDatabaseProof?.kind || 'configured-postgres'}: disabled flag, creator byte ceiling, project/capability/exact-grant checks, two-part geometry and exact replay conflict, post-revocation completion replay, sessionless initiation recovery, atomic pre-revocation cleanup intent and receipt, revocation-versus-part and revocation-versus-assembly cleanup barriers, issuing-authority/grant/connection revocation reads, playable-media seal, append-only private candidate isolation, current-manager retained access, bounded storage, successful and retried cleanup quota transitions, and quota denial are proven.`);
} finally {
  if (managedDatabaseProof) await managedDatabaseProof.close();
  else await db.$client.end();
  rmSync(objectRoot, { recursive: true, force: true });
}
