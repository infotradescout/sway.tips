import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const publicShell = readFileSync(join(root, 'shells/public.html'), 'utf8');
const failures = [];

function requireIncludes(term, label = term) {
  if (!publicShell.includes(term)) {
    failures.push(`Public product preview missing: ${label}`);
  }
}

for (const term of [
  'Pre-Production MVP Surface',
  'Preview layout, not live data',
  'product preview layout, not live production data',
  'Real-money payments are not live yet.',
  'Sway live ladder',
  'Fan view',
  'Performer console',
  'Venue screen',
  'This public page does not execute live payments',
  'grant admin authority',
  'enforce live moderation',
  'present fixture users/events as production truth'
]) {
  requireIncludes(term);
}

for (const forbidden of [
  'sway-demo-fixtures.json',
  'fixtureSource',
  'demo-fixture-harness',
  'demo_'
]) {
  if (publicShell.includes(forbidden)) {
    failures.push(`Public product preview must not reference demo fixture payload: ${forbidden}`);
  }
}

if (failures.length) {
  console.error('Public product preview contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Public product preview contract passed.');
