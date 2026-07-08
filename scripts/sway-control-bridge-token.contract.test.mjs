import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const sessionStore = readFileSync(join(root, 'src/server/performer-session-store.ts'), 'utf8');
const talentDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

for (const term of [
  "app.post('/api/talent/control-bridge/token'",
  'resolveProtectedMutationActor(req, res, parseDurableGigId(req.body?.gig_id))',
  'Control bridge token issuance requires durable session persistence.',
  'ttlHours: 2',
  "eventType: 'performer_control_bridge.token.issue'",
  "tokenTransport: 'bridge_auth_token'",
  'bridgeToken: bridgeSession.token',
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
  'Local bridge token',
  '/api/talent/control-bridge/token',
  'setBridgeCommand',
  'bridgeTokenStatus',
  'Create a short-lived token for Stream Deck, Companion, or scripts.'
]) {
  if (!talentDashboard.includes(term)) {
    failures.push(`Talent dashboard missing bridge token UX term: ${term}`);
  }
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

if (failures.length) {
  console.error('Sway control bridge token contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway control bridge token contract passed.');
