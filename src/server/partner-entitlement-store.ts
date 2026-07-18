import { and, desc, eq } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  gigSessions,
  performerPartnerEntitlements,
  performerPartnerEntitlementStatusEvents,
  performerPartnerTermsAcceptances,
  performers
} from '../db/schema';

type DbExecutor = SwayDb | any;

export type PartnerTermsSnapshot = {
  guarantee: string;
  publicProfileHostingFeeCents: number;
  performerSubscriptionFeeCents: number;
  paidInteractionPlatformFeeCents: number;
  externalChargesExcluded: string[];
};

export type PartnerEntitlementState = {
  entitlementId: string;
  performerId: string;
  ownerUserId: string;
  partnerKind: string;
  termsVersion: string;
  termsHash: string;
  termsText: string;
  termsSnapshot: PartnerTermsSnapshot;
  grantedAt: Date;
  acceptedAt: Date | null;
  currentStatus: 'active' | 'suspended' | null;
  statusReason: string | null;
  isAccepted: boolean;
  isSuspended: boolean;
  isEffective: boolean;
};

export async function loadPartnerEntitlementStateForPerformer(
  db: DbExecutor,
  performerId: string
): Promise<PartnerEntitlementState | null> {
  const [grant] = await db
    .select({
      entitlementId: performerPartnerEntitlements.id,
      performerId: performerPartnerEntitlements.performerId,
      ownerUserId: performers.ownerUserId,
      partnerKind: performerPartnerEntitlements.partnerKind,
      termsVersion: performerPartnerEntitlements.termsVersion,
      termsHash: performerPartnerEntitlements.termsHash,
      termsText: performerPartnerEntitlements.termsText,
      termsSnapshot: performerPartnerEntitlements.termsSnapshot,
      grantedAt: performerPartnerEntitlements.grantedAt
    })
    .from(performerPartnerEntitlements)
    .innerJoin(performers, eq(performers.id, performerPartnerEntitlements.performerId))
    .where(and(
      eq(performerPartnerEntitlements.performerId, performerId),
      eq(performerPartnerEntitlements.partnerKind, 'brand')
    ))
    .limit(1);

  if (!grant) return null;

  const [[acceptance], [latestStatus]] = await Promise.all([
    db
      .select({ acceptedAt: performerPartnerTermsAcceptances.acceptedAt })
      .from(performerPartnerTermsAcceptances)
      .where(and(
        eq(performerPartnerTermsAcceptances.entitlementId, grant.entitlementId),
        eq(performerPartnerTermsAcceptances.accountUserId, grant.ownerUserId),
        eq(performerPartnerTermsAcceptances.termsVersion, grant.termsVersion),
        eq(performerPartnerTermsAcceptances.termsHash, grant.termsHash)
      ))
      .orderBy(desc(performerPartnerTermsAcceptances.acceptedAt))
      .limit(1),
    db
      .select({
        status: performerPartnerEntitlementStatusEvents.status,
        reason: performerPartnerEntitlementStatusEvents.reason
      })
      .from(performerPartnerEntitlementStatusEvents)
      .where(eq(performerPartnerEntitlementStatusEvents.entitlementId, grant.entitlementId))
      .orderBy(
        desc(performerPartnerEntitlementStatusEvents.createdAt),
        desc(performerPartnerEntitlementStatusEvents.id)
      )
      .limit(1)
  ]);

  const currentStatus = latestStatus?.status === 'active' || latestStatus?.status === 'suspended'
    ? latestStatus.status
    : null;
  const isAccepted = Boolean(acceptance?.acceptedAt);
  const isSuspended = currentStatus !== 'active';

  return {
    ...grant,
    termsSnapshot: grant.termsSnapshot as PartnerTermsSnapshot,
    acceptedAt: acceptance?.acceptedAt ?? null,
    currentStatus,
    statusReason: latestStatus?.reason ?? null,
    isAccepted,
    isSuspended,
    isEffective: isAccepted && !isSuspended
  };
}

export async function resolveSwayPlatformFeePolicyForGig(input: {
  db: DbExecutor;
  gigId: string;
  proposedPlatformFeeCents: number;
}) {
  const proposedPlatformFeeCents = Math.max(0, Math.trunc(Number(input.proposedPlatformFeeCents) || 0));
  const [gig] = await input.db
    .select({ performerId: gigSessions.performerId })
    .from(gigSessions)
    .where(eq(gigSessions.id, input.gigId))
    .limit(1);

  if (!gig) {
    throw new Error('gig_not_found_for_platform_fee_policy');
  }

  const partner = await loadPartnerEntitlementStateForPerformer(input.db, gig.performerId);
  if (!partner?.isEffective) {
    return {
      platformFeeCents: proposedPlatformFeeCents,
      platformFeeCapCents: null,
      partnerTermsVersion: null,
      partnerTermsHash: null
    };
  }

  const rawCap = Number(partner.termsSnapshot?.paidInteractionPlatformFeeCents);
  const platformFeeCapCents = Number.isFinite(rawCap) && rawCap >= 0
    ? Math.trunc(rawCap)
    : 0;

  return {
    platformFeeCents: Math.min(proposedPlatformFeeCents, platformFeeCapCents),
    platformFeeCapCents,
    partnerTermsVersion: partner.termsVersion,
    partnerTermsHash: partner.termsHash
  };
}
