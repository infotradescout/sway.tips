import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];
const patronApp = readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(message);
}

function requireExcludes(source, term, message) {
  if (source.includes(term)) failures.push(message);
}

// The pure decision function must exist and stay exported so it is
// unit-testable without rendering JSX or adding a DOM-testing dependency.
requireIncludes(
  patronApp,
  'export function resolvePatronRoomRecoveryBranch',
  'PatronApp.tsx must keep resolvePatronRoomRecoveryBranch as a pure, exported, unit-testable decision function.'
);

// A transport exception must resolve to its own branch, not be folded into
// the confirmed-missing check.
requireIncludes(
  patronApp,
  "if (input.roomLookup.status === 'error') return 'connection-error';",
  'resolvePatronRoomRecoveryBranch must resolve a transport error to its own connection-error branch.'
);
requireExcludes(
  patronApp,
  "roomLookup.status === 'error' ||",
  'PatronApp.tsx must not re-fold roomLookup.status === \'error\' back into the no-session OR-clause.'
);

// The three render flags must all be derived from the single decision
// function -- one source of truth, not three independently-drifting checks.
for (const term of [
  "const shouldShowEndedRoomRecovery = recoveryBranch === 'ended';",
  "const shouldShowConnectionRecovery = recoveryBranch === 'connection-error';",
  "const shouldShowNoSessionRecovery = recoveryBranch === 'no-session';"
]) {
  requireIncludes(patronApp, term, `PatronApp.tsx render flags must derive from resolvePatronRoomRecoveryBranch: missing "${term}"`);
}

// Render branch must exist and stay ordered before the no-session branch so
// a transport error never falls through to the terminal recovery screen.
const endedIndex = patronApp.indexOf('shouldShowEndedRoomRecovery ? (');
const connectionIndex = patronApp.indexOf('shouldShowConnectionRecovery ? (');
const noSessionIndex = patronApp.indexOf('shouldShowNoSessionRecovery ? (');
if (endedIndex === -1 || connectionIndex === -1 || noSessionIndex === -1) {
  failures.push('PatronApp.tsx must render distinct ended, connection-error, and no-session branches.');
} else if (!(endedIndex < connectionIndex && connectionIndex < noSessionIndex)) {
  failures.push('PatronApp.tsx must check ended, then connection-error, then no-session, in that order, so an error never falls through to the terminal recovery screen.');
}

// The connection-error UI copy must be truthful (non-terminal) and must not
// reuse the terminal "Room not found" messaging or its "get a new QR" advice.
const connectionRecoveryStart = patronApp.indexOf('function PatronConnectionRecovery');
const connectionRecoveryEnd = patronApp.indexOf('export default function PatronApp');
const connectionRecoverySource = connectionRecoveryStart >= 0 && connectionRecoveryEnd > connectionRecoveryStart
  ? patronApp.slice(connectionRecoveryStart, connectionRecoveryEnd)
  : '';

if (!connectionRecoverySource) {
  failures.push('PatronApp.tsx must define a PatronConnectionRecovery component ahead of the default export.');
}

requireIncludes(connectionRecoverySource, 'Connection interrupted', 'PatronConnectionRecovery must show a truthful, non-terminal "Connection interrupted" heading.');
requireIncludes(connectionRecoverySource, 'reconnect', 'PatronConnectionRecovery must explain that Sway is trying to reconnect automatically.');

for (const forbidden of [
  'Room not found',
  'fresh QR code',
  'scan again',
  'does not exist',
  "doesn't exist"
]) {
  requireExcludes(connectionRecoverySource, forbidden, `PatronConnectionRecovery must not claim the room is missing/gone: forbidden phrase "${forbidden}"`);
}

// The connection-error state must never expose paid actions -- it must not
// render PatronView/SplitViewShell or wire any of the request/tip/boost
// handlers.
for (const forbidden of [
  'PatronView',
  'SplitViewShell',
  'onCreateRequest',
  'onBoostRequest',
  'postJson'
]) {
  requireExcludes(connectionRecoverySource, forbidden, `PatronConnectionRecovery must not expose paid actions or state mutation: found "${forbidden}"`);
}

// This lane must stay separate from the queued CTA-removal lane: the
// no-session recovery screen's existing Scan/Create account/Login CTAs must
// be untouched by this change.
for (const term of ['Scan', 'Create account', 'Login', "href=\"/talent/signup\"", "href=\"/talent/login\""]) {
  requireIncludes(patronApp, term, `PatronNoSessionRecovery CTAs must remain untouched by this lane: missing "${term}"`);
}

// The room-entry-viewed telemetry effect must not fire during a transport
// error (it previously could not fire during 'error' only because 'error'
// was folded into shouldShowNoSessionRecovery; that guard must be replaced
// with an explicit check now that the OR-clause no longer covers 'error').
const roomEntryEffectStart = patronApp.indexOf("sendRoomEntryViewed({");
const roomEntryGuardSource = roomEntryEffectStart >= 0 ? patronApp.slice(Math.max(0, roomEntryEffectStart - 400), roomEntryEffectStart) : '';
requireIncludes(
  roomEntryGuardSource,
  'shouldShowConnectionRecovery',
  'room_entry_viewed telemetry must stay gated off shouldShowConnectionRecovery so a transport error never counts as a confirmed room entry.'
);

// Hook order must remain stable: no hook may move behind either early return.
const useEffectIndex = patronApp.indexOf('useEffect(() => {');
const performerReturnIndex = patronApp.indexOf("if (route.name === 'performer') return");
const loadingReturnIndex = patronApp.indexOf('if (isLoading) return <LoadingState />;');
if (useEffectIndex === -1 || performerReturnIndex === -1 || loadingReturnIndex === -1) {
  failures.push('PatronApp.tsx must keep its useEffect hooks and both early returns.');
} else if (!(useEffectIndex < performerReturnIndex && performerReturnIndex < loadingReturnIndex)) {
  failures.push('PatronApp.tsx must keep both useEffect hooks before both early returns; hook order must stay unconditional and stable.');
}

// Scope boundary: this lane must not touch payment/schema/auth/admin surfaces.
for (const forbidden of ['stripe', 'Stripe', 'payment_intent', 'DATABASE_URL', 'drizzle', 'admin', 'operator', 'claim', 'moderation.']) {
  requireExcludes(connectionRecoverySource, forbidden, `Connection-recovery addition must not expand into forbidden scope: ${forbidden}`);
}

requireIncludes(packageJson, 'node scripts/sway-patron-room-lookup-transient-error-state.contract.test.mjs', 'package.json must register the patron room lookup transient error state contract.');

if (!failures.length) {
  const behavior = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sway-patron-room-lookup-transient-error-state.behavior.test.ts'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (behavior.status !== 0) {
    failures.push(`Patron room lookup transient error state behavior test failed:\n${behavior.stdout || ''}${behavior.stderr || ''}`);
  }
}

if (failures.length) {
  console.error('Patron room lookup transient error state contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Patron room lookup transient error state contract passed.');
