import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

function requireIncludes(label, source, terms) {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${label} missing live-night spine term: ${term}`);
  }
}

function requireExcludes(label, source, terms) {
  for (const term of terms) {
    if (source.includes(term)) failures.push(`${label} must not expose first-use sludge term: ${term}`);
  }
}

const talentDashboard = read('src/components/TalentDashboard.tsx');
const patronView = read('src/components/PatronView.tsx');
const overlayApp = read('src/shells/OverlayApp.tsx');
const victoryScreen = read('src/components/VictoryScreen.tsx');
const talentApp = read('src/shells/TalentApp.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
const sharedShell = read('src/shells/shared.tsx');
const app = read('src/App.tsx');

requireIncludes('TalentDashboard', talentDashboard, [
  "useState<'live' | 'share' | 'settings'>('live')",
  "useState(true)",
  'Start room',
  'Show QR',
  "Tonight's money settings",
  'Earnings tonight',
  'Approve, deny, complete'
]);

requireExcludes('TalentDashboard first-use/mobile path', talentDashboard, [
  "useState<'live' | 'share' | 'settings' | 'hardware'>('live')",
  "{ id: 'hardware'",
  "mobilePanel === 'hardware'",
  'Hardware Controls',
  'Before You Share',
  'crowd autopilot rank clean requests into up next',
  'Pause, hide, or veto stays available as the safety brake',
  'Performance Meter'
]);

requireIncludes('PatronView', patronView, [
  "setActiveTab('request')",
  "setActiveTab('tip')",
  "setActiveTab('queue')",
  'Sent. Status: Pending.',
  'Sway will show Pending until the performer and payment outcome are confirmed.'
]);

requireExcludes('PatronView primary path', patronView, [
  'Browse Performers',
  "setActiveTab('discover')",
  'Discover other live performers near you',
  'Hide lyrics',
  'Looking up lyrics',
  "fetch(`/api/lyrics?${params}`)"
]);

requireExcludes('OverlayApp default', overlayApp, [
  'Hide lyrics',
  'Looking up lyrics',
  "fetch(`/api/lyrics?${params}`)",
  'useLyrics'
]);

requireIncludes('OverlayApp', overlayApp, [
  'Request / Tip / Boost',
  'Scan to open this Sway live room',
  'Tips flowing in',
  'Boosts'
]);

requireIncludes('VictoryScreen', victoryScreen, [
  'Night recap',
  'Fulfilled requests',
  '{session.totals.totalCount} Requests'
]);

requireExcludes('VictoryScreen', victoryScreen, [
  'no card was charged',
  '{session.totals.totalCount} Gigs'
]);

for (const [label, source] of [
  ['TalentApp', talentApp],
  ['PatronApp', patronApp],
  ['Shared shell', sharedShell],
  ['Legacy App', app]
]) {
  requireExcludes(label, source, [
    'Sway Talent',
    'Patron App',
    'Selected gig inspector',
    'Synchronizing Sway live ledger'
  ]);
}

if (failures.length) {
  console.error('Sway live-night spine contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway live-night spine contract passed.');
