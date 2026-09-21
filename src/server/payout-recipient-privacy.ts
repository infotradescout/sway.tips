import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { performerPayoutPreferences, performerWithdrawals } from '../db/schema';
import { writeAuditEvent } from './audit-log';

const UNRESOLVED_WITHDRAWAL_STATUSES = [
  'requested',
  'submitting',
  'processing',
  'unclaimed',
  'held'
] as const;

type DbExecutor = SwayDb | any;

export function createPayoutRecipientPrivacyService(db: SwayDb, now = () => new Date()) {
  async function requestDeletion(input: {
    performerId: string;
    actorUserId: string;
    executor?: DbExecutor;
  }) {
    const executor = input.executor ?? db;
    const [preference] = await executor.select({
      performerId: performerPayoutPreferences.performerId
    }).from(performerPayoutPreferences)
      .where(eq(performerPayoutPreferences.performerId, input.performerId))
      .for('update')
      .limit(1);
    if (!preference) return { kind: 'not_found' } as const;

    const [unresolved] = await executor.select({ id: performerWithdrawals.id })
      .from(performerWithdrawals)
      .where(and(
        eq(performerWithdrawals.performerId, input.performerId),
        inArray(performerWithdrawals.status, [...UNRESOLVED_WITHDRAWAL_STATUSES])
      ))
      .limit(1);
    const requestedAt = now();
    if (unresolved) {
      await executor.update(performerPayoutPreferences).set({
        privacyDeletionRequestedAt: requestedAt,
        updatedAt: requestedAt
      }).where(eq(performerPayoutPreferences.performerId, input.performerId));
    } else {
      await executor.delete(performerPayoutPreferences)
        .where(eq(performerPayoutPreferences.performerId, input.performerId));
    }

    await writeAuditEvent(executor, {
      actorId: input.actorUserId,
      actorType: 'admin',
      entityType: 'performer_payout_preference',
      entityId: input.performerId,
      eventType: unresolved
        ? 'performer_payout_preference.privacy_purge_deferred'
        : 'performer_payout_preference.privacy_purged',
      previousStatus: 'stored',
      nextStatus: unresolved ? 'purge_pending' : 'purged',
      metadata: {
        performerId: input.performerId,
        unresolvedWithdrawalId: unresolved?.id ?? null,
        rawRecipientStoredInAudit: false
      }
    });
    return { kind: unresolved ? 'deferred' : 'purged' } as const;
  }

  async function purgeDeferred(limit = 100) {
    const candidates = await db.select({ performerId: performerPayoutPreferences.performerId })
      .from(performerPayoutPreferences)
      .where(isNotNull(performerPayoutPreferences.privacyDeletionRequestedAt))
      .orderBy(asc(performerPayoutPreferences.privacyDeletionRequestedAt))
      .limit(Math.max(1, Math.min(limit, 500)));
    let purged = 0;
    for (const candidate of candidates) {
      const result = await db.transaction(async (tx) => {
        const [preference] = await tx.select({
          performerId: performerPayoutPreferences.performerId
        }).from(performerPayoutPreferences)
          .where(and(
            eq(performerPayoutPreferences.performerId, candidate.performerId),
            isNotNull(performerPayoutPreferences.privacyDeletionRequestedAt)
          ))
          .for('update')
          .limit(1);
        if (!preference) return false;
        const [unresolved] = await tx.select({ id: performerWithdrawals.id })
          .from(performerWithdrawals)
          .where(and(
            eq(performerWithdrawals.performerId, candidate.performerId),
            inArray(performerWithdrawals.status, [...UNRESOLVED_WITHDRAWAL_STATUSES])
          ))
          .limit(1);
        if (unresolved) return false;
        await tx.delete(performerPayoutPreferences)
          .where(eq(performerPayoutPreferences.performerId, candidate.performerId));
        await writeAuditEvent(tx, {
          actorId: null,
          actorType: 'system',
          entityType: 'performer_payout_preference',
          entityId: candidate.performerId,
          eventType: 'performer_payout_preference.privacy_purged',
          previousStatus: 'purge_pending',
          nextStatus: 'purged',
          metadata: {
            performerId: candidate.performerId,
            rawRecipientStoredInAudit: false
          }
        });
        return true;
      });
      if (result) purged += 1;
    }
    return { inspected: candidates.length, purged };
  }

  return { requestDeletion, purgeDeferred };
}
