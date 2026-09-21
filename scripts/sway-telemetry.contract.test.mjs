import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const patronApp = readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8');
const telemetryClient = readFileSync(join(root, 'src/shells/frictionClient.ts'), 'utf8');
const trafficTruth = readFileSync(join(root, 'src/traffic-truth.ts'), 'utf8');
const trafficTruthRequest = readFileSync(join(root, 'src/server/traffic-truth-request.ts'), 'utf8');
const trafficTruthClient = readFileSync(join(root, 'src/shells/trafficTruthClient.ts'), 'utf8');
const accessControl = readFileSync(join(root, 'src/server/access-control.ts'), 'utf8');
const observatoryStore = readFileSync(join(root, 'src/server/discovery-observatory-store.ts'), 'utf8');
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
  'build_commit',
  'attribution_channel',
  'entity_kind'
]) {
  requireIncludes(server, `'${key}'`, `Server telemetry allowlist missing key: ${key}`);
  requireIncludes(telemetryClient, `'${key}'`, `Client telemetry allowlist missing key: ${key}`);
}

for (const eventName of [
  'discovery_landing',
  'discovery_entity_view',
  'discovery_primary_action'
]) {
  requireIncludes(server, eventName, `Missing discovery telemetry event in server.ts: ${eventName}`);
  requireIncludes(telemetryClient, eventName, `telemetryClient must allow discovery event: ${eventName}`);
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

for (const term of [
  "'human_candidate'",
  "'known_bot'",
  "'scanner'",
  "'qa_automation'",
  'projectHumanTrafficAuditRows',
  'isScannerTrafficPath',
  'SWAY_TRAFFIC_TRUTH_VERSION'
]) {
  requireIncludes(trafficTruth, term, `Traffic truth core contract missing: ${term}`);
}

for (const term of [
  'classifyBrowserTraffic',
  "'X-Sway-Traffic-Class'",
  'getOrCreateDiscoveryJourneyId()'
]) {
  requireIncludes(telemetryClient, term, `Telemetry client must attach traffic truth without replacing journey evidence: ${term}`);
}

for (const term of [
  'navigator.webdriver',
  "hostname === 'localhost'",
  "url.searchParams.get('sway_qa') === '1'"
]) {
  requireIncludes(trafficTruthClient, term, `Browser traffic classifier missing QA protection: ${term}`);
}

for (const term of [
  'applyTrafficTruthToTelemetryRequest',
  'shouldHard404ScannerRequest',
  "'X-Robots-Tag': 'noindex, nofollow'",
  "'X-Content-Type-Options': 'nosniff'",
  ".send('Not found.')"
]) {
  requireIncludes(accessControl, term, `Global request guard missing traffic-truth enforcement: ${term}`);
}

for (const term of [
  'encodeTrafficTruthSource',
  "value === 'known_bot' || value === 'scanner' || value === 'qa_automation'",
  "normalizeTrafficPath(req.path || req.originalUrl || '/') !== '/api/analytics/shell'",
  'SWAY_TRAFFIC_TRUTH_QA_IPS'
]) {
  requireIncludes(trafficTruthRequest, term, `Server traffic classifier missing fail-closed protection: ${term}`);
}

for (const term of [
  "'boost_started'",
  'projectHumanTrafficAuditRows(rawRows)',
  'return projection.rows'
]) {
  requireIncludes(observatoryStore, term, `Discovery observatory must use filtered traffic truth: ${term}`);
}

for (const forbidden of [
  'raw_user_agent',
  'user_agent',
  'ip_address',
  'x-forwarded-for:'
]) {
  if (trafficTruth.includes(forbidden) || trafficTruthClient.includes(forbidden)) {
    failures.push(`Traffic truth must not persist raw visitor identity data: ${forbidden}`);
  }
}

requireIncludes(
  packageJson.scripts?.['test:contracts'] ?? '',
  'node scripts/sway-telemetry.contract.test.mjs',
  'test:contracts must include the shell telemetry contract.'
);

if (!failures.length) {
  const behavior = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/sway-traffic-truth.behavior.test.ts'],
    { cwd: root, encoding: 'utf8' }
  );
  if (behavior.status !== 0) {
    failures.push(
      `Traffic-truth behavior contract failed.\n${behavior.stdout ?? ''}${behavior.stderr ?? ''}`
    );
  }
}

if (failures.length) {
  console.error('Sway telemetry contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway telemetry contract passed.');
