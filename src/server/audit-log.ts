import { createHash } from 'crypto';
import { auditEvents } from '../db/schema';

export type AuditWriteInput = {
  actorId: string | null;
  actorType: string;
  entityType: string;
  entityId: string;
  eventType: string;
  previousStatus?: string | null;
  nextStatus?: string | null;
  metadata?: Record<string, unknown>;
};

export function toAuditEntityUuid(input: string): string {
  const digest = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function writeAuditEvent(executor: any, input: AuditWriteInput) {
  await executor.insert(auditEvents).values({
    actorType: input.actorType,
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: toAuditEntityUuid(input.entityId),
    eventType: input.eventType,
    previousStatus: input.previousStatus ?? null,
    nextStatus: input.nextStatus ?? null,
    metadata: input.metadata ?? {}
  });
}
