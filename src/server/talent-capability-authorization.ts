import { and, desc, eq, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  performerAuthorityEvents,
  performerCapabilityGrantEvents
} from '../db/schema';
import type { PerformerCapability } from '../talent-capability-catalog';

export class TalentCapabilityAuthorizationError extends Error {
  constructor(
    public readonly status: 403,
    public readonly code: 'capability_not_granted' | 'subject_authority_not_granted' | 'live_money_not_authorized',
    message: string
  ) {
    super(message);
  }
}

function isCurrentGrant(
  decision: string | null | undefined,
  expiresAt: Date | null | undefined,
  now: Date
) {
  return decision === 'granted' && (!expiresAt || expiresAt.getTime() > now.getTime());
}

export function createTalentCapabilityAuthorization(db: SwayDb) {
  async function requireCapability(input: {
    performerId: string;
    capability: PerformerCapability;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const [latest] = await db
      .select({
        id: performerCapabilityGrantEvents.id,
        decision: performerCapabilityGrantEvents.decision,
        expiresAt: performerCapabilityGrantEvents.expiresAt,
        eventSequence: performerCapabilityGrantEvents.eventSequence
      })
      .from(performerCapabilityGrantEvents)
      .where(and(
        eq(performerCapabilityGrantEvents.performerId, input.performerId),
        eq(performerCapabilityGrantEvents.capability, input.capability)
      ))
      .orderBy(desc(performerCapabilityGrantEvents.eventSequence))
      .limit(1);

    if (!latest || !isCurrentGrant(latest.decision, latest.expiresAt, now)) {
      throw new TalentCapabilityAuthorizationError(
        403,
        'capability_not_granted',
        `Current ${input.capability.replaceAll('_', ' ')} authorization is required.`
      );
    }

    return latest;
  }

  async function requireEventOrganizerAuthority(input: {
    performerId: string;
    eventId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const [latest] = await db
      .select({
        id: performerAuthorityEvents.id,
        decision: performerAuthorityEvents.decision,
        expiresAt: performerAuthorityEvents.expiresAt,
        eventSequence: performerAuthorityEvents.eventSequence
      })
      .from(performerAuthorityEvents)
      .where(and(
        eq(performerAuthorityEvents.performerId, input.performerId),
        eq(performerAuthorityEvents.authorityKind, 'event_organizer'),
        eq(performerAuthorityEvents.subjectType, 'event'),
        eq(performerAuthorityEvents.subjectId, input.eventId)
      ))
      .orderBy(desc(performerAuthorityEvents.eventSequence))
      .limit(1);

    if (!latest || !isCurrentGrant(latest.decision, latest.expiresAt, now)) {
      throw new TalentCapabilityAuthorizationError(
        403,
        'subject_authority_not_granted',
        'Current organizer authority for this exact event is required.'
      );
    }

    return latest;
  }

  async function requireAuthority(input: {
    performerId: string;
    authorityKind: 'seller' | 'event_organizer' | 'venue_representative' | 'ticket_inventory' | 'catalog_controller' | 'payout_controller' | 'brand_representative';
    subjectType: string;
    subjectId: string;
    now?: Date;
  }) {
    const now = input.now ?? new Date();
    const [latest] = await db
      .select({
        id: performerAuthorityEvents.id,
        decision: performerAuthorityEvents.decision,
        expiresAt: performerAuthorityEvents.expiresAt,
        eventSequence: performerAuthorityEvents.eventSequence
      })
      .from(performerAuthorityEvents)
      .where(and(
        eq(performerAuthorityEvents.performerId, input.performerId),
        eq(performerAuthorityEvents.authorityKind, input.authorityKind),
        eq(performerAuthorityEvents.subjectType, input.subjectType),
        eq(performerAuthorityEvents.subjectId, input.subjectId)
      ))
      .orderBy(desc(performerAuthorityEvents.eventSequence))
      .limit(1);

    if (!latest || !isCurrentGrant(latest.decision, latest.expiresAt, now)) {
      throw new TalentCapabilityAuthorizationError(
        403,
        'subject_authority_not_granted',
        `Current ${input.authorityKind.replaceAll('_', ' ')} authority for this exact ${input.subjectType} is required.`
      );
    }
    return latest;
  }

  async function requireLiveMoneyAuthority(input: {
    performerId: string;
    destinationAccountId: string;
    environment: 'test' | 'live';
  }) {
    try {
      await db.execute(sql`select sway_require_current_live_money_authority(
        ${input.performerId}::uuid,
        ${input.destinationAccountId}::text,
        ${input.environment}::text
      )`);
    } catch {
      throw new TalentCapabilityAuthorizationError(
        403,
        'live_money_not_authorized',
        'Current live-money capability, seller authority, payout authority, readiness, and release authorization are required.'
      );
    }
  }

  return {
    requireCapability,
    requireAuthority,
    requireEventOrganizerAuthority,
    requireLiveMoneyAuthority
  };
}
