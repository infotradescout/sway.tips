import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

const patronView = read('src/components/PatronView.tsx');
const talentDashboard = [
  read('src/components/TalentDashboard.tsx'),
  read('src/components/PerformerRoomShare.tsx'),
  read('src/components/PerformerAudienceScreen.tsx'),
  read('src/components/PerformerRoomSetup.tsx')
].join('\n');
const talentApp = read('src/shells/TalentApp.tsx');
const performerShareKit = read('src/components/PerformerShareKit.tsx');

for (const term of [
  'Live show snapshot',
  '<Sparkles className="h-4 w-4" /> Request',
  'Request scope',
  'DJ library requests',
  'Setlist song requests',
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
  'Step {step + 1} of 4',
  'Minimum request',
  'Direct tips remain available',
  'Create room',
  'Show QR',
  'Copy link',
  'Nothing enters the approved queue until you allow it',
  'Should song requests cost money tonight?',
  'Free requests',
  'Paid requests',
  'Share Room',
  'Scan to Request',
  'Pending',
  'Approved',
  'Backers'
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
  '1. Set room settings',
  '2. Create room',
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
  'Live Command Center',
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
