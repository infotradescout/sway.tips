import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { performerPayoutKycReviews, performers } from '../db/schema';
import { writeAuditEvent } from './audit-log';

export const PERFORMER_KYC_PROCESS_APPROVAL_VERSION = '2026-09-02-v1';

type DbExecutor = SwayDb | any;

function normalizeEvidenceReference(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 200 || /[\r\n]/.test(normalized)) return null;
  return normalized;
}

function evidenceReferenceFingerprint(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

export type PerformerKycReviewStore = ReturnType<typeof createPerformerKycReviewStore>;

export function createPerformerKycReviewStore(input: {
  db: SwayDb;
  processApprovalVersion?: string | null;
  now?: () => Date;
}) {
  const { db } = input;
  const now = input.now ?? (() => new Date());
  const processApprovalVersion = input.processApprovalVersion?.trim() === PERFORMER_KYC_PROCESS_APPROVAL_VERSION
    ? PERFORMER_KYC_PROCESS_APPROVAL_VERSION
    : null;

  return {
    processApprovalVersion,
    configured: Boolean(processApprovalVersion),

    async loadCurrentApproval(performerId: string, executor: DbExecutor = db) {
      if (!processApprovalVersion) return null;
      const [review] = await executor.select().from(performerPayoutKycReviews).where(and(
        eq(performerPayoutKycReviews.performerId, performerId),
        eq(performerPayoutKycReviews.processApprovalVersion, processApprovalVersion),
        eq(performerPayoutKycReviews.status, 'approved')
      )).limit(1);
      return review ?? null;
    },

    async approve(inputApproval: {
      performerId: string;
      reviewerUserId: string;
      evidenceReference: unknown;
    }) {
      if (!processApprovalVersion) return { kind: 'process_not_approved' } as const;
      const evidenceReference = normalizeEvidenceReference(inputApproval.evidenceReference);
      if (!evidenceReference) return { kind: 'invalid_evidence_reference' } as const;
      return db.transaction(async (tx) => {
        const [performer] = await tx.select({ id: performers.id })
          .from(performers)
          .where(eq(performers.id, inputApproval.performerId))
          .for('update')
          .limit(1);
        if (!performer) return { kind: 'not_found' } as const;
        const reviewedAt = now();
        const [previousReview] = await tx.select({ status: performerPayoutKycReviews.status })
          .from(performerPayoutKycReviews)
          .where(and(
            eq(performerPayoutKycReviews.performerId, performer.id),
            eq(performerPayoutKycReviews.processApprovalVersion, processApprovalVersion)
          ))
          .for('update')
          .limit(1);
        const [review] = await tx.insert(performerPayoutKycReviews).values({
          performerId: performer.id,
          processApprovalVersion,
          status: 'approved',
          evidenceReference,
          reviewerUserId: inputApproval.reviewerUserId,
          reviewedAt,
          revokedAt: null,
          createdAt: reviewedAt,
          updatedAt: reviewedAt
        }).onConflictDoUpdate({
          target: [
            performerPayoutKycReviews.performerId,
            performerPayoutKycReviews.processApprovalVersion
          ],
          set: {
            status: 'approved',
            evidenceReference,
            reviewerUserId: inputApproval.reviewerUserId,
            reviewedAt,
            revokedAt: null,
            updatedAt: reviewedAt
          }
        }).returning();
        await writeAuditEvent(tx, {
          actorId: inputApproval.reviewerUserId,
          actorType: 'admin',
          entityType: 'performer_payout_kyc_review',
          entityId: review.id,
          eventType: 'performer_payout_kyc_review.approve',
          previousStatus: previousReview?.status ?? null,
          nextStatus: 'approved',
          metadata: {
            performerId: performer.id,
            processApprovalVersion,
            evidenceReferenceFingerprint: evidenceReferenceFingerprint(evidenceReference),
            rawIdentityDataStored: false
          }
        });
        return { kind: 'approved', review } as const;
      });
    },

    async revoke(inputRevocation: { performerId: string; reviewerUserId: string }) {
      if (!processApprovalVersion) return { kind: 'process_not_approved' } as const;
      return db.transaction(async (tx) => {
        const [performer] = await tx.select({ id: performers.id })
          .from(performers)
          .where(eq(performers.id, inputRevocation.performerId))
          .for('update')
          .limit(1);
        if (!performer) return { kind: 'not_found' } as const;
        const revokedAt = now();
        const [review] = await tx.update(performerPayoutKycReviews).set({
          status: 'revoked',
          revokedAt,
          updatedAt: revokedAt
        }).where(and(
          eq(performerPayoutKycReviews.performerId, performer.id),
          eq(performerPayoutKycReviews.processApprovalVersion, processApprovalVersion),
          eq(performerPayoutKycReviews.status, 'approved')
        )).returning();
        if (!review) return { kind: 'not_found' } as const;
        await writeAuditEvent(tx, {
          actorId: inputRevocation.reviewerUserId,
          actorType: 'admin',
          entityType: 'performer_payout_kyc_review',
          entityId: review.id,
          eventType: 'performer_payout_kyc_review.revoke',
          previousStatus: 'approved',
          nextStatus: 'revoked',
          metadata: { performerId: performer.id, processApprovalVersion }
        });
        return { kind: 'revoked', review } as const;
      });
    }
  };
}
