import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { auditEvents, performerCapabilityGrantEvents, performers, users } from '../db/schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

/** Administrative enrollment only. This cannot enable the deployment feature flag. */
export function createAudioCollaborationCapabilityService(db: SwayDb) {
  async function decide(input: {
    performerId: string;
    actorUserId: string;
    decision: 'granted' | 'revoked';
    reason: string;
    idempotencyKey: string;
    expiresAt?: string | null;
  }) {
    if (!UUID.test(input.performerId) || !UUID.test(input.actorUserId)) throw failure('Invalid account scope.', 422);
    if (!['granted', 'revoked'].includes(input.decision)) throw failure('Choose granted or revoked.', 422);
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
    if (!reason || reason.length > 500 || key.length < 16 || key.length > 200) {
      throw failure('A reason and an idempotency key of 16–200 characters are required.', 422);
    }
    const expiry = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiry && (!Number.isFinite(expiry.getTime()) || input.decision !== 'granted')) {
      throw failure('Only a grant may include a valid expiry.', 422);
    }
    const idempotencyKeyHash = hash(`private-collaboration-capability:${input.actorUserId}:${key}`);
    const intent = hash(JSON.stringify([input.performerId, input.decision, reason, expiry?.toISOString() ?? null]));
    return db.transaction(async (tx) => {
      const [actor] = await tx.select({ role: users.role }).from(users)
        .where(eq(users.id, input.actorUserId)).for('share').limit(1);
      if (actor?.role !== 'admin') throw failure('Persisted administrator access required.', 403);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKeyHash}, 0))`);
      const [performer] = await tx.select({ id: performers.id }).from(performers)
        .where(eq(performers.id, input.performerId)).for('update').limit(1);
      if (!performer) throw failure('Performer not found.', 404);
      const [existing] = await tx.select().from(performerCapabilityGrantEvents)
        .where(eq(performerCapabilityGrantEvents.idempotencyKeyHash, idempotencyKeyHash)).limit(1);
      if (existing) {
        if ((existing.evidence as Record<string, unknown>).intentFingerprint !== intent) throw failure('This request key belongs to a different capability decision.', 409);
        return { event: existing, reused: true };
      }
      const [{ now }] = await tx.select({ now: sql<Date>`clock_timestamp()` }).from(performers)
        .where(eq(performers.id, input.performerId));
      if (expiry && expiry.getTime() <= new Date(now).getTime()) throw failure('Grant expiry must be in the future.', 422);
      const [latest] = await tx.select().from(performerCapabilityGrantEvents)
        .where(and(eq(performerCapabilityGrantEvents.performerId, input.performerId),
          eq(performerCapabilityGrantEvents.capability, 'private_collaboration')))
        .orderBy(desc(performerCapabilityGrantEvents.eventSequence)).limit(1);
      const active = latest?.decision === 'granted'
        && (!latest.expiresAt || latest.expiresAt.getTime() > new Date(now).getTime());
      if ((input.decision === 'granted' && active) || (input.decision === 'revoked' && !active)) {
        throw failure(active ? 'Revoke the active grant before issuing another.' : 'There is no active grant to revoke.', 409);
      }
      const [event] = await tx.insert(performerCapabilityGrantEvents).values({
        performerId: input.performerId,
        capability: 'private_collaboration',
        decision: input.decision,
        actorType: 'admin',
        actorUserId: input.actorUserId,
        reason,
        evidence: { intentFingerprint: intent, scope: 'private_candidate_revision_intake' },
        expiresAt: expiry,
        idempotencyKeyHash
      }).returning();
      await tx.insert(auditEvents).values({
        actorType: 'admin', actorId: input.actorUserId,
        entityType: 'performer_capability_grant_event', entityId: event.id,
        eventType: `audio_private_collaboration.${input.decision}`,
        metadata: { performerId: input.performerId, capability: 'private_collaboration', reason, expiresAt: expiry?.toISOString() ?? null }
      });
      return { event, reused: false };
    });
  }
  return { decide };
}
