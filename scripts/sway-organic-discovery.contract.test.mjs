import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const client = readFileSync(join(root, 'src/shells/frictionClient.ts'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

for (const term of [
  '<link rel="canonical"',
  'application/ld+json',
  "'@type': 'Person'",
  "'@type': 'Event'",
  "'@type': 'MusicAlbum'",
  "app.get('/robots.txt'",
  "app.get('/llms.txt'",
  "app.get('/sitemap.xml'",
  "nullif(trim(${performers.bio}), '') is not null",
  "'platynum-47'",
  'isDiscoveryEligibleHandle(row.handle)',
  'performer_profile_claim_started',
  'guest_to_performer_started',
  'public_profile_shared',
  'public_event_shared',
  'public_release_shared',
  'structuredData: overrides.structuredData',
  'discoveryFacts: overrides.discoveryFacts',
  'sway-discovery-first-response',
  'function renderDiscoveryBodyHtml',
  'function canonicalPublicUrl',
  "ne(musicReleases.distributionMode, 'private')",
  'Canonical discovery host',
  'discovery_landing',
  'discovery_entity_view',
  'discovery_primary_action'
]) {
  if (!server.includes(term)) failures.push(`Organic discovery implementation missing: ${term}`);
}

for (const event of [
  'performer_profile_claim_started',
  'guest_to_performer_started',
  'public_profile_shared',
  'public_event_shared',
  'public_release_shared',
  'discovery_landing',
  'discovery_entity_view',
  'discovery_primary_action'
]) {
  if (!client.includes(event)) failures.push(`Acquisition telemetry client missing: ${event}`);
}

// App-shell crawler files are a hard failure.
if (server.includes("app.get('/robots.txt'") && !server.includes("res.type('text/plain')")) {
  failures.push('robots.txt must return text/plain, not an app shell.');
}
if (server.includes("app.get('/sitemap.xml'") && !server.includes("res.type('application/xml')")) {
  failures.push('sitemap.xml must return application/xml, not an app shell.');
}

// Public entity pages must put identity facts in the first HTML response.
if (!server.includes('<h1>${escapeDiscoveryHtmlText(facts.heading)}</h1>')) {
  failures.push('First-response discovery HTML must include a real H1.');
}
if (!server.includes('data-discovery="entity-name"')) {
  failures.push('First-response discovery HTML must include entity name.');
}
if (!server.includes('data-discovery="primary-action"')) {
  failures.push('First-response discovery HTML must include primary action.');
}

if (!(packageJson.scripts?.['test:contracts'] || '').includes('sway-organic-discovery.contract.test.mjs')) {
  failures.push('test:contracts must include the organic discovery contract.');
}

if (failures.length) {
  console.error('Sway organic discovery contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway organic discovery contract passed.');
