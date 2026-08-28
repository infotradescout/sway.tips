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
const performerRoomSetup = read('src/components/PerformerRoomSetup.tsx');
const performerRoomControls = read('src/components/PerformerRoomControls.tsx');
const patronView = read('src/components/PatronView.tsx');
const server = read('server.ts');
const overlayApp = read('src/shells/OverlayApp.tsx');
const victoryScreen = read('src/components/VictoryScreen.tsx');
const talentApp = read('src/shells/TalentApp.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
const sharedShell = read('src/shells/shared.tsx');
const app = read('src/App.tsx');

requireIncludes('TalentDashboard', talentDashboard, [
  "useState<'live' | 'share' | 'settings'>('live')",
  'resolveInactivePerformerWorkspace(window.location.pathname, window.location.hash)',
  'data-sway-performer-app-navigation="true"',
  'aria-label="Performer sections"',
  "inactiveWorkspace === 'home'",
  "inactiveWorkspace === 'room'",
  "inactiveWorkspace === 'shows'",
  "inactiveWorkspace === 'library'",
  "inactiveWorkspace === 'catalog'",
  "inactiveWorkspace === 'profile'",
  "inactiveWorkspace === 'account'",
  "onStartRoom={() => openInactiveWorkspace('room')}",
  "onOpenShows={() => openInactiveWorkspace('shows')}",
  'Start a Room',
  'LIVE_ROOM_LANGUAGE.shareRoom',
  "{ id: 'settings', label: LIVE_ROOM_LANGUAGE.controls }",
  'LIVE_ROOM_LANGUAGE.copyRoomLink',
  'Request library',
  'data-sway-library-workspace="true"',
  'Synced catalogs and external music sources used for audience requests.',
  'data-sway-audio-catalog="true"',
  'Audio catalog',
  'masters, beats, mixes, spoken word, audiobooks, demos',
  'data-sway-account-workspace="true"',
  'Payments & payout setup',
  "fetch('/api/payment/config'",
  "data?.mode === 'test'",
  'Money actions are unavailable because Stripe could not be verified. Free rooms remain available.',
  'Stripe test mode only. Test requests, tips, and boosts do not move real money or reach a bank.',
  'Backers',
  '<PerformerRoomSetup',
  'performerName={welcomePerformerName}'
]);

requireIncludes('PerformerRoomSetup', performerRoomSetup, [
  'data-sway-performer-room-setup="true"',
  "const steps = ['Pricing', 'Requests', 'Review', 'Start']",
  'Step {step + 1} of 4',
  'Create room',
  'Test paid requests',
  'Free requests',
  'My synced library',
  'Open requests',
  'Ready to go live',
  'disabled={!performerEmailVerified || isStarting}',
  'Stripe test mode — no real money moves',
  'globalThis.crypto.randomUUID()',
  'gig_id: string',
  "useState(false)",
  "role=\"alert\"",
  'Customers may still type a manual request',
  'No real money moves.'
]);

requireExcludes('PerformerRoomSetup account-identity questions', performerRoomSetup, [
  'Who is running this room tonight?',
  'Performer name',
  "(['DJ', 'Performer'] as const)"
]);

requireIncludes('Session start request scope', server, [
  'const { talentName, talentRole, feeType, minimumTip, paymentsEnabled, searchScope, gig_id } = req.body',
  "searchScope: (searchScope === 'catalog' ? 'catalog' : 'library') as 'catalog' | 'library'",
  'loadMatchingStartedRoom',
  "error.message === 'gig_session_state_revision_conflict'",
  'searchScope: roomState.session.searchScope'
]);

requireExcludes('TalentDashboard selectable request scopes', talentDashboard, [
  "['setlist', 'Set']"
]);

requireIncludes('PerformerRoomControls', performerRoomControls, [
  'data-sway-performer-room-controls="true"',
  'LIVE_ROOM_LANGUAGE.requestSource',
  "['library', 'Library']",
  "['catalog', 'Catalog']"
]);

requireExcludes('PerformerRoomControls selectable request scopes', performerRoomControls, [
  "['setlist', 'Set']"
]);

requireExcludes('TalentDashboard first-use/mobile path', talentDashboard, [
  '<div className="order-3 space-y-4">',
  "useState<'live' | 'share' | 'settings' | 'hardware'>('live')",
  "{ id: 'hardware'",
  "mobilePanel === 'hardware'",
  'Hardware Controls',
  'Live Command Center',
  'Before You Share',
  'crowd autopilot rank clean requests into up next',
  'Pause, hide, or veto stays available as the safety brake',
  'Performance Meter'
]);

requireIncludes('PatronView', patronView, [
  "useState<'home' | 'request' | 'tip' | 'queue' | 'discover'>('home')",
  'Live show snapshot',
  '<Sparkles className="h-4 w-4" /> Request',
  "setActiveTab('request')",
  "setActiveTab('tip')",
  "setActiveTab('queue')",
  "summaryLabel: 'BOOST SUMMARY'",
  "amountLabel: session.paymentsEnabled === false ? 'Upvote weight:' : 'Boost amount:'",
  "totalLabel: session.paymentsEnabled === false ? 'Upvote total:' : 'Total boost charge:'",
  'Sent. Status: {LIVE_ROOM_LANGUAGE.pending}.',
  'Sway will show Pending until the performer and payment outcome are confirmed.'
]);

requireIncludes('Runtime money mode', server, [
  'paymentsEnabled: liveRoomPaymentRuntimeConfig.moneyEnabled && requestedPaymentsEnabled && sellerMoneyReadiness.ready',
  'tipsEnabled: liveRoomPaymentRuntimeConfig.moneyEnabled && sellerMoneyReadiness.ready',
  "code: 'test_payment_runtime_unavailable'",
  "code: 'room_start_id_required'",
  'minimumTip: Math.max(5, Number(minimumTip) || 5)',
  'let amt = Math.max(Number(boostAmount) || 0, roomState.session.minimumTip)',
  'amt = 1'
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
  'LIVE_ROOM_ACTION_SLASH',
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
  '{session.totals.totalCount} Gigs',
  'Start New Gig Session',
  'GIG CLEARED SUCCESSFULLY'
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
