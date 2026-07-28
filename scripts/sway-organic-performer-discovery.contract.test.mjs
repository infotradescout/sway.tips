import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const seed = readFileSync(join(root, 'scripts/sway-seed-performer-previews.mjs'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

for (const required of [
  '<link rel="canonical"',
  'application/ld+json',
  "'@type': 'ProfilePage'",
  "'@type': 'Person'",
  'mainEntity.homeLocation',
  'mainEntity.knowsAbout',
  'data-sway-discovery-summary="performer-profile"',
  "app.get('/robots.txt'",
  "app.get('/sitemap.xml'",
  "app.get('/llms.txt'",
  'listPublicDiscoveryProfiles',
  '/api/public/performer/{handle}',
  'Only use facts present on the linked public page or API response.'
]) {
  assert.ok(server.includes(required), `Organic discovery contract is missing: ${required}`);
}

assert.ok(
  server.includes('isNull(performerProfilePreviews.claimedPerformerId)'),
  'Sitemap and AI index must not duplicate claimed previews.'
);
assert.ok(
  server.includes("notInArray(performers.onboardingStatus, ['suspended'])"),
  'Suspended performer pages must be excluded from discovery.'
);
assert.ok(
  server.includes('Allow: /api/public/'),
  'Public machine-readable profile and event facts must remain crawlable.'
);
assert.ok(
  server.includes('Disallow: /api/'),
  'Non-public APIs must remain excluded from crawling.'
);

assert.ok(
  seed.includes('https://www.youtube.com/watch?v=_KzoiR1RgrU')
    && seed.includes('Opening set from coreymack.us — the same showcase video on his site.'),
  'Corey Mack discovery must retain the verified website showcase video.'
);
assert.ok(
  seed.includes("handle: 'dj3x'") && seed.includes("city: 'Pensacola, FL'"),
  'DJ3X discovery must retain the curated performer and location facts.'
);

assert.match(
  packageJson.scripts['test:contracts'],
  /sway-organic-performer-discovery\.contract\.test\.mjs/,
  'Organic performer discovery contract must be wired directly into test:contracts.'
);

console.log('Sway organic performer discovery contract passed.');
