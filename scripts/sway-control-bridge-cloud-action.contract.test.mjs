import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const sessionStore = readFileSync(join(root, 'src/server/performer-session-store.ts'), 'utf8');
const talentDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

for (const term of [
  'function readBearerTokenHeader',
  'readCookieHeaderValue(req, cookieName) ?? readBearerTokenHeader(req)',
  'req.headers.authorization'
]) {
  if (!sessionStore.includes(term)) {
    failures.push(`Performer session store missing bearer-auth term: ${term}`);
  }
}

for (const term of [
  "app.post('/api/talent/control-bridge/action/:action'",
  'CONTROL_BRIDGE_ACTIONS',
  "'toggle-requests'",
  "'fulfill-top'",
  "'hide-top'",
  "'approve-pending'",
  "'veto-pending'",
  "'open-top-source'",
  "'search-top-spotify'",
  "'search-top-soundcloud'",
  "'search-top-youtube'",
  'async function applyWindowToggle',
  'async function applyRequestTriage',
  'async function applyRequestFulfill',
  'async function applyRequestHide',
  'function topApprovedRoomRequest',
  'function topPendingRoomRequest',
  'nextOpen: !roomState.session.requestsOpen',
  'No approved request is available.',
  'No pending request is available.'
]) {
  if (!server.includes(term)) {
    failures.push(`Control bridge cloud action route missing term: ${term}`);
  }
}

for (const term of [
  'transport: \'direct-cloud\'',
  'Authorization: `Bearer',
  '/api/talent/control-bridge/action',
  'localBridgeFallback',
  'bridgeToken',
  'bridgeSwayUrl'
]) {
  if (!talentDashboard.includes(term)) {
    failures.push(`Talent dashboard missing direct-cloud preset term: ${term}`);
  }
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
if (!testContracts.includes('node scripts/sway-control-bridge-cloud-action.contract.test.mjs')) {
  failures.push('test:contracts must include the control bridge cloud action contract.');
}

if (failures.length) {
  console.error('Sway control bridge cloud action contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway control bridge cloud action contract passed.');
