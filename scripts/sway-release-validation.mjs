import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// One-off, anonymous GET-only delivery proof on the existing isolated service.
// This diagnostic runner exists only on the validation branch, never production.
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
assert.equal(process.env.SWAY_POST_RELEASE_READ_ONLY_PROOF, 'true');
for (const name of ['SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED', 'SWAY_NATIVE_TICKETS_ENABLED', 'SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED', 'SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED', 'SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED']) {
  assert.equal(process.env[name], 'false');
}
assert.deepEqual(Object.keys(process.env).filter(name => /DATABASE_URL$/.test(name) || /^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SWAY_EMAIL_API_KEY)$/.test(name) || /PAYPAL.*(?:SECRET|TOKEN)$/.test(name)).filter(name => Boolean(process.env[name]?.trim())), []);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(head, process.env.SWAY_VALIDATION_EXPECTED_SHA);
assert.equal(head, process.env.RENDER_GIT_COMMIT);
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
const expectedProduction = '4c4c2de992a0d45762ba44d1eaae31fb148f03bb';
const expectedTree = 'b947f43366c887e510223e307cf93aad1f1e5a1b';
const indexDirectory = mkdtempSync(resolve(tmpdir(), 'sway-proof235-index-'));
try {
  const options = { encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: resolve(indexDirectory, 'index') } };
  execFileSync('git', ['read-tree', 'HEAD'], options);
  execFileSync('git', ['update-index', '--force-remove', 'scripts/sway-release-validation-suite.mjs'], options);
  execFileSync('git', ['update-index', '--add', '--cacheinfo', '100644,f3ead40f579515c3257a632062d5be6180f2887a,scripts/sway-release-validation.mjs'], options);
  assert.equal(execFileSync('git', ['write-tree'], options).trim(), expectedTree, 'All application source must match the released, tested tree.');
} finally { rmSync(indexDirectory, { recursive: true, force: true }); }

const results = [];
async function read(origin, path) {
  const response = await fetch(origin + path, {
    method: 'GET', cache: 'no-store', redirect: 'follow',
    headers: { 'Cache-Control': 'no-cache', 'X-Sway-QA': 'read-only-pr235-delivery-proof' },
    signal: AbortSignal.timeout(20_000)
  });
  assert.equal(response.status, 200, origin + path);
  return { response, body: await response.text() };
}
function record(value) {
  const row = { ...value, passed: true };
  results.push(row);
  console.log('POST_RELEASE_235_PASS ' + JSON.stringify(row));
}
console.log('POST_RELEASE_235_BEGIN ' + JSON.stringify({ diagnosticHead: head, expectedProduction, expectedTree, scope: 'Anonymous HTTP GET-only; no account, provider, publication, or payment mutation.' }));
for (const origin of ['https://app.sway.tips', 'https://sway.tips', 'https://www.sway.tips']) {
  const marker = JSON.parse((await read(origin, '/api/build-marker')).body);
  assert.equal(marker.commit, expectedProduction);
  record({ origin, path: '/api/build-marker', commit: marker.commit });
  const health = JSON.parse((await read(origin, '/api/release-health')).body);
  assert.equal(health.commit, expectedProduction);
  assert.equal(health.releaseActive, true);
  assert.equal(health.database.reachable, true);
  assert.equal(health.migrations.compatible, true);
  record({ origin, path: '/api/release-health', commit: health.commit, releaseActive: health.releaseActive, databaseReachable: health.database.reachable, migrationsCompatible: health.migrations.compatible });
}
const origin = 'https://app.sway.tips';
for (const path of ['/api/public/feed', '/api/public/feed?q=DJ3X', '/api/public/feed?q=%40dj3x']) {
  const { response, body } = await read(origin, path);
  assert.match(response.headers.get('cache-control') || '', /no-store/i);
  const feed = JSON.parse(body);
  assert(feed.performerDirectory.performers.some(performer => performer.handle === 'dj3x'));
  for (const performer of feed.performerDirectory.performers) {
    assert.deepEqual(Object.keys(performer).sort(), ['handle', 'displayName', 'performerPath', 'headline', 'bio', 'city', 'avatarUrl', 'updatedAt'].sort());
  }
  record({ origin, path, performerHandles: feed.performerDirectory.performers.map(performer => performer.handle), publicFieldAllowlist: true });
}
for (const path of ['/discover', '/discover?q=DJ3X']) {
  const { response, body } = await read(origin, path);
  assert.equal(response.headers.get('x-commit-sha'), expectedProduction);
  assert.match(body, /href="https:\/\/app\.sway\.tips\/p\/dj3x"/);
  if (path.includes('?')) assert.match(body, /noindex/);
  record({ origin, path, commit: response.headers.get('x-commit-sha'), initialHtmlProfileLink: true });
}
const profile = await read(origin, '/p/dj3x');
assert.equal(profile.response.headers.get('x-commit-sha'), expectedProduction);
record({ origin, path: '/p/dj3x', commit: profile.response.headers.get('x-commit-sha') });
assert.equal(results.length, 12);
const output = resolve('.validation-public');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const report = { diagnosticHead: head, expectedProduction, expectedTree, observedAt: new Date().toISOString(), passed: results.length, failed: 0, scope: 'Read-only post-release HTTP proof. No claim of customer acquisition, live-money readiness, or whole-product acceptance.', results };
writeFileSync(resolve(output, 'delivery-235.json'), JSON.stringify(report, null, 2));
writeFileSync(resolve(output, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
writeFileSync(resolve(output, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Sway release 235 proof</title><p>Read-only production delivery checks passed. This is not whole-product or live-money approval.</p></html>');
console.log('POST_RELEASE_235_SUMMARY ' + JSON.stringify(report));
