import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  audioAssets,
  audioProjectAccessGrants,
  audioProjectAssetVersions,
  audioProjects,
  audioShareGrants,
  audioUploadParts,
  audioUploadSessions,
  auditEvents
} from '../db/schema';
import { parseAudioStorageProvider, type AudioObjectIdentity, type AudioObjectStore } from './audio-object-storage';

const DEFAULT_PART_SIZE = 5 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sha256Hex(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeAudit(
  db: SwayDb,
  input: {
    actorId: string;
    entityType: string;
    entityId: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  }
) {
  await db.insert(auditEvents).values({
    actorType: 'performer',
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    previousStatus: null,
    nextStatus: null,
    metadata: input.metadata ?? null
  });
}

export function createAudioPublishingService(config: {
  db: SwayDb;
  store: AudioObjectStore;
}) {
  const { db, store } = config;

  function sessionObjectIdentity(session: {
    storageProvider: string;
    storageBucket: string;
    storageKey: string;
    providerUploadId: string;
  }): AudioObjectIdentity {
    return {
      storageProvider: parseAudioStorageProvider(session.storageProvider),
      storageBucket: session.storageBucket,
      storageKey: session.storageKey,
      providerUploadId: session.providerUploadId
    };
  }

  async function requireProjectAccess(input: {
    projectId: string;
    userId: string;
    needUpload?: boolean;
    needDownload?: boolean;
    needManageAccess?: boolean;
  }) {
    const [grant] = await db
      .select()
      .from(audioProjectAccessGrants)
      .where(and(
        eq(audioProjectAccessGrants.projectId, input.projectId),
        eq(audioProjectAccessGrants.granteeUserId, input.userId),
        isNull(audioProjectAccessGrants.revokedAt)
      ))
      .limit(1);
    if (!grant) return null;
    if (input.needUpload && !grant.canUploadVersions) return null;
    if (input.needDownload && !grant.canDownloadOriginals) return null;
    if (input.needManageAccess && !grant.canManageAccess) return null;
    return grant;
  }

  async function createProject(input: {
    performerId: string;
    actorUserId: string;
    title: string;
    projectKind?: 'music' | 'comedy' | 'podcast' | 'other_audio';
  }) {
    const title = input.title.trim();
    if (!title) throw new Error('Project title is required.');

    return db.transaction(async (tx) => {
      const [project] = await tx.insert(audioProjects).values({
        performerId: input.performerId,
        createdByUserId: input.actorUserId,
        title,
        projectKind: input.projectKind ?? 'music',
        status: 'active'
      }).returning();

      await tx.insert(audioProjectAccessGrants).values({
        projectId: project.id,
        granteeUserId: input.actorUserId,
        role: 'owner',
        canUploadVersions: true,
        canDownloadOriginals: true,
        canComment: true,
        canApprove: true,
        canManageRelease: true,
        canManageAccess: true,
        grantedByUserId: input.actorUserId
      });

      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'audio_project',
        entityId: project.id,
        eventType: 'audio_project.create',
        previousStatus: null,
        nextStatus: 'active',
        metadata: { title: project.title }
      });

      return project;
    });
  }

  async function listProjects(input: { performerId: string; actorUserId: string }) {
    return db
      .select({
        id: audioProjects.id,
        title: audioProjects.title,
        projectKind: audioProjects.projectKind,
        status: audioProjects.status,
        createdAt: audioProjects.createdAt,
        updatedAt: audioProjects.updatedAt
      })
      .from(audioProjects)
      .innerJoin(
        audioProjectAccessGrants,
        and(
          eq(audioProjectAccessGrants.projectId, audioProjects.id),
          eq(audioProjectAccessGrants.granteeUserId, input.actorUserId),
          isNull(audioProjectAccessGrants.revokedAt)
        )
      )
      .where(and(eq(audioProjects.performerId, input.performerId), eq(audioProjects.status, 'active')))
      .orderBy(desc(audioProjects.updatedAt));
  }

  async function listProjectAssets(input: { projectId: string; actorUserId: string }) {
    const access = await requireProjectAccess({ projectId: input.projectId, userId: input.actorUserId });
    if (!access) throw new Error('Project access required.');

    const assets = await db
      .select({
        id: audioAssets.id,
        title: audioAssets.title,
        assetKind: audioAssets.assetKind,
        status: audioAssets.status,
        createdAt: audioAssets.createdAt
      })
      .from(audioAssets)
      .where(and(eq(audioAssets.projectId, input.projectId), eq(audioAssets.status, 'active')))
      .orderBy(desc(audioAssets.createdAt));

    const versions = await db
      .select({
        id: audioProjectAssetVersions.id,
        assetId: audioProjectAssetVersions.assetId,
        versionNumber: audioProjectAssetVersions.versionNumber,
        originalFilename: audioProjectAssetVersions.originalFilename,
        mimeType: audioProjectAssetVersions.mimeType,
        byteSize: audioProjectAssetVersions.byteSize,
        sha256: audioProjectAssetVersions.sha256,
        sealedAt: audioProjectAssetVersions.sealedAt
      })
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.projectId, input.projectId))
      .orderBy(desc(audioProjectAssetVersions.createdAt));

    return { assets, versions };
  }

  async function initiateUpload(input: {
    projectId: string;
    actorUserId: string;
    title: string;
    assetKind: string;
    originalFilename: string;
    mimeType: string;
    expectedByteSize: number;
    expectedSha256: string;
    idempotencyKey: string;
    partSizeBytes?: number;
  }) {
    const access = await requireProjectAccess({
      projectId: input.projectId,
      userId: input.actorUserId,
      needUpload: true
    });
    if (!access) throw new Error('Upload permission required.');

    const expectedSha256 = input.expectedSha256.trim().toLowerCase();
    if (!input.idempotencyKey.trim()) throw new Error('idempotencyKey is required.');
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('expectedSha256 must be a 64-char hex digest.');
    if (!Number.isSafeInteger(input.expectedByteSize) || input.expectedByteSize <= 0) {
      throw new Error('expectedByteSize must be a positive integer.');
    }
    const partSizeBytes = input.partSizeBytes ?? DEFAULT_PART_SIZE;
    if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes < DEFAULT_PART_SIZE || partSizeBytes > 6 * 1024 * 1024) {
      throw new Error('partSizeBytes must be an integer from 5 MiB through 6 MiB.');
    }

    const existing = await db
      .select()
      .from(audioUploadSessions)
      .where(and(
        eq(audioUploadSessions.projectId, input.projectId),
        eq(audioUploadSessions.idempotencyKey, input.idempotencyKey)
      ))
      .limit(1);
    if (existing[0]) return existing[0];

    let objectIdentity: AudioObjectIdentity | null = null;
    try {
      return await db.transaction(async (tx) => {
        const [asset] = await tx.insert(audioAssets).values({
          projectId: input.projectId,
          createdByUserId: input.actorUserId,
          title: input.title.trim() || input.originalFilename,
          assetKind: input.assetKind,
          provenanceType: 'user_upload',
          status: 'active'
        }).returning();

        const uploadSessionId = randomUUID();
        objectIdentity = await store.beginUpload({
          projectId: input.projectId,
          uploadSessionId,
          filename: input.originalFilename,
          mimeType: input.mimeType
        });

        const [session] = await tx.insert(audioUploadSessions).values({
          id: uploadSessionId,
          projectId: input.projectId,
          assetId: asset.id,
          initiatedByUserId: input.actorUserId,
          idempotencyKey: input.idempotencyKey,
          storageProvider: objectIdentity.storageProvider,
          storageBucket: objectIdentity.storageBucket,
          providerUploadId: objectIdentity.providerUploadId!,
          storageKey: objectIdentity.storageKey,
          originalFilename: input.originalFilename,
          expectedMimeType: input.mimeType,
          expectedByteSize: input.expectedByteSize,
          expectedSha256,
          partSizeBytes,
          uploadStatus: 'initiated',
          expiresAt: new Date(Date.now() + UPLOAD_TTL_MS)
        }).returning();

        return session;
      });
    } catch (error) {
      if (objectIdentity) {
        try {
          await store.abortUpload(objectIdentity);
        } catch (abortError) {
          console.error('[sway.audio] failed to abort orphaned provider upload:', abortError);
        }
      }
      throw error;
    }
  }

  async function writeUploadPart(input: {
    uploadSessionId: string;
    actorUserId: string;
    partNumber: number;
    body: Buffer;
  }) {
    const [session] = await db
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.id, input.uploadSessionId))
      .limit(1);
    if (!session) throw new Error('Upload session not found.');
    if (session.expiresAt.getTime() <= Date.now()) throw new Error('Upload session expired.');
    if (!['initiated', 'uploading'].includes(session.uploadStatus)) {
      throw new Error(`Upload session is ${session.uploadStatus} and cannot accept parts.`);
    }

    const access = await requireProjectAccess({
      projectId: session.projectId,
      userId: input.actorUserId,
      needUpload: true
    });
    if (!access) throw new Error('Upload permission required.');

    const written = await store.writePart({
      identity: sessionObjectIdentity(session),
      partNumber: input.partNumber,
      body: input.body
    });

    await db
      .insert(audioUploadParts)
      .values({
        uploadSessionId: session.id,
        partNumber: input.partNumber,
        byteSize: written.byteSize,
        providerEtag: written.etag,
        providerChecksum: written.checksum
      })
      .onConflictDoNothing();

    if (session.uploadStatus === 'initiated') {
      await db
        .update(audioUploadSessions)
        .set({ uploadStatus: 'uploading', updatedAt: new Date() })
        .where(eq(audioUploadSessions.id, session.id));
    }

    return written;
  }

  async function completeAndSealUpload(input: {
    uploadSessionId: string;
    actorUserId: string;
    performerId: string;
  }) {
    const [session] = await db
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.id, input.uploadSessionId))
      .limit(1);
    if (!session) throw new Error('Upload session not found.');
    if (!session.assetId) throw new Error('Upload session is missing an asset.');

    const access = await requireProjectAccess({
      projectId: session.projectId,
      userId: input.actorUserId,
      needUpload: true
    });
    if (!access) throw new Error('Upload permission required.');

    if (session.uploadStatus === 'completed') {
      const [existing] = await db
        .select()
        .from(audioProjectAssetVersions)
        .where(eq(audioProjectAssetVersions.uploadSessionId, session.id))
        .limit(1);
      if (existing) return existing;
    }

    const parts = await db
      .select()
      .from(audioUploadParts)
      .where(eq(audioUploadParts.uploadSessionId, session.id))
      .orderBy(asc(audioUploadParts.partNumber));

    if (!parts.length) throw new Error('No upload parts found.');
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].partNumber !== i + 1) throw new Error('Upload parts must be contiguous starting at 1.');
      if (parts[i].byteSize > session.partSizeBytes) throw new Error(`Upload part ${parts[i].partNumber} exceeds the declared part size.`);
      if (i < parts.length - 1 && parts[i].byteSize < DEFAULT_PART_SIZE) {
        throw new Error(`Upload part ${parts[i].partNumber} is below the provider minimum of 5 MiB.`);
      }
    }

    await db
      .update(audioUploadSessions)
      .set({ uploadStatus: 'uploaded', updatedAt: new Date() })
      .where(eq(audioUploadSessions.id, session.id));

    await db
      .update(audioUploadSessions)
      .set({ uploadStatus: 'verifying', updatedAt: new Date() })
      .where(eq(audioUploadSessions.id, session.id));

    let assembled: { byteSize: number; sha256: string };
    try {
      assembled = await store.assembleParts({
        identity: sessionObjectIdentity(session),
        parts: parts.map((part) => ({
          partNumber: part.partNumber,
          etag: part.providerEtag
        })),
        expectedByteSize: session.expectedByteSize,
        expectedSha256: session.expectedSha256,
        mimeType: session.expectedMimeType
      });
    } catch (error) {
      await db
        .update(audioUploadSessions)
        .set({ uploadStatus: 'quarantined', updatedAt: new Date() })
        .where(eq(audioUploadSessions.id, session.id));
      throw error;
    }

    return db.transaction(async (tx) => {
      const [{ nextVersion }] = await tx
        .select({
          nextVersion: sql<number>`coalesce(max(${audioProjectAssetVersions.versionNumber}), 0) + 1`
        })
        .from(audioProjectAssetVersions)
        .where(eq(audioProjectAssetVersions.assetId, session.assetId!));

      const verifiedAt = new Date();
      const [version] = await tx.insert(audioProjectAssetVersions).values({
        projectId: session.projectId,
        performerId: input.performerId,
        assetId: session.assetId!,
        uploadedByUserId: input.actorUserId,
        uploadSessionId: session.id,
        versionNumber: nextVersion,
        originalFilename: session.originalFilename,
        storageProvider: session.storageProvider,
        storageBucket: session.storageBucket,
        storageKey: session.storageKey,
        mimeType: session.expectedMimeType,
        byteSize: assembled.byteSize,
        sha256: assembled.sha256,
        integrityStatus: 'verified',
        integrityVerifierKey: `sway.${store.provider}.sha256`,
        integrityVerifiedAt: verifiedAt,
        integrityEvidence: {
          expectedSha256: session.expectedSha256,
          assembledSha256: assembled.sha256,
          expectedByteSize: session.expectedByteSize,
          assembledByteSize: assembled.byteSize,
          partCount: parts.length,
          verifier: `sway.${store.provider}.sha256`
        },
        originalPreserved: true,
        sealedAt: verifiedAt
      }).returning();

      await tx
        .update(audioUploadSessions)
        .set({
          uploadStatus: 'completed',
          completedAt: verifiedAt,
          updatedAt: verifiedAt
        })
        .where(eq(audioUploadSessions.id, session.id));

      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'audio_project_asset_version',
        entityId: version.id,
        eventType: 'audio_asset_version.seal',
        previousStatus: 'verifying',
        nextStatus: 'verified',
        metadata: {
          sha256: version.sha256,
          byteSize: version.byteSize,
          uploadSessionId: session.id
        }
      });

      return version;
    });
  }

  async function createShareGrant(input: {
    versionId: string;
    actorUserId: string;
    maxUses?: number | null;
    recipientLabel?: string | null;
  }) {
    const [version] = await db
      .select()
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.id, input.versionId))
      .limit(1);
    if (!version) throw new Error('Asset version not found.');

    const access = await requireProjectAccess({
      projectId: version.projectId,
      userId: input.actorUserId,
      needDownload: true
    });
    if (!access) throw new Error('Share permission requires download access.');

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(rawToken);
    const [grant] = await db.insert(audioShareGrants).values({
      projectId: version.projectId,
      assetVersionId: version.id,
      createdByUserId: input.actorUserId,
      tokenHash,
      recipientLabel: input.recipientLabel ?? null,
      permissions: {
        view: true,
        downloadOriginal: true,
        uploadVersion: false,
        approve: false
      },
      maxUses: input.maxUses ?? 5,
      useCount: 0,
      expiresAt: new Date(Date.now() + SHARE_TTL_MS)
    }).returning();

    await writeAudit(db, {
      actorId: input.actorUserId,
      entityType: 'audio_share_grant',
      entityId: grant.id,
      eventType: 'audio_share_grant.create',
      metadata: { versionId: version.id, maxUses: grant.maxUses }
    });

    return { grant, rawToken };
  }

  async function downloadSharedOriginal(input: {
    rawToken: string;
    actorUserId: string;
  }) {
    const tokenHash = sha256Hex(input.rawToken.trim());
    const [grant] = await db
      .select()
      .from(audioShareGrants)
      .where(eq(audioShareGrants.tokenHash, tokenHash))
      .limit(1);
    if (!grant || !grant.assetVersionId) throw new Error('Share grant not found.');
    if (grant.revokedAt) throw new Error('Share grant was revoked.');
    if (grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) throw new Error('Share grant expired.');
    if (grant.maxUses != null && grant.useCount >= grant.maxUses) throw new Error('Share grant exhausted.');
    if (!grant.permissions.downloadOriginal) throw new Error('Share grant does not allow original download.');

    const [version] = await db
      .select()
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.id, grant.assetVersionId))
      .limit(1);
    if (!version) throw new Error('Shared asset version not found.');

    const updated = await db
      .update(audioShareGrants)
      .set({ useCount: grant.useCount + 1 })
      .where(and(
        eq(audioShareGrants.id, grant.id),
        eq(audioShareGrants.useCount, grant.useCount)
      ))
      .returning();
    if (!updated[0]) throw new Error('Share grant could not be consumed.');

    await writeAudit(db, {
      actorId: input.actorUserId,
      entityType: 'audio_share_grant',
      entityId: grant.id,
      eventType: 'audio_share_grant.download',
      metadata: { versionId: version.id, sha256: version.sha256 }
    });

    const object = await store.openOriginal({
      storageProvider: parseAudioStorageProvider(version.storageProvider),
      storageBucket: version.storageBucket,
      storageKey: version.storageKey
    });

    return { version, ...object };
  }

  return {
    createProject,
    listProjects,
    listProjectAssets,
    initiateUpload,
    writeUploadPart,
    completeAndSealUpload,
    createShareGrant,
    downloadSharedOriginal
  };
}

export type AudioPublishingService = ReturnType<typeof createAudioPublishingService>;
