import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const patronApp = readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8');
const telemetryClient = readFileSync(join(root, 'src/shells/frictionClient.ts'), 'utf8');
const trafficTruthContract = readFileSync(join(root, 'src/traffic-truth-contract.ts'), 'utf8');
const trafficTruth = readFileSync(join(root, 'src/server/traffic-truth.ts'), 'utf8');
const accessControl = readFileSync(join(root, 'src/server/access-control.ts'), 'utf8');
const discoveryAttribution = readFileSync(join(root, 'src/shells/discoveryAttribution.ts'), 'utf8');
const discoveryObservatoryStore = readFileSync(join(root, 'src/server/discovery-observatory-store.ts'), 'utf8');
const trafficTruthRunbook = readFileSync(join(root, 'docs/process/SWAY_TRAFFIC_TRUTH_V1.md'), 'utf8');
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

requireIncludes(
  packageJson.scripts?.['test:contracts'] ?? '',
  'node scripts/sway-telemetry.contract.test.mjs',
  'test:contracts must include the shell telemetry contract.'
);

for (const classification of [
  'human_candidate',
  'known_bot',
  'scanner',
  'internal_qa',
  'platform_probe',
  'unknown_automation'
]) {
  requireIncludes(trafficTruth, `'${classification}'`, `Traffic Truth must preserve the ${classification} evidence class.`);
}

for (const crawlerSignal of [
  'googlebot',
  'gptbot',
  'oai-searchbot',
  'chatgpt-user',
  'facebookexternalhit',
  'applebot',
  'ahrefsbot',
  'mj12bot'
]) {
  requireIncludes(trafficTruth.toLowerCase(), crawlerSignal, `Traffic Truth must recognize crawler signal: ${crawlerSignal}`);
}

for (const scannerSignal of [
  "^\\/\\.env",
  "^\\/\\.git",
  'wp-admin',
  'xmlrpc',
  'wlwmanifest',
  'phpmyadmin',
  'etc\\/passwd'
]) {
  requireIncludes(trafficTruth, scannerSignal, `Traffic Truth must hard-classify scanner path signal: ${scannerSignal}`);
}

for (const privacyTerm of [
  "createHmac('sha256'",
  'SWAY_TRAFFIC_TRUTH_SALT',
  '.slice(0, 24)',
  "return null;",
  "console.info('[sway.traffic.truth]'"
]) {
  requireIncludes(trafficTruth, privacyTerm, `Traffic Truth privacy boundary missing: ${privacyTerm}`);
}

requireIncludes(trafficTruth, "const salt = env.SWAY_TRAFFIC_TRUTH_SALT?.trim() || '';", 'Traffic Truth must require a private salt before producing a visitor pseudonym.');
requireIncludes(trafficTruth, 'if (salt.length < 32) return null;', 'Traffic Truth must fail privacy-safe when its salt is unavailable or too short.');
requireIncludes(trafficTruth, 'dayBucket', 'Traffic Truth visitor pseudonyms must rotate by UTC day.');
requireIncludes(trafficTruth, 'blockAsScanner: true', 'Traffic Truth must identify scanner requests for hard 404 handling.');

requireIncludes(accessControl, "import { beginTrafficTruthObservation } from './traffic-truth';", 'The shared route boundary must import Traffic Truth.');
requireIncludes(accessControl, 'beginTrafficTruthObservation(req, res)', 'The shared route boundary must observe public traffic before shell routing.');
requireIncludes(accessControl, 'trafficTruth.blockAsScanner', 'The shared route boundary must hard-fail scanner paths.');
requireIncludes(accessControl, "'Cache-Control': 'no-store'", 'Scanner responses must not be cached.');
requireIncludes(accessControl, ".send('Not found.')", 'Scanner responses must be generic hard 404s.');

requireIncludes(trafficTruthContract, "SWAY_INTERNAL_QA_JOURNEY_PREFIX = '00000000-'", 'Internal QA must use a reserved journey namespace.');
requireIncludes(trafficTruthContract, "SWAY_TRAFFIC_TRUTH_QA_QUERY_KEY = 'sway_traffic'", 'Internal QA must have an explicit query marker.');
requireIncludes(discoveryAttribution, 'isInternalQaTrafficMode', 'Discovery attribution must preserve an explicit internal QA mode.');
requireIncludes(discoveryAttribution, 'namespaceInternalQaJourneyId', 'Discovery attribution must namespace internal QA journeys.');
requireIncludes(discoveryAttribution, 'SWAY_TRAFFIC_TRUTH_LIVE_QUERY_VALUE', 'Discovery attribution must support clearing QA mode.');
requireIncludes(discoveryObservatoryStore, 'SWAY_INTERNAL_QA_JOURNEY_PREFIX', 'Discovery Observatory must import the internal QA namespace.');
requireIncludes(discoveryObservatoryStore, "not like", 'Discovery Observatory must exclude internal QA journeys from operator funnels.');

for (const runbookTerm of [
  'A navigation is never relabeled as an interaction.',
  'SWAY_TRAFFIC_TRUTH_SALT',
  'SWAY_TRAFFIC_TRUTH_QA_TOKEN',
  'hard `404`',
  '[sway.traffic.truth]'
]) {
  requireIncludes(trafficTruthRunbook, runbookTerm, `Traffic Truth runbook missing release boundary: ${runbookTerm}`);
}

try {
  execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/sway-traffic-truth.behavior.test.ts'],
    { cwd: root, stdio: 'pipe' }
  );
} catch (error) {
  const details = [error?.stdout, error?.stderr]
    .filter(Boolean)
    .map((value) => String(value))
    .join('\n')
    .trim();
  failures.push(`Traffic Truth behavior proof failed.${details ? `\n${details}` : ''}`);
}

if (failures.length) {
  console.error('Sway telemetry contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway telemetry contract passed.');
