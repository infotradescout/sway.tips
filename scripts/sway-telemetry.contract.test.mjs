import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const patronApp = readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8');
const telemetryClient = readFileSync(join(root, 'src/shells/frictionClient.ts'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(message);
}

requireIncludes(server, 'app.post("/api/analytics/shell"', 'server.ts must mount POST /api/analytics/shell.');
requireIncludes(server, 'validateShellTelemetryPayload', 'server.ts must validate shell telemetry synchronously.');
requireIncludes(server, 'writeAuditEvent', 'server.ts must write shell telemetry through writeAuditEvent().');
requireIncludes(server, "entityType: 'shell_friction'", 'Shell telemetry must distinguish shell friction events in audit history.');

for (const eventName of [
  'telemetry_friction_patron_no_session_recovery_viewed',
  'telemetry_friction_patron_no_session_return_home_clicked'
]) {
  requireIncludes(server, eventName, `Missing approved telemetry event name in server.ts: ${eventName}`);
  requireIncludes(telemetryClient, eventName, `telemetryClient must allow approved telemetry event: ${eventName}`);
}

for (const helperName of [
  'sendPatronNoSessionRecoveryViewed',
  'sendPatronNoSessionReturnHomeClicked'
]) {
  requireIncludes(patronApp, helperName, `PatronApp must trigger approved telemetry helper: ${helperName}`);
  requireIncludes(telemetryClient, helperName, `telemetryClient must export helper: ${helperName}`);
}

for (const key of [
  'shell',
  'surface',
  'event',
  'route_family',
  'has_route_context',
  'has_session_context',
  'build_commit'
]) {
  requireIncludes(server, `'${key}'`, `Server telemetry allowlist missing key: ${key}`);
  requireIncludes(telemetryClient, `'${key}'`, `Client telemetry allowlist missing key: ${key}`);
}

for (const sensitiveKey of [
  'card',
  'cvc',
  'cvv',
  'pan',
  'token',
  'secret',
  'cookie',
  'authorization',
  'session',
  'jwt',
  'email',
  'phone',
  'name',
  'message',
  'note',
  'request',
  'query',
  'url',
  'headers',
  'device',
  'location',
  'latitude',
  'longitude',
  'amount',
  'payment',
  'stripe'
]) {
  requireIncludes(server, `'${sensitiveKey}'`, `Sensitive telemetry key must be rejected: ${sensitiveKey}`);
}

for (const term of [
  'Unexpected telemetry field rejected',
  'Sensitive telemetry field rejected',
  'Unknown shell telemetry event.'
]) {
  requireIncludes(server, term, `Server must explicitly reject invalid telemetry payloads: ${term}`);
}

for (const forbidden of ['segment', 'mixpanel', 'amplitude', 'posthog', 'gtag', 'analytics sdk']) {
  if (JSON.stringify(packageJson).toLowerCase().includes(forbidden)) {
    failures.push(`Third-party analytics package must not be introduced: ${forbidden}`);
  }
}

for (const term of [
  'export function sendFrictionEvent',
  'try {',
  "void fetch('/api/analytics/shell'",
  '.catch(() => {})',
  '} catch {'
]) {
  requireIncludes(telemetryClient, term, `telemetry client must remain non-throwing and non-blocking: ${term}`);
}

requireIncludes(
  packageJson.scripts?.['test:contracts'] ?? '',
  'node scripts/sway-telemetry.contract.test.mjs',
  'test:contracts must include the shell telemetry contract.'
);

if (failures.length) {
  console.error('Sway telemetry contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway telemetry contract passed.');
