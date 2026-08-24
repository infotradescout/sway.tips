import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const server = read('server.ts');
const service = read('src/server/account-discovery-attribution.ts');
const observatoryStore = read('src/server/discovery-observatory-store.ts');
const accountAccess = read('src/components/AccountAccess.tsx');
const envExample = read('.env.example');
const packageJson = JSON.parse(read('package.json'));
const failures = [];

function requireText(source, text, label) {
  if (!source.includes(text)) failures.push(`${label}: missing ${text}`);
}

function rejectText(source, text, label) {
  if (source.includes(text)) failures.push(`${label}: prohibited ${text}`);
}

for (const term of [
  'getOrCreateDiscoveryJourneyId',
  'discoveryJourneyId: getOrCreateDiscoveryJourneyId()'
]) requireText(accountAccess, term, 'Signup journey handoff');

for (const term of [
  'createDiscoveryAttributionReceipt',
  'TRUSTED_DISCOVERY_ATTRIBUTION_ORIGINS',
  'SWAY_DISCOVERY_ATTRIBUTION_SECRET',
  'readDiscoveryAttributionReceiptCookie',
  'resolveReceiptBackedAttributionEvidence',
  "req.get('sec-fetch-site')",
  "req.get('sec-fetch-mode')",
  "req.get('sec-fetch-dest')",
  'AttributionReceiptConflictError',
  'res.clearCookie(DISCOVERY_ATTRIBUTION_RECEIPT_COOKIE',
  "stage === 'entry'",
  'attributionEvidence ? { attributionEvidence } : undefined',
  'linkSignupDiscoveryAttribution(outcome.accountId, discoveryJourneyId)',
  'missing or conflicting journey must never deny an otherwise valid account.'
]) requireText(server, term, 'Server-owned signup attribution');
rejectText(server, "allowedOrigins: [CANONICAL_APP_ORIGIN, requestOrigin]", 'Caller Host must not become a trusted attribution origin');
const telemetryRouteStart = server.indexOf('app.post("/api/analytics/shell"');
const telemetryRouteEnd = server.indexOf('function executeRows', telemetryRouteStart);
const telemetryRoute = server.slice(telemetryRouteStart, telemetryRouteEnd);
rejectText(telemetryRoute, "req.get('referer')", 'Telemetry Referer must not qualify signup attribution');
rejectText(telemetryRoute, "req.get('host')", 'Telemetry Host must not qualify signup attribution');

const signupRouteStart = server.indexOf("app.post('/api/account/signup'");
const signupRouteEnd = server.indexOf("app.get('/api/account/verify-email/consume'", signupRouteStart);
const signupRoute = server.slice(signupRouteStart, signupRouteEnd);
requireText(signupRoute, 'Discovery journey context is invalid.', 'Signup journey validation');
const signupLinkCount = (signupRoute.match(/linkSignupDiscoveryAttribution\(outcome\.accountId, discoveryJourneyId\)/g) ?? []).length;
if (signupLinkCount !== 2) failures.push(`Signup attribution: expected claim and email-delivered link calls, found ${signupLinkCount}`);

for (const term of [
  'accountDiscoveryAttributions',
  "metadata}->>'stage' = 'entry'",
  "reason: 'no_durable_entry'",
  "reason: 'unverified_organic_evidence'",
  "reason: 'unverified_server_evidence'",
  'resolveReceiptBackedAttributionEvidence',
  'receiptSecret',
  'header_observed_unverified',
  'are not proof of origin',
  "const sourceClass: AcquisitionSourceClass = 'unknown'",
  'referrerHost',
  '.onConflictDoNothing()',
  'firstTouchAt',
  'sourceEventId',
  'journeyEntityId',
  'idempotencyKeyHash'
]) requireText(service, term, 'Durable first-touch linker');
rejectText(service, 'growthMilestones', 'Signup attribution must not self-award OQPS');
rejectText(service, '.insert(growthMilestones)', 'Signup attribution must not create a qualification milestone');

for (const term of [
  'source_class: options.attributionEvidence.sourceClass',
  'claimed_source_class: options.attributionEvidence.claimedSourceClass',
  'utm_source: options.attributionEvidence.utmSource',
  'link_strength: options.attributionEvidence.linkStrength',
  'attribution_receipt: options.attributionEvidence.attributionReceipt',
  'attribution_receipt_id: options.attributionEvidence.attributionReceiptId',
  'referrer_host: options.attributionEvidence.referrerHost',
  'attribution-receipt:',
  'AttributionReceiptConflictError',
  'metadata: persisted'
]) requireText(observatoryStore, term, 'Durable server-observed entry snapshot');

for (const term of [
  'SWAY_DISCOVERY_ATTRIBUTION_SECRET',
  'HttpOnly landing receipts',
  'remains unverified and cannot qualify OQPS'
]) requireText(envExample, term, 'Attribution receipt configuration');

requireText(server, 'function applyPublicDiscoveryIndexHold', 'Wave 3A index hold');
requireText(server, "res.setHeader('X-Robots-Tag', 'noindex, follow')", 'Wave 3A index hold');

if (packageJson.scripts?.['test:integration:signup-attribution'] !== 'node --import tsx scripts/sway-signup-attribution.integration.test.ts') {
  failures.push('Package scripts: signup attribution integration command is missing');
}
if (packageJson.scripts?.['test:signup-attribution'] !== 'node scripts/sway-signup-attribution.contract.test.mjs && npm run test:integration:signup-attribution') {
  failures.push('Package scripts: signup attribution aggregate command is missing');
}
if (!(packageJson.scripts?.['test:contracts'] ?? '').includes('node scripts/sway-signup-attribution.contract.test.mjs')) {
  failures.push('Package scripts: signup attribution contract is not directly registered');
}

if (failures.length) {
  console.error('Sway signup attribution contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway signup attribution contract passed.');
