import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  auditEvents,
  performerCapabilityGrantEvents,
  performerIdentityEvents,
  performerIntentEvents,
  performers
} from '../db/schema';
import {
  PERFORMER_CAPABILITIES,
  PERFORMER_CAPABILITY_OPTIONS,
  PERFORMER_EARNING_MODES,
  PERFORMER_EARNING_MODE_OPTIONS,
  PROFESSIONAL_IDENTITY_KINDS,
  PROFESSIONAL_IDENTITY_OPTIONS,
  type PerformerCapability,
  type PerformerEarningMode,
  type ProfessionalIdentityKind
} from '../talent-capability-catalog';
import { toAuditEntityUuid } from './audit-log';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ProfessionalIdentitySelection = {
  kind: ProfessionalIdentityKind;
  customLabel: string | null;
};

export type ProfessionalSetupMutation = {
  clientMutationId: string;
  primaryIdentity: ProfessionalIdentitySelection;
  secondaryIdentities: ProfessionalIdentitySelection[];
  earningModes: PerformerEarningMode[];
  desiredCapabilities: PerformerCapability[];
};

export class TalentProfessionalSetupError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 422,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeCustomLabel(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

function parseIdentity(value: unknown, field: string): ProfessionalIdentitySelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TalentProfessionalSetupError(422, 'invalid_identity', `${field} must be a professional identity choice.`);
  }
  const candidate = value as Record<string, unknown>;
  const kind = typeof candidate.kind === 'string' ? candidate.kind.trim().toLowerCase() : '';
  if (!PROFESSIONAL_IDENTITY_KINDS.includes(kind as ProfessionalIdentityKind)) {
    throw new TalentProfessionalSetupError(422, 'invalid_identity', `${field} is not supported.`);
  }
  const customLabel = normalizeCustomLabel(candidate.customLabel);
  if (kind === 'other' && (!customLabel || customLabel.length > 80)) {
    throw new TalentProfessionalSetupError(422, 'invalid_custom_identity', `${field} needs a label of 80 characters or fewer.`);
  }
  if (kind !== 'other' && customLabel) {
    throw new TalentProfessionalSetupError(422, 'unexpected_custom_identity', `${field} may use a custom label only with Something else.`);
  }
  return { kind: kind as ProfessionalIdentityKind, customLabel };
}

function parseKnownList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  maxItems: number
) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TalentProfessionalSetupError(422, 'invalid_selection_list', `${field} must be an array with at most ${maxItems} choices.`);
  }
  const normalized = value.map((item) => typeof item === 'string' ? item.trim().toLowerCase() : '');
  if (normalized.some((item) => !allowed.includes(item as T))) {
    throw new TalentProfessionalSetupError(422, 'unsupported_selection', `${field} contains an unsupported choice.`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new TalentProfessionalSetupError(422, 'duplicate_selection', `${field} contains a duplicate choice.`);
  }
  return normalized as T[];
}

function identityKey(identity: ProfessionalIdentitySelection) {
  return `${identity.kind}:${identity.customLabel?.trim().toLowerCase() ?? ''}`;
}

function identityOrder(identity: ProfessionalIdentitySelection) {
  const index = PROFESSIONAL_IDENTITY_KINDS.indexOf(identity.kind);
  return `${String(index).padStart(3, '0')}:${identity.customLabel ?? ''}`;
}

export type ProfessionalIdentityEventProjection = {
  identityRole: string;
  identityKind: ProfessionalIdentityKind;
  customLabel: string | null;
  eventType: string;
};

export function resolveCurrentProfessionalIdentities(rows: ProfessionalIdentityEventProjection[]) {
  let primaryIdentity: ProfessionalIdentitySelection | null = null;
  const secondaryIdentities = new Map<string, ProfessionalIdentitySelection>();
  for (const row of rows) {
    const identity = { kind: row.identityKind, customLabel: row.customLabel ?? null };
    if (row.identityRole === 'primary') {
      primaryIdentity = row.eventType === 'selected' ? identity : null;
    } else if (row.identityRole === 'secondary' && row.eventType === 'selected') {
      secondaryIdentities.set(identityKey(identity), identity);
    } else if (row.identityRole === 'secondary' && row.eventType === 'withdrawn') {
      secondaryIdentities.delete(identityKey(identity));
    }
  }
  return {
    primaryIdentity,
    secondaryIdentities: [...secondaryIdentities.values()].sort((a, b) => identityOrder(a).localeCompare(identityOrder(b)))
  };
}

export function parseProfessionalSetupMutation(value: unknown): ProfessionalSetupMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TalentProfessionalSetupError(422, 'invalid_setup', 'Professional setup must be a JSON object.');
  }
  const input = value as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(clientMutationId)) {
    throw new TalentProfessionalSetupError(422, 'invalid_mutation_id', 'A UUID clientMutationId is required.');
  }
  const primaryIdentity = parseIdentity(input.primaryIdentity, 'Primary identity');
  if (!Array.isArray(input.secondaryIdentities) || input.secondaryIdentities.length > 8) {
    throw new TalentProfessionalSetupError(422, 'invalid_secondary_identities', 'Choose at most 8 secondary identities.');
  }
  const secondaryIdentities = input.secondaryIdentities.map((identity, index) => parseIdentity(identity, `Secondary identity ${index + 1}`));
  const identityKeys = secondaryIdentities.map(identityKey);
  if (new Set(identityKeys).size !== identityKeys.length || identityKeys.includes(identityKey(primaryIdentity))) {
    throw new TalentProfessionalSetupError(422, 'duplicate_identity', 'Primary and secondary identities must be distinct.');
  }
  return {
    clientMutationId,
    primaryIdentity,
    secondaryIdentities: [...secondaryIdentities].sort((a, b) => identityOrder(a).localeCompare(identityOrder(b))),
    earningModes: parseKnownList(input.earningModes, PERFORMER_EARNING_MODES, 'earningModes', PERFORMER_EARNING_MODES.length),
    desiredCapabilities: parseKnownList(input.desiredCapabilities, PERFORMER_CAPABILITIES, 'desiredCapabilities', PERFORMER_CAPABILITIES.length)
  };
}

function mutationPayload(input: ProfessionalSetupMutation) {
  return {
    primaryIdentity: input.primaryIdentity,
    secondaryIdentities: [...input.secondaryIdentities].sort((a, b) => identityOrder(a).localeCompare(identityOrder(b))),
    earningModes: [...input.earningModes].sort((a, b) => PERFORMER_EARNING_MODES.indexOf(a) - PERFORMER_EARNING_MODES.indexOf(b)),
    desiredCapabilities: [...input.desiredCapabilities].sort((a, b) => PERFORMER_CAPABILITIES.indexOf(a) - PERFORMER_CAPABILITIES.indexOf(b))
  };
}

function auditMetadata(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function loadLedgerState(executor: any, actorUserId: string, now: Date) {
  const ownedPerformers = await executor
    .select({
      performerId: performers.id,
      ownerUserId: performers.ownerUserId,
      visibilityState: performers.visibilityState
    })
    .from(performers)
    .where(eq(performers.ownerUserId, actorUserId))
    .orderBy(asc(performers.id))
    .limit(2);
  const performer = ownedPerformers[0];
  if (!performer) throw new TalentProfessionalSetupError(403, 'owner_required', 'Only the performer owner can manage professional setup.');
  if (ownedPerformers.length > 1) {
    throw new TalentProfessionalSetupError(409, 'ambiguous_owner_subject', 'Professional setup cannot continue while this account owns more than one professional profile.');
  }

  const identityRows = await executor
    .select({
      identityRole: performerIdentityEvents.identityRole,
      identityKind: performerIdentityEvents.identityKind,
      customLabel: performerIdentityEvents.customLabel,
      eventType: performerIdentityEvents.eventType
    })
    .from(performerIdentityEvents)
    .where(eq(performerIdentityEvents.performerId, performer.performerId))
    .orderBy(asc(performerIdentityEvents.eventSequence));
  const intentRows = await executor
    .select({
      intentType: performerIntentEvents.intentType,
      earningMode: performerIntentEvents.earningMode,
      desiredCapability: performerIntentEvents.desiredCapability,
      eventType: performerIntentEvents.eventType
    })
    .from(performerIntentEvents)
    .where(eq(performerIntentEvents.performerId, performer.performerId))
    .orderBy(asc(performerIntentEvents.eventSequence));
  const grantRows = await executor
    .select({
      capability: performerCapabilityGrantEvents.capability,
      decision: performerCapabilityGrantEvents.decision,
      reason: performerCapabilityGrantEvents.reason,
      expiresAt: performerCapabilityGrantEvents.expiresAt,
      createdAt: performerCapabilityGrantEvents.createdAt
    })
    .from(performerCapabilityGrantEvents)
    .where(eq(performerCapabilityGrantEvents.performerId, performer.performerId))
    .orderBy(asc(performerCapabilityGrantEvents.eventSequence));

  const { primaryIdentity, secondaryIdentities } = resolveCurrentProfessionalIdentities(
    identityRows.map((row) => ({
      ...row,
      identityKind: row.identityKind as ProfessionalIdentityKind
    }))
  );

  const earningModes = new Set<PerformerEarningMode>();
  const desiredCapabilities = new Set<PerformerCapability>();
  for (const row of intentRows) {
    if (row.intentType === 'earning_mode' && row.earningMode) {
      if (row.eventType === 'selected') earningModes.add(row.earningMode as PerformerEarningMode);
      else earningModes.delete(row.earningMode as PerformerEarningMode);
    }
    if (row.intentType === 'desired_capability' && row.desiredCapability) {
      if (row.eventType === 'selected') desiredCapabilities.add(row.desiredCapability as PerformerCapability);
      else desiredCapabilities.delete(row.desiredCapability as PerformerCapability);
    }
  }

  const latestGrants = new Map<PerformerCapability, typeof grantRows[number]>();
  for (const row of grantRows) latestGrants.set(row.capability as PerformerCapability, row);
  const capabilityStatuses = PERFORMER_CAPABILITY_OPTIONS.map((option) => {
    const latest = latestGrants.get(option.id);
    const naturallyExpired = latest?.decision === 'granted' && latest.expiresAt !== null && latest.expiresAt.getTime() <= now.getTime();
    const decision = naturallyExpired ? 'expired' : latest?.decision ?? null;
    return {
      capability: option.id,
      requested: desiredCapabilities.has(option.id),
      decision,
      grantCurrent: decision === 'granted',
      reason: latest?.reason ?? null,
      expiresAt: latest?.expiresAt?.toISOString() ?? null,
      decidedAt: latest?.createdAt?.toISOString() ?? null
    };
  });

  return {
    performerId: performer.performerId,
    primaryIdentity,
    secondaryIdentities,
    earningModes: PERFORMER_EARNING_MODES.filter((mode) => earningModes.has(mode)),
    desiredCapabilities: PERFORMER_CAPABILITIES.filter((capability) => desiredCapabilities.has(capability)),
    capabilityStatuses,
    publication: {
      visibilityState: performer.visibilityState,
      explicitlyPublic: performer.visibilityState === 'public',
      managedSeparately: true
    },
    catalogs: {
      identities: PROFESSIONAL_IDENTITY_OPTIONS,
      earningModes: PERFORMER_EARNING_MODE_OPTIONS,
      capabilities: PERFORMER_CAPABILITY_OPTIONS
    }
  };
}

export function createTalentProfessionalSetupService(db: SwayDb) {
  async function getState(actorUserId: string) {
    return loadLedgerState(db, actorUserId, new Date());
  }

  async function save(actorUserId: string, rawInput: unknown) {
    const input = parseProfessionalSetupMutation(rawInput);
    const canonicalPayload = mutationPayload(input);
    const payloadHash = sha256(JSON.stringify(canonicalPayload));
    const mutationEventId = toAuditEntityUuid(`professional-setup:${actorUserId}:${input.clientMutationId}`);

    const outcome = await db.transaction(async (tx) => {
      const lockedPerformers = await tx
        .select({ performerId: performers.id })
        .from(performers)
        .where(eq(performers.ownerUserId, actorUserId))
        .orderBy(asc(performers.id))
        .for('update')
        .limit(2);
      const lockedPerformer = lockedPerformers[0];
      if (!lockedPerformer) throw new TalentProfessionalSetupError(403, 'owner_required', 'Only the performer owner can manage professional setup.');
      if (lockedPerformers.length > 1) {
        throw new TalentProfessionalSetupError(409, 'ambiguous_owner_subject', 'Professional setup cannot continue while this account owns more than one professional profile.');
      }

      const [priorMutation] = await tx
        .select({ metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(eq(auditEvents.eventId, mutationEventId))
        .limit(1);
      if (priorMutation) {
        if (auditMetadata(priorMutation.metadata).payloadHash !== payloadHash) {
          throw new TalentProfessionalSetupError(409, 'mutation_reuse_conflict', 'This clientMutationId was already used for different professional setup choices.');
        }
        return { replayed: true, changed: false };
      }

      const current = await loadLedgerState(tx, actorUserId, new Date());
      const now = new Date();
      let changed = false;
      let changeCount = 0;
      const eventHash = (label: string) => sha256(`${mutationEventId}:${label}`);
      const appendIdentity = async (identity: ProfessionalIdentitySelection, identityRole: 'primary' | 'secondary', eventType: 'selected' | 'withdrawn', label: string) => {
        await tx.insert(performerIdentityEvents).values({
          performerId: lockedPerformer.performerId,
          identityRole,
          identityKind: identity.kind,
          customLabel: identity.customLabel,
          eventType,
          actorUserId,
          idempotencyKeyHash: eventHash(`identity:${label}`),
          createdAt: now
        });
        changed = true;
        changeCount += 1;
      };
      const appendIntent = async (inputValue: {
        intentType: 'earning_mode' | 'desired_capability';
        earningMode?: PerformerEarningMode;
        desiredCapability?: PerformerCapability;
        eventType: 'selected' | 'withdrawn';
        label: string;
      }) => {
        await tx.insert(performerIntentEvents).values({
          performerId: lockedPerformer.performerId,
          intentType: inputValue.intentType,
          earningMode: inputValue.earningMode ?? null,
          desiredCapability: inputValue.desiredCapability ?? null,
          eventType: inputValue.eventType,
          actorUserId,
          idempotencyKeyHash: eventHash(`intent:${inputValue.label}`),
          createdAt: now
        });
        changed = true;
        changeCount += 1;
      };

      if (!current.primaryIdentity || identityKey(current.primaryIdentity) !== identityKey(input.primaryIdentity)) {
        if (current.primaryIdentity) {
          await appendIdentity(current.primaryIdentity, 'primary', 'withdrawn', `primary:withdraw:${identityKey(current.primaryIdentity)}`);
        }
        await appendIdentity(input.primaryIdentity, 'primary', 'selected', `primary:select:${identityKey(input.primaryIdentity)}`);
      }

      const currentSecondaries = new Map(current.secondaryIdentities.map((identity) => [identityKey(identity), identity]));
      const nextSecondaries = new Map(input.secondaryIdentities.map((identity) => [identityKey(identity), identity]));
      for (const [key, identity] of currentSecondaries) {
        if (!nextSecondaries.has(key)) await appendIdentity(identity, 'secondary', 'withdrawn', `secondary:withdraw:${key}`);
      }
      for (const [key, identity] of nextSecondaries) {
        if (!currentSecondaries.has(key)) await appendIdentity(identity, 'secondary', 'selected', `secondary:select:${key}`);
      }

      const currentEarningModes = new Set(current.earningModes);
      const nextEarningModes = new Set(input.earningModes);
      for (const earningMode of currentEarningModes) {
        if (!nextEarningModes.has(earningMode)) await appendIntent({ intentType: 'earning_mode', earningMode, eventType: 'withdrawn', label: `earning:withdraw:${earningMode}` });
      }
      for (const earningMode of nextEarningModes) {
        if (!currentEarningModes.has(earningMode)) await appendIntent({ intentType: 'earning_mode', earningMode, eventType: 'selected', label: `earning:select:${earningMode}` });
      }

      const currentCapabilities = new Set(current.desiredCapabilities);
      const nextCapabilities = new Set(input.desiredCapabilities);
      for (const desiredCapability of currentCapabilities) {
        if (!nextCapabilities.has(desiredCapability)) await appendIntent({ intentType: 'desired_capability', desiredCapability, eventType: 'withdrawn', label: `capability:withdraw:${desiredCapability}` });
      }
      for (const desiredCapability of nextCapabilities) {
        if (!currentCapabilities.has(desiredCapability)) await appendIntent({ intentType: 'desired_capability', desiredCapability, eventType: 'selected', label: `capability:select:${desiredCapability}` });
      }

      await tx.insert(auditEvents).values({
        eventId: mutationEventId,
        actorType: 'performer',
        actorId: actorUserId,
        entityType: 'performer',
        entityId: lockedPerformer.performerId,
        eventType: 'professional_setup.update',
        previousStatus: null,
        nextStatus: null,
        metadata: {
          clientMutationId: input.clientMutationId,
          payloadHash,
          changeCount,
          publicationChanged: false,
          capabilityGrantChanged: false,
          authorityChanged: false
        },
        createdAt: now
      });
      return { replayed: false, changed };
    });

    return { ...outcome, state: await getState(actorUserId) };
  }

  return { getState, save };
}
