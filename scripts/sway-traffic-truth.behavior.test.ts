import assert from 'node:assert/strict';
import { classifyTrafficTruthRequest, type TrafficTruthRequestLike } from '../src/server/traffic-truth';

const env = {
  SWAY_TRAFFIC_TRUTH_SALT: '0123456789abcdef0123456789abcdef',
  SWAY_TRAFFIC_TRUTH_QA_TOKEN: 'qa-secret',
  SWAY_TRAFFIC_TRUTH_QA_IPS: '203.0.113.9'
};
const now = new Date('2026-08-19T12:00:00.000Z');

function request(overrides: Partial<TrafficTruthRequestLike> = {}): TrafficTruthRequestLike {
  return {
    method: 'GET',
    path: '/',
    query: {},
    ...overrides,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'x-forwarded-for': '198.51.100.10',
      host: 'app.sway.tips',
      ...(overrides.headers || {})
    }
  };
}

const human = classifyTrafficTruthRequest(request(), env, now);
assert.equal(human.classification, 'human_candidate');
assert.equal(human.confidence, 'medium');
assert.equal(human.routeFamily, 'home');
assert.match(human.visitorId || '', /^[0-9a-f]{24}$/);
assert.equal(human.blockAsScanner, false);

const sameHuman = classifyTrafficTruthRequest(request(), env, new Date('2026-08-19T23:59:00.000Z'));
assert.equal(sameHuman.visitorId, human.visitorId, 'Visitor pseudonym must remain stable inside one UTC day.');
const nextDayHuman = classifyTrafficTruthRequest(request(), env, new Date('2026-08-20T00:01:00.000Z'));
assert.notEqual(nextDayHuman.visitorId, human.visitorId, 'Visitor pseudonym must rotate daily.');

const scanner = classifyTrafficTruthRequest(request({ path: '/.env' }), env, now);
assert.equal(scanner.classification, 'scanner');
assert.equal(scanner.blockAsScanner, true);
assert.equal(scanner.visitorId, null);

const wordpressScanner = classifyTrafficTruthRequest(request({ method: 'POST', path: '/wp-login.php' }), env, now);
assert.equal(wordpressScanner.classification, 'scanner');
assert.equal(wordpressScanner.blockAsScanner, true);

const google = classifyTrafficTruthRequest(request({
  path: '/p/example',
  headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }
}), env, now);
assert.equal(google.classification, 'known_bot');
assert.equal(google.botFamily, 'google');
assert.equal(google.blockAsScanner, false);

const openai = classifyTrafficTruthRequest(request({
  path: '/robots.txt',
  headers: { 'user-agent': 'OAI-SearchBot/1.0' }
}), env, now);
assert.equal(openai.classification, 'known_bot');
assert.equal(openai.botFamily, 'openai');
assert.equal(openai.routeFamily, 'crawler_resource');

const explicitQa = classifyTrafficTruthRequest(request({ query: { sway_traffic: 'qa' } }), env, now);
assert.equal(explicitQa.classification, 'internal_qa');
assert.equal(explicitQa.reason, 'explicit_qa_query');

const cookieQa = classifyTrafficTruthRequest(request({ headers: { cookie: 'other=1; sway_traffic_truth=qa' } }), env, now);
assert.equal(cookieQa.classification, 'internal_qa');
assert.equal(cookieQa.reason, 'explicit_qa_cookie');

const tokenQa = classifyTrafficTruthRequest(request({ headers: { 'x-sway-traffic-qa': 'qa-secret' } }), env, now);
assert.equal(tokenQa.classification, 'internal_qa');
assert.equal(tokenQa.reason, 'authenticated_qa_header');

const addressQa = classifyTrafficTruthRequest(request({ headers: { 'x-forwarded-for': '203.0.113.9' } }), env, now);
assert.equal(addressQa.classification, 'internal_qa');
assert.equal(addressQa.reason, 'configured_qa_address');

const curl = classifyTrafficTruthRequest(request({ headers: { 'user-agent': 'curl/8.12.0', accept: '*/*' } }), env, now);
assert.equal(curl.classification, 'unknown_automation');
assert.equal(curl.reason, 'recognized_automation_user_agent');
assert.equal(curl.visitorId, null);

const chatgptReferral = classifyTrafficTruthRequest(request({
  headers: { referer: 'https://chatgpt.com/c/abc' }
}), env, now);
assert.equal(chatgptReferral.attributionChannel, 'chatgpt');

const asset = classifyTrafficTruthRequest(request({ path: '/favicon.ico' }), env, now);
assert.equal(asset.shouldLog, false);

const privateAdmin = classifyTrafficTruthRequest(request({ path: '/admin' }), env, now);
assert.equal(privateAdmin.shouldLog, false);

const noSalt = classifyTrafficTruthRequest(request(), {}, now);
assert.equal(noSalt.classification, 'human_candidate');
assert.equal(noSalt.visitorId, null, 'Raw address or user agent must never substitute for a missing privacy salt.');

console.log('Sway traffic truth behavior passed.');
