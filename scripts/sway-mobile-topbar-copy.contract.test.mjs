import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const patronSource = fs.readFileSync(path.join(root, 'src', 'shells', 'PatronApp.tsx'), 'utf8');
const talentSource = fs.readFileSync(path.join(root, 'src', 'shells', 'TalentApp.tsx'), 'utf8');

const failures = [];

if (!patronSource.includes('showHeader={false}')) {
  failures.push('Patron mobile room must use the top bar as its single visible room heading.');
}

for (const banned of ['Gig route:', 'Performer link:']) {
  if (patronSource.includes(banned)) {
    failures.push(`Patron mobile top bar must not expose technical route copy: ${banned}`);
  }
}

if (!patronSource.includes('`${LIVE_ROOM_ACTION_LIST} live`')) {
  failures.push('Patron mobile top bar must orient patrons with Request, Tip, and Boost language.');
}

if (talentSource.includes('Now Playing, Pending Requests, Approved Queue, Controls, and Room State')) {
  failures.push('Performer mobile top bar must not use the dense feature-list descriptor.');
}

if (!talentSource.includes('Live Rooms, music, files, and account')) {
  failures.push('Performer mobile top bar must orient performers across the complete performer app.');
}

if (failures.length > 0) {
  console.error('Mobile top-bar copy contract failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Mobile top-bar copy contract passed.');
