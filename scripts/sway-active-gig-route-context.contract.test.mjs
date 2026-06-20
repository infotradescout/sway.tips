import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const types = readFileSync(join(root, 'src/types.ts'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const talentApp = readFileSync(join(root, 'src/shells/TalentApp.tsx'), 'utf8');
const talentDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const shared = readFileSync(join(root, 'src/shells/shared.tsx'), 'utf8');
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
const demo = readFileSync(join(root, 'src/demo-mode.tsx'), 'utf8');
const businessStore = readFileSync(join(root, 'src/server/business-store.ts'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');

for (const file of [
  { name: 'src/types.ts', source: types },
  { name: 'src/shells/shared.tsx', source: shared },
  { name: 'src/App.tsx', source: app },
  { name: 'src/demo-mode.tsx', source: demo },
  { name: 'src/server/business-store.ts', source: businessStore }
]) {
  if (!file.source.includes('activeGigId')) {
    failures.push(`${file.name} must include activeGigId route context plumbing.`);
  }
}

if (!types.includes('activeGigId: string | null;')) {
  failures.push('BackendState must declare activeGigId: string | null.');
}

for (const term of [
  'function createEmptyBackendState()',
  'function prepareRoomState(inputState: BackendState, gigId: string | null)',
  'async function loadRoomState(gigId: string)',
  'async function resolveLegacyWritableRoom(req: express.Request, res: express.Response)',
  'async function findRoomStateByRequestId(requestId: string)',
  'await businessStore.hydrateStateByGigId(gigId, createEmptyBackendState())',
  'activeGigId: talentAccess.allowed ? state.activeGigId : null'
]) {
  if (!server.includes(term)) {
    failures.push(`server.ts missing required active gig route context behavior: ${term}`);
  }
}

if (!businessStore.includes('hydrateStateByGigId') || !businessStore.includes('listTrackedGigIds')) {
  failures.push('Business store must expose gig-scoped hydration helpers for room isolation.');
}

if (!server.includes('res.json({') || !server.includes('session: state.session') || !server.includes('requests: state.requests') || !server.includes('performers: state.performers')) {
  failures.push('/api/state must explicitly serialize the allowlisted legacy state payload.');
}

const apiStateSection = server.slice(server.indexOf('app.get("/api/state"'), server.indexOf('app.post("/api/pending-action/reconcile"'));
for (const forbidden of ['buildMarker', 'paymentService', 'idempotencyStore', 'paymentProvider']) {
  if (apiStateSection.includes(forbidden)) {
    failures.push(`/api/state must not expose adjacent runtime field source: ${forbidden}`);
  }
}

for (const forbiddenField of [
  'buildMarker:',
  'paymentService:',
  'idempotencyStore:',
  'paymentProvider:',
  'actorId:',
  'sessionId:',
  'patronDeviceIdHash:'
]) {
  if (apiStateSection.includes(forbiddenField)) {
    failures.push(`/api/state must not serialize adjacent runtime field: ${forbiddenField}`);
  }
}

if (!talentApp.includes('const { activeGigId } = bState;') || !talentApp.includes('activeGigId={activeGigId}')) {
  failures.push('TalentApp must plumb activeGigId into TalentDashboard.');
}

if (!talentDashboard.includes('activeGigId: string | null;')) {
  failures.push('TalentDashboard must accept activeGigId route context.');
}

for (const forbidden of [
  'Copy Room Link',
  'Download QR',
  'Download QR Sign',
  'Share Your Room',
  'Connect Your Audience',
  '/room/',
  'QRCode',
  'qr-code',
  'qrcode'
]) {
  if (server.includes(forbidden) || talentApp.includes(forbidden) || talentDashboard.includes(forbidden) || types.includes(forbidden)) {
    failures.push(`Route-context lane must not introduce forbidden share-kit artifact: ${forbidden}`);
  }
}

if (!packageJson.includes('qrcode.react')) {
  failures.push('Performer room share completion must install qrcode.react for room-specific QR rendering.');
}

for (const qrTerm of ['react-qr', '@zxing', 'qr-image']) {
  if (packageJson.includes(qrTerm)) {
    failures.push(`No QR dependency may be added in this prerequisite lane: ${qrTerm}`);
  }
}

if (!packageJson.includes('node scripts/sway-active-gig-route-context.contract.test.mjs')) {
  failures.push('package.json must register the active gig route context contract in test:contracts.');
}

if (failures.length) {
  console.error('Active gig route context contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Active gig route context contract passed.');
