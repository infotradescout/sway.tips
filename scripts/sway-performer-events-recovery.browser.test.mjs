import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Actual component, React, Vite and application CSS; synthetic loopback HTTP.
// This proves neither production account access nor durable saves or payments.
const directory = join('artifacts', 'readiness-223', `events-recovery-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const eventId = '97170e93-586b-4c8e-bbe3-151065932051';
const makeEvent = () => ({
  id: eventId, title: 'Recovery fixture show', description: 'Synthetic show only',
  startsAt: '2099-09-15T01:00:00.000Z', endsAt: '2099-09-15T04:00:00.000Z',
  doorOpensAt: null, timeZone: 'America/Chicago', locationName: 'Fixture hall',
  locationAddress: null, city: 'Fixture city', locationIsTba: false,
  coverImageUrl: null, ticketingMode: 'external',
  externalTicketUrl: 'https://tickets.example.test/show', externalTicketLabel: 'Get tickets',
  nativeTicket: null, visibility: 'public', status: 'draft', eventPath: null,
  updatedAt: '2026-09-06T00:00:00.000Z'
});
const closedCapability = { salesAvailable: false, reasonCodes: ['fixture_money_locked'] };
const readyCapability = { salesAvailable: true, feeBps: 1000, feeFixedCents: 0 };
const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const results = [];
let browser;
let vite;
let base;

async function run(name, viewport, configure, scenario) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const state = {
    event: makeEvent(), listPayload: null, listStatus: 200, holdList: false,
    capability: closedCapability, capabilityStatus: 200, holdCapability: false,
    capabilityFailure: false, allowPatch: false, calls: [], writes: [], unexpected: [],
    heldLists: [], heldCapabilities: [], errors: []
  };
  configure(state);
  page.on('pageerror', error => state.errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    if (!url.pathname.startsWith('/api/')) return route.continue();
    state.calls.push({ method: request.method(), path: url.pathname });
    if (url.pathname === '/api/talent/events' && request.method() === 'GET') {
      if (state.holdList) { state.heldLists.push(route); return; }
      return respond(route, state.listPayload ?? { events: [state.event] }, state.listStatus);
    }
    if (url.pathname === '/api/talent/events/native-ticket-capability' && request.method() === 'GET') {
      if (state.holdCapability) { state.heldCapabilities.push(route); return; }
      if (state.capabilityFailure) return route.abort('failed');
      return respond(route, { capability: state.capability }, state.capabilityStatus);
    }
    if (url.pathname === `/api/talent/events/${eventId}` && request.method() === 'PATCH' && state.allowPatch) {
      const body = request.postDataJSON();
      state.writes.push(body);
      assert.equal(body.expectedUpdatedAt, state.event.updatedAt);
      state.event = { ...state.event, ...body, updatedAt: '2026-09-06T00:00:01.000Z' };
      return respond(route, { event: state.event });
    }
    state.unexpected.push(`${request.method()} ${url.pathname}`);
    return respond(route, { error: 'Unexpected fixture endpoint' }, 500);
  });
  try {
    await page.goto(`${base}/scripts/browser-fixtures/sway-events-recovery.html`, { waitUntil: 'domcontentloaded' });
    await scenario(page, state);
    assert.deepEqual(state.unexpected, []);
    assert.deepEqual(state.errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Shows must not overflow horizontally');
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}x${viewport.height}.png`), fullPage: true });
    results.push({ name, viewport, status: 'PASS', requests: state.calls.length, writes: state.writes.length });
  } catch (error) {
    results.push({ name, viewport, status: 'FAIL', error: String(error), pageErrors: state.errors, unexpected: state.unexpected });
    await page.screenshot({ path: join(directory, `${name}-${viewport.width}x${viewport.height}-failure.png`), fullPage: true }).catch(() => undefined);
  } finally {
    await context.close();
    console.log('EVENT_RECOVERY_BROWSER_RESULT', JSON.stringify(results.at(-1)));
  }
}

const show = page => page.getByRole('heading', { name: 'Recovery fixture show', exact: true });
const edit = page => page.getByRole('button', { name: 'Edit', exact: true });
const title = page => page.getByLabel('Event title', { exact: true });
const refresh = page => page.getByRole('button', { name: 'Refresh shows', exact: true });
const retry = page => page.getByRole('button', { name: 'Try again', exact: true });
const nativeOption = page => page.locator('input[name="ticketingMode"][value="native_ga"]');

try {
  vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const address = vite.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  console.log(`EVENT_RECOVERY_BROWSER Chromium ${browser.version()}`);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1366, height: 768 }]) {
    await run('stalled-ticket-check-does-not-block-edit-save', viewport, state => {
      state.holdCapability = true;
      state.allowPatch = true;
    }, async (page, state) => {
      await show(page).waitFor({ state: 'visible' });
      assert.equal(await page.getByLabel('Loading events', { exact: true }).count(), 0);
      await edit(page).click();
      await title(page).fill('Edited fixture show');
      assert.equal(await nativeOption(page).isDisabled(), true);
      await page.getByRole('button', { name: 'Save event changes', exact: true }).click();
      await page.getByRole('heading', { name: 'Edited fixture show', exact: true }).waitFor({ state: 'visible' });
      assert.equal(await page.locator('#sway-event-editor').count(), 0);
      assert.equal(state.writes.length, 1);
      assert.equal(state.writes[0].title, 'Edited fixture show');
      assert.equal(state.writes[0].nativeTermsAccepted, undefined);
      await refresh(page).click();
      await page.getByLabel('Loading events', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(state.writes.length, 1, 'Read-only refresh must not repeat the save');
    });
    await run('ticket-check-failure-has-read-only-recovery', viewport, state => { state.capabilityFailure = true; }, async (page, state) => {
      await show(page).waitFor({ state: 'visible' });
      const retryTicket = page.getByRole('button', { name: 'Retry ticket check', exact: true });
      await retryTicket.waitFor({ state: 'visible' });
      state.capabilityFailure = false;
      await retryTicket.click();
      await retryTicket.waitFor({ state: 'hidden' });
      await show(page).waitFor({ state: 'visible' });
      assert.equal(state.writes.length, 0);
      assert.ok(state.calls.every(call => call.method === 'GET'));
    });
    await run('malformed-refresh-preserves-shows-and-unsaved-draft', viewport, () => {}, async (page, state) => {
      await show(page).waitFor({ state: 'visible' });
      await edit(page).click();
      await title(page).fill('Unsaved title stays here');
      state.listPayload = { events: null };
      await refresh(page).click();
      await page.getByRole('alert').filter({ hasText: 'Shows could not refresh' }).waitFor({ state: 'visible' });
      await show(page).waitFor({ state: 'visible' });
      assert.equal(await title(page).inputValue(), 'Unsaved title stays here');
      assert.equal(await page.getByRole('button', { name: 'Add your first upcoming show', exact: true }).count(), 0);
      state.listPayload = null;
      await retry(page).click();
      await page.getByRole('alert').waitFor({ state: 'hidden' });
      assert.equal(await title(page).inputValue(), 'Unsaved title stays here');
      assert.equal(state.writes.length, 0);
    });
    for (const endpoint of ['list', 'capability']) {
      await run(`${endpoint}-access-loss-clears-private-state`, viewport, () => {}, async (page, state) => {
        await show(page).waitFor({ state: 'visible' });
        await edit(page).click();
        await title(page).fill('Private unsaved draft');
        if (endpoint === 'list') state.listStatus = 401;
        else state.capabilityStatus = 403;
        await refresh(page).click();
        await page.getByRole('alert').filter({ hasText: 'Your access changed' }).waitFor({ state: 'visible' });
        assert.equal(await show(page).count(), 0);
        assert.equal(await page.locator('#sway-event-editor').count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Add event', exact: true }).isDisabled(), true);
        state.listStatus = 200;
        state.capabilityStatus = 200;
        await retry(page).click();
        await show(page).waitFor({ state: 'visible' });
        assert.equal(await page.getByRole('button', { name: 'Add event', exact: true }).isDisabled(), false);
        assert.equal(await page.locator('#sway-event-editor').count(), 0);
        assert.equal(state.writes.length, 0);
      });
    }
    await run('preview-transition-discards-live-state-and-late-replies', viewport, state => { state.holdCapability = true; }, async (page, state) => {
      await show(page).waitFor({ state: 'visible' });
      await edit(page).click();
      await title(page).fill('Private unsaved draft');
      const callsBefore = state.calls.length;
      await page.getByRole('button', { name: 'Toggle fixture preview', exact: true }).click();
      await page.getByText('Event management is read-only in demo mode. No event request will be sent.', { exact: true }).waitFor({ state: 'visible' });
      for (const route of state.heldCapabilities) await respond(route, { capability: readyCapability }).catch(() => undefined);
      assert.equal(await show(page).count(), 0);
      assert.equal(await page.locator('#sway-event-editor').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Add event', exact: true }).isDisabled(), true);
      assert.equal(state.calls.length, callsBefore);
      assert.equal(state.writes.length, 0);
    });
    await run('superseded-ticket-reply-cannot-restore-old-permission', viewport, state => { state.holdCapability = true; }, async (page, state) => {
      await show(page).waitFor({ state: 'visible' });
      const stale = [...state.heldCapabilities];
      state.holdCapability = false;
      await refresh(page).click();
      await page.getByLabel('Loading events', { exact: true }).waitFor({ state: 'hidden' });
      for (const route of stale) await respond(route, { capability: readyCapability }).catch(() => undefined);
      await page.getByRole('button', { name: 'Add event', exact: true }).click();
      assert.equal(await nativeOption(page).isDisabled(), true);
      assert.equal(state.writes.length, 0);
    });
  }
  await run('real-read-deadline-releases-spinner-and-allows-retry', { width: 390, height: 844 }, state => { state.holdList = true; }, async (page, state) => {
    await page.getByRole('alert').filter({ hasText: 'Shows could not refresh' }).waitFor({ state: 'visible', timeout: 22_000 });
    assert.equal(await page.getByLabel('Loading events', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Add your first upcoming show', exact: true }).count(), 0);
    state.holdList = false;
    await retry(page).click();
    await show(page).waitFor({ state: 'visible' });
    assert.equal(state.writes.length, 0);
  });
} finally {
  await browser?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
  const hashes = Object.fromEntries(['src/components/PerformerEventsManager.tsx', 'src/performer-event-reads.ts'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ hashes, limits: 'Real Chromium, actual Shows component and app stylesheet. Synthetic local replies, not full signed-in integration, real account permissions, durable database saves, payment providers or production.', results }, null, 2));
}
assert.equal(results.length, 22);
assert.equal(results.filter(result => result.status !== 'PASS').length, 0, 'Shows recovery browser failures');
console.log(`EVENT_RECOVERY_BROWSER_TOTAL ${results.length} PASS ${results.length} FAIL 0`);
