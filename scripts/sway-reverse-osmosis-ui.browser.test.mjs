// Isolated browser mocks prove operator controls, not real provider consent or publication.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Sync from './src/components/PerformerReverseOsmosis'; const root=createRoot(document.getElementById('root')); window.renderProfile=(handle,revision=0)=>root.render(<Sync performerHandle={handle} profileRevision={revision}/>); window.renderProfile('mock-performer-a');`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const proposal = { id: 'mock-proposal', proposal: { scope: { provider: 'mock-provider', accountId: 'mock-account-a', businessId: 'mock-business-a', subjectId: 'mock-native-a' }, direction: 'native_to_social', fields: { bio: 'Mock reviewed biography' }, payloadDigest: 'mock-digest', expectedNativeVersion: 'mock-v1', businessBindingRevision: 1 } };
try {
  for (const width of [320, 390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const writes = []; let bindings = [{ id: 'mock-binding', ...proposal.proposal.scope }]; let approvalMode = 'normal'; let outcomeReads = 0; let previewMode = 'normal'; let heldPreview; let expectedHandle = 'mock-performer-a'; let proposals = [];
    await page.route('**/api/talent/profile/sync**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      assert.equal(url.searchParams.get('handle'), expectedHandle, 'Every read and action must transmit the exact displayed performer scope');
      if (request.method() === 'GET') { if (path.endsWith('/outcome')) { outcomeReads++; return route.fulfill({ json: { outcome: { status: 'held' } } }); } return route.fulfill({ json: { nativeVersion: 'mock-v1', fields: { bio: 'Mock previous biography' }, bindings, proposals, providerPublishingAvailable: false } }); }
      const body = request.postDataJSON(); writes.push({ path, body });
      if (path.endsWith('/preview')) { assert.deepEqual(body, { bindingId: 'mock-binding' }); if (previewMode === 'held') { heldPreview = route; return; } if (previewMode === 'revoked') return route.fulfill({ status: 403, json: { error: 'Mock revoked authorization' } }); return route.fulfill({ json: proposal }); }
      if (path.endsWith('/approve')) { assert.deepEqual(body, { confirmed: true, payloadDigest: 'mock-digest', expectedNativeVersion: 'mock-v1', businessBindingRevision: 1 }); if (approvalMode === 'lost') return route.abort('failed'); return route.fulfill({ json: { id: proposal.id, approval: { approvalId: 'mock-approval' } } }); }
      if (path.endsWith('/run')) { assert.deepEqual(body, { approvalId: 'mock-approval' }); return route.fulfill({ json: { outcome: { status: 'held' } } }); }
      throw new Error(`Unexpected mock request ${path}`);
    });
    await page.goto(base);
    await page.getByRole('button', { name: 'Preview saved profile changes' }).click();
    await page.getByText('Proposed value: Mock reviewed biography', { exact: true }).waitFor();
    assert.equal(writes.length, 1, 'Preview cannot approve or run automatically');
    const run = page.getByRole('button', { name: 'Approve and run reviewed changes' });
    assert.equal(await run.isDisabled(), true);
    await page.getByRole('checkbox').check(); await run.click();
    await page.getByText(/Changes are held for review/).waitFor();
    assert.equal(writes.length, 3); assert.equal(await run.isDisabled(), true);
    await page.getByRole('button', { name: 'Check outcome' }).click();
    await page.getByText(/Changes remain held/).waitFor(); assert.equal(outcomeReads, 1); assert.equal(writes.length, 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    expectedHandle = 'mock-performer-b'; await page.evaluate(() => window.renderProfile('mock-performer-b'));
    await page.getByRole('button', { name: 'Preview saved profile changes' }).click();
    await page.getByRole('checkbox').waitFor(); assert.equal(await page.getByRole('checkbox').isChecked(), false);
    approvalMode = 'lost'; await page.getByRole('checkbox').check(); await run.click();
    await page.getByText(/The outcome is unconfirmed/).waitFor(); assert.equal(await run.isDisabled(), true);
    assert.equal(writes.filter(item => item.path.endsWith('/run')).length, 1, 'Lost approval response must never run');
    bindings = []; expectedHandle = 'mock-performer-c'; await page.evaluate(() => window.renderProfile('mock-performer-c'));
    await page.getByText(/A verified business account bound to this profile is needed/).waitFor();
    assert.equal(await page.getByRole('checkbox').count(), 0);
    bindings = [{ id: 'mock-binding', ...proposal.proposal.scope }]; previewMode = 'held';
    expectedHandle = 'mock-performer-d'; await page.evaluate(() => window.renderProfile('mock-performer-d'));
    await page.getByRole('button', { name: 'Preview saved profile changes' }).click();
    await page.waitForTimeout(50); assert.ok(heldPreview);
    bindings = []; expectedHandle = 'mock-performer-e'; await page.evaluate(() => window.renderProfile('mock-performer-e'));
    await page.getByText(/A verified business account bound to this profile is needed/).waitFor();
    await heldPreview.fulfill({ json: proposal }).catch(() => {});
    assert.equal(await page.getByRole('checkbox').count(), 0, 'Late preview must not enter another performer scope');
    bindings = [{ id: 'mock-binding', ...proposal.proposal.scope }]; previewMode = 'normal';
    expectedHandle = 'mock-performer-f'; await page.evaluate(() => window.renderProfile('mock-performer-f'));
    await page.getByRole('button', { name: 'Preview saved profile changes' }).click();
    await page.getByRole('checkbox').check();
    previewMode = 'revoked'; await page.getByRole('button', { name: 'Preview saved profile changes' }).click();
    await page.getByText(/Access changed/).waitFor(); assert.equal(await page.getByRole('checkbox').count(), 0, 'Revocation clears private preview and consent');
    proposals = [{ ...proposal, id: 'mock-pending-inbound', status: null, proposal: { ...proposal.proposal, direction: 'social-to-native' } },
      ...['held', 'claimed', 'completed', 'reflected', 'denied'].map(status => ({ ...proposal, id: `mock-history-${status}`, status }))];
    const writesBeforeRecovery = writes.length;
    // A real reload mounts the fixture's initial performer and reloads durable server history.
    expectedHandle = 'mock-performer-a';
    await page.reload();
    await page.getByRole('button', { name: 'Review account changes', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Review account changes', exact: true }).isEnabled(), true, 'Actual DB LEFT JOIN status:null must permit pending inbound review');
    await page.getByRole('button', { name: 'Review account changes', exact: true }).click();
    await page.getByRole('checkbox').waitFor(); assert.equal(await page.getByRole('checkbox').isChecked(), false);
    const checks = page.getByRole('button', { name: 'Check saved outcome', exact: true });
    assert.equal(await checks.count(), 5, 'All durable history statuses must expose read-only recovery after reload');
    const readsBeforeRecovery = outcomeReads;
    for (let index = 0; index < 5; index++) { await checks.nth(index).click(); await page.getByText(/Changes remain held/).waitFor(); await checks.nth(index).waitFor({ state: 'visible' }); }
    assert.equal(outcomeReads - readsBeforeRecovery, 5); assert.equal(writes.length, writesBeforeRecovery, 'Saved outcome recovery must never approve or run');
    await page.getByText('Publishing to business accounts is unavailable. No publication will occur.', { exact: true }).waitFor();
    await page.close(); console.log(`PASS mocked Reverse Osmosis review, hold, recovery, scope reset and empty bindings at ${width}px`);
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
