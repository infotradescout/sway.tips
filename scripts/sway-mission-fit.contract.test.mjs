import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

const patronView = read('src/components/PatronView.tsx');
const talentDashboard = read('src/components/TalentDashboard.tsx');
const talentApp = read('src/shells/TalentApp.tsx');
const performerShareKit = read('src/components/PerformerShareKit.tsx');

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
  "useState<'live' | 'share' | 'settings'>('live')",
  "Tonight's money settings",
  'Start room',
  'Show QR',
  'Approve, deny, complete',
  "Tonight's controls",
  'Pause intake',
  'Queue live',
  'Earnings tonight'
]) {
  if (!talentDashboard.includes(term)) {
    failures.push(`Performer live-night spine copy missing: ${term}`);
  }
}

for (const term of [
  'Crowd route',
  'Request scope',
  'Crowd can request; performer approves what moves forward.'
]) {
  if (!talentApp.includes(term)) {
    failures.push(`Talent shell room-state copy missing: ${term}`);
  }
}

for (const term of [
  '1. Start room',
  '2. Confirm scope',
  '3. Share QR',
  'Patron entry'
]) {
  if (!performerShareKit.includes(term)) {
    failures.push(`Performer share kit first-run copy missing: ${term}`);
  }
}

for (const forbidden of [
  'only pick the songs you have',
  'only choose songs you have',
  'guaranteed library match',
  'automatically plays',
  'Hardware Controls',
  "useState<'live' | 'share' | 'settings' | 'hardware'>('live')",
  'Before You Share',
  'crowd autopilot rank clean requests into up next'
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
