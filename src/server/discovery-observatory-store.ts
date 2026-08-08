import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { auditEvents } from '../db/schema';
import { writeAuditEvent } from './audit-log';
import {
  SWAY_DISCOVERY_EXPERIMENTS,
  discoveryEntityUuid,
  discoveryExperimentVariant,
  normalizeDiscoveryExperimentAssignment,
  normalizeDiscoveryJourneyEvent,
  normalizeDiscoveryObservation,
  type DiscoveryJourneyEventInput,
  type DiscoveryObservationInput
} from './discovery-observatory';

const EXPERIMENT_DECISIONS = new Set(['approve', 'activate', 'pause', 'complete', 'rollback', 'reject']);

function experimentExists(key: string) {
  return SWAY_DISCOVERY_EXPERIMENTS.some((experiment) => experiment.key === key);
}

function experimentDefinition(key: string) {
  return SWAY_DISCOVERY_EXPERIMENTS.find((experiment) => experiment.key === key) ?? null;
}

function metadataValue(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function metadataNumber(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

export function createDiscoveryObservatoryStore(db: any) {
  async function recordObservation(input: {
    actorUserId: string;
    observation: DiscoveryObservationInput;
    now?: Date;
  }) {
    const normalized = normalizeDiscoveryObservation(input.observation, input.now);
    const observationKey = JSON.stringify(normalized);
    await db.insert(auditEvents).values({
      eventId: discoveryEntityUuid(`observation:${observationKey}`),
      actorId: input.actorUserId,
      actorType: 'admin',
      entityType: 'discovery_observation',
      entityId: discoveryEntityUuid(observationKey),
      eventType: 'discovery_observation.recorded',
      metadata: normalized
    }).onConflictDoNothing({ target: auditEvents.eventId });
    return normalized;
  }

  async function latestExperimentDecision(experimentKey: string) {
    const [row] = await db
      .select({ metadata: auditEvents.metadata, createdAt: auditEvents.createdAt })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.entityType, 'discovery_experiment'),
        eq(auditEvents.entityId, discoveryEntityUuid(experimentKey)),
        eq(auditEvents.eventType, 'discovery_experiment.decision')
      ))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.eventId))
      .limit(1);
    return row
      ? { decision: metadataValue(row.metadata, 'decision'), createdAt: row.createdAt }
      : null;
  }

  async function recordExperimentDecision(input: {
    actorUserId: string;
    experimentKey: string;
    decision: string;
    evidenceNote: string;
  }) {
    if (!experimentExists(input.experimentKey)) throw new Error('Experiment is not predeclared.');
    if (!EXPERIMENT_DECISIONS.has(input.decision)) throw new Error('Experiment decision is invalid.');
    const evidenceNote = input.evidenceNote.trim();
    if (!evidenceNote || evidenceNote.length > 1200) throw new Error('Experiment evidence note is required.');
    await writeAuditEvent(db, {
      actorId: input.actorUserId,
      actorType: 'admin',
      entityType: 'discovery_experiment',
      entityId: input.experimentKey,
      eventType: 'discovery_experiment.decision',
      metadata: {
        platform: 'sway',
        stage: 'experiment',
        experiment_key: input.experimentKey,
        decision: input.decision,
        evidence_note: evidenceNote,
        public_change_applied: false
      }
    });
    return { experimentKey: input.experimentKey, decision: input.decision };
  }

  async function assignExperiment(input: {
    journeyId: string;
    experimentKey: string;
    assignedAt?: string;
  }) {
    if (!experimentExists(input.experimentKey)) throw new Error('Experiment is not predeclared.');
    const assignment = normalizeDiscoveryExperimentAssignment({
      journeyId: input.journeyId,
      experimentKey: input.experimentKey,
      assignedAt: input.assignedAt
    });
    const decision = await latestExperimentDecision(input.experimentKey);
    if (decision?.decision !== 'activate') throw new Error('Experiment is not active.');
    if (decision.createdAt && new Date(assignment.assigned_at).getTime() < new Date(decision.createdAt).getTime()) {
      throw new Error('Experiment assignment cannot predate activation.');
    }
    const journeyEntityId = discoveryEntityUuid(input.journeyId.toLowerCase());
    const definition = experimentDefinition(input.experimentKey)!;
    const variant = discoveryExperimentVariant(assignment.journey_id, input.experimentKey);
    const deterministicEventId = discoveryEntityUuid(
      `experiment-assignment:${input.journeyId.toLowerCase()}:${input.experimentKey}`
    );
    const inserted = await db.insert(auditEvents).values({
      eventId: deterministicEventId,
      actorType: 'anonymous',
      actorId: null,
      entityType: 'shell_friction',
      entityId: journeyEntityId,
      eventType: 'discovery_experiment.assignment',
      metadata: {
        platform: 'sway',
        stage: 'experiment',
        journey_id: assignment.journey_id,
        experiment_key: input.experimentKey,
        assigned_at: assignment.assigned_at,
        variant,
        controlled_change_key: definition.controlledChangeKey,
        controlled_change_count: 1,
        link_strength: 'direct_server_observed'
      }
    }).onConflictDoNothing({ target: auditEvents.eventId }).returning({
      eventId: auditEvents.eventId,
      createdAt: auditEvents.createdAt
    });
    if (inserted[0]) {
      return {
        assigned: true, created: true, assignedAt: assignment.assigned_at,
        variant, controlledChangeKey: definition.controlledChangeKey
      };
    }
    const [existing] = await db
      .select({ createdAt: auditEvents.createdAt, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(eq(auditEvents.eventId, deterministicEventId))
      .limit(1);
    const existingCreatedAt = existing?.createdAt
      ? new Date(existing.createdAt).toISOString()
      : null;
    const existingAssignedAt = metadataValue(existing?.metadata, 'assigned_at')
      ?? existingCreatedAt
      ?? assignment.assigned_at;
    if (metadataValue(existing?.metadata, 'journey_id') !== assignment.journey_id
      || metadataValue(existing?.metadata, 'experiment_key') !== input.experimentKey
      || metadataValue(existing?.metadata, 'variant') !== variant
      || metadataValue(existing?.metadata, 'controlled_change_key') !== definition.controlledChangeKey
      || metadataNumber(existing?.metadata, 'controlled_change_count') !== 1) {
      throw new Error('Existing experiment assignment conflicts with the deterministic cohort contract.');
    }
    return {
      assigned: true, created: false, assignedAt: existingAssignedAt,
      variant, controlledChangeKey: definition.controlledChangeKey
    };
  }

  async function requireExperimentAssignment(input: {
    journeyId: string;
    experimentKey: string;
    occurredAt: string;
  }) {
    const journeyEntityId = discoveryEntityUuid(input.journeyId.toLowerCase());
    const [assignment] = await db
      .select({ createdAt: auditEvents.createdAt, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.entityType, 'shell_friction'),
        eq(auditEvents.entityId, journeyEntityId),
        eq(auditEvents.eventType, 'discovery_experiment.assignment'),
        sql`${auditEvents.metadata}->>'experiment_key' = ${input.experimentKey}`
      ))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.eventId))
      .limit(1);
    if (!assignment) throw new Error('Experiment assignment must exist before journey evidence.');
    const definition = experimentDefinition(input.experimentKey);
    const expectedVariant = discoveryExperimentVariant(input.journeyId, input.experimentKey);
    if (!definition
      || metadataValue(assignment.metadata, 'journey_id') !== input.journeyId.toLowerCase()
      || metadataValue(assignment.metadata, 'variant') !== expectedVariant
      || metadataValue(assignment.metadata, 'controlled_change_key') !== definition.controlledChangeKey
      || metadataNumber(assignment.metadata, 'controlled_change_count') !== 1) {
      throw new Error('Experiment assignment conflicts with the deterministic cohort contract.');
    }
    const assignedAt = metadataValue(assignment.metadata, 'assigned_at') ?? new Date(assignment.createdAt).toISOString();
    if (new Date(assignedAt).getTime() > new Date(input.occurredAt).getTime()) {
      throw new Error('Experiment assignment must precede journey evidence.');
    }
  }

  async function recordJourneyEvent(
    input: DiscoveryJourneyEventInput,
    now?: Date,
    options?: { idempotencyKey?: string }
  ) {
    const normalized = normalizeDiscoveryJourneyEvent(input, now);
    if (Boolean(normalized.entity_kind) !== Boolean(normalized.entity_key)) {
      throw new Error('entityKind and entityKey must be supplied together.');
    }
    if (normalized.stage === 'outcome') {
      if (!normalized.action_kind || !normalized.outcome_status) {
        throw new Error('Outcome evidence requires actionKind and outcomeStatus.');
      }
      if (normalized.outcome_status === 'completed' && normalized.link_strength !== 'direct_server_observed') {
        throw new Error('Completed outcomes require direct server evidence.');
      }
    } else if (normalized.outcome_status) {
      throw new Error('Only outcome evidence may carry outcomeStatus.');
    }
    if (normalized.experiment_key) {
      await requireExperimentAssignment({
        journeyId: normalized.journey_id,
        experimentKey: normalized.experiment_key,
        occurredAt: normalized.occurred_at
      });
    }
    if (options?.idempotencyKey) {
      if (!/^[a-z0-9][a-z0-9_.:-]{0,159}$/i.test(options.idempotencyKey)) {
        throw new Error('idempotencyKey is invalid.');
      }
      await db.insert(auditEvents).values({
        eventId: discoveryEntityUuid(
          `journey:${normalized.journey_id}:${normalized.event_type}:${options.idempotencyKey}`
        ),
        actorId: null,
        actorType: 'anonymous',
        entityType: 'shell_friction',
        entityId: discoveryEntityUuid(normalized.journey_id),
        eventType: normalized.event_type,
        metadata: normalized
      }).onConflictDoNothing({ target: auditEvents.eventId });
    } else {
      await writeAuditEvent(db, {
        actorId: null,
        actorType: 'anonymous',
        entityType: 'shell_friction',
        entityId: normalized.journey_id,
        eventType: normalized.event_type,
        metadata: normalized
      });
    }
    return normalized;
  }

  async function listDiscoveryAuditRows(input: { since: Date; limit?: number }) {
    const limit = Math.max(1, Math.min(20_000, Math.trunc(input.limit ?? 10_000)));
    return db
      .select({
        eventId: auditEvents.eventId,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        eventType: auditEvents.eventType,
        metadata: auditEvents.metadata,
        createdAt: auditEvents.createdAt
      })
      .from(auditEvents)
      .where(and(
        gte(auditEvents.createdAt, input.since),
        sql`(
          ${auditEvents.eventType} like 'discovery_%'
          or ${auditEvents.eventType} in (
            'room_entry_viewed', 'room_entry_attempted', 'room_entry_completed', 'request_started',
            'tip_action_completed',
            'internal_search_zero_result'
          )
        )`
      ))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.eventId))
      .limit(limit);
  }

  return {
    recordObservation,
    recordExperimentDecision,
    assignExperiment,
    recordJourneyEvent,
    listDiscoveryAuditRows
  };
}

export type DiscoveryObservatoryStore = ReturnType<typeof createDiscoveryObservatoryStore>;
