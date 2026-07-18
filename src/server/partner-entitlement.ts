export const SWAY_PARTNER_TERMS_VERSION = '2026-07-18';

export const SWAY_PARTNER_TERMS_SNAPSHOT = Object.freeze({
  guarantee: 'No new or increased Sway fees beyond the Sway terms in effect when Brand Partner status was granted.',
  publicProfileHostingFeeCents: 0,
  performerSubscriptionFeeCents: 0,
  paidInteractionPlatformFeeCents: 100,
  externalChargesExcluded: [
    'payment processor fees',
    'taxes',
    'refunds',
    'disputes and chargebacks'
  ]
});

export function buildSwayPartnerTermsSnapshot() {
  return {
    ...SWAY_PARTNER_TERMS_SNAPSHOT,
    externalChargesExcluded: [...SWAY_PARTNER_TERMS_SNAPSHOT.externalChargesExcluded]
  };
}
