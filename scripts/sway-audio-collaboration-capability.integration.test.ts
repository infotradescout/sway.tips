import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client';
import { auditEvents, performerCapabilityGrantEvents, performers, users } from '../src/db/schema';
import { createAudioCollaborationCapabilityService } from '../src/server/audio-collaboration-capability-service';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

const proof = await startEmbeddedPostgresProof('audio_capability_decisions');
const db = createSwayDb(proof.databaseUrl);
const service = createAudioCollaborationCapabilityService(db);
try {
  const adminId = randomUUID();
  const ownerId = randomUUID();
  await db.insert(users).values([
    { id: adminId, role: 'admin', email: `${adminId}@example.test` },
    { id: ownerId, role: 'patron', email: `${ownerId}@example.test` }
  ]);
  const [performer] = await db.insert(performers).values({ ownerUserId: ownerId, displayName: 'Capability proof' }).returning();
  const grant = {
    performerId: performer.id, actorUserId: adminId, decision: 'granted' as const,
    reason: 'Explicit private collaboration enrollment', idempotencyKey: `grant:${randomUUID()}`
  };
  await assert.rejects(service.decide({ ...grant, actorUserId: ownerId }), (error: any) => error.status === 403);
  const issued = await service.decide(grant);
  assert.equal(issued.reused, false);
  const replay = await service.decide(grant);
  assert.equal(replay.reused, true);
  assert.equal(replay.event.id, issued.event.id);
  await assert.rejects(service.decide({ ...grant, reason: 'Changed request' }), (error: any) => error.status === 409);
  await assert.rejects(service.decide({ ...grant, idempotencyKey: `another:${randomUUID()}` }), (error: any) => error.status === 409);
  await db.execute(sql`select sway_require_current_performer_capability(${performer.id}::uuid, 'private_collaboration')`);
  const revoked = await service.decide({ ...grant, decision: 'revoked', reason: 'Enrollment ended', idempotencyKey: `revoke:${randomUUID()}` });
  assert.equal(revoked.event.decision, 'revoked');
  await assert.rejects(db.execute(sql`select sway_require_current_performer_capability(${performer.id}::uuid, 'private_collaboration')`));
  await assert.rejects(service.decide({ ...grant, decision: 'revoked', idempotencyKey: `revoke-again:${randomUUID()}` }), (error: any) => error.status === 409);
  const events = await db.select().from(performerCapabilityGrantEvents);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.capability), ['private_collaboration', 'private_collaboration']);
  const audits = await db.select().from(auditEvents).where(eq(auditEvents.entityType, 'performer_capability_grant_event'));
  assert.equal(audits.length, 2, 'An idempotent retry must not write duplicate audit evidence.');
  await db.update(users).set({ role: 'patron' }).where(eq(users.id, adminId));
  await assert.rejects(service.decide(grant), (error: any) => error.status === 403,
    'An old administrator request key must not bypass current persisted authority.');
  console.log(`Private collaboration administrative capability proof passed (${proof.kind}).`);
} finally {
  await proof.close();
}
