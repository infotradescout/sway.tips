import { readFileSync } from 'node:fs';

const patronSource = readFileSync(new URL('../src/shells/PatronApp.tsx', import.meta.url), 'utf8');
const sharedSource = readFileSync(new URL('../src/shells/shared.tsx', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

const failures = [];
const recoveryStart = patronSource.indexOf('function PatronNoSessionRecovery');
const recoveryEnd = patronSource.indexOf('export default function PatronApp');
const recoverySource = recoveryStart >= 0 && recoveryEnd > recoveryStart
  ? patronSource.slice(recoveryStart, recoveryEnd)
  : '';

const useEffectIndex = patronSource.indexOf('useEffect(() => {');
const loadingReturnIndex = patronSource.indexOf('if (isLoading) return <LoadingState />;');

if (useEffectIndex === -1) {
  failures.push('PatronApp.tsx must keep a useEffect hook for no-session recovery telemetry.');
}

if (loadingReturnIndex === -1) {
  failures.push('PatronApp.tsx must still render LoadingState while room lookup is in progress.');
}

if (useEffectIndex !== -1 && loadingReturnIndex !== -1 && useEffectIndex > loadingReturnIndex) {
  failures.push('PatronApp.tsx must not place useEffect after the loading early return; hook order must stay stable.');
}

if (!patronSource.includes('if (isLoading || !shouldShowNoSessionRecovery) return;')) {
  failures.push('PatronApp.tsx must gate recovery telemetry until loading completes.');
}

if (!patronSource.includes('Scan')) {
  failures.push('PatronApp.tsx must render a visible Scan recovery CTA for invalid /g/:gigId routes.');
}

// Removed by ux/patron-room-not-found-auth-cta-removal: a patron whose room
// link failed to resolve must not be offered performer claim/authentication
// as the recovery path from a public audience surface.
for (const forbidden of ['Create account', 'href="/talent/signup"', 'href="/talent/login"']) {
  if (recoverySource.includes(forbidden)) {
    failures.push(`PatronNoSessionRecovery must not route patrons into performer auth flows: found "${forbidden}"`);
  }
}

if (!patronSource.includes("const statePath = routeGigId ? `/api/state/${routeGigId}` : null;")) {
  failures.push('PatronApp.tsx must keep invalid /g/:gigId from relying on active room state by deriving a gig-scoped state path.');
}

if (!patronSource.includes("roomLookup.status === 'missing'")) {
  failures.push('PatronApp.tsx must keep invalid room recovery bound to fail-closed room lookup state.');
}

if (!sharedSource.includes('This live room session has ended. Thank you for supporting the performer!')) {
  failures.push('Ended-room copy must remain exact in the shared recovery shell.');
}

for (const forbidden of ['stripe', 'payment_intent', 'QrCode', 'moderation.block', 'admin', 'operator', 'marketplace', 'Serato', 'AI']) {
  if (recoverySource.includes(forbidden)) {
    failures.push(`Invalid patron room recovery hotfix must not expand into forbidden scope: ${forbidden}`);
  }
}

if (!packageSource.includes('scripts/sway-invalid-patron-room-recovery.contract.test.mjs')) {
  failures.push('package.json must register the invalid patron room recovery contract.');
}

if (failures.length > 0) {
  console.error('Invalid patron room recovery contract failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Invalid patron room recovery contract passed.');
