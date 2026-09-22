import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import express from 'express';
import { build } from 'esbuild';
import { completeUtcWindow, defaultAcquisitionDates, parseAcquisitionQualityReport } from '../src/acquisition-quality-report.ts';
import { acquireReportClient } from '../src/server/acquisition-quality-routes.ts';
import { registerAffiliateRoutes } from '../src/server/affiliate-program.ts';

const window = { start: '2026-09-01T00:00:00.000Z', endExclusive: '2026-09-02T00:00:00.000Z' };
export const fixture = () => ({ schemaVersion: 1, product: 'sway', ...window, capturedAt: '2026-09-03T00:00:00.000Z', recorded_events: 5, recorded_landing_events: 3, classified_events: 3, quality_available: true, first_classified_event: '2026-09-01T01:00:00.000Z', last_recorded_event: '2026-09-01T02:00:00.000Z', quality_totals: [{ quality: 'browser_candidate', recorded_events: 2, landing_events: 1 }, { quality: 'qa_signal', recorded_events: 1, landing_events: 1 }, { quality: 'legacy_unclassified', recorded_events: 2, landing_events: 1 }], browser_candidate_journeys: 1, candidate_sources: [{ source_group: 'search_labeled', browser_candidate_journeys: 1, journeys_with_recorded_action: 1, journeys_with_linked_durable_outcome: 0 }], linked_durable_outcomes: 0, unlinked_durable_outcomes: 0, verified_unique_people: null, search_console_impressions: null, search_console_clicks: null });

test('complete UTC windows reject coercion, invalid dates, future days and more than 90 days', () => {
  const now = new Date('2026-09-22T02:00:00Z');
  assert.deepEqual(completeUtcWindow('2026-09-01', '2026-09-02', now), window);
  assert.deepEqual(defaultAcquisitionDates(now), { start: '2026-08-25', end: '2026-09-22' });
  for (const [first, last] of [[['2026-09-01'], '2026-09-02'], [{}, '2026-09-02'], ['2026-02-30', '2026-03-02'], ['2026-09-02', '2026-09-01'], ['2026-09-01', '2026-09-01'], ['2026-01-01', '2026-09-01'], ['2026-09-21', '2026-09-23'], ['2026-09-01T00:00:00Z', '2026-09-02']]) assert.throws(() => completeUtcWindow(first, last, now));
});
test('report projection retains supported aggregates and strips private/extra payloads', () => {
  const raw = fixture(); raw.privateIdentifier = 'do-not-display'; raw.quality_totals[0].raw_user_agent = 'private';
  const value = parseAcquisitionQualityReport(raw, window);
  assert.equal(value.browser_candidate_journeys, 1); assert.equal(value.verified_unique_people, null);
  assert(!JSON.stringify(value).includes('private')); assert(!JSON.stringify(value).includes('do-not-display'));
});
test('empty and historical-only windows preserve unavailable candidate counts', () => {
  const empty = { ...fixture(), recorded_events: 0, recorded_landing_events: 0, classified_events: 0, quality_available: false, first_classified_event: null, last_recorded_event: null, quality_totals: [], browser_candidate_journeys: null, candidate_sources: [] };
  assert.equal(parseAcquisitionQualityReport(empty, window).browser_candidate_journeys, null);
  const historical = { ...empty, recorded_events: 1, recorded_landing_events: 1, last_recorded_event: '2026-09-01T02:00:00Z', quality_totals: [{ quality: 'legacy_unclassified', recorded_events: 1, landing_events: 1 }] };
  assert.equal(parseAcquisitionQualityReport(historical, window).quality_available, false);
  assert.throws(() => parseAcquisitionQualityReport({ ...historical, browser_candidate_journeys: 0 }, window));
});
test('malformed and mismatched counts, windows, quality groups and unsupported claims fail closed', () => {
  const changes = [r => r.recorded_events = '5', r => r.recorded_events = -1, r => r.recorded_events = NaN, r => r.classified_events = 4, r => r.quality_available = false, r => r.verified_unique_people = 1, r => r.search_console_clicks = 0, r => r.start = '2026-08-01T00:00:00.000Z', r => r.quality_totals.push(r.quality_totals[0]), r => r.quality_totals[0].quality = 'confirmed_human', r => r.quality_totals[0].landing_events = 99, r => r.candidate_sources[0].source_group = 'private@example.com', r => r.candidate_sources[0].journeys_with_recorded_action = 5, r => r.candidate_sources[0].journeys_with_linked_durable_outcome = 2, r => r.first_classified_event = null, r => r.last_recorded_event = window.endExclusive];
  for (const change of changes) { const raw = fixture(); change(raw); assert.throws(() => parseAcquisitionQualityReport(raw, window)); }
});

async function withRoute(options, work) {
  const app = express(); const queries = []; let connections = 0, releases = 0;
  const client = { query: async (text, values) => { queries.push([text, values]); if (text.startsWith('\nWITH')) { if (options.failQuery) throw new Error('postgres://secret/private'); if (options.wait) await options.wait; return { rows: [{ report: options.payload ? options.payload() : fixture() }] }; } return { rows: [] }; }, release: () => { releases++; } };
  const db = options.noDatabase ? null : { $client: { connect: async () => { connections++; if (options.failConnect) throw new Error('private pool detail'); return client; } } };
  const accessControl = { requireAdminAccess: async req => { if (options.failGuard) throw new Error('private guard detail'); return req.headers['x-test-role'] === 'admin' ? { allowed: true, actor: { actorId: 'isolated-admin' } } : { allowed: false, status: req.headers['x-test-role'] ? 403 : 401, reason: 'denied' }; } };
  registerAffiliateRoutes({ app, db, accessControl, isProduction: true });
  app.use((_req, res) => res.status(404).end());
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (query = 'start=2026-09-01&end=2026-09-02', headers = { 'x-test-role': 'admin' }) => fetch(base + '/api/admin/discovery-observatory/acquisition-quality?' + query, { headers, signal: AbortSignal.timeout(3000) });
  try { await work({ get, queries, counts: () => ({ connections, releases }), base }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('actual registered HTTP route authorizes before acquiring a report connection', async () => withRoute({}, async ({ get, counts }) => {
  for (const headers of [{}, { 'x-test-role': 'performer' }, { 'x-sway-qa': '1' }]) { const response = await get('start=bad', headers); assert([401, 403].includes(response.status)); assert(!JSON.stringify(await response.json()).includes('recorded_events')); }
  assert.deepEqual(counts(), { connections: 0, releases: 0 });
}));
test('actual route uses readonly report, bind parameters, aggregate projection and connection release', async () => withRoute({}, async ({ get, queries, counts }) => {
  const response = await get(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await response.json()).report.browser_candidate_journeys, 1);
  assert.equal(queries[0][0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); assert(queries.some(([text]) => text.includes("statement_timeout='8s'")));
  assert.deepEqual(queries.find(([text]) => text.startsWith('\nWITH'))[1], [window.start, window.endExclusive]); assert.equal(queries.at(-1)[0], 'COMMIT'); assert.deepEqual(counts(), { connections: 1, releases: 1 });
}));
test('invalid and repeated query values cause no database access; non-GET does not read report', async () => withRoute({}, async ({ get, counts, base }) => {
  for (const query of ['start=2026-02-30&end=2026-03-02', 'start=2026-09-01&start=2026-09-02&end=2026-09-03', 'start=2026-09-01&end=9999-01-01', 'start[x]=2026-09-01&end=2026-09-02']) assert.equal((await get(query)).status, 400);
  assert.equal((await fetch(base + '/api/admin/discovery-observatory/acquisition-quality', { method: 'POST' })).status, 404); assert.deepEqual(counts(), { connections: 0, releases: 0 });
}));
for (const kind of ['noDatabase', 'failConnect', 'failQuery', 'failGuard', 'malformed']) test(`${kind}: unavailable response exposes no private error or zero report`, async () => withRoute(kind === 'malformed' ? { payload: () => ({ ...fixture(), recorded_events: -1 }) } : { [kind]: true }, async ({ get, counts, queries }) => {
  const response = await get(); assert.equal(response.status, 503); const body = await response.text(); assert(!body.includes('recorded_events')); assert(!body.includes('private')); assert(!body.includes('postgres'));
  if (kind === 'failQuery') assert.equal(queries.at(-1)[0], 'ROLLBACK');
  if (['malformed', 'failQuery'].includes(kind)) assert.equal(counts().releases, 1);
}));
test('timed-out pool acquisition releases the late connection', async () => {
  let complete, released = 0;
  const promise = acquireReportClient({ connect: () => new Promise(resolve => { complete = resolve; }) }, 5);
  await assert.rejects(promise, /unavailable/); complete({ query: async () => ({}), release: () => released++ }); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(released, 1);
});
test('standalone report never executes its CLI when bundled into a server entry; original guard fails negative control', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sway-quality-bundle-'));
  try {
    const original = readFileSync('scripts/report-acquisition-quality.mjs', 'utf8');
    for (const [name, source, expected] of [['fixed', original, 0], ['negative', original.replace(/if \(process\.argv\[1\] && \/\(\?:\^\|\[.*?\.test\(process\.argv\[1\]\) && import\.meta\.url/, 'if (process.argv[1] && import.meta.url'), 1]]) {
      if (name === 'negative') assert.notEqual(source, original, 'Negative control must remove the filename guard');
      const entry = path.join(dir, name + '.mjs'); writeFileSync(entry, source);
      const target = path.join(dir, name + '-server.mjs'); await build({ entryPoints: [entry], outfile: target, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
      const run = spawnSync(process.execPath, [target], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } }); assert.equal(run.status, expected, run.stderr);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('legacy evidence and all affiliate logic are preserved; only report registration is added', () => {
  const sha = '2011efd13cb9d7b068721e5512b32e3c21cd7cfc';
  const readBase = file => execFileSync('git', ['show', `${sha}:${file}`], { encoding: 'utf8' });
  assert.equal(readFileSync('src/shells/DiscoveryEvidencePage.tsx', 'utf8'), readBase('src/shells/DiscoveryObservatoryPage.tsx'));
  assert.equal(readFileSync('src/server/affiliate-program.ts', 'utf8').replace("import { registerAcquisitionQualityRoutes } from './acquisition-quality-routes';\n", '').replace('  registerAcquisitionQualityRoutes({ app, db, accessControl });\n', ''), readBase('src/server/affiliate-program.ts'));
});
