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
  'performer_profile_claim_started',
  'guest_to_performer_started',
  'public_profile_shared',
  'public_event_shared',
  'public_release_shared'
]) {
  if (!server.includes(term)) failures.push(`Organic discovery implementation missing: ${term}`);
}

for (const event of [
  'performer_profile_claim_started',
  'guest_to_performer_started',
  'public_profile_shared',
  'public_event_shared',
  'public_release_shared'
]) {
  if (!client.includes(event)) failures.push(`Acquisition telemetry client missing: ${event}`);
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
