import assert from 'node:assert/strict';
import {
  normalizePublicProfileEmail,
  normalizePublicProfileLinks,
  normalizePublicProfilePhone,
  normalizePublicProfileSpecialties,
  normalizePublicProfileUrl
} from '../src/server/public-profile';
import {
  buildSwayPartnerTermsSnapshot,
  SWAY_PARTNER_TERMS_SNAPSHOT,
  SWAY_PARTNER_TERMS_VERSION
} from '../src/server/partner-entitlement';

assert.equal(normalizePublicProfileUrl('javascript:alert(1)'), null);
assert.equal(normalizePublicProfileUrl('ftp://example.com/file'), null);
assert.equal(normalizePublicProfileUrl('https://user:secret@example.com/'), null);
assert.equal(normalizePublicProfileUrl('https://example.com/path'), 'https://example.com/path');
assert.equal(normalizePublicProfileEmail(' BOOKING@Example.com '), 'booking@example.com');
assert.equal(normalizePublicProfileEmail('not-an-email'), null);
assert.equal(normalizePublicProfilePhone('(850) 555-0123'), '(850) 555-0123');
assert.equal(normalizePublicProfilePhone('123'), null);

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
assert.equal(firstSnapshot.publicProfileHostingFeeCents, 0);
assert.equal(firstSnapshot.performerSubscriptionFeeCents, 0);
assert.equal(firstSnapshot.paidInteractionPlatformFeeCents, 100);
assert.notEqual(firstSnapshot.externalChargesExcluded, secondSnapshot.externalChargesExcluded);
firstSnapshot.externalChargesExcluded.push('test-only mutation');
assert.equal(SWAY_PARTNER_TERMS_SNAPSHOT.externalChargesExcluded.includes('test-only mutation'), false);

console.log('Performer link profile behavior tests passed.');
