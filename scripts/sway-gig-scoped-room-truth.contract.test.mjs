import { readFileSync } from 'node:fs';

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const storeSource = readFileSync(new URL('../src/server/business-store.ts', import.meta.url), 'utf8');
const patronSource = readFileSync(new URL('../src/shells/PatronApp.tsx', import.meta.url), 'utf8');
const overlaySource = readFileSync(new URL('../src/shells/OverlayApp.tsx', import.meta.url), 'utf8');
const sharedSource = readFileSync(new URL('../src/shells/shared.tsx', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../package.json', import.meta.url), 'utf8');

const failures = [];

if (!serverSource.includes('app.get("/api/state/:gigId"')) {
  failures.push('server.ts must expose a gig-scoped state route at /api/state/:gigId.');
}

for (const term of [
  'const roomSnapshot = await loadRoomState(requestedGigId);',
  "if (roomSnapshot.roomStatus === 'missing')",
  "if (roomSnapshot.roomStatus === 'ended')",
  "if (roomSnapshot.roomStatus !== 'active')",
  "room_lookup: 'ended'",
  "room_lookup: 'active'"
]) {
  if (!serverSource.includes(term)) {
    failures.push(`Gig-scoped state route missing required room truth behavior: ${term}`);
  }
}

if (!storeSource.includes('hydrateStateByGigId') || !storeSource.includes('restoreSnapshotForGig')) {
  failures.push('Business store must hydrate gig-scoped room state without a singleton active-room gate.');
}

if (!patronSource.includes('const statePath = routeGigId ? `/api/state/${routeGigId}` : null;')) {
  failures.push('PatronApp.tsx must derive a gig-scoped state path from the route gigId.');
}

if (!patronSource.includes("const { bState, isLoading, setBState, roomLookup } = useSwayState({ statePath });")) {
  failures.push('PatronApp.tsx must fetch room state through the gig-scoped shared hook.');
}

if (!overlaySource.includes("statePath: routeGigId ? `/api/state/${routeGigId}` : null")) {
  failures.push('OverlayApp.tsx must fetch room state through the exact route gigId.');
}

if (!overlaySource.includes("if (roomLookup.status !== 'active') return <JoinLiveRoomRecovery />;")) {
  failures.push('OverlayApp.tsx must fail closed instead of rendering another room state.');
}

if (!sharedSource.includes('statePath?: string | null;')) {
  failures.push('Shared room-state hook must accept a gig-scoped state path.');
}

if (!sharedSource.includes("if (!statePath) {")) {
  failures.push('Shared room-state hook must gracefully fall back when no gig-scoped path exists.');
}

if (!sharedSource.includes('This live room session has ended. Thank you for supporting the performer!')) {
  failures.push('Ended room copy must exist exactly in the shared recovery shell.');
}

if (!sharedSource.includes('Join a Live Room')) {
  failures.push('Invalid room lookups must fail closed into the Join a Live Room recovery shell.');
}

if (patronSource.includes("const { bState, isLoading, setBState } = useSwayState();")) {
  failures.push('PatronApp.tsx must not rely only on the global state hook for gig routes.');
}

if (overlaySource.includes("const { bState, isLoading } = useSwayState();")) {
  failures.push('OverlayApp.tsx must not rely only on the global state hook for gig routes.');
}

if (!packageSource.includes('"check": "npm run lint"')) {
  failures.push('package.json must register npm run check for lane validation.');
}

if (!packageSource.includes('scripts/sway-gig-scoped-room-truth.contract.test.mjs')) {
  failures.push('package.json must register the gig-scoped room truth contract in test:contracts.');
}

for (const forbidden of ['drizzle', 'migration', 'stripe-signature', 'client_secret', 'QrCode', 'marketplace', 'Serato']) {
  if (sharedSource.includes(forbidden) || patronSource.includes(forbidden) || overlaySource.includes(forbidden)) {
    failures.push(`Gig-scoped room truth lane must not expand into forbidden area: ${forbidden}`);
  }
}

if (failures.length > 0) {
  console.error('Gig-scoped room truth contract failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Gig-scoped room truth contract passed.');
