import assert from 'node:assert/strict';
import {
  escapePublicProfileMetadataAttribute,
  labelForPublicPerformerPrimaryRole,
  mergePublicProfileMetadata,
  normalizePublicProfileEmail,
  normalizePublicProfileFeaturedMedia,
  normalizePublicProfileLinks,
  normalizePublicProfilePhone,
  normalizePublicProfilePrimaryRole,
  normalizePublicProfileSpecialties,
  normalizePublicProfileUrl,
  resolvePublicProfileHeroName,
  resolvePublicProfilePageKindLabel,
  resolveVerifiedPublicBookingContact
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
assert.equal(normalizePublicProfileUrl('https://djthreeex.com'), null);
assert.equal(normalizePublicProfileUrl('https://www.djthreeex.com/book'), null);
assert.equal(normalizePublicProfileUrl('https://booking.djthreeex.com/request'), null);
assert.equal(normalizePublicProfileEmail(' BOOKING@Example.com '), 'booking@example.com');
assert.equal(normalizePublicProfileEmail('not-an-email'), null);
assert.equal(normalizePublicProfilePhone('(850) 555-0123'), '(850) 555-0123');
assert.equal(normalizePublicProfilePhone('123'), null);
assert.deepEqual(
  resolveVerifiedPublicBookingContact({
    email: ' BOOKING@Example.com ',
    phone: '(850) 555-0123',
    ownerEmailVerifiedAt: null
  }),
  {
    email: null,
    phone: null,
    available: false,
    verificationRequired: true
  }
);
assert.deepEqual(
  resolveVerifiedPublicBookingContact({
    email: ' BOOKING@Example.com ',
    phone: '(850) 555-0123',
    ownerEmailVerifiedAt: new Date('2026-07-18T12:00:00.000Z')
  }),
  {
    email: 'booking@example.com',
    phone: '(850) 555-0123',
    available: true,
    verificationRequired: false
  }
);
assert.deepEqual(
  resolveVerifiedPublicBookingContact({
    email: null,
    phone: null,
    ownerEmailVerifiedAt: null
  }),
  {
    email: null,
    phone: null,
    available: false,
    verificationRequired: false
  }
);
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

assert.equal(normalizePublicProfilePrimaryRole(' DJ '), 'dj');
assert.equal(normalizePublicProfilePrimaryRole('Host / MC'), 'host');
assert.equal(normalizePublicProfilePrimaryRole('mc'), 'host');
assert.equal(normalizePublicProfilePrimaryRole('other performer'), 'other');
assert.equal(normalizePublicProfilePrimaryRole('lawyer'), null);
assert.equal(labelForPublicPerformerPrimaryRole('host'), 'Host / MC');
assert.equal(labelForPublicPerformerPrimaryRole('other'), 'Other');
assert.equal(
  resolvePublicProfileHeroName({ handle: 'coreymack', stageName: 'Corey Mack', displayName: 'Legal Name' }),
  '@coreymack'
);
assert.equal(
  resolvePublicProfileHeroName({ handle: null, stageName: 'Corey Mack', displayName: 'Legal Name' }),
  'Corey Mack'
);
assert.equal(
  resolvePublicProfileHeroName({ handle: null, stageName: null, displayName: 'Legal Name' }),
  'Legal Name'
);
assert.equal(
  resolvePublicProfilePageKindLabel({ primaryRole: 'dj', specialties: ['Open format'], isPreview: false }),
  'DJ'
);
assert.equal(
  resolvePublicProfilePageKindLabel({ primaryRole: null, specialties: ['Beatbox'], isPreview: false }),
  'Beatbox'
);
assert.equal(
  resolvePublicProfilePageKindLabel({ primaryRole: null, specialties: [], isPreview: false }),
  'Sway page'
);
assert.deepEqual(
  mergePublicProfileMetadata(
    { analyticsTag: 'keep-me', nested: { preserved: true }, stageName: 'Old name' },
    { stageName: 'New name', primaryRole: 'musician' }
  ),
  {
    analyticsTag: 'keep-me',
    nested: { preserved: true },
    stageName: 'New name',
    primaryRole: 'musician'
  }
);
assert.deepEqual(
  mergePublicProfileMetadata(
    { analyticsTag: 'keep-me', stageName: 'Old name', primaryRole: 'dj' },
    { stageName: null, primaryRole: 'host' }
  ),
  { analyticsTag: 'keep-me', primaryRole: 'host' }
);

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

const linksWithSuppressedDomain = normalizePublicProfileLinks([
  { label: 'Dead website', url: 'https://djthreeex.com', kind: 'booking' },
  { label: 'Published interview', url: 'https://example.com/interview', kind: 'press' }
]);
assert.equal(linksWithSuppressedDomain.error, null);
assert.deepEqual(linksWithSuppressedDomain.links.map((link) => link.label), ['Published interview']);

assert.match(normalizePublicProfileLinks([{ url: 'https://example.com' }]).error || '', /needs a label/);
assert.match(normalizePublicProfileLinks([{ label: 'Bad', url: 'javascript:alert(1)' }]).error || '', /valid http or https URL/);
assert.match(
  normalizePublicProfileLinks(Array.from({ length: 13 }, (_, index) => ({ label: `Link ${index}`, url: `https://example.com/${index}` }))).error || '',
  /up to 12 links/
);

const featuredMedia = normalizePublicProfileFeaturedMedia([
  {
    title: 'Corey Mack live',
    description: 'Beatbox cover',
    url: 'https://www.youtube.com/watch?v=--7MMybc6Vw'
  }
]);
assert.equal(featuredMedia.error, null);
assert.equal(featuredMedia.media[0].kind, 'youtube');
assert.equal(featuredMedia.media[0].embedUrl, 'https://www.youtube-nocookie.com/embed/--7MMybc6Vw?rel=0&modestbranding=1');
assert.match(normalizePublicProfileFeaturedMedia([{ title: 'Bad', url: 'https://example.com/video' }]).error || '', /valid YouTube video URL/);

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
