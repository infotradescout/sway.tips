import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  audioCandidateRevisions,
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
const REVIEW_AUDIT_EVENT_TYPES = REVIEW_EVENT_TYPES.map((eventType) => `audio_review.${eventType}`);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CANDIDATE_REVISION_BYTES = 536_870_912;

function sha256Hex(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

type ReviewEventType = typeof REVIEW_EVENT_TYPES[number];
type ReviewGrantScope = {
  id: string;
  assetVersionId: string;
  grantedByUserId: string;
  granteeUserId: string;
  grantPurpose: string;
};

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

function hasCurrentPrivateCollaborationCapability() {
  return sql`coalesce((
    select
      capability_event.decision = 'granted'::performer_capability_decision
      and (
        capability_event.expires_at is null
        or capability_event.expires_at > clock_timestamp()
      )
    from performer_capability_grant_events capability_event
    where capability_event.performer_id = ${audioProjects.performerId}
      and capability_event.capability = 'private_collaboration'::performer_capability
    order by capability_event.event_sequence desc
    limit 1
  ), false)`;
}

function hasCurrentIssuingProjectAuthority() {
  return sql`exists (
    select 1
    from audio_project_access_grants issuing_authority
    where issuing_authority.id = ${audioFileAccessGrants.grantorProjectAccessGrantId}
      and issuing_authority.project_id = ${audioFileAccessGrants.projectId}
      and issuing_authority.grantee_user_id = ${audioFileAccessGrants.grantedByUserId}
      and issuing_authority.can_manage_access = true
      and issuing_authority.revoked_at is null
      and (
        issuing_authority.expires_at is null
        or issuing_authority.expires_at > clock_timestamp()
      )
  )`;
}

function hasCurrentProjectManager(userId: string) {
  return sql`exists (
    select 1
    from audio_project_access_grants current_manager
    where current_manager.project_id = ${audioFileAccessGrants.projectId}
      and current_manager.grantee_user_id = ${userId}::uuid
      and current_manager.can_manage_access = true
      and current_manager.revoked_at is null
      and (
        current_manager.expires_at is null
        or current_manager.expires_at > clock_timestamp()
      )
  )`;
}

function isConnectionMember(
  connection: { memberOneUserId: string; memberTwoUserId: string },
  userId: string
) {
  return connection.memberOneUserId === userId || connection.memberTwoUserId === userId;
}

function reviewAuditBindingWhere(grant: ReviewGrantScope) {
  return and(
    eq(auditEvents.entityType, 'audio_review_event'),
    eq(auditEvents.entityId, audioReviewEvents.id),
    eq(auditEvents.actorId, audioReviewEvents.actorUserId),
    inArray(auditEvents.eventType, REVIEW_AUDIT_EVENT_TYPES),
    sql`${auditEvents.eventType} = ('audio_review.' || ${audioReviewEvents.eventType})`,
    sql`${auditEvents.metadata}->>'grantId' = ${grant.id}`,
    sql`${auditEvents.metadata}->>'versionId' = ${grant.assetVersionId}`
  );
}

function reviewEventGrantWhere(grant: ReviewGrantScope) {
  return and(
    eq(audioReviewEvents.assetVersionId, grant.assetVersionId),
    inArray(audioReviewEvents.eventType, REVIEW_EVENT_TYPES.map((eventType) => eventType)),
    or(
      eq(audioReviewEvents.actorUserId, grant.granteeUserId),
      eq(audioReviewEvents.actorUserId, grant.grantedByUserId)
    )
  );
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
    actorType: 'account',
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
  collaboratorRevisionUploadsEnabled?: boolean;
}) {
  const { db, store } = config;
  const collaboratorRevisionUploadsEnabled = config.collaboratorRevisionUploadsEnabled === true;

  function assertCollaboratorRevisionUploadsEnabled() {
    if (!collaboratorRevisionUploadsEnabled) {
      throw Object.assign(new Error('Private candidate uploads are disabled.'), {
        status: 503,
        code: 'candidate_uploads_disabled'
      });
    }
  }

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
          isNull(audioProjectAccessGrants.revokedAt),
          or(
            isNull(audioProjectAccessGrants.expiresAt),
            gt(audioProjectAccessGrants.expiresAt, new Date())
          )
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
          eq(audioFileAccessGrants.grantPurpose, 'review_share'),
          isNull(audioFileAccessGrants.revokedAt)
        ))
        .limit(1);
      if (existing) return { grant: existing, reused: true as const };

      const canDownloadOriginal = input.canDownloadOriginal !== false;
      const canComment = input.canComment !== false;
      const canApprove = input.canApprove !== false;
      const grantId = randomUUID();
      await tx
        .insert(audioFileAccessGrants)
        .values({
          id: grantId,
          connectionId: connection.id,
          connectionMemberOneUserId: connection.memberOneUserId,
          connectionMemberTwoUserId: connection.memberTwoUserId,
          projectId: version.projectId,
          assetVersionId: version.id,
          grantorProjectAccessGrantId: grantorAccess.id,
          grantorCanManageAccess: true,
          grantedByUserId: input.grantedByUserId,
          granteeUserId,
          grantPurpose: 'review_share',
          canStreamPreview: true,
          canDownloadOriginal,
          canUploadNewVersion: false,
          canComment,
          canApprove,
          expiresAt: input.expiresAt ?? null
        });
      const [grant] = await tx
        .select()
        .from(audioFileAccessGrants)
        .where(eq(audioFileAccessGrants.id, grantId))
        .limit(1);
      if (!grant) throw new Error('Review-share grant was not persisted.');

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

  async function grantCandidateRevisionUpload(input: {
    connectionId: string;
    versionId: string;
    grantedByUserId: string;
    idempotencyKey: string;
    maxCandidateBytes: number;
    expiresInHours?: number;
  }) {
    assertCollaboratorRevisionUploadsEnabled();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw Object.assign(new Error('idempotencyKey is required and must not exceed 200 characters.'), { status: 422 });
    }
    const expiresInHours = input.expiresInHours ?? 24;
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168) {
      throw Object.assign(new Error('expiresInHours must be an integer from 1 through 168.'), { status: 422 });
    }
    const maxCandidateBytes = input.maxCandidateBytes;
    if (!Number.isSafeInteger(maxCandidateBytes)
      || maxCandidateBytes < 1
      || maxCandidateBytes > MAX_CANDIDATE_REVISION_BYTES) {
      throw Object.assign(
        new Error(`maxCandidateBytes must be a positive safe integer no greater than ${MAX_CANDIDATE_REVISION_BYTES}.`),
        { status: 422 }
      );
    }
    const idempotencyKeyHash = sha256Hex(`candidate-grant:${input.grantedByUserId}:${idempotencyKey}`);
    const activeScopeLockHash = sha256Hex(
      `candidate-grant-scope:${input.grantedByUserId}:${input.connectionId}:${input.versionId}`
    );
    const intentFingerprint = sha256Hex(JSON.stringify({
      purpose: 'collaborator_revision_upload',
      connectionId: input.connectionId,
      versionId: input.versionId,
      grantedByUserId: input.grantedByUserId,
      expiresInHours,
      maxCandidateBytes
    }));

    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKeyHash}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${activeScopeLockHash}, 0))`);
      const [idempotent] = await tx
        .select()
        .from(audioFileAccessGrants)
        .where(and(
          eq(audioFileAccessGrants.grantedByUserId, input.grantedByUserId),
          eq(audioFileAccessGrants.idempotencyKeyHash, idempotencyKeyHash)
        ))
        .limit(1);

      const [version] = await tx
        .select({
          id: audioProjectAssetVersions.id,
          projectId: audioProjectAssetVersions.projectId,
          performerId: audioProjects.performerId
        })
        .from(audioProjectAssetVersions)
        .innerJoin(audioProjects, eq(audioProjects.id, audioProjectAssetVersions.projectId))
        .where(and(
          eq(audioProjectAssetVersions.id, input.versionId),
          sql`${audioProjectAssetVersions.mimeType} like 'audio/%'`,
          eq(audioProjectAssetVersions.integrityStatus, 'verified')
        ))
        .limit(1);
      if (!version) throw Object.assign(new Error('A verified audio source version is required.'), { status: 404 });
      try {
        await tx.execute(sql`select sway_require_current_performer_capability(
          ${version.performerId}::uuid,
          'private_collaboration'::performer_capability
        )`);
      } catch (error) {
        throw Object.assign(new Error('Current private collaboration capability is required.', { cause: error }), {
          status: 403,
          code: 'private_collaboration_capability_required'
        });
      }

      const [grantorAccess] = await tx
        .select()
        .from(audioProjectAccessGrants)
        .where(and(
          eq(audioProjectAccessGrants.projectId, version.projectId),
          eq(audioProjectAccessGrants.granteeUserId, input.grantedByUserId),
          eq(audioProjectAccessGrants.canManageAccess, true),
          isNull(audioProjectAccessGrants.revokedAt),
          or(
            isNull(audioProjectAccessGrants.expiresAt),
            gt(audioProjectAccessGrants.expiresAt, new Date())
          )
        ))
        .for('update')
        .limit(1);
      if (!grantorAccess) {
        throw Object.assign(new Error('Project access management permission required.'), { status: 403 });
      }

      const [connection] = await tx
        .select()
        .from(audioFileConnections)
        .where(and(
          eq(audioFileConnections.id, input.connectionId),
          isNull(audioFileConnections.revokedAt)
        ))
        .for('update')
        .limit(1);
      if (!connection) throw Object.assign(new Error('Active file connection required.'), { status: 404 });
      if (!isConnectionMember(connection, input.grantedByUserId)) {
        throw Object.assign(new Error('Only connection members can request a private candidate.'), { status: 403 });
      }
      const granteeUserId = connection.memberOneUserId === input.grantedByUserId
        ? connection.memberTwoUserId
        : connection.memberOneUserId;

      const now = new Date();
      if (idempotent) {
        if (idempotent.intentFingerprint !== intentFingerprint
          || idempotent.maxCandidateBytes !== maxCandidateBytes) {
          throw Object.assign(new Error('Candidate grant idempotency key was already used for a different intent.'), {
            status: 409,
            code: 'candidate_grant_intent_conflict'
          });
        }
        if (idempotent.revokedAt
          || !idempotent.expiresAt
          || idempotent.expiresAt.getTime() <= now.getTime()) {
          throw Object.assign(new Error('That idempotent private-candidate request is no longer active.'), {
            status: 410,
            code: 'candidate_grant_no_longer_active'
          });
        }
        if (idempotent.grantorProjectAccessGrantId !== grantorAccess.id) {
          throw Object.assign(new Error('The project authority that issued this private-candidate request has ended.'), {
            status: 410,
            code: 'candidate_grant_issuing_authority_ended'
          });
        }
        return { grant: idempotent, reused: true as const };
      }

      const [existing] = await tx
        .select()
        .from(audioFileAccessGrants)
        .where(and(
          eq(audioFileAccessGrants.connectionId, connection.id),
          eq(audioFileAccessGrants.assetVersionId, version.id),
          eq(audioFileAccessGrants.granteeUserId, granteeUserId),
          eq(audioFileAccessGrants.grantPurpose, 'collaborator_revision_upload'),
          isNull(audioFileAccessGrants.revokedAt)
        ))
        .for('update')
        .limit(1);
      const existingIsActive = Boolean(existing?.expiresAt
        && existing.expiresAt.getTime() > now.getTime());
      if (existing && existingIsActive
        && existing.grantorProjectAccessGrantId !== grantorAccess.id) {
        await tx
          .update(audioFileAccessGrants)
          .set({
            revokedAt: now,
            revokedByUserId: input.grantedByUserId,
            revocationReason: 'Issuing project authority ended before a candidate was uploaded.'
          })
          .where(eq(audioFileAccessGrants.id, existing.id));
      } else if (existing && existingIsActive) {
        throw Object.assign(
          new Error(
            'An active private-candidate request already exists. Replay its original request key or revoke it before creating another.'
          ),
          {
            status: 409,
            code: 'active_candidate_grant_idempotency_conflict'
          }
        );
      } else if (existing) {
        await tx
          .update(audioFileAccessGrants)
          .set({
            revokedAt: now,
            revokedByUserId: input.grantedByUserId,
            revocationReason: 'Expired candidate upload window replaced by creator.'
          })
          .where(eq(audioFileAccessGrants.id, existing.id));
      }

      const grantId = randomUUID();
      await tx
        .insert(audioFileAccessGrants)
        .values({
          id: grantId,
          connectionId: connection.id,
          connectionMemberOneUserId: connection.memberOneUserId,
          connectionMemberTwoUserId: connection.memberTwoUserId,
          projectId: version.projectId,
          assetVersionId: version.id,
          grantorProjectAccessGrantId: grantorAccess.id,
          grantorCanManageAccess: true,
          grantedByUserId: input.grantedByUserId,
          granteeUserId,
          grantPurpose: 'collaborator_revision_upload',
          idempotencyKeyHash,
          intentFingerprint,
          maxCandidateBytes,
          canStreamPreview: false,
          canDownloadOriginal: false,
          canUploadNewVersion: true,
          canComment: false,
          canApprove: false,
          expiresAt: new Date(now.getTime() + expiresInHours * 60 * 60 * 1000)
        });
      const [grant] = await tx
        .select()
        .from(audioFileAccessGrants)
        .where(eq(audioFileAccessGrants.id, grantId))
        .limit(1);
      if (!grant) throw new Error('Private candidate upload grant was not persisted.');

      await tx.insert(audioFileConnectionEvents).values({
        connectionId: connection.id,
        actorUserId: input.grantedByUserId,
        eventType: 'file_requested',
        projectId: version.projectId,
        assetVersionId: version.id,
        metadata: {
          grantId: grant.id,
          purpose: 'collaborator_revision_upload',
          granteeUserId,
          intentFingerprint,
          maxCandidateBytes
        }
      });
      await tx.update(audioFileConnections)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(audioFileConnections.id, connection.id));
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.grantedByUserId,
        entityType: 'audio_file_access_grant',
        entityId: grant.id,
        eventType: 'audio_candidate_revision.grant_created',
        previousStatus: null,
        nextStatus: 'active',
        metadata: {
          connectionId: connection.id,
          sourceAssetVersionId: version.id,
          granteeUserId,
          expiresAt: grant.expiresAt?.toISOString(),
          intentFingerprint,
          idempotencyKeyHash,
          maxCandidateBytes
        }
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
        grantPurpose: audioFileAccessGrants.grantPurpose,
        canUploadCandidateRevision: audioFileAccessGrants.canUploadNewVersion,
        maxCandidateBytes: audioFileAccessGrants.maxCandidateBytes,
        canDownloadOriginal: audioFileAccessGrants.canDownloadOriginal,
        canComment: audioFileAccessGrants.canComment,
        canApprove: audioFileAccessGrants.canApprove,
        expiresAt: audioFileAccessGrants.expiresAt,
        revokedAt: audioFileAccessGrants.revokedAt,
        createdAt: audioFileAccessGrants.createdAt,
        candidateId: audioCandidateRevisions.id,
        candidateOriginalFilename: audioCandidateRevisions.originalFilename,
        candidateMimeType: audioCandidateRevisions.mimeType,
        candidateByteSize: audioCandidateRevisions.byteSize,
        candidateSha256: audioCandidateRevisions.sha256,
        candidateDurationMs: audioCandidateRevisions.durationMs,
        candidateSealedAt: audioCandidateRevisions.sealedAt,
        canRevoke: sql<boolean>`true`,
        canReadReviews: sql<boolean>`${audioFileAccessGrants.grantPurpose} = 'review_share'`,
        initiatedByCurrentUser: sql<boolean>`${audioFileAccessGrants.grantedByUserId} = ${input.userId}::uuid`,
        managedByCurrentUser: sql<boolean>`false`
      })
      .from(audioFileAccessGrants)
      .innerJoin(audioFileConnections, eq(audioFileConnections.id, audioFileAccessGrants.connectionId))
      .innerJoin(audioProjects, eq(audioProjects.id, audioFileAccessGrants.projectId))
      .innerJoin(audioProjectAssetVersions, eq(audioProjectAssetVersions.id, audioFileAccessGrants.assetVersionId))
      .leftJoin(audioCandidateRevisions, eq(audioCandidateRevisions.fileAccessGrantId, audioFileAccessGrants.id))
      .where(and(
        eq(audioFileAccessGrants.granteeUserId, input.userId),
        isNull(audioFileConnections.revokedAt),
        isNull(audioFileAccessGrants.revokedAt),
        or(
          isNull(audioFileAccessGrants.expiresAt),
          gt(audioFileAccessGrants.expiresAt, new Date())
        ),
        or(
          eq(audioFileAccessGrants.grantPurpose, 'review_share'),
          collaboratorRevisionUploadsEnabled
            ? and(
                eq(audioFileAccessGrants.grantPurpose, 'collaborator_revision_upload'),
                hasCurrentPrivateCollaborationCapability(),
                hasCurrentIssuingProjectAuthority()
              )
            : sql<boolean>`false`
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
        grantPurpose: audioFileAccessGrants.grantPurpose,
        canUploadCandidateRevision: audioFileAccessGrants.canUploadNewVersion,
        maxCandidateBytes: audioFileAccessGrants.maxCandidateBytes,
        canDownloadOriginal: audioFileAccessGrants.canDownloadOriginal,
        canComment: audioFileAccessGrants.canComment,
        canApprove: audioFileAccessGrants.canApprove,
        expiresAt: audioFileAccessGrants.expiresAt,
        revokedAt: audioFileAccessGrants.revokedAt,
        createdAt: audioFileAccessGrants.createdAt,
        candidateId: audioCandidateRevisions.id,
        candidateOriginalFilename: audioCandidateRevisions.originalFilename,
        candidateMimeType: audioCandidateRevisions.mimeType,
        candidateByteSize: audioCandidateRevisions.byteSize,
        candidateSha256: audioCandidateRevisions.sha256,
        candidateDurationMs: audioCandidateRevisions.durationMs,
        candidateSealedAt: audioCandidateRevisions.sealedAt,
        canRevoke: sql<boolean>`(
          ${audioFileAccessGrants.revokedAt} is null
          and (
            ${audioFileAccessGrants.expiresAt} is null
            or ${audioFileAccessGrants.expiresAt} > clock_timestamp()
          )
          and ${audioFileAccessGrants.grantedByUserId} = ${input.userId}::uuid
        )`,
        canReadReviews: sql<boolean>`(
          ${audioFileAccessGrants.grantPurpose} = 'review_share'
          and ${audioFileAccessGrants.grantedByUserId} = ${input.userId}::uuid
        )`,
        initiatedByCurrentUser: sql<boolean>`${audioFileAccessGrants.grantedByUserId} = ${input.userId}::uuid`,
        managedByCurrentUser: sql<boolean>`(
          ${audioFileAccessGrants.grantPurpose} = 'collaborator_revision_upload'
          and ${hasCurrentProjectManager(input.userId)}
        )`
      })
      .from(audioFileAccessGrants)
      .innerJoin(audioFileConnections, eq(audioFileConnections.id, audioFileAccessGrants.connectionId))
      .innerJoin(audioProjects, eq(audioProjects.id, audioFileAccessGrants.projectId))
      .innerJoin(audioProjectAssetVersions, eq(audioProjectAssetVersions.id, audioFileAccessGrants.assetVersionId))
      .leftJoin(audioCandidateRevisions, eq(audioCandidateRevisions.fileAccessGrantId, audioFileAccessGrants.id))
      .where(or(
        and(
          eq(audioFileAccessGrants.grantedByUserId, input.userId),
          isNull(audioFileConnections.revokedAt),
          isNull(audioFileAccessGrants.revokedAt),
          or(
            isNull(audioFileAccessGrants.expiresAt),
            gt(audioFileAccessGrants.expiresAt, new Date())
          ),
          or(
            eq(audioFileAccessGrants.grantPurpose, 'review_share'),
            and(
              eq(audioFileAccessGrants.grantPurpose, 'collaborator_revision_upload'),
              hasCurrentProjectManager(input.userId)
            )
          )
        ),
        and(
          eq(audioFileAccessGrants.grantPurpose, 'collaborator_revision_upload'),
          isNotNull(audioCandidateRevisions.id),
          isNotNull(audioCandidateRevisions.sealedAt),
          hasCurrentProjectManager(input.userId)
        )
      ))
      .orderBy(desc(audioFileAccessGrants.createdAt));
  }

  async function requireActiveGrantForUser(grantId: string, userId: string) {
    const [grant] = await db
      .select({
        id: audioFileAccessGrants.id,
        connectionId: audioFileAccessGrants.connectionId,
        projectId: audioFileAccessGrants.projectId,
        assetVersionId: audioFileAccessGrants.assetVersionId,
        grantedByUserId: audioFileAccessGrants.grantedByUserId,
        granteeUserId: audioFileAccessGrants.granteeUserId,
        grantPurpose: audioFileAccessGrants.grantPurpose,
        canDownloadOriginal: audioFileAccessGrants.canDownloadOriginal,
        canComment: audioFileAccessGrants.canComment,
        canApprove: audioFileAccessGrants.canApprove
      })
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

  async function requireActiveReviewGrantForUser(grantId: string, userId: string) {
    const grant = await requireActiveGrantForUser(grantId, userId);
    if (grant.grantPurpose !== 'review_share') {
      throw Object.assign(new Error('Active review-share grant required.'), { status: 403 });
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

  async function openCandidateRevision(input: {
    grantId: string;
    candidateId: string;
    userId: string;
  }) {
    assertCollaboratorRevisionUploadsEnabled();
    const [row] = await db
      .select({
        grant: audioFileAccessGrants,
        candidate: audioCandidateRevisions,
        connection: audioFileConnections
      })
      .from(audioCandidateRevisions)
      .innerJoin(audioFileAccessGrants, eq(audioFileAccessGrants.id, audioCandidateRevisions.fileAccessGrantId))
      .innerJoin(audioFileConnections, eq(audioFileConnections.id, audioFileAccessGrants.connectionId))
      .where(and(
        eq(audioCandidateRevisions.id, input.candidateId),
        eq(audioCandidateRevisions.fileAccessGrantId, input.grantId),
        eq(audioFileAccessGrants.grantPurpose, 'collaborator_revision_upload'),
        eq(audioFileAccessGrants.assetVersionId, audioCandidateRevisions.sourceAssetVersionId)
      ))
      .limit(1);
    if (!row) throw Object.assign(new Error('Private candidate unavailable.'), { status: 404 });

    const [currentProjectManager] = await db
      .select({ id: audioProjectAccessGrants.id })
      .from(audioProjectAccessGrants)
      .where(and(
        eq(audioProjectAccessGrants.projectId, row.grant.projectId),
        eq(audioProjectAccessGrants.granteeUserId, input.userId),
        eq(audioProjectAccessGrants.canManageAccess, true),
        isNull(audioProjectAccessGrants.revokedAt),
        or(
          isNull(audioProjectAccessGrants.expiresAt),
          gt(audioProjectAccessGrants.expiresAt, new Date())
        )
      ))
      .limit(1);

    if (!currentProjectManager && row.grant.granteeUserId === input.userId) {
      if (row.grant.revokedAt
        || !row.grant.expiresAt
        || row.grant.expiresAt.getTime() <= Date.now()
        || row.connection.revokedAt
        || !isConnectionMember(row.connection, input.userId)) {
        throw Object.assign(new Error('Active candidate grant required.'), { status: 410 });
      }
      try {
        await db.execute(sql`select sway_require_active_collaborator_revision_grant(
          ${row.grant.id}::uuid,
          ${row.grant.projectId}::uuid,
          ${input.userId}::uuid,
          ${row.candidate.assetId}::uuid,
          ${row.candidate.sourceAssetVersionId}::uuid
        )`);
      } catch (error) {
        throw Object.assign(new Error('Active candidate grant required.', { cause: error }), {
          status: 410,
          code: 'candidate_upload_authority_ended'
        });
      }
    } else if (!currentProjectManager) {
      throw Object.assign(new Error('Private candidate unavailable.'), { status: 404 });
    }

    const object = await store.openOriginal({
      storageProvider: parseAudioStorageProvider(row.candidate.storageProvider),
      storageBucket: row.candidate.storageBucket,
      storageKey: row.candidate.storageKey
    });
    await writeAudit(db, {
      actorId: input.userId,
      entityType: 'audio_candidate_revision',
      entityId: row.candidate.id,
      eventType: 'audio_candidate_revision.private_read',
      metadata: {
        grantId: row.grant.id,
        sourceAssetVersionId: row.candidate.sourceAssetVersionId,
        sha256: row.candidate.sha256
      }
    });
    return { candidate: row.candidate, ...object };
  }

  async function listReviewEvents(input: { grantId: string; userId: string }) {
    const grant = await requireActiveReviewGrantForUser(input.grantId, input.userId);
    return db
      .selectDistinct({
        id: audioReviewEvents.id,
        actorUserId: audioReviewEvents.actorUserId,
        eventType: audioReviewEvents.eventType,
        timecodeMs: audioReviewEvents.timecodeMs,
        body: audioReviewEvents.body,
        supersedesEventId: audioReviewEvents.supersedesEventId,
        createdAt: audioReviewEvents.createdAt
      })
      .from(audioReviewEvents)
      .innerJoin(auditEvents, reviewAuditBindingWhere(grant))
      .where(reviewEventGrantWhere(grant))
      .orderBy(asc(audioReviewEvents.createdAt), asc(audioReviewEvents.id));
  }

  async function addReviewEvent(input: {
    grantId: string;
    userId: string;
    eventType: unknown;
    body?: unknown;
    timecodeMs?: unknown;
    supersedesEventId?: unknown;
  }) {
    const grant = await requireActiveReviewGrantForUser(input.grantId, input.userId);
    const eventType = input.eventType;
    if (!isReviewEventType(eventType)) {
      throw Object.assign(new Error('Unsupported review event type.'), { status: 422 });
    }

    const isGrantee = grant.granteeUserId === input.userId;
    if (eventType === 'resolved') {
      if (grant.grantedByUserId !== input.userId) {
        throw Object.assign(new Error('Only the file owner can resolve review items.'), { status: 403 });
      }
    } else if (!isGrantee) {
      throw Object.assign(new Error('Only the selected reviewer can submit this review event.'), { status: 403 });
    } else if ((eventType === 'approved' || eventType === 'approval_withdrawn') && !grant.canApprove) {
      throw Object.assign(new Error('Approval permission required.'), { status: 403 });
    } else if ((eventType === 'comment' || eventType === 'changes_requested') && !grant.canComment) {
      throw Object.assign(new Error('Comment permission required.'), { status: 403 });
    }

    const body = typeof input.body === 'string' ? input.body.trim().slice(0, 4000) : '';
    if ((eventType === 'comment' || eventType === 'changes_requested') && !body) {
      throw Object.assign(new Error('Review text is required.'), { status: 422 });
    }
    const timecodeMs = input.timecodeMs == null ? null : Number(input.timecodeMs);
    if (timecodeMs != null && (!Number.isInteger(timecodeMs) || timecodeMs < 0)) {
      throw Object.assign(new Error('timecodeMs must be a non-negative integer.'), { status: 422 });
    }
    const rawSupersedesEventId = input.supersedesEventId;
    if (rawSupersedesEventId != null
      && (typeof rawSupersedesEventId !== 'string' || !UUID_PATTERN.test(rawSupersedesEventId))) {
      throw Object.assign(new Error('supersedesEventId must be a UUID.'), { status: 422 });
    }
    const supersedesEventId = typeof rawSupersedesEventId === 'string' ? rawSupersedesEventId : null;
    if (eventType === 'resolved' && !supersedesEventId) {
      throw Object.assign(new Error('Resolved review events must reference the item they resolve.'), { status: 422 });
    }

    return db.transaction(async (tx) => {
      if (supersedesEventId) {
        const [supersededEvent] = await tx
          .select({ id: audioReviewEvents.id })
          .from(audioReviewEvents)
          .innerJoin(auditEvents, reviewAuditBindingWhere(grant))
          .where(and(
            reviewEventGrantWhere(grant),
            eq(audioReviewEvents.id, supersedesEventId)
          ))
          .limit(1);
        if (!supersededEvent) {
          throw Object.assign(new Error('Superseded review event must belong to this file grant.'), { status: 422 });
        }
      }

      const [event] = await tx.insert(audioReviewEvents).values({
        assetVersionId: grant.assetVersionId,
        actorUserId: input.userId,
        eventType,
        timecodeMs,
        body: body || null,
        supersedesEventId
      }).returning();
      await tx.insert(auditEvents).values({
        actorType: 'account',
        actorId: input.userId,
        entityType: 'audio_review_event',
        entityId: event.id,
        eventType: `audio_review.${eventType}`,
        previousStatus: null,
        nextStatus: null,
        metadata: { grantId: grant.id, versionId: grant.assetVersionId }
      });
      return event;
    });
  }

  async function revokeGrant(input: { grantId: string; userId: string; reason?: string | null }) {
    const grant = await requireActiveGrantForUser(input.grantId, input.userId);
    return db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(audioFileAccessGrants)
        .set({
          revokedAt: new Date(),
          revokedByUserId: input.userId,
          revocationReason: input.reason?.trim().slice(0, 240) || null
        })
        .where(activeGrantWhere(grant.id))
        .returning();
      if (!revoked) throw Object.assign(new Error('Active file grant required.'), { status: 410 });
      await tx.insert(auditEvents).values({
        actorType: 'account',
        actorId: input.userId,
        entityType: 'audio_file_access_grant',
        entityId: revoked.id,
        eventType: 'audio_file_access.revoke',
        previousStatus: null,
        nextStatus: null,
        metadata: { reason: revoked.revocationReason }
      });
      return { grantId: revoked.id, revokedAt: revoked.revokedAt!.toISOString() };
    });
  }

  return {
    shareVersion,
    grantCandidateRevisionUpload,
    listSharedWithMe,
    listSharedByMe,
    downloadGrantedOriginal,
    openCandidateRevision,
    listReviewEvents,
    addReviewEvent,
    revokeGrant
  };
}

export type AudioFileCollaborationService = ReturnType<typeof createAudioFileCollaborationService>;
