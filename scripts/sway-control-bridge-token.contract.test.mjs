import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const sessionStore = readFileSync(join(root, 'src/server/performer-session-store.ts'), 'utf8');
const talentDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];
const tokenRouteStart = server.indexOf("app.post('/api/talent/control-bridge/token'");
const tokenRouteEnd = server.indexOf('const CONTROL_BRIDGE_ACTIONS', tokenRouteStart);
const tokenRoute = tokenRouteStart >= 0 && tokenRouteEnd > tokenRouteStart
  ? server.slice(tokenRouteStart, tokenRouteEnd)
  : '';

for (const term of [
  "app.post('/api/talent/control-bridge/token'",
  'const actor = await resolveProtectedMutationActor(req, res, gigId)',
  'Control bridge token issuance requires durable session persistence.',
  'ttlHours: 6',
  "sessionType: 'control_bridge'",
  'gigId,',
  "eventType: 'performer_control_bridge.token.issue'",
  "tokenTransport: 'bridge_auth_token'",
  'bridgeToken: bridgeSession.token',
  'buildWindowsBoothLauncher({',
  'windowsLauncher,',
  "availableLaunchers: ['windows_cmd_v1']",
  'resolvePerformerLoginBaseUrl(process.env)',
  "tokenTransport: 'auth-token'",
  'command: bridgeCommand'
]) {
  if (!server.includes(term)) {
    failures.push(`Control bridge token route missing term: ${term}`);
  }
}

for (const term of [
  'ttlHours?: number | null',
  'Math.min(Math.floor(ttlHours), sessionTtlHours)'
]) {
  if (!sessionStore.includes(term)) {
    failures.push(`Performer session store missing bridge TTL term: ${term}`);
  }
}

for (const term of [
  'Booth connection',
  '/api/talent/control-bridge/token',
  'setBridgeCommand',
  'setWindowsBoothLauncher',
  'bridgeTokenStatus',
  'Create a six-hour connection for VirtualDJ, Stream Deck, or Companion.',
  'Replace connection',
  'data-sway-windows-booth-download="true"',
  'Download Sway Booth for Windows',
  'Advanced Stream Deck / Companion setup',
  'buildDashboardBridgePreset',
  'downloadBase64File',
  'downloadJsonFile',
  'data-sway-control-bridge-preset-download="true"',
  'Download button preset',
  'sway-dashboard-control-bridge-preset.v1',
  'sway-control-bridge-${safeGigId}.json'
]) {
  if (!talentDashboard.includes(term)) {
    failures.push(`Talent dashboard missing bridge token UX term: ${term}`);
  }
}

if (tokenRoute.includes('req.headers.origin') || tokenRoute.includes("req.get('host')")) {
  failures.push('Control bridge launchers must not derive their token destination from caller-controlled Origin/Host headers.');
}

for (const forbidden of [
  'authCookie:',
  'auth_cookie',
  'SWAY_CONTROL_AUTH_COOKIE',
  'document.cookie'
]) {
  if (server.includes(forbidden) || talentDashboard.includes(forbidden)) {
    failures.push(`Bridge token route/UI must not expose browser cookie material: ${forbidden}`);
  }
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
if (!testContracts.includes('node scripts/sway-control-bridge-token.contract.test.mjs')) {
  failures.push('test:contracts must include the control bridge token contract.');
}
if (!testContracts.includes('node scripts/sway-windows-booth-launcher.contract.test.mjs')) {
  failures.push('test:contracts must execute the Windows booth launcher behavior/security test.');
}

if (failures.length) {
  console.error('Sway control bridge token contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway control bridge token contract passed.');
