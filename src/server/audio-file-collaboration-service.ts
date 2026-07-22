import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  audioFileAccessGrants,
  audioFileConnectionEvents,
  audioFileConnections,
  audioProjectAccessGrants,
  audioProjectAssetVersions,
  audioProjects,
  audioReviewEvents,
  auditEvents
} from '../db/schema';
import type { AudioObjectStore } from './audio-object-storage';
import { parseAudioStorageProvider } from './audio-object-storage';

const REVIEW_EVENT_TYPES = [
  'comment',
  'approved',
  'changes_requested',
  'approval_withdrawn',
  'resolved'
] as const;

type ReviewEventType = typeof REVIEW_EVENT_TYPES[number];

function isReviewEventType(value: unknown): value is ReviewEventType {
  return typeof value === 'string' && REVIEW_EVENT_TYPES.includes(value as ReviewEventType);
}

function activeGrantWhere(grantId: string) {
  return and(
    eq(audioFileAccessGrants.id, grantId),
    isNull(audioFileAccessGrants.revokedAt),
    or(
      isNull(audioFileAccessGrants.expiresAt),
      gt(audioFileAccessGrants.expiresAt, new Date())
    )
  );
}

function isConnectionMember(
  connection: { memberOneUserId: string; memberTwoUserId: string },
  userId: string
) {
  return connection.memberOneUserId === userId || connection.memberTwoUserId === userId;
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

export function createAudioFileCollaborationService(config: {
  db: SwayDb;
  store: AudioObjectStore;
}) {
  const { db, store } = config;

  async function shareVersion(input: {
    connectionId: string;
    versionId: string;
    grantedByUserId: string;
    canDownloadOriginal?: boolean;
    canComment?: boolean;
    canApprove?: boolean;
    expiresAt?: Date | null;
  }) {
    return db.transaction(async (tx) => {
      const [connection] = await tx
        .select()
        .from(audioFileConnections)
        .where(and(
          eq(audioFileConnections.id, input.connectionId),
          isNull(audioFileConnections.revokedAt)
        ))
        .limit(1);
      if (!connection) throw Object.assign(new Error('Active file connection required.'), { status: 404 });
      if (!isConnectionMember(connection, input.grantedByUserId)) {
        throw Object.assign(new Error('Only connection members can share files.'), { status: 403 });
      }

      const granteeUserId = connection.memberOneUserId === input.grantedByUserId
        ? connection.memberTwoUserId
        : connection.memberOneUserId;
      const [version] = await tx
        .select()
        .from(audioProjectAssetVersions)
        .where(eq(audioProjectAssetVersions.id, input.versionId))
        .limit(1);
      if (!version) throw Object.assign(new Error('Asset version not found.'), { status: 404 });

      const [grantorAccess] = await tx
        .select()
        .from(audioProjectAccessGrants)
        .where(and(
          eq(audioProjectAccessGrants.projectId, version.projectId),
          eq(audioProjectAccessGrants.granteeUserId, input.grantedByUserId),
          eq(audioProjectAccessGrants.canManageAccess, true),
          isNull(audioProjectAccessGrants.revokedAt)
        ))
        .limit(1);
      if (!grantorAccess) {
        throw Object.assign(new Error('Project access management permission required.'), { status: 403 });
      }

      const [existing] = await tx
        .select()
        .from(audioFileAccessGrants)
        .where(and(
          eq(audioFileAccessGrants.connectionId, connection.id),
          eq(audioFileAccessGrants.assetVersionId, version.id),
          eq(audioFileAccessGrants.granteeUserId, granteeUserId),
          isNull(audioFileAccessGrants.revokedAt)
        ))
        .limit(1);
      if (existing) return { grant: existing, reused: true as const };

      const canDownloadOriginal = input.canDownloadOriginal !== false;
      const canComment = input.canComment !== false;
      const canApprove = input.canApprove !== false;
      const [grant] = await tx
        .insert(audioFileAccessGrants)
        .values({
          connectionId: connection.id,
          connectionMemberOneUserId: connection.memberOneUserId,
          connectionMemberTwoUserId: connection.memberTwoUserId,
          projectId: version.projectId,
          assetVersionId: version.id,
          grantorProjectAccessGrantId: grantorAccess.id,
          grantorCanManageAccess: true,
          grantedByUserId: input.grantedByUserId,
          granteeUserId,
          canStreamPreview: true,
          canDownloadOriginal,
          canUploadNewVersion: false,
          canComment,
          canApprove,
          expiresAt: input.expiresAt ?? null
        })
        .returning();

      await tx.insert(audioFileConnectionEvents).values({
        connectionId: connection.id,
        actorUserId: input.grantedByUserId,
        eventType: 'file_shared',
        projectId: version.projectId,
        assetVersionId: version.id,
        metadata: { grantId: grant.id, canDownloadOriginal, canComment, canApprove }
      });
      await tx.update(audioFileConnections)
        .set({ lastUsedAt: new Date(), updatedAt: new Date() })
        .where(eq(audioFileConnections.id, connection.id));
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.grantedByUserId,
        entityType: 'audio_file_access_grant',
        entityId: grant.id,
        eventType: 'audio_file_access.share',
        previousStatus: null,
        nextStatus: null,
        metadata: { connectionId: connection.id, versionId: version.id, granteeUserId }
      });

      return { grant, reused: false as const };
    });
  }

  async function listSharedWithMe(input: { userId: string }) {
    return db
      .select({
        grantId: audioFileAccessGrants.id,
        connectionId: audioFileAccessGrants.connectionId,
        projectId: audioFileAccessGrants.projectId,
        projectTitle: audioProjects.title,
        versionId: audioProjectAssetVersions.id,
        originalFilename: audioProjectAssetVersions.originalFilename,
        mimeType: audioProjectAssetVersions.mimeType,
        byteSize: audioProjectAssetVersions.byteSize,
        sha256: audioProjectAssetVersions.sha256,
        canDownloadOriginal: audioFileAccessGrants.canDownloadOriginal,
        canComment: audioFileAccessGrants.canComment,
        canApprove: audioFileAccessGrants.canApprove,
        expiresAt: audioFileAccessGrants.expiresAt,
        createdAt: audioFileAccessGrants.createdAt
      })
      .from(audioFileAccessGrants)
      .innerJoin(audioFileConnections, and(
        eq(audioFileConnections.id, audioFileAccessGrants.connectionId),
        isNull(audioFileConnections.revokedAt)
      ))
      .innerJoin(audioProjects, eq(audioProjects.id, audioFileAccessGrants.projectId))
      .innerJoin(audioProjectAssetVersions, eq(audioProjectAssetVersions.id, audioFileAccessGrants.assetVersionId))
      .where(and(
        eq(audioFileAccessGrants.granteeUserId, input.userId),
        isNull(audioFileAccessGrants.revokedAt),
        or(
          isNull(audioFileAccessGrants.expiresAt),
          gt(audioFileAccessGrants.expiresAt, new Date())
        )
      ))
      .orderBy(desc(audioFileAccessGrants.createdAt));
  }

  async function listSharedByMe(input: { userId: string }) {
    return db
      .select({
        grantId: audioFileAccessGrants.id,
        connectionId: audioFileAccessGrants.connectionId,
        granteeUserId: audioFileAccessGrants.granteeUserId,
        projectId: audioFileAccessGrants.projectId,
        projectTitle: audioProjects.title,
        versionId: audioProjectAssetVersions.id,
        originalFilename: audioProjectAssetVersions.originalFilename,
        mimeType: audioProjectAssetVersions.mimeType,
        byteSize: audioProjectAssetVersions.byteSize,
        sha256: audioProjectAssetVersions.sha256,
        canDownloadOriginal: audioFileAccessGrants.canDownloadOriginal,
        canComment: audioFileAccessGrants.canComment,
        canApprove: audioFileAccessGrants.canApprove,
        expiresAt: audioFileAccessGrants.expiresAt,
        createdAt: audioFileAccessGrants.createdAt
      })
      .from(audioFileAccessGrants)
      .innerJoin(audioFileConnections, and(
        eq(audioFileConnections.id, audioFileAccessGrants.connectionId),
        isNull(audioFileConnections.revokedAt)
      ))
      .innerJoin(audioProjects, eq(audioProjects.id, audioFileAccessGrants.projectId))
      .innerJoin(audioProjectAssetVersions, eq(audioProjectAssetVersions.id, audioFileAccessGrants.assetVersionId))
      .where(and(
        eq(audioFileAccessGrants.grantedByUserId, input.userId),
        isNull(audioFileAccessGrants.revokedAt),
        or(
          isNull(audioFileAccessGrants.expiresAt),
          gt(audioFileAccessGrants.expiresAt, new Date())
        )
      ))
      .orderBy(desc(audioFileAccessGrants.createdAt));
  }

  async function requireActiveGrantForUser(grantId: string, userId: string) {
    const [grant] = await db
      .select()
      .from(audioFileAccessGrants)
      .where(activeGrantWhere(grantId))
      .limit(1);
    if (!grant) throw Object.assign(new Error('Active file grant required.'), { status: 410 });
    if (grant.granteeUserId !== userId && grant.grantedByUserId !== userId) {
      throw Object.assign(new Error('File grant access denied.'), { status: 403 });
    }
    const [connection] = await db
      .select()
      .from(audioFileConnections)
      .where(and(
        eq(audioFileConnections.id, grant.connectionId),
        isNull(audioFileConnections.revokedAt)
      ))
      .limit(1);
    if (!connection || !isConnectionMember(connection, userId)) {
      throw Object.assign(new Error('Active file connection required.'), { status: 410 });
    }
    return grant;
  }

  async function downloadGrantedOriginal(input: { grantId: string; userId: string }) {
    const grant = await requireActiveGrantForUser(input.grantId, input.userId);
    if (grant.granteeUserId !== input.userId || !grant.canDownloadOriginal) {
      throw Object.assign(new Error('Original download permission required.'), { status: 403 });
    }
    const [version] = await db
      .select()
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.id, grant.assetVersionId))
      .limit(1);
    if (!version) throw Object.assign(new Error('Shared asset version not found.'), { status: 404 });

    const object = await store.openOriginal({
      storageProvider: parseAudioStorageProvider(version.storageProvider),
      storageBucket: version.storageBucket,
      storageKey: version.storageKey
    });
    await writeAudit(db, {
      actorId: input.userId,
      entityType: 'audio_file_access_grant',
      entityId: grant.id,
      eventType: 'audio_file_access.download',
      metadata: { versionId: version.id, sha256: version.sha256 }
    });
    return { version, ...object };
  }

  async function listReviewEvents(input: { grantId: string; userId: string }) {
    const grant = await requireActiveGrantForUser(input.grantId, input.userId);
    return db
      .select({
        id: audioReviewEvents.id,
        actorUserId: audioReviewEvents.actorUserId,
        eventType: audioReviewEvents.eventType,
        timecodeMs: audioReviewEvents.timecodeMs,
        body: audioReviewEvents.body,
        supersedesEventId: audioReviewEvents.supersedesEventId,
        createdAt: audioReviewEvents.createdAt
      })
      .from(audioReviewEvents)
      .where(eq(audioReviewEvents.assetVersionId, grant.assetVersionId))
      .orderBy(asc(audioReviewEvents.createdAt));
  }

  async function addReviewEvent(input: {
    grantId: string;
    userId: string;
    eventType: unknown;
    body?: unknown;
    timecodeMs?: unknown;
    supersedesEventId?: unknown;
  }) {
    const grant = await requireActiveGrantForUser(input.grantId, input.userId);
    if (!isReviewEventType(input.eventType)) {
      throw Object.assign(new Error('Unsupported review event type.'), { status: 422 });
    }

    const isGrantee = grant.granteeUserId === input.userId;
    if (input.eventType === 'resolved') {
      if (grant.grantedByUserId !== input.userId) {
        throw Object.assign(new Error('Only the file owner can resolve review items.'), { status: 403 });
      }
    } else if (!isGrantee) {
      throw Object.assign(new Error('Only the selected reviewer can submit this review event.'), { status: 403 });
    } else if ((input.eventType === 'approved' || input.eventType === 'approval_withdrawn') && !grant.canApprove) {
      throw Object.assign(new Error('Approval permission required.'), { status: 403 });
    } else if ((input.eventType === 'comment' || input.eventType === 'changes_requested') && !grant.canComment) {
      throw Object.assign(new Error('Comment permission required.'), { status: 403 });
    }

    const body = typeof input.body === 'string' ? input.body.trim().slice(0, 4000) : '';
    if ((input.eventType === 'comment' || input.eventType === 'changes_requested') && !body) {
      throw Object.assign(new Error('Review text is required.'), { status: 422 });
    }
    const timecodeMs = input.timecodeMs == null ? null : Number(input.timecodeMs);
    if (timecodeMs != null && (!Number.isInteger(timecodeMs) || timecodeMs < 0)) {
      throw Object.assign(new Error('timecodeMs must be a non-negative integer.'), { status: 422 });
    }
    const supersedesEventId = typeof input.supersedesEventId === 'string' && input.supersedesEventId
      ? input.supersedesEventId
      : null;

    const [event] = await db.insert(audioReviewEvents).values({
      assetVersionId: grant.assetVersionId,
      actorUserId: input.userId,
      eventType: input.eventType,
      timecodeMs,
      body: body || null,
      supersedesEventId
    }).returning();
    await writeAudit(db, {
      actorId: input.userId,
      entityType: 'audio_review_event',
      entityId: event.id,
      eventType: `audio_review.${input.eventType}`,
      metadata: { grantId: grant.id, versionId: grant.assetVersionId }
    });
    return event;
  }

  async function revokeGrant(input: { grantId: string; userId: string; reason?: string | null }) {
    const grant = await requireActiveGrantForUser(input.grantId, input.userId);
    const [revoked] = await db
      .update(audioFileAccessGrants)
      .set({
        revokedAt: new Date(),
        revokedByUserId: input.userId,
        revocationReason: input.reason?.trim().slice(0, 240) || null
      })
      .where(activeGrantWhere(grant.id))
      .returning();
    if (!revoked) throw Object.assign(new Error('Active file grant required.'), { status: 410 });
    await writeAudit(db, {
      actorId: input.userId,
      entityType: 'audio_file_access_grant',
      entityId: revoked.id,
      eventType: 'audio_file_access.revoke',
      metadata: { reason: revoked.revocationReason }
    });
    return { grantId: revoked.id, revokedAt: revoked.revokedAt!.toISOString() };
  }

  return {
    shareVersion,
    listSharedWithMe,
    listSharedByMe,
    downloadGrantedOriginal,
    listReviewEvents,
    addReviewEvent,
    revokeGrant
  };
}

export type AudioFileCollaborationService = ReturnType<typeof createAudioFileCollaborationService>;
