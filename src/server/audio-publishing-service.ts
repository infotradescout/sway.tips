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
  auditEvents,
  musicRecordings,
  musicReleaseRecordings,
  musicReleases
} from '../db/schema';
import { parseAudioStorageProvider, type AudioObjectIdentity, type AudioObjectStore } from './audio-object-storage';

const DEFAULT_PART_SIZE = 5 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RELEASE_TYPES = new Set(['single', 'ep', 'album', 'comedy_special', 'spoken_word', 'other']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256Hex(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredReleaseText(value: string, label: string, maxLength = 200) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return normalized;
}

function optionalReleaseText(value: string | null | undefined, label: string, maxLength = 200) {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return normalized;
}

function normalizeTerritories(values: string[] | null | undefined) {
  const normalized = [...new Set((values ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean))];
  if (normalized.some((value) => !/^[A-Z]{2}$/.test(value))) {
    throw new Error('Territories must use two-letter country codes.');
  }
  return normalized.length ? normalized : ['US'];
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
    needManageRelease?: boolean;
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
    if (input.needManageRelease && !grant.canManageRelease) return null;
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
        metadata: audioAssets.metadata,
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
    if (!['initiated', 'uploading', 'uploaded', 'verifying'].includes(session.uploadStatus)) {
      throw new Error(`Upload session is ${session.uploadStatus} and cannot be sealed.`);
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

    if (session.uploadStatus === 'initiated' || session.uploadStatus === 'uploading') {
      await db
        .update(audioUploadSessions)
        .set({ uploadStatus: 'uploaded', updatedAt: new Date() })
        .where(eq(audioUploadSessions.id, session.id));
    }

    if (session.uploadStatus !== 'verifying') {
      await db
        .update(audioUploadSessions)
        .set({ uploadStatus: 'verifying', updatedAt: new Date() })
        .where(eq(audioUploadSessions.id, session.id));
    }

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
      await tx
        .update(audioUploadSessions)
        .set({
          uploadStatus: 'completed',
          completedAt: verifiedAt,
          updatedAt: verifiedAt
        })
        .where(eq(audioUploadSessions.id, session.id));

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

  async function openOwnedVersion(input: { versionId: string; actorUserId: string }) {
    const [version] = await db
      .select()
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.id, input.versionId))
      .limit(1);
    if (!version) throw new Error('Catalog audio not found.');

    const access = await requireProjectAccess({
      projectId: version.projectId,
      userId: input.actorUserId,
      needDownload: true
    });
    if (!access) throw new Error('Catalog audio access denied.');

    const object = await store.openOriginal({
      storageProvider: parseAudioStorageProvider(version.storageProvider),
      storageBucket: version.storageBucket,
      storageKey: version.storageKey
    });
    return { version, ...object };
  }

  async function listReleaseWorkspace(input: { performerId: string; actorUserId: string }) {
    const releases = await db
      .select({
        id: musicReleases.id,
        projectId: musicReleases.projectId,
        title: musicReleases.title,
        primaryArtistName: musicReleases.primaryArtistName,
        releaseType: musicReleases.releaseType,
        distributionMode: musicReleases.distributionMode,
        status: musicReleases.status,
        upc: musicReleases.upc,
        labelName: musicReleases.labelName,
        pLine: musicReleases.pLine,
        cLine: musicReleases.cLine,
        originalReleaseDate: musicReleases.originalReleaseDate,
        territories: musicReleases.territories,
        createdAt: musicReleases.createdAt,
        updatedAt: musicReleases.updatedAt
      })
      .from(musicReleases)
      .where(eq(musicReleases.performerId, input.performerId))
      .orderBy(desc(musicReleases.updatedAt));

    const recordings = await db
      .select({
        releaseId: musicReleaseRecordings.releaseId,
        recordingId: musicRecordings.id,
        masterAssetVersionId: musicRecordings.masterAssetVersionId,
        title: musicRecordings.title,
        versionTitle: musicRecordings.versionTitle,
        primaryArtistName: musicRecordings.primaryArtistName,
        isrc: musicRecordings.isrc,
        isExplicit: musicRecordings.isExplicit,
        languageCode: musicRecordings.languageCode,
        rightsStatus: musicRecordings.rightsStatus,
        discNumber: musicReleaseRecordings.discNumber,
        trackNumber: musicReleaseRecordings.trackNumber
      })
      .from(musicReleaseRecordings)
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
      .innerJoin(musicReleases, eq(musicReleases.id, musicReleaseRecordings.releaseId))
      .where(eq(musicReleases.performerId, input.performerId))
      .orderBy(asc(musicReleaseRecordings.discNumber), asc(musicReleaseRecordings.trackNumber));

    const masterRows = await db
      .select({
        versionId: audioProjectAssetVersions.id,
        assetId: audioProjectAssetVersions.assetId,
        projectId: audioProjectAssetVersions.projectId,
        projectTitle: audioProjects.title,
        title: audioAssets.title,
        originalFilename: audioProjectAssetVersions.originalFilename,
        mimeType: audioProjectAssetVersions.mimeType,
        versionNumber: audioProjectAssetVersions.versionNumber,
        sha256: audioProjectAssetVersions.sha256,
        sealedAt: audioProjectAssetVersions.sealedAt
      })
      .from(audioProjectAssetVersions)
      .innerJoin(audioAssets, eq(audioAssets.id, audioProjectAssetVersions.assetId))
      .innerJoin(audioProjects, eq(audioProjects.id, audioProjectAssetVersions.projectId))
      .innerJoin(audioProjectAccessGrants, and(
        eq(audioProjectAccessGrants.projectId, audioProjects.id),
        eq(audioProjectAccessGrants.granteeUserId, input.actorUserId),
        eq(audioProjectAccessGrants.canManageRelease, true),
        isNull(audioProjectAccessGrants.revokedAt)
      ))
      .where(and(
        eq(audioProjects.performerId, input.performerId),
        eq(audioProjects.status, 'active'),
        eq(audioAssets.status, 'active'),
        eq(audioProjectAssetVersions.integrityStatus, 'verified'),
        sql`${audioProjectAssetVersions.mimeType} like 'audio/%'`
      ))
      .orderBy(desc(audioProjectAssetVersions.versionNumber), desc(audioProjectAssetVersions.createdAt));

    const seenAssets = new Set<string>();
    const masters = masterRows.filter((row) => {
      if (seenAssets.has(row.assetId)) return false;
      seenAssets.add(row.assetId);
      return true;
    });

    return {
      masters,
      releases: releases.map((release) => ({
        ...release,
        recordings: recordings.filter((recording) => recording.releaseId === release.id)
      }))
    };
  }

  async function createReleaseDraft(input: {
    clientReleaseId: string;
    performerId: string;
    actorUserId: string;
    projectId: string;
    masterAssetVersionId: string;
    title: string;
    trackTitle: string;
    versionTitle?: string | null;
    primaryArtistName: string;
    releaseType: string;
    upc?: string | null;
    isrc?: string | null;
    labelName?: string | null;
    pLine?: string | null;
    cLine?: string | null;
    originalReleaseDate?: string | null;
    territories?: string[] | null;
    isExplicit?: boolean;
    languageCode?: string | null;
  }) {
    if (!UUID_PATTERN.test(input.clientReleaseId)) throw new Error('clientReleaseId must be a UUID.');
    if (!RELEASE_TYPES.has(input.releaseType)) throw new Error('Release type is invalid.');

    const title = requiredReleaseText(input.title, 'Release title');
    const trackTitle = requiredReleaseText(input.trackTitle, 'Track title');
    const primaryArtistName = requiredReleaseText(input.primaryArtistName, 'Primary artist');
    const versionTitle = optionalReleaseText(input.versionTitle, 'Version title');
    const labelName = optionalReleaseText(input.labelName, 'Label name');
    const pLine = optionalReleaseText(input.pLine, 'P line');
    const cLine = optionalReleaseText(input.cLine, 'C line');
    const upc = optionalReleaseText(input.upc, 'UPC', 14);
    const isrc = optionalReleaseText(input.isrc, 'ISRC', 12)?.toUpperCase() ?? null;
    const languageCode = optionalReleaseText(input.languageCode, 'Language code', 3)?.toLowerCase() ?? null;
    const originalReleaseDate = optionalReleaseText(input.originalReleaseDate, 'Original release date', 10);
    const territories = normalizeTerritories(input.territories);

    if (upc && !/^[0-9]{8,14}$/.test(upc)) throw new Error('UPC must contain 8 through 14 digits.');
    if (isrc && !/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)) throw new Error('ISRC must use the 12-character ISRC format.');
    if (languageCode && !/^[a-z]{2,3}$/.test(languageCode)) throw new Error('Language code must contain 2 or 3 letters.');
    if (originalReleaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(originalReleaseDate)) {
      throw new Error('Original release date must use YYYY-MM-DD.');
    }

    const access = await requireProjectAccess({
      projectId: input.projectId,
      userId: input.actorUserId,
      needManageRelease: true
    });
    if (!access) throw new Error('Release management permission required.');

    const [master] = await db
      .select({
        id: audioProjectAssetVersions.id,
        projectId: audioProjectAssetVersions.projectId,
        performerId: audioProjectAssetVersions.performerId,
        mimeType: audioProjectAssetVersions.mimeType,
        integrityStatus: audioProjectAssetVersions.integrityStatus,
        sha256: audioProjectAssetVersions.sha256
      })
      .from(audioProjectAssetVersions)
      .where(and(
        eq(audioProjectAssetVersions.id, input.masterAssetVersionId),
        eq(audioProjectAssetVersions.projectId, input.projectId),
        eq(audioProjectAssetVersions.performerId, input.performerId)
      ))
      .limit(1);
    if (!master || master.integrityStatus !== 'verified' || !master.mimeType.startsWith('audio/')) {
      throw new Error('A verified audio master owned by this performer is required.');
    }

    return db.transaction(async (tx) => {
      const [release] = await tx
        .insert(musicReleases)
        .values({
          id: input.clientReleaseId,
          performerId: input.performerId,
          projectId: input.projectId,
          title,
          primaryArtistName,
          releaseType: input.releaseType,
          distributionMode: 'private',
          status: 'draft',
          upc,
          labelName,
          pLine,
          cLine,
          originalReleaseDate,
          territories,
          metadata: {
            draftSource: 'creator_catalog',
            clientReleaseId: input.clientReleaseId,
            deliveryEnabled: false
          }
        })
        .onConflictDoNothing({ target: musicReleases.id })
        .returning();

      if (!release) {
        const [existing] = await tx
          .select()
          .from(musicReleases)
          .where(and(eq(musicReleases.id, input.clientReleaseId), eq(musicReleases.performerId, input.performerId)))
          .limit(1);
        if (!existing) throw new Error('Release idempotency key belongs to another account.');
        const [existingRecording] = await tx
          .select({ recording: musicRecordings })
          .from(musicReleaseRecordings)
          .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
          .where(eq(musicReleaseRecordings.releaseId, existing.id))
          .orderBy(asc(musicReleaseRecordings.trackNumber))
          .limit(1);
        return { release: existing, recording: existingRecording?.recording ?? null, created: false };
      }

      const [recording] = await tx.insert(musicRecordings).values({
        performerId: input.performerId,
        projectId: input.projectId,
        masterAssetVersionId: master.id,
        title: trackTitle,
        versionTitle,
        primaryArtistName,
        isrc,
        isExplicit: input.isExplicit === true,
        languageCode,
        originalReleaseDate,
        rightsStatus: 'draft',
        metadata: { masterSha256: master.sha256 }
      }).returning();

      await tx.insert(musicReleaseRecordings).values({
        releaseId: release.id,
        recordingId: recording.id,
        discNumber: 1,
        trackNumber: 1
      });

      await tx.insert(auditEvents).values([
        {
          actorType: 'performer',
          actorId: input.actorUserId,
          entityType: 'music_release',
          entityId: release.id,
          eventType: 'music_release.draft_create',
          previousStatus: null,
          nextStatus: 'draft',
          metadata: { projectId: input.projectId, releaseType: input.releaseType, distributionMode: 'private' }
        },
        {
          actorType: 'performer',
          actorId: input.actorUserId,
          entityType: 'music_recording',
          entityId: recording.id,
          eventType: 'music_recording.create',
          previousStatus: null,
          nextStatus: 'draft',
          metadata: { releaseId: release.id, masterAssetVersionId: master.id, masterSha256: master.sha256 }
        }
      ]);

      return { release, recording, created: true };
    });
  }

  return {
    createProject,
    listProjects,
    listProjectAssets,
    initiateUpload,
    writeUploadPart,
    completeAndSealUpload,
    createShareGrant,
    openOwnedVersion,
    listReleaseWorkspace,
    createReleaseDraft,
    downloadSharedOriginal
  };
}

export type AudioPublishingService = ReturnType<typeof createAudioPublishingService>;
