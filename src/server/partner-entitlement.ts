import { createHash } from 'node:crypto';

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

export const SWAY_PARTNER_TERMS_TEXT = [
  'Sway Brand Partner terms version 2026-07-18.',
  'Public profile hosting is $0.',
  'The performer subscription fee for capabilities available on the grant date is $0.',
  'The Sway-controlled platform fee is capped at $1 USD per paid Request, Tip, or Boost interaction.',
  'Payment processor fees, taxes, refunds, disputes, and chargebacks are outside the Sway-controlled fee cap.',
  'Optional future premium add-ons cannot be required to retain the capabilities covered by this version.',
  'Brand Partner status does not bypass identity verification, KYC, payout eligibility, safety, moderation, or legal requirements.'
].join('\n');

function canonicalPartnerTermsPayload() {
  return JSON.stringify({
    version: SWAY_PARTNER_TERMS_VERSION,
    text: SWAY_PARTNER_TERMS_TEXT,
    snapshot: SWAY_PARTNER_TERMS_SNAPSHOT
  });
}

export const SWAY_PARTNER_TERMS_HASH = createHash('sha256')
  .update(canonicalPartnerTermsPayload(), 'utf8')
  .digest('hex');

export function buildSwayPartnerTermsSnapshot() {
  return {
    ...SWAY_PARTNER_TERMS_SNAPSHOT,
    externalChargesExcluded: [...SWAY_PARTNER_TERMS_SNAPSHOT.externalChargesExcluded]
  };
}
