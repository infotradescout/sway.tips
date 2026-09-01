// Sway's creator-direct transaction fee is always $1. It is added to the
// customer's checkout total and never deducted from performer earnings.
const CREATOR_DIRECT_TRANSACTION_FEE_CENTS = 100;

export type FeeAttribution =
  | { kind: 'creator_direct' }
  | { kind: 'sway_promoted'; campaignId: string; commissionBps: number };

export type ProposedFee = {
  // The fee Sway proposes to charge for this sale, before any Brand Partner cap is
  // applied. resolveSwayPlatformFeePolicyForGig (partner-entitlement-store.ts) is the
  // downstream authority that may clamp this down -- this function never applies or
  // knows about that cap, and never decides who's billed for it (platformFeePayer,
  // resolved separately from the room's feeType, handles that split).
  proposedPlatformFeeCents: number;
  attributionSource: 'creator_direct' | 'sway_promoted';
  campaignId: string | null;
  commissionBpsApplied: number | null;
};

/**
 * Sway never invents a promoted rate -- it comes from the campaign row (an explicit,
 * opt-in deal term set by ops), never a code constant.
 */
export function resolveProposedPlatformFee(input: {
  subtotalCents: number;
  attribution: FeeAttribution;
}): ProposedFee {
  const proposedPlatformFeeCents = input.attribution.kind === 'sway_promoted'
    ? Math.round(input.subtotalCents * input.attribution.commissionBps / 10000)
    : CREATOR_DIRECT_TRANSACTION_FEE_CENTS;

  return {
    proposedPlatformFeeCents,
    attributionSource: input.attribution.kind,
    campaignId: input.attribution.kind === 'sway_promoted' ? input.attribution.campaignId : null,
    commissionBpsApplied: input.attribution.kind === 'sway_promoted' ? input.attribution.commissionBps : null
  };
}
