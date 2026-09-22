import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sway-quality-browser-'));
const evidence = { passed: false, scope: 'Whole Discovery wrapper and preserved evidence view, production CSS, intercepted read-only API fixtures. Not production login or real traffic.', cases: [] };
let server, browser;
function responseFor(url) {
  const start = url.searchParams.get('start') + 'T00:00:00.000Z';
  const endExclusive = url.searchParams.get('end') + 'T00:00:00.000Z';
  return { report: { schemaVersion: 1, product: 'sway', start, endExclusive, capturedAt: new Date().toISOString(), recorded_events: 5, recorded_landing_events: 3, classified_events: 3, quality_available: true, first_classified_event: start.replace('T00:', 'T01:'), last_recorded_event: start.replace('T00:', 'T02:'), quality_totals: [{ quality: 'browser_candidate', recorded_events: 2, landing_events: 1 }, { quality: 'qa_signal', recorded_events: 1, landing_events: 1 }, { quality: 'legacy_unclassified', recorded_events: 2, landing_events: 1 }], browser_candidate_journeys: 1, candidate_sources: [{ source_group: 'search_labeled', browser_candidate_journeys: 1, journeys_with_recorded_action: 1, journeys_with_linked_durable_outcome: 0 }], linked_durable_outcomes: 0, unlinked_durable_outcomes: 0, verified_unique_people: null, search_console_impressions: null, search_console_clicks: null } };
}
const legacy = { observatory: { generatedAt: new Date().toISOString(), funnels: [], discoverySources: [], queries: [], observedPages: [], repeatedOutsideSources: [], repeatedCompetitors: [], pagesWithEntriesButNoActions: [], pagesWithImpressionsButNoActions: {}, internalZeroResults: [], freshnessFailures: [], experiments: [], visibility: { schema: 'present', eligible: 0, ineligible: 0, unknown: 0 }, eligibilityExclusions: {}, sourceAvailability: [], unclaimedEntitiesReceivingDemand: {}, unknownOrUnavailableEvidence: [], quality: {} } };
try {
  await build({ stdin: { contents: "import React from 'react';import {createRoot} from 'react-dom/client';import Page from './src/shells/DiscoveryObservatoryPage';createRoot(document.getElementById('root')).render(<Page/>);", resolveDir: root, loader: 'tsx' }, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', outfile: path.join(tmp, 'app.js'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const cssFiles = fs.readdirSync(path.join(root, 'dist'), { recursive: true }).filter(file => String(file).endsWith('.css'));
  assert(cssFiles.length, 'Real production CSS is required');
  fs.writeFileSync(path.join(tmp, 'app.css'), cssFiles.map(file => fs.readFileSync(path.join(root, 'dist', String(file)), 'utf8')).join('\n'));
  const app = express(); app.use(express.static(tmp)); app.get('*', (_req, res) => res.type('html').send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(10000); const errors = []; let mode = 'hold', calls = 0, writes = 0, releaseInitial;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() !== 'GET') { writes++; return route.abort(); }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/admin/discovery-observatory/acquisition-quality') {
        calls++;
        if (mode === 'hold') await new Promise(resolve => { releaseInitial = resolve; });
        if (mode === 'fail') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
        if (mode === 'denied') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"denied"}' });
        const payload = responseFor(url);
        if (mode === 'malformed') payload.report.recorded_events = -1;
        if (mode === 'empty') Object.assign(payload.report, { recorded_events: 0, recorded_landing_events: 0, classified_events: 0, quality_available: false, first_classified_event: null, last_recorded_event: null, quality_totals: [], candidate_sources: [], browser_candidate_journeys: null });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
      }
      if (url.pathname === '/api/admin/discovery-observatory') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(legacy) });
      if (url.pathname.startsWith('/api/')) return route.abort();
      return route.continue();
    });
    await page.goto(origin + '/admin/discovery-observatory');
    await page.getByRole('status').waitFor(); assert.equal(await page.getByTestId('acquisition-results').count(), 0);
    mode = 'success'; releaseInitial(); await page.getByTestId('acquisition-results').waitFor();
    assert((await page.getByTestId('acquisition-results').innerText()).includes('Verified people'));
    mode = 'fail'; await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await page.getByRole('button', { name: 'Retry report' }).waitFor(); assert.equal(await page.getByTestId('acquisition-results').count(), 0);
    mode = 'success'; await page.getByRole('button', { name: 'Retry report' }).click(); await page.getByTestId('acquisition-results').waitFor();
    await page.getByLabel('Start date (UTC)', { exact: true }).fill('2026-09-01'); await page.getByLabel('End date (excluded, UTC)').fill('2026-09-02'); await page.getByRole('button', { name: 'Apply dates' }).click(); await page.getByText('Applied window: 2026-09-01 to 2026-09-02', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Discovery evidence', exact: true }).click(); await page.getByPlaceholder('Source (for example web_search)').fill('preserved-draft');
    await page.getByRole('button', { name: 'Traffic quality', exact: true }).click(); assert.equal(await page.getByLabel('Start date (UTC)', { exact: true }).inputValue(), '2026-09-01');
    await page.getByRole('button', { name: 'Discovery evidence', exact: true }).click(); assert.equal(await page.getByPlaceholder('Source (for example web_search)').inputValue(), 'preserved-draft');
    await page.getByRole('button', { name: 'Traffic quality', exact: true }).click();
    const prior = calls; await page.getByLabel('End date (excluded, UTC)').fill('2026-08-31'); await page.getByRole('button', { name: 'Apply dates' }).click(); await page.getByRole('alert').waitFor(); assert.equal(calls, prior); await page.getByLabel('End date (excluded, UTC)').fill('2026-09-02');
    mode = 'malformed'; await page.getByRole('button', { name: 'Apply dates' }).click(); await page.getByRole('button', { name: 'Retry report' }).waitFor(); assert.equal(await page.getByTestId('acquisition-results').count(), 0);
    mode = 'empty'; await page.getByRole('button', { name: 'Retry report' }).click(); await page.getByText('No classified request evidence is available', { exact: false }).waitFor();
    mode = 'denied'; await page.getByTestId('acquisition-quality-panel').getByRole('button', { name: 'Refresh', exact: true }).click(); await page.getByText('Administrator access is required. Sign in again.').waitFor(); assert.equal(await page.getByTestId('acquisition-results').count(), 0);
    mode = 'success'; await page.getByRole('button', { name: 'Retry report' }).click(); await page.getByTestId('acquisition-results').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false); assert.deepEqual(errors, []); assert.equal(writes, 0);
    if (process.env.SWAY_QUALITY_BROWSER_OUTPUT) { fs.mkdirSync(process.env.SWAY_QUALITY_BROWSER_OUTPUT, { recursive: true }); await page.screenshot({ path: path.join(process.env.SWAY_QUALITY_BROWSER_OUTPUT, `sway-quality-${width}.png`), fullPage: true }); }
    evidence.cases.push({ width, passed: true, calls, writes, loadingNoFakeZeros: true, failedRefreshHidesData: true, retry: true, invalidDatesNoQuery: true, datesAndLegacyDraftPreserved: true, malformedRejected: true, historicalEmptyUnavailable: true, permissionLossHidesData: true, overflow, pageErrors: errors });
    await context.close();
  }
  evidence.passed = true;
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('SWAY_QUALITY_DASHBOARD_BROWSER ' + JSON.stringify(evidence));
}
