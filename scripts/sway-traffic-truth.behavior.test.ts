import assert from 'node:assert/strict';
import {
  classifyTrafficUserAgent,
  encodeTrafficTruthSource,
  isScannerTrafficPath,
  parseTrafficTruthSource,
  projectHumanTrafficAuditRows,
  type TrafficTruthAuditRow
} from '../src/traffic-truth';
import {
  applyTrafficTruthToTelemetryRequest,
  classifyTrafficRequest,
  shouldHard404ScannerRequest
} from '../src/server/traffic-truth-request';
import { classifyBrowserTraffic } from '../src/shells/trafficTruthClient';

const humanUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1';

for (const path of [
  '/.env',
  '/.env.local',
  '//wp-includes/wlwmanifest.xml',
  '/wp-login.php',
  '/wp-json/batch/v1',
  '/xmlrpc.php',
  '/.git/config',
  '/package.json',
  '/src/server/access-control.ts',
  '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
  '/%2e%2e/%2e%2e/etc/passwd'
]) {
  assert.equal(isScannerTrafficPath(path), true, `scanner path must fail closed: ${path}`);
}

for (const path of [
  '/',
  '/g/4bff1537-dafa-48fc-b42c-75304ed43906',
  '/p/dj3x',
  '/u/coreymack',
  '/robots.txt',
  '/llms.txt',
  '/.well-known/apple-app-site-association'
]) {
  assert.equal(isScannerTrafficPath(path), false, `real public path must remain reachable: ${path}`);
}

assert.equal(classifyTrafficUserAgent('Googlebot/2.1 (+http://www.google.com/bot.html)'), 'known_bot');
assert.equal(classifyTrafficUserAgent('Mozilla/5.0 (compatible; GPTBot/1.2)'), 'known_bot');
assert.equal(classifyTrafficUserAgent('CensysInspect/1.1'), 'scanner');
assert.equal(classifyTrafficUserAgent('curl/8.7.1'), 'qa_automation');
assert.equal(classifyTrafficUserAgent(humanUa), 'human_candidate');

assert.deepEqual(parseTrafficTruthSource('human_candidate:google'), {
  classification: 'human_candidate',
  source: 'google'
});
assert.equal(encodeTrafficTruthSource('known_bot', 'human_candidate:google'), 'known_bot:google');
assert.equal(encodeTrafficTruthSource('human_candidate', 'direct'), 'human_candidate:direct');
assert.ok(encodeTrafficTruthSource('human_candidate', 'x'.repeat(200)).length <= 64);
assert.deepEqual(parseTrafficTruthSource(' HUMAN_CANDIDATE:Email Campaign '), {
  classification: 'human_candidate',
  source: 'email_campaign'
});

assert.equal(classifyBrowserTraffic({ userAgent: humanUa, webdriver: false, href: 'https://app.sway.tips/', hostname: 'app.sway.tips' }), 'human_candidate');
assert.equal(classifyBrowserTraffic({ userAgent: humanUa, webdriver: true, href: 'https://app.sway.tips/', hostname: 'app.sway.tips' }), 'qa_automation');
assert.equal(classifyBrowserTraffic({ userAgent: humanUa, webdriver: false, href: 'https://app.sway.tips/?sway_qa=1', hostname: 'app.sway.tips' }), 'qa_automation');
assert.equal(classifyBrowserTraffic({ userAgent: 'Applebot/0.1', webdriver: false, href: 'https://app.sway.tips/', hostname: 'app.sway.tips' }), 'known_bot');

const humanRequest = {
  method: 'POST',
  path: '/api/analytics/shell',
  originalUrl: '/api/analytics/shell',
  headers: { 'user-agent': humanUa, 'x-sway-traffic-class': 'human_candidate' },
  ip: '203.0.113.10',
  body: { attribution_channel: 'google' }
};
assert.equal(applyTrafficTruthToTelemetryRequest(humanRequest as never, {}), 'human_candidate');
assert.equal(humanRequest.body.attribution_channel, 'human_candidate:google');
assert.equal(applyTrafficTruthToTelemetryRequest(humanRequest as never, {}), 'human_candidate');
assert.equal(humanRequest.body.attribution_channel, 'human_candidate:google');

const spoofedHumanRequest = {
  method: 'POST',
  path: '/api/analytics/shell',
  originalUrl: '/api/analytics/shell',
  headers: { 'user-agent': 'Googlebot/2.1', 'x-sway-traffic-class': 'human_candidate' },
  ip: '203.0.113.12',
  body: { attribution_channel: 'direct' }
};
assert.equal(classifyTrafficRequest(spoofedHumanRequest as never, {}), 'known_bot');

const botRequest = {
  method: 'POST',
  path: '/api/analytics/shell',
  originalUrl: '/api/analytics/shell',
  headers: { 'user-agent': 'Googlebot/2.1', 'x-sway-traffic-class': 'human_candidate' },
  ip: '203.0.113.11',
  body: { attribution_channel: 'human_candidate:direct' }
};
assert.equal(applyTrafficTruthToTelemetryRequest(botRequest as never, {}), 'known_bot');
assert.equal(botRequest.body.attribution_channel, 'known_bot:direct');

const qaRequest = {
  method: 'POST',
  path: '/api/analytics/shell',
  originalUrl: '/api/analytics/shell',
  headers: { 'user-agent': humanUa },
  ip: '198.51.100.9',
  body: { attribution_channel: 'direct' }
};
assert.equal(classifyTrafficRequest(qaRequest as never, { SWAY_TRAFFIC_TRUTH_QA_IPS: '198.51.100.9' }), 'qa_automation');
assert.equal(applyTrafficTruthToTelemetryRequest(qaRequest as never, { SWAY_TRAFFIC_TRUTH_QA_IPS: '198.51.100.9' }), 'qa_automation');
assert.equal(qaRequest.body.attribution_channel, 'qa_automation:direct');

const qaMarkerRequest = {
  method: 'POST',
  path: '/api/analytics/shell',
  originalUrl: '/api/analytics/shell?sway_qa=1',
  headers: { 'user-agent': humanUa },
  ip: '203.0.113.13',
  body: { attribution_channel: 'direct' }
};
assert.equal(classifyTrafficRequest(qaMarkerRequest as never, {}), 'qa_automation');

assert.equal(shouldHard404ScannerRequest({ path: '/.env', originalUrl: '/.env' } as never), true);
assert.equal(shouldHard404ScannerRequest({ path: '/g/real-room', originalUrl: '/g/real-room' } as never), false);

function row(
  eventId: string,
  entityId: string,
  eventType: string,
  source: string | null,
  entityType = 'shell_friction'
): TrafficTruthAuditRow {
  return {
    eventId,
    entityId,
    entityType,
    eventType,
    metadata: source === null ? {} : { source },
    createdAt: '2026-08-19T06:00:00.000Z'
  };
}

const rawRows: TrafficTruthAuditRow[] = [
  row('human-entry', 'journey-human', 'room_entry_viewed', 'human_candidate:google'),
  row('human-outcome', 'journey-human', 'room_entry_completed', 'direct'),
  row('human-assignment', 'journey-human', 'discovery_experiment.assignment', null),
  row('qa-entry', 'journey-qa', 'room_entry_viewed', 'qa_automation:direct'),
  row('qa-outcome', 'journey-qa', 'room_entry_completed', 'direct'),
  row('bot-entry', 'journey-bot', 'discovery_landing', 'known_bot:google'),
  row('scanner-entry', 'journey-scanner', 'discovery_landing', 'scanner:unknown'),
  row('legacy-entry', 'journey-legacy', 'discovery_landing', 'direct'),
  row('tainted-human', 'journey-tainted', 'discovery_landing', 'human_candidate:direct'),
  row('tainted-qa', 'journey-tainted', 'request_started', 'qa_automation:direct'),
  row('observation', 'observation-1', 'discovery_observation.recorded', 'web_search', 'discovery_observation')
];

const projection = projectHumanTrafficAuditRows(rawRows);
assert.deepEqual(
  projection.rows.map((value) => value.eventId).sort(),
  ['human-assignment', 'human-entry', 'human-outcome', 'observation'].sort()
);
assert.equal(projection.rows.find((value) => value.eventId === 'human-entry')?.metadata?.source, 'google');
assert.equal(projection.rows.find((value) => value.eventId === 'human-outcome')?.metadata?.source, 'direct');
assert.equal(projection.summary.humanCandidateJourneys, 1);
assert.equal(projection.summary.knownBotJourneys, 1);
assert.equal(projection.summary.scannerJourneys, 1);
assert.equal(projection.summary.qaAutomationJourneys, 2);
assert.equal(projection.summary.automatedJourneysExcluded, 4);
assert.equal(projection.summary.taintedJourneysExcluded, 1);
assert.equal(projection.summary.legacyJourneysExcluded, 1);

console.log('Sway traffic-truth behavior passed.');
