import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  audioAssets,
  audioFileConnections,
  audioProjectAccessGrants,
  audioProjectAssetVersions,
  audioProjects,
  audioShareGrants,
  audioUploadParts,
  audioUploadSessions,
  auditEvents,
  musicRecordingCredits,
  musicRecordings,
  musicDistributionDeliveries,
  musicReleaseRecordings,
  musicReleases,
  musicRightsDeclarationEvents,
  musicRightsDeclarations,
  performers
} from '../db/schema';
import { parseAudioStorageProvider, type AudioObjectIdentity, type AudioObjectStore } from './audio-object-storage';

const DEFAULT_PART_SIZE = 5 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RELEASE_TYPES = new Set(['single', 'ep', 'album', 'comedy_special', 'spoken_word', 'other']);
const DISTRIBUTION_MODES = new Set(['private', 'sway_only', 'sway_first', 'everywhere']);
const CREDIT_ROLES = new Set([
  'primary_artist', 'featured_artist', 'songwriter', 'composer', 'producer', 'co_producer',
  'engineer', 'mix_engineer', 'mastering_engineer', 'performer', 'publisher', 'other'
]);
const RIGHTS_DECLARATION_TYPES = new Set([
  'master_control', 'composition_control', 'sample_clearance', 'cover_license',
  'beat_license', 'artwork_control', 'performer_consent', 'ai_disclosure',
  'distribution_authorization'
]);
const BASE_REQUIRED_RIGHTS = ['master_control', 'composition_control', 'artwork_control', 'distribution_authorization'] as const;
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

function normalizeCredits(values: Array<{ displayName?: string; role?: string }> | null | undefined) {
  const credits = (values ?? []).map((value, sequence) => ({
    displayName: requiredReleaseText(value.displayName ?? '', `Credit ${sequence + 1} name`, 160),
    role: (value.role ?? '').trim().toLowerCase(),
    sequence
  }));
  if (!credits.length) throw new Error('At least one release credit is required.');
  for (const credit of credits) {
    if (!CREDIT_ROLES.has(credit.role)) throw new Error(`Unsupported credit role: ${credit.role || 'blank'}.`);
  }
  if (!credits.some((credit) => credit.role === 'primary_artist')) {
    throw new Error('Credits must identify at least one primary artist.');
  }
  return credits;
}

function buildReleaseReadiness(input: {
  release: {
    artworkAssetVersionId: string | null;
    title: string;
    primaryArtistName: string;
    pLine: string | null;
    cLine: string | null;
    originalReleaseDate: string | null;
    territories: string[] | null;
    distributionMode: string;
    scheduledReleaseAt: Date | null;
  };
  recordings: Array<{ recordingId: string; masterAssetVersionId: string | null; title: string; languageCode: string | null }>;
  credits: Array<{ recordingId: string; role: string }>;
  declarations: Array<{ declarationType: string; outcome: string }>;
}) {
  const issues: string[] = [];
  const { release, recordings, credits, declarations } = input;
  const latestDeclarationByType = new Map<string, { declarationType: string; outcome: string }>();
  for (const declaration of declarations) {
    if (!latestDeclarationByType.has(declaration.declarationType)) {
      latestDeclarationByType.set(declaration.declarationType, declaration);
    }
  }
  if (!release.title.trim()) issues.push('Release title is required.');
  if (!release.primaryArtistName.trim()) issues.push('Primary artist is required.');
  if (!release.artworkAssetVersionId) issues.push('Verified release artwork is required.');
  if (!release.pLine) issues.push('The ℗ sound-recording copyright line is required.');
  if (!release.cLine) issues.push('The © artwork/release copyright line is required.');
  if (!release.originalReleaseDate) issues.push('Original release date is required.');
  if (!release.territories?.length) issues.push('At least one release territory is required.');
  if (!recordings.length) issues.push('At least one recording is required.');
  for (const recording of recordings) {
    if (!recording.masterAssetVersionId) issues.push(`${recording.title}: verified master is required.`);
    if (!recording.languageCode) issues.push(`${recording.title}: language code is required.`);
    const recordingCredits = credits.filter((credit) => credit.recordingId === recording.recordingId);
    if (!recordingCredits.some((credit) => credit.role === 'primary_artist')) issues.push(`${recording.title}: primary artist credit is required.`);
    if (!recordingCredits.some((credit) => ['songwriter', 'composer'].includes(credit.role))) issues.push(`${recording.title}: songwriter or composer credit is required.`);
  }
  if (release.distributionMode !== 'private' && !release.scheduledReleaseAt) {
    issues.push('A scheduled release time is required for publication or distribution.');
  }
  for (const declarationType of BASE_REQUIRED_RIGHTS) {
    if (latestDeclarationByType.get(declarationType)?.outcome !== 'verified') {
      issues.push(`Verified ${declarationType.replaceAll('_', ' ')} rights evidence is required.`);
    }
  }
  return {
    ready: issues.length === 0,
    issues,
    verifiedRights: BASE_REQUIRED_RIGHTS.filter((type) => latestDeclarationByType.get(type)?.outcome === 'verified'),
    requiredRights: [...BASE_REQUIRED_RIGHTS]
  };
}

async function writeAudit(
  db: SwayDb,
  input: {
    actorType?: 'performer' | 'account';
    actorId: string;
    entityType: string;
    entityId: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  }
) {
  await db.insert(auditEvents).values({
    actorType: input.actorType ?? 'performer',
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
    needApprove?: boolean;
    needManageRelease?: boolean;
    needManageAccess?: boolean;
  }) {
    const [grant] = await db
      .select()
      .from(audioProjectAccessGrants)
      .where(and(
        eq(audioProjectAccessGrants.projectId, input.projectId),
        eq(audioProjectAccessGrants.granteeUserId, input.userId),
        isNull(audioProjectAccessGrants.revokedAt),
        or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
      ))
      .limit(1);
    if (!grant) return null;
    if (input.needUpload && !grant.canUploadVersions) return null;
    if (input.needDownload && !grant.canDownloadOriginals) return null;
    if (input.needApprove && !grant.canApprove) return null;
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
          isNull(audioProjectAccessGrants.revokedAt),
          or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
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
        artworkAssetVersionId: musicReleases.artworkAssetVersionId,
        upc: musicReleases.upc,
        labelName: musicReleases.labelName,
        pLine: musicReleases.pLine,
        cLine: musicReleases.cLine,
        originalReleaseDate: musicReleases.originalReleaseDate,
        scheduledReleaseAt: musicReleases.scheduledReleaseAt,
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

    const credits = await db
      .select({
        id: musicRecordingCredits.id,
        recordingId: musicRecordingCredits.recordingId,
        displayName: musicRecordingCredits.displayName,
        role: musicRecordingCredits.role,
        sequence: musicRecordingCredits.sequence
      })
      .from(musicRecordingCredits)
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicRecordingCredits.recordingId))
      .where(eq(musicRecordings.performerId, input.performerId))
      .orderBy(asc(musicRecordingCredits.sequence));

    const declarations = await db
      .select({
        id: musicRightsDeclarations.id,
        releaseId: musicRightsDeclarations.releaseId,
        recordingId: musicRightsDeclarations.recordingId,
        declarationType: musicRightsDeclarations.declarationType,
        declarationText: musicRightsDeclarations.declarationText,
        termsDocumentAssetVersionId: musicRightsDeclarations.termsDocumentAssetVersionId,
        termsVersion: musicRightsDeclarations.termsVersion,
        termsHash: musicRightsDeclarations.termsHash,
        declaredAt: musicRightsDeclarations.declaredAt
      })
      .from(musicRightsDeclarations)
      .innerJoin(musicReleases, eq(musicReleases.id, musicRightsDeclarations.releaseId))
      .where(eq(musicReleases.performerId, input.performerId))
      .orderBy(desc(musicRightsDeclarations.declaredAt));

    const declarationEvents = await db
      .select({
        declarationId: musicRightsDeclarationEvents.declarationId,
        eventType: musicRightsDeclarationEvents.eventType,
        reason: musicRightsDeclarationEvents.reason,
        createdAt: musicRightsDeclarationEvents.createdAt
      })
      .from(musicRightsDeclarationEvents)
      .innerJoin(musicRightsDeclarations, eq(musicRightsDeclarations.id, musicRightsDeclarationEvents.declarationId))
      .innerJoin(musicReleases, eq(musicReleases.id, musicRightsDeclarations.releaseId))
      .where(eq(musicReleases.performerId, input.performerId))
      .orderBy(asc(musicRightsDeclarationEvents.createdAt));

    const masterRows = await db
      .select({
        versionId: audioProjectAssetVersions.id,
        assetId: audioProjectAssetVersions.assetId,
        projectId: audioProjectAssetVersions.projectId,
        projectTitle: audioProjects.title,
        title: audioAssets.title,
        originalFilename: audioProjectAssetVersions.originalFilename,
        mimeType: audioProjectAssetVersions.mimeType,
        assetKind: audioAssets.assetKind,
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
        isNull(audioProjectAccessGrants.revokedAt),
        or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
      ))
      .where(and(
        eq(audioProjects.performerId, input.performerId),
        eq(audioProjects.status, 'active'),
        eq(audioAssets.status, 'active'),
        eq(audioProjectAssetVersions.integrityStatus, 'verified')
      ))
      .orderBy(desc(audioProjectAssetVersions.versionNumber), desc(audioProjectAssetVersions.createdAt));

    const seenAssets = new Set<string>();
    const latestAssets = masterRows.filter((row) => {
      if (seenAssets.has(row.assetId)) return false;
      seenAssets.add(row.assetId);
      return true;
    });
    const masters = latestAssets.filter((row) => row.mimeType.startsWith('audio/'));
    const artworks = latestAssets.filter((row) => row.mimeType.startsWith('image/') && row.assetKind === 'artwork');
    const rightsDocuments = latestAssets.filter((row) => row.assetKind === 'document' || row.mimeType === 'application/pdf' || row.mimeType.startsWith('text/'));

    return {
      masters,
      artworks,
      rightsDocuments,
      releases: releases.map((release) => ({
        ...release,
        recordings: recordings.filter((recording) => recording.releaseId === release.id).map((recording) => ({
          ...recording,
          credits: credits.filter((credit) => credit.recordingId === recording.recordingId)
        })),
        declarations: declarations.filter((declaration) => declaration.releaseId === release.id).map((declaration) => {
          const events = declarationEvents.filter((event) => event.declarationId === declaration.id);
          const outcome = events.some((event) => event.eventType === 'revoked')
            ? 'revoked'
            : events.find((event) => event.eventType === 'verified' || event.eventType === 'rejected')?.eventType ?? 'declared';
          return { ...declaration, outcome, events };
        }),
        readiness: buildReleaseReadiness({
          release,
          recordings: recordings.filter((recording) => recording.releaseId === release.id),
          credits,
          declarations: declarations.filter((declaration) => declaration.releaseId === release.id).map((declaration) => {
            const events = declarationEvents.filter((event) => event.declarationId === declaration.id);
            const outcome = events.some((event) => event.eventType === 'revoked')
              ? 'revoked'
              : events.find((event) => event.eventType === 'verified' || event.eventType === 'rejected')?.eventType ?? 'declared';
            return { declarationType: declaration.declarationType, outcome };
          })
        })
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

  async function updateReleaseDraft(input: {
    releaseId: string;
    performerId: string;
    actorUserId: string;
    expectedUpdatedAt?: string | null;
    artworkAssetVersionId?: string | null;
    title: string;
    trackTitle: string;
    versionTitle?: string | null;
    primaryArtistName: string;
    releaseType: string;
    distributionMode: string;
    upc?: string | null;
    isrc?: string | null;
    labelName?: string | null;
    pLine?: string | null;
    cLine?: string | null;
    originalReleaseDate?: string | null;
    scheduledReleaseAt?: string | null;
    territories?: string[] | null;
    isExplicit?: boolean;
    languageCode?: string | null;
    credits?: Array<{ displayName?: string; role?: string }> | null;
  }) {
    if (!RELEASE_TYPES.has(input.releaseType)) throw new Error('Release type is invalid.');
    if (!DISTRIBUTION_MODES.has(input.distributionMode)) throw new Error('Distribution mode is invalid.');
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
    const credits = normalizeCredits(input.credits);
    const scheduledReleaseAt = input.scheduledReleaseAt?.trim() ? new Date(input.scheduledReleaseAt) : null;
    if (upc && !/^[0-9]{8,14}$/.test(upc)) throw new Error('UPC must contain 8 through 14 digits.');
    if (isrc && !/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)) throw new Error('ISRC must use the 12-character ISRC format.');
    if (languageCode && !/^[a-z]{2,3}$/.test(languageCode)) throw new Error('Language code must contain 2 or 3 letters.');
    if (originalReleaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(originalReleaseDate)) throw new Error('Original release date must use YYYY-MM-DD.');
    if (scheduledReleaseAt && Number.isNaN(scheduledReleaseAt.getTime())) throw new Error('Scheduled release time is invalid.');

    const [release] = await db.select().from(musicReleases).where(and(
      eq(musicReleases.id, input.releaseId),
      eq(musicReleases.performerId, input.performerId)
    )).limit(1);
    if (!release?.projectId) throw new Error('Release draft not found.');
    if (release.status !== 'draft') throw new Error('Only a draft release can be edited. Return it to draft through rights review before changing metadata.');
    if (input.expectedUpdatedAt) {
      const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
      if (Number.isNaN(expectedUpdatedAt.getTime()) || release.updatedAt.toISOString() !== expectedUpdatedAt.toISOString()) {
        throw new Error('Release changed in another session. Reload before saving.');
      }
    }
    const access = await requireProjectAccess({ projectId: release.projectId, userId: input.actorUserId, needManageRelease: true });
    if (!access) throw new Error('Release management permission required.');
    const [releaseRecording] = await db
      .select({ recording: musicRecordings })
      .from(musicReleaseRecordings)
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
      .where(eq(musicReleaseRecordings.releaseId, release.id))
      .orderBy(asc(musicReleaseRecordings.trackNumber))
      .limit(1);
    if (!releaseRecording) throw new Error('Release recording not found.');

    const artworkAssetVersionId = input.artworkAssetVersionId?.trim() || null;
    if (artworkAssetVersionId) {
      const [artwork] = await db
        .select({ id: audioProjectAssetVersions.id, mimeType: audioProjectAssetVersions.mimeType, assetKind: audioAssets.assetKind })
        .from(audioProjectAssetVersions)
        .innerJoin(audioAssets, eq(audioAssets.id, audioProjectAssetVersions.assetId))
        .where(and(
          eq(audioProjectAssetVersions.id, artworkAssetVersionId),
          eq(audioProjectAssetVersions.projectId, release.projectId),
          eq(audioProjectAssetVersions.performerId, input.performerId),
          eq(audioProjectAssetVersions.integrityStatus, 'verified')
        ))
        .limit(1);
      if (!artwork || artwork.assetKind !== 'artwork' || !artwork.mimeType.startsWith('image/')) {
        throw new Error('Artwork must be a verified image from this release project.');
      }
    }

    // Draft edits are progressive: persist any structurally valid revision and
    // report readiness for the proposed state. No declaration is assumed here,
    // so metadata can be completed over time without making rights readiness
    // appear green early.
    const proposedReadiness = buildReleaseReadiness({
      release: {
        artworkAssetVersionId,
        title,
        primaryArtistName,
        pLine,
        cLine,
        originalReleaseDate,
        territories,
        distributionMode: input.distributionMode,
        scheduledReleaseAt
      },
      recordings: [{
        recordingId: releaseRecording.recording.id,
        masterAssetVersionId: releaseRecording.recording.masterAssetVersionId,
        title: trackTitle,
        languageCode
      }],
      credits: credits.map((credit) => ({
        recordingId: releaseRecording.recording.id,
        role: credit.role
      })),
      declarations: []
    });

    const previousMetadataRevision = Number((release.metadata as any)?.metadataRevision ?? 1);
    const now = new Date(Math.max(Date.now(), release.updatedAt.getTime() + 1));
    return db.transaction(async (tx) => {
      const [updatedRelease] = await tx.update(musicReleases).set({
        artworkAssetVersionId,
        title,
        primaryArtistName,
        releaseType: input.releaseType,
        distributionMode: input.distributionMode as 'private' | 'sway_only' | 'sway_first' | 'everywhere',
        upc,
        labelName,
        pLine,
        cLine,
        originalReleaseDate,
        scheduledReleaseAt,
        territories,
        metadata: {
          ...((release.metadata as Record<string, unknown> | null) ?? {}),
          metadataRevision: previousMetadataRevision + 1,
          lastEditedByUserId: input.actorUserId,
          deliveryEnabled: false
        },
        updatedAt: now
      }).where(and(
        eq(musicReleases.id, release.id),
        eq(musicReleases.status, 'draft'),
        sql`coalesce((${musicReleases.metadata}->>'metadataRevision')::integer, 1) = ${previousMetadataRevision}`
      )).returning();
      if (!updatedRelease) {
        throw new Error('Release changed in another session. Reload before saving.');
      }

      const [updatedRecording] = await tx.update(musicRecordings).set({
        title: trackTitle,
        versionTitle,
        primaryArtistName,
        isrc,
        isExplicit: input.isExplicit === true,
        languageCode,
        originalReleaseDate,
        rightsStatus: 'draft',
        updatedAt: now
      }).where(eq(musicRecordings.id, releaseRecording.recording.id)).returning();

      await tx.delete(musicRecordingCredits).where(eq(musicRecordingCredits.recordingId, releaseRecording.recording.id));
      await tx.insert(musicRecordingCredits).values(credits.map((credit) => ({
        recordingId: releaseRecording.recording.id,
        displayName: credit.displayName,
        role: credit.role,
        sequence: credit.sequence
      })));
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'music_release',
        entityId: release.id,
        eventType: 'music_release.draft_update',
        previousStatus: 'draft',
        nextStatus: 'draft',
        metadata: {
          projectId: release.projectId,
          previousUpdatedAt: release.updatedAt.toISOString(),
          metadataRevision: Number((updatedRelease.metadata as any)?.metadataRevision ?? 2),
          creditCount: credits.length,
          artworkAssetVersionId
        }
      });
      return { release: updatedRelease, recording: updatedRecording, credits, readiness: proposedReadiness };
    });
  }

  async function createRightsDeclaration(input: {
    releaseId: string;
    performerId: string;
    actorUserId: string;
    declarationType: string;
    termsDocumentAssetVersionId: string;
    termsVersion: string;
    declarationText: string;
    evidenceNote: string;
    recordingId?: string | null;
  }) {
    const declarationType = input.declarationType.trim().toLowerCase();
    if (!RIGHTS_DECLARATION_TYPES.has(declarationType)) throw new Error('Rights declaration type is invalid.');
    const termsVersion = requiredReleaseText(input.termsVersion, 'Terms version', 80);
    const declarationText = requiredReleaseText(input.declarationText, 'Declaration text', 4000);
    const evidenceNote = requiredReleaseText(input.evidenceNote, 'Evidence note', 1000);
    const [release] = await db.select().from(musicReleases).where(and(
      eq(musicReleases.id, input.releaseId), eq(musicReleases.performerId, input.performerId)
    )).limit(1);
    if (!release?.projectId) throw new Error('Release not found.');
    if (!['draft', 'rights_review'].includes(release.status)) throw new Error('Rights evidence cannot be added in the current release state.');
    const access = await requireProjectAccess({ projectId: release.projectId, userId: input.actorUserId, needManageRelease: true });
    if (!access) throw new Error('Release management permission required.');
    if (release.status === 'draft') {
      const workspace = await listReleaseWorkspace({ performerId: input.performerId, actorUserId: input.actorUserId });
      const current = workspace.releases.find((candidate) => candidate.id === release.id);
      const requiredRightsIssues = new Set(BASE_REQUIRED_RIGHTS.map(
        (type) => `Verified ${type.replaceAll('_', ' ')} rights evidence is required.`
      ));
      const metadataIssues = current?.readiness.issues.filter((issue) => !requiredRightsIssues.has(issue))
        ?? ['Release readiness could not be evaluated.'];
      if (metadataIssues.length) {
        throw new Error(`Complete release metadata before rights review: ${metadataIssues.join(' ')}`);
      }
    }
    const [document] = await db
      .select({
        id: audioProjectAssetVersions.id,
        sha256: audioProjectAssetVersions.sha256,
        assetKind: audioAssets.assetKind,
        integrityStatus: audioProjectAssetVersions.integrityStatus
      })
      .from(audioProjectAssetVersions)
      .innerJoin(audioAssets, eq(audioAssets.id, audioProjectAssetVersions.assetId))
      .where(and(
        eq(audioProjectAssetVersions.id, input.termsDocumentAssetVersionId),
        eq(audioProjectAssetVersions.projectId, release.projectId),
        eq(audioProjectAssetVersions.performerId, input.performerId)
      ))
      .limit(1);
    if (!document || document.integrityStatus !== 'verified' || document.assetKind !== 'document') {
      throw new Error('A verified rights document from this release project is required.');
    }
    const recordingId = input.recordingId?.trim() || null;
    if (recordingId) {
      const [link] = await db.select().from(musicReleaseRecordings).where(and(
        eq(musicReleaseRecordings.releaseId, release.id), eq(musicReleaseRecordings.recordingId, recordingId)
      )).limit(1);
      if (!link) throw new Error('Rights recording must belong to this release.');
    }
    const evidence = { note: evidenceNote, sourceDocumentSha256: document.sha256, attestedByUserId: input.actorUserId };
    const declarationSha256 = sha256Hex(JSON.stringify({
      releaseId: release.id,
      recordingId,
      declarationType,
      termsVersion,
      termsHash: document.sha256,
      declarationText,
      evidence
    }));
    const [declaration] = await db.insert(musicRightsDeclarations).values({
      projectId: release.projectId,
      releaseId: release.id,
      recordingId,
      declaredByUserId: input.actorUserId,
      declarationType,
      termsDocumentAssetVersionId: document.id,
      termsVersion,
      termsHash: document.sha256,
      declarationText,
      declarationSha256,
      evidence
    }).returning();
    if (release.status === 'draft') {
      await db.update(musicReleases).set({ status: 'rights_review', updatedAt: new Date() }).where(eq(musicReleases.id, release.id));
    }
    if (recordingId) {
      await db.update(musicRecordings).set({ rightsStatus: 'declared', updatedAt: new Date() }).where(eq(musicRecordings.id, recordingId));
    }
    await writeAudit(db, {
      actorId: input.actorUserId,
      entityType: 'music_rights_declaration',
      entityId: declaration.id,
      eventType: 'music_rights_declaration.create',
      metadata: { releaseId: release.id, recordingId, declarationType, termsHash: document.sha256, declarationSha256 }
    });
    return declaration;
  }

  async function reviewRightsDeclaration(input: {
    declarationId: string;
    actorUserId: string;
    outcome: 'verified' | 'rejected';
    reason: string;
  }) {
    const reason = requiredReleaseText(input.reason, 'Review reason', 1000);
    const [row] = await db
      .select({
        declaration: musicRightsDeclarations,
        release: musicReleases,
        performerOwnerUserId: performers.ownerUserId
      })
      .from(musicRightsDeclarations)
      .innerJoin(musicReleases, eq(musicReleases.id, musicRightsDeclarations.releaseId))
      .innerJoin(performers, eq(performers.id, musicReleases.performerId))
      .where(eq(musicRightsDeclarations.id, input.declarationId))
      .limit(1);
    if (!row?.release.projectId) throw new Error('Rights declaration not found.');
    if (row.declaration.declaredByUserId === input.actorUserId) throw new Error('Rights evidence requires an independent project reviewer.');
    const access = await requireProjectAccess({ projectId: row.release.projectId, userId: input.actorUserId, needApprove: true });
    if (!access) throw new Error('Release review permission required.');
    const [evidenceAccess] = await db
      .select({ eventId: auditEvents.eventId })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.actorId, input.actorUserId),
        eq(auditEvents.entityType, 'music_rights_declaration'),
        eq(auditEvents.entityId, row.declaration.id),
        eq(auditEvents.eventType, 'music_rights_declaration.evidence_access'),
        sql`${auditEvents.metadata}->>'termsHash' = ${row.declaration.termsHash}`,
        sql`${auditEvents.metadata}->>'termsDocumentAssetVersionId' = ${row.declaration.termsDocumentAssetVersionId}`
      ))
      .limit(1);
    if (!evidenceAccess) {
      throw new Error('Open the exact sealed rights document before recording a review outcome.');
    }
    const [event] = await db.insert(musicRightsDeclarationEvents).values({
      declarationId: row.declaration.id,
      actorUserId: input.actorUserId,
      eventType: input.outcome,
      declarationSha256: row.declaration.declarationSha256,
      evidence: { independentReview: true, reviewerUserId: input.actorUserId },
      reason
    }).returning();
    if (row.declaration.recordingId) {
      await db.update(musicRecordings).set({
        rightsStatus: input.outcome === 'verified' ? 'under_review' : 'blocked',
        updatedAt: new Date()
      }).where(eq(musicRecordings.id, row.declaration.recordingId));
    }
    if (input.outcome === 'rejected') {
      await db.update(musicReleases).set({ status: 'blocked', updatedAt: new Date() }).where(eq(musicReleases.id, row.release.id));
    }
    await writeAudit(db, {
      actorType: 'account',
      actorId: input.actorUserId,
      entityType: 'music_rights_declaration',
      entityId: row.declaration.id,
      eventType: `music_rights_declaration.${input.outcome}`,
      metadata: { releaseId: row.release.id, reason }
    });
    if (input.outcome === 'verified') {
      const workspace = await listReleaseWorkspace({
        performerId: row.release.performerId,
        actorUserId: row.performerOwnerUserId
      });
      const refreshed = workspace.releases.find((release) => release.id === row.release.id);
      if (refreshed?.readiness.ready) {
        const now = new Date();
        await db.transaction(async (tx) => {
          await tx.update(musicReleases).set({ status: 'ready', updatedAt: now }).where(eq(musicReleases.id, row.release.id));
          for (const recording of refreshed.recordings) {
            await tx.update(musicRecordings).set({ rightsStatus: 'cleared', updatedAt: now }).where(eq(musicRecordings.id, recording.recordingId));
          }
          await tx.insert(auditEvents).values({
            actorType: 'account',
            actorId: input.actorUserId,
            entityType: 'music_release',
            entityId: row.release.id,
            eventType: 'music_release.readiness_pass',
            previousStatus: row.release.status,
            nextStatus: 'ready',
            metadata: { verifiedDeclarationId: row.declaration.id, readinessIssues: [] }
          });
        });
      }
    }
    return event;
  }

  async function openRightsReviewDocument(input: {
    declarationId: string;
    actorUserId: string;
  }) {
    const [row] = await db
      .select({
        declaration: musicRightsDeclarations,
        releaseProjectId: musicReleases.projectId
      })
      .from(musicRightsDeclarations)
      .innerJoin(musicReleases, eq(musicReleases.id, musicRightsDeclarations.releaseId))
      .where(eq(musicRightsDeclarations.id, input.declarationId))
      .limit(1);
    if (!row?.releaseProjectId || row.releaseProjectId !== row.declaration.projectId) {
      throw new Error('Rights declaration not found.');
    }
    if (row.declaration.declaredByUserId === input.actorUserId) {
      throw new Error('Rights evidence requires an independent project reviewer.');
    }
    const access = await requireProjectAccess({
      projectId: row.declaration.projectId,
      userId: input.actorUserId,
      needApprove: true
    });
    if (!access) throw new Error('Release review permission required.');

    const [version] = await db
      .select({
        id: audioProjectAssetVersions.id,
        projectId: audioProjectAssetVersions.projectId,
        originalFilename: audioProjectAssetVersions.originalFilename,
        mimeType: audioProjectAssetVersions.mimeType,
        byteSize: audioProjectAssetVersions.byteSize,
        sha256: audioProjectAssetVersions.sha256,
        storageProvider: audioProjectAssetVersions.storageProvider,
        storageBucket: audioProjectAssetVersions.storageBucket,
        storageKey: audioProjectAssetVersions.storageKey,
        integrityStatus: audioProjectAssetVersions.integrityStatus,
        assetKind: audioAssets.assetKind
      })
      .from(audioProjectAssetVersions)
      .innerJoin(audioAssets, eq(audioAssets.id, audioProjectAssetVersions.assetId))
      .where(and(
        eq(audioProjectAssetVersions.id, row.declaration.termsDocumentAssetVersionId),
        eq(audioProjectAssetVersions.projectId, row.declaration.projectId),
        eq(audioProjectAssetVersions.integrityStatus, 'verified'),
        eq(audioAssets.assetKind, 'document')
      ))
      .limit(1);
    if (!version) throw new Error('The sealed rights document is unavailable for review.');
    if (version.sha256 !== row.declaration.termsHash) {
      throw new Error('The sealed rights document does not match the declaration terms hash.');
    }

    const object = await store.openOriginal({
      storageProvider: parseAudioStorageProvider(version.storageProvider),
      storageBucket: version.storageBucket,
      storageKey: version.storageKey
    });
    await writeAudit(db, {
      actorType: 'account',
      actorId: input.actorUserId,
      entityType: 'music_rights_declaration',
      entityId: row.declaration.id,
      eventType: 'music_rights_declaration.evidence_access',
      metadata: {
        projectId: row.declaration.projectId,
        termsDocumentAssetVersionId: row.declaration.termsDocumentAssetVersionId,
        termsHash: row.declaration.termsHash
      }
    });
    return { version, ...object };
  }

  async function grantReleaseReviewer(input: {
    projectId: string;
    connectionId: string;
    actorUserId: string;
  }) {
    const access = await requireProjectAccess({
      projectId: input.projectId,
      userId: input.actorUserId,
      needManageAccess: true
    });
    if (!access) throw new Error('Project access management permission required.');
    const [connection] = await db.select().from(audioFileConnections).where(and(
      eq(audioFileConnections.id, input.connectionId),
      isNull(audioFileConnections.revokedAt)
    )).limit(1);
    if (!connection || ![connection.memberOneUserId, connection.memberTwoUserId].includes(input.actorUserId)) {
      throw new Error('Active file connection required.');
    }
    const reviewerUserId = connection.memberOneUserId === input.actorUserId
      ? connection.memberTwoUserId
      : connection.memberOneUserId;
    const now = new Date();
    const [existing] = await db.select().from(audioProjectAccessGrants).where(and(
      eq(audioProjectAccessGrants.projectId, input.projectId),
      eq(audioProjectAccessGrants.granteeUserId, reviewerUserId),
      isNull(audioProjectAccessGrants.revokedAt)
    )).limit(1);
    const existingIsActive = Boolean(existing && (!existing.expiresAt || existing.expiresAt.getTime() > now.getTime()));
    if (existing?.role === 'owner' && (!existingIsActive || !existing.canApprove)) {
      throw new Error('The project owner grant cannot be replaced through reviewer access.');
    }

    const { grant, replacedGrantId } = existingIsActive && existing?.canApprove
      ? { grant: existing, replacedGrantId: null }
      : await db.transaction(async (tx) => {
          if (existing) {
            await tx.update(audioProjectAccessGrants).set({
              revokedAt: now,
              revokedByUserId: input.actorUserId,
              revocationReason: 'Replaced by an explicit release-review grant.'
            }).where(and(
              eq(audioProjectAccessGrants.id, existing.id),
              isNull(audioProjectAccessGrants.revokedAt)
            ));
          }
          const [replacement] = await tx.insert(audioProjectAccessGrants).values({
            projectId: input.projectId,
            granteeUserId: reviewerUserId,
            role: existing?.role ?? 'reviewer',
            canUploadVersions: existing?.canUploadVersions ?? false,
            canDownloadOriginals: existing?.canDownloadOriginals ?? false,
            canComment: existing?.canComment ?? true,
            canApprove: true,
            canManageRelease: existing?.canManageRelease ?? false,
            canManageAccess: existing?.canManageAccess ?? false,
            grantedByUserId: input.actorUserId,
            expiresAt: existingIsActive ? existing?.expiresAt ?? null : null
          }).returning();
          return { grant: replacement, replacedGrantId: existing?.id ?? null };
        });
    await writeAudit(db, {
      actorId: input.actorUserId,
      entityType: 'audio_project_access_grant',
      entityId: grant.id,
      eventType: 'audio_project.release_reviewer_grant',
      metadata: { projectId: input.projectId, connectionId: input.connectionId, reviewerUserId, replacedGrantId }
    });
    return { grant, reviewerUserId, reused: existingIsActive && Boolean(existing?.canApprove), replaced: Boolean(replacedGrantId) };
  }

  async function listRightsReviewQueue(input: { actorUserId: string }) {
    const declarations = await db
      .select({
        id: musicRightsDeclarations.id,
        releaseId: musicRightsDeclarations.releaseId,
        releaseTitle: musicReleases.title,
        primaryArtistName: musicReleases.primaryArtistName,
        projectId: musicRightsDeclarations.projectId,
        recordingId: musicRightsDeclarations.recordingId,
        declaredByUserId: musicRightsDeclarations.declaredByUserId,
        declarationType: musicRightsDeclarations.declarationType,
        declarationText: musicRightsDeclarations.declarationText,
        declarationSha256: musicRightsDeclarations.declarationSha256,
        termsVersion: musicRightsDeclarations.termsVersion,
        termsHash: musicRightsDeclarations.termsHash,
        evidence: musicRightsDeclarations.evidence,
        declaredAt: musicRightsDeclarations.declaredAt
      })
      .from(musicRightsDeclarations)
      .innerJoin(musicReleases, eq(musicReleases.id, musicRightsDeclarations.releaseId))
      .innerJoin(audioProjectAccessGrants, and(
        eq(audioProjectAccessGrants.projectId, musicRightsDeclarations.projectId),
        eq(audioProjectAccessGrants.granteeUserId, input.actorUserId),
        eq(audioProjectAccessGrants.canApprove, true),
        isNull(audioProjectAccessGrants.revokedAt),
        or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
      ))
      .where(sql`${musicRightsDeclarations.declaredByUserId} <> ${input.actorUserId}`)
      .orderBy(asc(musicRightsDeclarations.declaredAt));
    if (!declarations.length) return [];
    const events = await db.select({
      declarationId: musicRightsDeclarationEvents.declarationId,
      eventType: musicRightsDeclarationEvents.eventType
    }).from(musicRightsDeclarationEvents);
    return declarations.filter((declaration) => !events.some((event) =>
      event.declarationId === declaration.id && ['verified', 'rejected', 'revoked'].includes(event.eventType)
    ));
  }

  async function getPublicRelease(input: { releaseId: string }) {
    const [release] = await db.select({
      id: musicReleases.id,
      performerId: musicReleases.performerId,
      artworkAssetVersionId: musicReleases.artworkAssetVersionId,
      title: musicReleases.title,
      primaryArtistName: musicReleases.primaryArtistName,
      releaseType: musicReleases.releaseType,
      distributionMode: musicReleases.distributionMode,
      status: musicReleases.status,
      labelName: musicReleases.labelName,
      pLine: musicReleases.pLine,
      cLine: musicReleases.cLine,
      originalReleaseDate: musicReleases.originalReleaseDate,
      scheduledReleaseAt: musicReleases.scheduledReleaseAt,
      publishedAt: musicReleases.publishedAt,
      territories: musicReleases.territories
    }).from(musicReleases).where(and(
      eq(musicReleases.id, input.releaseId),
      ne(musicReleases.distributionMode, 'private'),
      inArray(musicReleases.status, ['ready', 'scheduled', 'published'])
    )).limit(1);
    if (!release) return null;
    const recordings = await db.select({
      recordingId: musicRecordings.id,
      title: musicRecordings.title,
      versionTitle: musicRecordings.versionTitle,
      primaryArtistName: musicRecordings.primaryArtistName,
      isExplicit: musicRecordings.isExplicit,
      languageCode: musicRecordings.languageCode,
      rightsStatus: musicRecordings.rightsStatus,
      discNumber: musicReleaseRecordings.discNumber,
      trackNumber: musicReleaseRecordings.trackNumber
    }).from(musicReleaseRecordings)
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
      .where(eq(musicReleaseRecordings.releaseId, release.id))
      .orderBy(asc(musicReleaseRecordings.discNumber), asc(musicReleaseRecordings.trackNumber));
    if (!release.artworkAssetVersionId || !recordings.length || recordings.some((recording) => recording.rightsStatus !== 'cleared')) {
      return null;
    }
    const credits = await db.select({
      recordingId: musicRecordingCredits.recordingId,
      displayName: musicRecordingCredits.displayName,
      role: musicRecordingCredits.role,
      sequence: musicRecordingCredits.sequence
    }).from(musicRecordingCredits)
      .innerJoin(musicReleaseRecordings, eq(musicReleaseRecordings.recordingId, musicRecordingCredits.recordingId))
      .where(eq(musicReleaseRecordings.releaseId, release.id))
      .orderBy(asc(musicRecordingCredits.sequence));
    const destinations = await db.select({
      destinationKey: musicDistributionDeliveries.destinationKey,
      deliveryStatus: musicDistributionDeliveries.deliveryStatus,
      liveAt: musicDistributionDeliveries.liveAt
    }).from(musicDistributionDeliveries)
      .where(eq(musicDistributionDeliveries.releaseId, release.id))
      .orderBy(asc(musicDistributionDeliveries.destinationKey));
    const providerConfirmedLive = destinations.some((destination) => destination.deliveryStatus === 'live' && destination.liveAt);
    return {
      ...release,
      status: release.status === 'published' && !providerConfirmedLive ? 'ready' : release.status,
      artworkUrl: release.artworkAssetVersionId ? `/api/public/releases/${release.id}/artwork` : null,
      releasePath: `/r/${release.id}`,
      recordings: recordings.map((recording) => ({
        ...recording,
        credits: credits.filter((credit) => credit.recordingId === recording.recordingId)
      })),
      destinations
    };
  }

  async function openPublicReleaseArtwork(input: { releaseId: string }) {
    const release = await getPublicRelease(input);
    if (!release?.artworkAssetVersionId) throw new Error('Public release artwork not found.');
    const [version] = await db.select().from(audioProjectAssetVersions).where(and(
      eq(audioProjectAssetVersions.id, release.artworkAssetVersionId),
      eq(audioProjectAssetVersions.integrityStatus, 'verified')
    )).limit(1);
    if (!version || !version.mimeType.startsWith('image/')) throw new Error('Public release artwork not found.');
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
    openOwnedVersion,
    listReleaseWorkspace,
    createReleaseDraft,
    updateReleaseDraft,
    createRightsDeclaration,
    openRightsReviewDocument,
    reviewRightsDeclaration,
    grantReleaseReviewer,
    listRightsReviewQueue,
    getPublicRelease,
    openPublicReleaseArtwork,
    downloadSharedOriginal
  };
}

export type AudioPublishingService = ReturnType<typeof createAudioPublishingService>;
