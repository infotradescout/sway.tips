import assert from 'node:assert/strict';
import {
  escapePublicProfileMetadataAttribute,
  normalizePublicProfileEmail,
  normalizePublicProfileLinks,
  normalizePublicProfilePhone,
  normalizePublicProfileSpecialties,
  normalizePublicProfileUrl
} from '../src/server/public-profile';
import {
  buildSwayPartnerTermsSnapshot,
  SWAY_PARTNER_TERMS_HASH,
  SWAY_PARTNER_TERMS_SNAPSHOT,
  SWAY_PARTNER_TERMS_TEXT,
  SWAY_PARTNER_TERMS_VERSION
} from '../src/server/partner-entitlement';
import {
  normalizePerformerHandle,
  RESERVED_PERFORMER_HANDLES
} from '../src/server/performer-login';
import { calculateSwayPaymentAmounts } from '../src/server/payment-service';

assert.equal(normalizePublicProfileUrl('javascript:alert(1)'), null);
assert.equal(normalizePublicProfileUrl('data:text/html,<script>alert(1)</script>'), null);
assert.equal(normalizePublicProfileUrl('file:///etc/passwd'), null);
assert.equal(normalizePublicProfileUrl('ftp://example.com/file'), null);
assert.equal(normalizePublicProfileUrl('https://user:secret@example.com/'), null);
assert.equal(normalizePublicProfileUrl('https://example.com/path'), 'https://example.com/path');
assert.equal(normalizePublicProfileEmail(' BOOKING@Example.com '), 'booking@example.com');
assert.equal(normalizePublicProfileEmail('not-an-email'), null);
assert.equal(normalizePublicProfilePhone('(850) 555-0123'), '(850) 555-0123');
assert.equal(normalizePublicProfilePhone('123'), null);
assert.equal(
  escapePublicProfileMetadataAttribute('\"><script>alert(1)</script>&'),
  '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;'
);

for (const reservedHandle of RESERVED_PERFORMER_HANDLES) {
  assert.equal(normalizePerformerHandle(reservedHandle), null);
  assert.equal(normalizePerformerHandle(reservedHandle.toUpperCase()), null);
}
assert.equal(normalizePerformerHandle('CoreyMack'), 'CoreyMack');
assert.equal(normalizePerformerHandle('coreymack'), 'coreymack');

assert.deepEqual(
  normalizePublicProfileSpecialties(['DJ', 'Beatbox', 'DJ', ' Comedy ', '', ...Array(10).fill('Extra')]),
  ['DJ', 'Beatbox', 'Comedy', 'Extra']
);
assert.equal(normalizePublicProfileSpecialties('DJ'), null);

const orderedLinks = normalizePublicProfileLinks([
  { label: 'Book me', url: 'https://example.com/book', kind: 'booking' },
  { label: 'Community', description: 'Join us', url: 'https://example.com/community', kind: 'community', isActive: false }
]);
assert.equal(orderedLinks.error, null);
assert.equal(orderedLinks.provided, true);
assert.deepEqual(orderedLinks.links.map((link) => link.sortOrder), [0, 1]);
assert.deepEqual(orderedLinks.links.map((link) => link.kind), ['booking', 'community']);
assert.equal(orderedLinks.links[1].isActive, false);

assert.match(normalizePublicProfileLinks([{ url: 'https://example.com' }]).error || '', /needs a label/);
assert.match(normalizePublicProfileLinks([{ label: 'Bad', url: 'javascript:alert(1)' }]).error || '', /valid http or https URL/);
assert.match(
  normalizePublicProfileLinks(Array.from({ length: 13 }, (_, index) => ({ label: `Link ${index}`, url: `https://example.com/${index}` }))).error || '',
  /up to 12 links/
);

const firstSnapshot = buildSwayPartnerTermsSnapshot();
const secondSnapshot = buildSwayPartnerTermsSnapshot();
assert.equal(SWAY_PARTNER_TERMS_VERSION, '2026-07-18');
assert.match(SWAY_PARTNER_TERMS_HASH, /^[0-9a-f]{64}$/);
assert.match(SWAY_PARTNER_TERMS_TEXT, /Request, Tip, or Boost/);
assert.match(SWAY_PARTNER_TERMS_TEXT, /processor fees, taxes, refunds, disputes, and chargebacks/i);
assert.equal(firstSnapshot.publicProfileHostingFeeCents, 0);
assert.equal(firstSnapshot.performerSubscriptionFeeCents, 0);
assert.equal(firstSnapshot.paidInteractionPlatformFeeCents, 100);
assert.notEqual(firstSnapshot.externalChargesExcluded, secondSnapshot.externalChargesExcluded);
firstSnapshot.externalChargesExcluded.push('test-only mutation');
assert.equal(SWAY_PARTNER_TERMS_SNAPSHOT.externalChargesExcluded.includes('test-only mutation'), false);

const patronPaidAmounts = calculateSwayPaymentAmounts({
  amountSubtotalCents: 1_000,
  platformFeeCents: 100,
  platformFeePayer: 'patron'
});
assert.equal(patronPaidAmounts.platformFeeCents, 100);
assert.equal(patronPaidAmounts.platformFeeChargedToPatronCents, 100);
assert.equal(patronPaidAmounts.amountTotalCents, 1_100);
assert.equal(patronPaidAmounts.amountTotalCents - patronPaidAmounts.platformFeeCents, 1_000);

const performerPaidAmounts = calculateSwayPaymentAmounts({
  amountSubtotalCents: 1_000,
  platformFeeCents: 100,
  platformFeePayer: 'performer'
});
assert.equal(performerPaidAmounts.platformFeeCents, 100);
assert.equal(performerPaidAmounts.platformFeeChargedToPatronCents, 0);
assert.equal(performerPaidAmounts.amountTotalCents, 1_000);
assert.equal(performerPaidAmounts.amountTotalCents - performerPaidAmounts.platformFeeCents, 900);

console.log('Performer link profile behavior tests passed.');
