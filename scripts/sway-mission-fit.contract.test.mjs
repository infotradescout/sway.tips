import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

const patronView = read('src/components/PatronView.tsx');
const talentDashboard = read('src/components/TalentDashboard.tsx');

for (const term of [
  'Request scope',
  'DJ library requests',
  'Setlist requests',
  'Open request lane',
  'manual request',
  'The DJ decides what is approved and played.'
]) {
  if (!patronView.includes(term)) {
    failures.push(`Patron room mission copy missing: ${term}`);
  }
}

for (const term of [
  'Live Command Center',
  'operatorNextAction',
  'Open crowd view',
  'Before You Share',
  'Set the request scope',
  'Patrons can request, tip, or boost',
  'DJ decides',
  'Approve or Veto',
  'Pause Requests',
  'Mark Playing'
]) {
  if (!talentDashboard.includes(term)) {
    failures.push(`Performer mission control copy missing: ${term}`);
  }
}

for (const forbidden of [
  'only pick the songs you have',
  'only choose songs you have',
  'guaranteed library match',
  'automatically plays'
]) {
  if (patronView.includes(forbidden) || talentDashboard.includes(forbidden)) {
    failures.push(`Mission copy overpromises DJ library/control behavior: ${forbidden}`);
  }
}

if (failures.length) {
  console.error('Sway mission fit contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway mission fit contract passed.');
