import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

const eventId = '22222222-2222-4222-8222-222222222222';
const legacyPendingActionKey = 'sway.pendingAction';
const longEventTitle = 'Friday Community Showcase with Crowdwork, Service Stories, and Local Hosts';

type FixtureRoomType = 'comedy' | 'service' | 'general';
type LegacyMode = 'foreign' | 'room-and-foreign' | 'matching';
type Scenario = {
  name: string;
  viewport: { width: number; height: number };
  orientation: 'portrait' | 'landscape';
  roomType: FixtureRoomType;
  gigId: string;
  directFixture: boolean;
  legacyMode: LegacyMode;
  languageLabel: string;
  languageIdentity: RegExp;
};

const scenarios: Scenario[] = [
  {
    name: '320px portrait',
    viewport: { width: 320, height: 844 },
    orientation: 'portrait',
    roomType: 'comedy',
    gigId: '11111111-1111-4111-8111-111111111101',
    directFixture: false,
    legacyMode: 'foreign',
    languageLabel: 'Comedy request menu',
    languageIdentity: /\bcomedian\b/i
  },
  {
    name: '390px portrait',
    viewport: { width: 390, height: 844 },
    orientation: 'portrait',
    roomType: 'service',
    gigId: '11111111-1111-4111-8111-111111111102',
    directFixture: true,
    legacyMode: 'room-and-foreign',
    languageLabel: 'Service request menu',
    languageIdentity: /\bservice professional\b/i
  },
  {
    name: '430px portrait',
    viewport: { width: 430, height: 932 },
    orientation: 'portrait',
    roomType: 'general',
    gigId: '11111111-1111-4111-8111-111111111103',
    directFixture: true,
    legacyMode: 'matching',
    languageLabel: 'Professional request menu',
    languageIdentity: /\bprofessional\b/i
  },
  {
    name: '844x390 landscape',
    viewport: { width: 844, height: 390 },
    orientation: 'landscape',
    roomType: 'service',
    gigId: '11111111-1111-4111-8111-111111111102',
    directFixture: true,
    legacyMode: 'foreign',
    languageLabel: 'Service request menu',
    languageIdentity: /\bservice professional\b/i
  }
];

const mobileChromiumUserAgent = 'Mozilla/5.0 (Linux; Android 14; Sway Wave 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

async function reservePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve generalized live-room test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function assertNoHorizontalOverflow(page: Page, surface: string) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  assert.ok(
    dimensions.document <= dimensions.viewport,
    `${surface} must fit the mobile viewport (${dimensions.document}px document vs ${dimensions.viewport}px viewport).`
  );
}

async function focusAndTapControl(page: Page, control: Locator, label: string) {
  await control.waitFor({ state: 'visible' });
  await control.scrollIntoViewIfNeeded();
  assert.equal(await control.isEnabled(), true, `${label} must be enabled before interaction.`);

  await control.focus();
  assert.equal(
    await control.evaluate((element) => document.activeElement === element),
    true,
    `${label} must accept focus.`
  );

  const hitTarget = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);
    return {
      bottom: rect.bottom,
      fontStatus: document.fonts.status,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
      insideViewport: rect.left >= 0
        && rect.top >= 0
        && rect.right <= window.innerWidth
        && rect.bottom <= window.innerHeight,
      receivesPointer: Boolean(hit && (hit === element || element.contains(hit)))
    };
  });

  assert.ok(hitTarget.width >= 44, `${label} must be at least 44 CSS pixels wide; received ${hitTarget.width}.`);
  assert.ok(hitTarget.height >= 44, `${label} must be at least 44 CSS pixels tall; received ${hitTarget.height}.`);
  assert.equal(
    hitTarget.insideViewport,
    true,
    `${label} must remain inside the active viewport after scrolling: ${JSON.stringify(hitTarget)}.`
  );
  assert.equal(hitTarget.receivesPointer, true, `${label} must win center-point hit testing.`);

  await control.tap();
}

function pendingPayload(gigId: string, suffix: string) {
  return {
    type: 'request',
    clientRequestId: `66666666-6666-4666-8666-6666666666${suffix}`,
    idempotencyKey: `legacy-${suffix}-${gigId}`,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    gigId,
    title: 'Pending room-scoped request'
  };
}

async function seedPendingStorage(context: BrowserContext, scenario: Scenario) {
  const foreignGigId = '99999999-9999-4999-8999-999999999999';
  const legacyPayload = pendingPayload(
    scenario.legacyMode === 'matching' ? scenario.gigId : foreignGigId,
    scenario.legacyMode === 'matching' ? '01' : '02'
  );
  const roomPayload = scenario.legacyMode === 'room-and-foreign'
    ? pendingPayload(scenario.gigId, '03')
    : null;

  await context.addInitScript(({ legacyKey, legacyValue, roomKey, roomValue }) => {
    window.localStorage.setItem(legacyKey, legacyValue);
    if (roomKey && roomValue) window.localStorage.setItem(roomKey, roomValue);
  }, {
    legacyKey: legacyPendingActionKey,
    legacyValue: JSON.stringify(legacyPayload),
    roomKey: roomPayload ? `${legacyPendingActionKey}:${scenario.gigId}` : null,
    roomValue: roomPayload ? JSON.stringify(roomPayload) : null
  });

  return {
    legacyValue: JSON.stringify(legacyPayload),
    roomValue: roomPayload ? JSON.stringify(roomPayload) : null
  };
}

async function installApiRoutes(context: BrowserContext, roomType: FixtureRoomType, gigId: string) {
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/health/network-probe') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (path === '/api/talent/events') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: [{
          id: eventId,
          title: longEventTitle,
          startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          endsAt: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(),
          status: 'published',
          ticketingMode: 'external',
          attendanceMode: 'external_ticket'
        }] })
      });
      return;
    }
    if (path === `/api/public/events/${eventId}`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ event: {
          id: eventId,
          title: longEventTitle,
          description: 'A long-form neighborhood program bringing together audience crowdwork, service stories, community announcements, and a closing discussion for guests across the city.',
          startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          doorOpensAt: null,
          endsAt: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(),
          timeZone: 'America/Chicago',
          location: {
            name: 'The Corner Stage and Community Gathering Hall',
            address: '100 Main Street, Accessible South Entrance',
            city: 'Chicago',
            isTba: false
          },
          coverImageUrl: null,
          attendanceMode: 'external_ticket',
          externalTicket: { url: 'https://tickets.example.test/community-showcase', label: 'Get tickets' },
          nativeTicket: null,
          activeRoom: { gigId, routePath: `/g/${gigId}`, roomType },
          status: 'published',
          visibility: 'public',
          eventPath: `/e/${eventId}`,
          performer: {
            displayName: roomType === 'comedy'
              ? 'Casey Crowdwork'
              : roomType === 'service'
                ? 'Jordan Service Desk'
                : 'Morgan Community Host',
            handle: `wave-four-${roomType}`,
            performerPath: `/p/wave-four-${roomType}`,
            avatarUrl: null,
            headline: roomType === 'comedy'
              ? 'Comedian and host'
              : roomType === 'service'
                ? 'Service professional and venue host'
                : 'Independent professional and community host'
          }
        } })
      });
      return;
    }
    if (path === '/api/payment/config') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ mode: 'unavailable', liveRoomMoneyEnabled: false, testModePlatformBalanceEnabled: false })
      });
      return;
    }
    const body = path.endsWith('/sources')
      ? { sources: [] }
      : path.endsWith('/tracks')
        ? { tracks: [] }
        : path.endsWith('/source-capabilities')
          ? { capabilities: [] }
          : {};
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function waitForEffects(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  }));
}

async function assertPendingStorageBoundary(
  page: Page,
  scenario: Scenario,
  seeded: { legacyValue: string; roomValue: string | null }
) {
  await waitForEffects(page);
  const storage = await page.evaluate(({ legacyKey, roomKey }) => ({
    legacy: window.localStorage.getItem(legacyKey),
    room: window.localStorage.getItem(roomKey)
  }), {
    legacyKey: legacyPendingActionKey,
    roomKey: `${legacyPendingActionKey}:${scenario.gigId}`
  });

  if (scenario.legacyMode === 'matching') {
    assert.equal(storage.legacy, null, 'Matching legacy action must be removed after room-scoped migration.');
    assert.equal(storage.room, seeded.legacyValue, 'Matching legacy action must migrate into the current room key.');
    return;
  }

  assert.equal(storage.legacy, seeded.legacyValue, 'A legacy action belonging to another room must remain untouched.');
  assert.equal(
    storage.room,
    seeded.roomValue,
    scenario.legacyMode === 'room-and-foreign'
      ? 'An existing room-scoped action must remain authoritative over the legacy key.'
      : 'A foreign legacy action must never be copied into the current room key.'
  );
}

async function runScenario(browser: Browser, baseUrl: string, scenario: Scenario) {
  const context = await browser.newContext({
    viewport: scenario.viewport,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    userAgent: mobileChromiumUserAgent,
    serviceWorkers: 'block'
  });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  try {
    const seeded = await seedPendingStorage(context, scenario);
    await installApiRoutes(context, scenario.roomType, scenario.gigId);
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const networkProbe = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/health/network-probe');
    const query = scenario.directFixture ? `?started=true&roomType=${scenario.roomType}` : '';
    await page.goto(`${baseUrl}/scripts/browser-fixtures/sway-generalized-live-room.html${query}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });

    const deviceEvidence = await page.evaluate(() => ({
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
      landscape: window.matchMedia('(orientation: landscape)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
      mobileUserAgent: /Mobile|Android/i.test(navigator.userAgent)
    }));
    assert.ok(deviceEvidence.maxTouchPoints > 0, `${scenario.name} must run with touch input enabled.`);
    assert.equal(deviceEvidence.coarsePointer, true, `${scenario.name} must expose a coarse mobile pointer.`);
    assert.equal(deviceEvidence.mobileUserAgent, true, `${scenario.name} must use a mobile user agent.`);
    assert.equal(
      deviceEvidence.landscape,
      scenario.orientation === 'landscape',
      `${scenario.name} must render in the requested orientation.`
    );
    assert.equal(
      await page.locator('[data-nextjs-dialog], .vite-error-overlay, #webpack-dev-server-client-overlay').count(),
      0,
      `${scenario.name} must not render a framework error overlay.`
    );

    if (!scenario.directFixture) {
      await page.locator('[data-sway-performer-room-setup="true"]').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Comedy/ }).click();
      await page.getByText('This room is free-only.', { exact: false }).waitFor({ state: 'visible' });
      assert.equal(await page.getByRole('button', { name: /Paid requests/ }).count(), 0, 'Comedy setup must expose no paid-request control.');
      await assertNoHorizontalOverflow(page, `${scenario.name} room setup`);

      await page.getByRole('button', { name: /Next/ }).click();
      await page.getByRole('button', { name: /Add/ }).click();
      await page.getByLabel('Title').fill("Audience story prompt for the comedian's closing crowdwork segment");
      await page.getByLabel('Description').fill('Suggest a respectful, specific audience story with enough context for thoughtful crowdwork while protecting every guest from targeted or demeaning requests.');
      await page.getByRole('button', { name: /Next/ }).click();
      await page.locator('select').selectOption(eventId);
      await page.locator('p').filter({ hasText: /Friday Community Showcase.*Tickets elsewhere/ }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Next/ }).click();
      await page.getByRole('button', { name: 'Create room' }).click();
    }

    const setupOutput = page.locator('[data-sway-room-setup-proof="true"]');
    await setupOutput.waitFor({ state: 'attached' });
    await networkProbe;
    const setup = JSON.parse(await setupOutput.textContent() || '{}');
    assert.equal(setup.gig_id, scenario.gigId);
    assert.equal(setup.roomType, scenario.roomType);
    assert.equal(setup.paymentsEnabled, false);
    assert.equal(setup.linkedEventId, eventId);
    assert.ok(setup.requestMenu[0].title.length > 50, 'Fixture menu title must exercise realistic long content.');
    assert.ok(setup.requestMenu[0].description.length > 100, 'Fixture menu description must exercise realistic long content.');
    await assertPendingStorageBoundary(page, scenario, seeded);

    const initialPatronText = await page.locator('#patron_crowd_screen').innerText();
    assert.match(initialPatronText, /Live room snapshot/i, `${scenario.name} nonmusic room must use room-aware snapshot copy.`);
    assert.doesNotMatch(initialPatronText, /Live show snapshot/i, `${scenario.name} nonmusic room must not retain music-only snapshot copy.`);

    await page.getByRole('button', { name: 'Request', exact: true }).filter({ visible: true }).first().click();
    await page.getByText(scenario.languageLabel, { exact: true }).waitFor({ state: 'visible' });
    const patronText = await page.locator('#patron_crowd_screen').innerText();
    assert.match(patronText, scenario.languageIdentity, `${scenario.roomType} room must name the correct professional identity.`);
    assert.doesNotMatch(
      patronText,
      /track requests|performer approvals|Browse active performers and DJs|DJ library requests|Setlist song requests/i,
      `${scenario.roomType} room must not expose music-only performer, DJ, or track language.`
    );

    await page.getByRole('button', { name: 'Upvote', exact: true }).click();
    await page.getByText('No approved requests yet', { exact: true }).waitFor({ state: 'visible' });
    const queueText = await page.locator('#patron_crowd_screen').innerText();
    assert.match(queueText, scenario.languageIdentity, `${scenario.roomType} queue must retain room-specific professional language.`);
    assert.doesNotMatch(
      queueText,
      /track requests|performer approvals|Browse active performers and DJs|DJ library requests|Setlist song requests/i,
      `${scenario.roomType} queue must not regress to music-only performer, DJ, or track language.`
    );
    await page.getByRole('button', { name: 'Request', exact: true }).last().click();

    const firstMenuItem = setup.requestMenu[0];
    const selectMenuItem = page.locator(`[data-sway-select-menu-item="${firstMenuItem.id}"]`);
    await focusAndTapControl(page, selectMenuItem, `${scenario.name} menu selection`);
    assert.equal(await selectMenuItem.getAttribute('aria-pressed'), 'true');
    await focusAndTapControl(
      page,
      page.locator(`[data-sway-report-menu-item="${firstMenuItem.id}"]`),
      `${scenario.name} menu report`
    );
    const reportOutput = page.locator('[data-sway-menu-report-proof="true"]');
    await page.waitForFunction(() => Boolean(document.querySelector('[data-sway-menu-report-proof="true"]')?.textContent));
    const report = JSON.parse(await reportOutput.textContent() || '{}');
    assert.deepEqual(report, {
      gig_id: scenario.gigId,
      menu_item_id: firstMenuItem.id,
      reason: 'Host menu item safety report',
      details: 'Patron requested safety review of a host-authored room menu item.'
    });

    if (scenario.roomType === 'comedy') {
      await page.getByLabel('Your Name / Group').fill('Table Seven');
      await page.getByRole('button', { name: 'Send Free Request' }).click();
      const dialog = page.locator('[data-sway-payment-dialog="true"]');
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByRole('button', { name: 'Confirm Request' }).click();

      const requestOutput = page.locator('[data-sway-patron-request-proof="true"]');
      await page.waitForFunction(() => Boolean(document.querySelector('[data-sway-patron-request-proof="true"]')?.textContent));
      const request = JSON.parse(await requestOutput.textContent() || '{}');
      assert.equal(request.type, 'request');
      assert.equal(request.targetType, 'custom');
      assert.equal(request.menu_item_id, firstMenuItem.id);
      assert.equal(request.title, firstMenuItem.title);
      assert.equal(request.subtitle, firstMenuItem.description);
      assert.equal(request.amount, 0);
      assert.equal(request.gig_id, scenario.gigId);
      assert.equal(await page.getByText('Tip Amount').count(), 0, 'Free comedy request must expose no tip amount control.');
    }

    const scrollEvidence = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight
    }));
    assert.ok(
      scrollEvidence.scrollHeight > scrollEvidence.viewportHeight,
      `${scenario.name} fixture must exercise a vertically scrollable patron room.`
    );
    await assertNoHorizontalOverflow(page, `${scenario.name} ${scenario.roomType} patron room`);
    await focusAndTapControl(
      page,
      page.locator('[data-sway-open-event-proof="true"]'),
      `${scenario.name} event navigation`
    );
    await page.getByRole('heading', { name: longEventTitle }).waitFor({ state: 'visible' });
    const liveRoomLink = page.getByRole('link', { name: 'Join live room' });
    assert.equal(await liveRoomLink.getAttribute('href'), `/g/${scenario.gigId}`);
    const ticketLink = page.getByRole('link', { name: /Get tickets on external ticket site/ });
    assert.equal(await ticketLink.getAttribute('href'), `/api/public/events/${eventId}/ticket`);
    assert.equal(await ticketLink.getAttribute('target'), '_blank');
    await page.getByText('You are leaving Sway. Checkout, charges, ticket delivery, admission, transfers, cancellations, refunds, and support are handled under the external ticket provider’s policies.').waitFor({ state: 'visible' });
    await assertNoHorizontalOverflow(page, `${scenario.name} public event`);
    assert.deepEqual(pageErrors, [], `${scenario.roomType} journey raised page errors:\n${pageErrors.join('\n')}`);
    assert.deepEqual(consoleErrors, [], `${scenario.roomType} journey raised console errors:\n${consoleErrors.join('\n')}`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function main() {
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;

  try {
    const port = await reservePort();
    vite = await createViteServer({
      root: process.cwd(),
      logLevel: 'silent',
      server: { host: '127.0.0.1', port, strictPort: true }
    });
    await vite.listen();

    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    const baseUrl = `http://127.0.0.1:${port}`;
    for (const scenario of scenarios) {
      await runScenario(browser, baseUrl, scenario);
    }

    console.log('Sway generalized live-room browser journey passed in touch/mobile Chromium at 320px, 390px, and 430px portrait plus 844x390 landscape.');
  } finally {
    await browser?.close().catch(() => undefined);
    await vite?.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
