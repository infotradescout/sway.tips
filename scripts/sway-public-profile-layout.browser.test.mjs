import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Browser-boundary proof: the real patron entrypoint, profile component, styles,
// DOM events, and fetch calls run in Chromium. All identities/API responses and
// artwork below are synthetic local fixtures. This is not DB/auth/provider proof.
const directory = join('artifacts', 'public-profile-layout', `browser-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const labels = { identity: 'Profile header', about: 'About', live: 'Live room', events: 'Shows & events', releases: 'Releases', media: 'Featured performances', links: 'Links', booking: 'Booking', social: 'Social links' };
const defaults = {
  musician: ['identity', 'releases', 'links', 'media', 'live', 'events', 'about', 'booking', 'social'],
  comedian: ['identity', 'media', 'events', 'booking', 'live', 'about', 'links', 'releases', 'social'],
  dj: ['identity', 'live', 'media', 'events', 'booking', 'links', 'releases', 'about', 'social']
};
const viewports = [{ width: 390, height: 844 }, { width: 1440, height: 1000 }];
const results = [];
const respond = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const contentOrder = page => page.locator('[data-profile-section]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-profile-section')));
const tileOrder = page => page.locator('[data-arrange-target]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-arrange-target')));
const until = async (predicate, message) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
};
const layout = (sectionOrder, revision = 0, customized = false) => ({ sectionOrder: [...sectionOrder], revision, customized });
function fixture(role) {
  const handle = `layout-proof-${role}`;
  const performer = {
    displayName: `Synthetic ${role} fixture`, stageName: null, handle,
    primaryRole: role, roles: [role], bio: `Synthetic ${role} profile for local browser acceptance. This fixture exercises real profile layout and never represents a real person.`,
    headline: role === 'musician' ? 'Original songs and stories.' : role === 'comedian' ? 'Stand-up, stories, and live shows.' : 'Live sets, mixes, and private events.',
    specialties: role === 'dj' ? ['Open format', 'Private events', 'Live mixing'] : role === 'comedian' ? ['Stand-up', 'Event hosting'] : ['Songwriting', 'Live music'],
    city: 'Local fixture', avatarUrl: '/__layout-proof/avatar.svg',
    booking: { email: 'booking@sway.test', phone: '+1 555 010 0200', available: true, verificationRequired: false },
    socialLinks: { instagram: 'https://example.test/synthetic-instagram', website: 'https://example.test/synthetic-website' },
    links: [{ label: 'Official fixture website', description: 'Synthetic link; never opened by the test.', url: 'https://example.test/fixture', kind: 'other', sortOrder: 0 }],
    featuredMedia: role === 'musician' ? [] : [{ kind: 'youtube', title: 'Synthetic performance sample', description: 'Local stand-in for embedded media.', url: 'https://www.youtube.com/watch?v=fixture', embedUrl: 'https://www.youtube-nocookie.com/embed/layout-proof', sortOrder: 0 }],
    partner: { active: false, kind: null, termsVersion: null }, isPreview: false, claimState: 'claimed', layout: layout(defaults[role])
  };
  const event = {
    id: 'layout-proof-event', title: 'Synthetic upcoming show', description: 'Fixture show only.', startsAt: '2099-10-10T01:00:00Z', doorOpensAt: null, endsAt: '2099-10-10T03:00:00Z', timeZone: 'America/Chicago',
    location: { name: 'Fixture stage', address: null, city: 'Local fixture', isTba: false }, coverImageUrl: null, externalTicket: null, nativeTicket: null, status: 'published', visibility: 'public', eventPath: '/e/layout-proof-event',
    performer: { displayName: performer.displayName, handle, performerPath: `/p/${handle}`, avatarUrl: null, headline: performer.headline }
  };
  const release = { id: 'layout-proof-release', title: 'Synthetic release', primaryArtistName: performer.displayName, releaseType: 'single', status: 'published', scheduledReleaseAt: null, publishedAt: '2026-01-01T00:00:00Z', releasePath: '/r/layout-proof-release', artworkUrl: null, creationTags: [], humanWrittenLyrics: false, originalVirtualArtist: false, fullyGenerated: false };
  return { performer, activeRoom: role === 'dj' ? { routePath: '/g/00000000-0000-4000-8000-000000000001', talentRole: 'DJ', requestCount: 3 } : null, events: role === 'musician' ? [] : [event], releases: role === 'comedian' ? [] : [release] };
}
function visibleKeys(profile) {
  const p = profile.performer;
  return new Set(['identity', ...(p.bio ? ['about'] : []), ...(profile.activeRoom ? ['live'] : []), ...(profile.events.length ? ['events'] : []), ...(profile.releases.length ? ['releases'] : []), ...(p.featuredMedia.length ? ['media'] : []), ...(p.links.length ? ['links'] : []), ...(p.booking.available || p.booking.verificationRequired ? ['booking'] : []), ...(Object.values(p.socialLinks).some(Boolean) ? ['social'] : [])]);
}
async function expectOrder(page, expected, visible = null) {
  const target = visible ? expected.filter(key => visible.has(key)) : expected;
  await until(async () => JSON.stringify(await contentOrder(page)) === JSON.stringify(target), `Rendered section order must equal ${JSON.stringify(target)}; got ${JSON.stringify(await contentOrder(page))}`);
  assert.deepEqual(await contentOrder(page), target);
}
async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  // Bring lazy-loaded content into view before accepting a full-page screenshot.
  await page.evaluate(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight) { scrollTo(0, y); await frame(); }
    scrollTo(0, 0);
  });
  await page.waitForFunction(() => [...document.querySelectorAll('main img')].every(image => image.complete && image.naturalWidth > 0)
    && [...document.querySelectorAll('main [style*="opacity"]')].every(node => Number(getComputedStyle(node).opacity) >= .99));
  if (await page.locator('iframe').count()) await page.frameLocator('iframe').getByText('Synthetic media fixture', { exact: true }).waitFor();
}
async function dragTile(page, from, to, touch) {
  const grip = button(page, `Move ${labels[from]}`), target = page.locator(`[data-arrange-target="${to}"]`);
  await grip.scrollIntoViewIfNeeded();
  const a = await grip.boundingBox(), b = await target.boundingBox();
  assert.ok(a && b, 'Both drag endpoints must be rendered');
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width / 2, y: b.y + Math.min(25, b.height / 2) };
  assert.ok(end.y >= 0 && end.y <= page.viewportSize().height, 'Drag target must be inside the real viewport');
  if (touch) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1, radiusX: 2, radiusY: 2, force: 1 }] });
      for (let step = 1; step <= 12; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * step / 12, y: start.y + (end.y - start.y) * step / 12, id: 1, radiusX: 2, radiusY: 2, force: 1 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await session.detach(); }
  } else {
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up();
  }
}
let vite, browser, base;
async function run(name, viewport, role, configure, scenario) {
  const context = await browser.newContext({ viewport, isMobile: viewport.width === 390, hasTouch: viewport.width === 390, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
  const data = fixture(role);
  const state = { data, owner: true, saved: structuredClone(data.performer.layout), publicStatus: 200, publicReads: 0, postMode: 'normal', reads: 0, writes: [], pageErrors: [], unexpected: [], blockedExistingSdkLoads: [], interactions: [] };
  configure(state);
  page.on('pageerror', error => state.pageErrors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== base) {
      // The existing patron shell imports @stripe/stripe-js through PatronView;
      // that package eagerly inserts its SDK even on a profile route. Record and
      // block this known read without opening any payment/provider connection.
      if (url.origin === 'https://js.stripe.com' && request.resourceType() === 'script' && method === 'GET') {
        state.blockedExistingSdkLoads.push(url.href); return route.abort('blockedbyclient');
      }
      if (url.origin === 'https://fonts.googleapis.com' && request.resourceType() === 'stylesheet') return route.fulfill({ contentType: 'text/css', body: '/* External fonts omitted for deterministic offline fixture. */' });
      if (url.href === 'https://www.youtube-nocookie.com/embed/layout-proof') return route.fulfill({ contentType: 'text/html', body: '<body style="background:#090d19;color:#a5b4fc;font:16px sans-serif;display:grid;place-items:center;height:90vh">Synthetic media fixture</body>' });
      state.unexpected.push(`${method} ${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
    }
    if (url.pathname === '/__layout-proof/avatar.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="#17132e"/><circle cx="120" cy="88" r="35" fill="#9087af"/><path d="M40 240v-36a80 80 0 0 1 160 0v36" fill="#655681"/></svg>' });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (method === 'POST' && url.pathname === '/api/analytics/shell') return respond(route, { ok: true });
    if (method === 'GET' && url.pathname === `/api/public/performer/${data.performer.handle}`) {
      state.publicReads++;
      return respond(route, state.publicStatus === 200 ? { ...data, performer: { ...data.performer, layout: state.saved } } : { error: 'Synthetic unavailable profile response.' }, state.publicStatus);
    }
    if (url.pathname === '/api/talent/profile/layout' && method === 'GET') {
      state.reads++;
      assert.equal(url.searchParams.get('handle'), data.performer.handle);
      return respond(route, state.owner ? { handle: data.performer.handle, layout: state.saved } : { error: 'Synthetic anonymous session.' }, state.owner ? 200 : 401);
    }
    if (url.pathname === '/api/talent/profile/layout' && method === 'POST') {
      const body = request.postDataJSON(); state.writes.push(body);
      assert.deepEqual(Object.keys(body).sort(), ['expectedRevision', 'handle', 'sectionOrder']);
      assert.equal(body.handle, data.performer.handle);
      assert.equal(typeof body.expectedRevision, 'number');
      if (state.postMode === 'abort') return route.abort('failed');
      if (state.postMode === 'denied') { state.owner = false; return respond(route, { error: 'Your access changed.' }, 403); }
      if (body.expectedRevision !== state.saved.revision) return respond(route, { error: 'This profile layout changed elsewhere.', code: 'profile_layout_conflict', handle: data.performer.handle, layout: state.saved }, 409);
      assert.ok(body.sectionOrder === null || (Array.isArray(body.sectionOrder) && body.sectionOrder.length === 9 && new Set(body.sectionOrder).size === 9 && body.sectionOrder.every(id => id in labels)));
      state.saved = layout(body.sectionOrder ?? defaults[role], state.saved.revision + 1, body.sectionOrder !== null);
      return respond(route, { handle: data.performer.handle, layout: state.saved });
    }
    state.unexpected.push(`${method} ${url.pathname}`); return respond(route, { error: 'Unexpected synthetic fixture request.' }, 500);
  });
  let record;
  try {
    await page.goto(`${base}/p/${data.performer.handle}`, { waitUntil: 'domcontentloaded' });
    if (state.publicStatus === 200) {
      await page.locator('[data-profile-section="identity"]').waitFor();
      await until(() => state.reads > 0, 'Ownership probe must run');
    } else await until(() => state.publicReads > 0, 'Public profile request must run');
    await scenario(page, state);
    await settle(page);
    assert.deepEqual(state.pageErrors, [], 'No browser runtime errors');
    assert.deepEqual(state.unexpected, [], 'No unexpected API/provider effects');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Profile must fit the viewport');
    const screenshot = join(directory, `${name}-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    if (name.startsWith('public-')) await page.screenshot({ path: join(directory, `${name}-${viewport.width}-viewport.png`) });
    record = { name, viewport, role, passed: true, writes: state.writes, blockedExistingSdkLoads: state.blockedExistingSdkLoads, interactions: state.interactions, sectionOrder: await contentOrder(page), screenshot };
  } catch (error) {
    const screenshot = join(directory, `${name}-${viewport.width}-failed.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    record = { name, viewport, role, passed: false, error: String(error), pageErrors: state.pageErrors, unexpected: state.unexpected, writes: state.writes, sectionOrder: await contentOrder(page).catch(() => []), screenshot };
  } finally { await context.close(); results.push(record); console.log('PROFILE_LAYOUT_BROWSER_RESULT', JSON.stringify(record)); }
}
try {
  vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0, watch: null }, plugins: [{
    name: 'synthetic-profile-patron-entry', configureServer(server) {
      // The production server selects this same existing patron shell for /p/.
      // Vite alone has no server route selector, so map that bounded HTML entry.
      server.middlewares.use((request, _response, next) => { if (request.url?.startsWith('/p/layout-proof-')) request.url = '/shells/patron.html'; next(); });
    }
  }] });
  await vite.listen(); const address = vite.httpServer.address(); assert.ok(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  for (const viewport of viewports) {
    for (const role of ['musician', 'comedian', 'dj']) await run(`public-${role}`, viewport, role, state => { state.owner = false; }, async (page, state) => {
      await expectOrder(page, defaults[role], visibleKeys(state.data));
      const action = page.locator('[data-profile-section="identity"] a');
      assert.equal(await action.count(), 1, 'A role-appropriate primary action is clear');
      assert.equal(await action.getAttribute('href'), role === 'dj' ? state.data.activeRoom.routePath : role === 'comedian' ? state.data.performer.featuredMedia[0].url : state.data.releases[0].releasePath);
      assert.equal(await button(page, 'Arrange profile').count(), 0);
      assert.equal(await page.locator('[data-arrange-target]').count(), 0);
      assert.equal(state.writes.length, 0);
    });
    await run('owner-move-save-reload', viewport, 'dj', () => {}, async (page, state) => {
      await button(page, 'Arrange profile').click();
      const expected = [...defaults.dj]; [expected[0], expected[1]] = [expected[1], expected[0]];
      await button(page, 'Move Live room earlier').click();
      await expectOrder(page, expected);
      assert.deepEqual(await tileOrder(page), expected);
      assert.equal(state.writes.length, 0, 'Rearranging must remain a draft before Save');
      await button(page, 'Save layout').click();
      await button(page, 'Arrange profile').waitFor();
      assert.deepEqual(state.saved.sectionOrder, expected);
      assert.equal(state.writes.length, 1);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expectOrder(page, expected);
      await button(page, 'Arrange profile').click();
      await button(page, 'Move Live room later').click();
      await expectOrder(page, defaults.dj);
      await button(page, 'Cancel').click();
      await expectOrder(page, expected);
      assert.equal(state.writes.length, 1, 'Cancel cannot send a write');
    });
    await run('owner-native-drag', viewport, 'dj', () => {}, async (page, state) => {
      await button(page, 'Arrange profile').click();
      await dragTile(page, 'identity', 'live', viewport.width === 390);
      const expected = [...defaults.dj]; [expected[0], expected[1]] = [expected[1], expected[0]];
      await expectOrder(page, expected);
      assert.deepEqual(await tileOrder(page), expected);
      await dragTile(page, 'identity', 'events', viewport.width === 390);
      expected.splice(expected.indexOf('identity'), 1);
      expected.splice(expected.indexOf('events') + 1, 0, 'identity');
      await expectOrder(page, expected);
      assert.deepEqual(await tileOrder(page), expected);
      state.interactions.push(viewport.width === 390 ? 'Chromium native touchStart/touchMove/touchEnd' : 'Chromium native mouse pointer drag');
      state.interactions.push('Adjacent drag followed by a nonadjacent drag across tile rows');
      assert.equal(state.writes.length, 0);
      await settle(page);
      await page.screenshot({ path: join(directory, `owner-drag-board-${viewport.width}.png`), fullPage: true });
      await page.screenshot({ path: join(directory, `owner-drag-board-${viewport.width}-viewport.png`) });
      await button(page, 'Save layout').click(); await button(page, 'Arrange profile').waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' }); await expectOrder(page, expected);
      assert.equal(state.writes.length, 1);
    });
    await run('keyboard-reorder-retains-focus', viewport, 'dj', () => {}, async (page, state) => {
      await button(page, 'Arrange profile').click();
      const control = button(page, 'Move Featured performances earlier');
      await control.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
      assert.equal(await control.evaluate(node => document.activeElement === node), true, 'Keyboard Tab reaches the reorder control');
      await page.keyboard.press('Enter');
      const expected = [...defaults.dj]; [expected[1], expected[2]] = [expected[2], expected[1]];
      await expectOrder(page, expected);
      assert.equal(await control.evaluate(node => document.activeElement === node), true, 'Moving a tile retains keyboard focus');
      state.interactions.push('Native ShiftTab, Tab, Enter with focus retained after move');
      await button(page, 'Cancel').click(); await expectOrder(page, defaults.dj); assert.equal(state.writes.length, 0);
    });
    await run('share-fallback-does-not-steal-reorder-focus', viewport, 'dj', () => {}, async (page, state) => {
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Synthetic clipboard failure'); } } });
      });
      await button(page, 'Share').click(); await page.getByLabel('Profile link to copy', { exact: true }).waitFor();
      await button(page, 'Arrange profile').click();
      const control = button(page, 'Move Featured performances earlier');
      await control.focus(); await page.keyboard.press('Enter');
      const expected = [...defaults.dj]; [expected[1], expected[2]] = [expected[2], expected[1]];
      await expectOrder(page, expected);
      assert.equal(await control.evaluate(node => document.activeElement === node), true, 'An already displayed share fallback must not steal focus on a later layout update');
      assert.equal(state.writes.length, 0);
      await button(page, 'Cancel').click(); await expectOrder(page, defaults.dj);
    });
    await run('long-public-copy-fits-sections', viewport, 'dj', state => {
      state.owner = false;
      state.data.performer.headline = 'W'.repeat(140);
      state.data.performer.bio = 'W'.repeat(240);
      state.data.performer.links[0].label = 'W'.repeat(80);
      state.data.performer.featuredMedia[0].title = 'W'.repeat(120);
    }, async (page, state) => {
      await expectOrder(page, defaults.dj);
      const overflowing = await page.locator('[data-profile-section]').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => ({ section: node.getAttribute('data-profile-section'), width: node.clientWidth, scrollWidth: node.scrollWidth })));
      assert.deepEqual(overflowing, [], 'Valid single-token profile copy must wrap inside its section');
      assert.equal(state.writes.length, 0);
    });
    await run('reset-suggested-with-cancel', viewport, 'dj', state => { state.saved = layout([...defaults.dj].reverse(), 4, true); }, async (page, state) => {
      const prior = [...state.saved.sectionOrder];
      await button(page, 'Arrange profile').click(); await button(page, 'Use suggested layout').click();
      await expectOrder(page, defaults.dj); assert.equal(state.writes.length, 0);
      await button(page, 'Cancel').click(); await expectOrder(page, prior);
      await button(page, 'Arrange profile').click(); await button(page, 'Use suggested layout').click();
      await button(page, 'Save layout').click(); await button(page, 'Arrange profile').waitFor();
      assert.equal(state.writes[0].sectionOrder, null); assert.equal(state.writes[0].expectedRevision, 4);
      assert.equal(state.saved.customized, false);
      await page.reload({ waitUntil: 'domcontentloaded' }); await expectOrder(page, defaults.dj);
    });
    await run('failed-save-retains-draft-retry', viewport, 'dj', state => { state.postMode = 'abort'; }, async (page, state) => {
      await button(page, 'Arrange profile').click(); await button(page, 'Move Live room earlier').click();
      const draft = await contentOrder(page);
      await button(page, 'Save layout').click(); await until(() => state.writes.length === 1, 'Failed save must be sent once');
      await until(async () => await button(page, 'Save layout').isEnabled(), 'Failure must preserve a retry action');
      await expectOrder(page, draft); assert.deepEqual(state.saved.sectionOrder, defaults.dj);
      assert.equal(state.writes.length, 1, 'No automatic resubmission');
      state.postMode = 'normal'; await button(page, 'Save layout').click(); await button(page, 'Arrange profile').waitFor();
      assert.equal(state.writes.length, 2); assert.deepEqual(state.writes[0], state.writes[1]);
      await page.reload({ waitUntil: 'domcontentloaded' }); await expectOrder(page, draft);
    });
    await run('stale-save-keeps-draft-until-reload', viewport, 'dj', () => {}, async (page, state) => {
      await button(page, 'Arrange profile').click(); await button(page, 'Move Live room earlier').click();
      const draft = await contentOrder(page);
      state.saved = layout([...defaults.dj].reverse(), 2, true);
      await button(page, 'Save layout').click(); await button(page, 'Reload saved layout').waitFor();
      await expectOrder(page, draft); assert.equal(state.writes.length, 1); assert.equal(state.writes[0].expectedRevision, 0);
      await button(page, 'Reload saved layout').click();
      await expectOrder(page, state.saved.sectionOrder);
      assert.equal(state.writes.length, 1, 'Conflict recovery must not repeat a write');
    });
    await run('stale-save-rebases-draft-before-explicit-save', viewport, 'dj', () => {}, async (page, state) => {
      await button(page, 'Arrange profile').click(); await button(page, 'Move Live room earlier').click();
      const draft = await contentOrder(page);
      state.saved = layout([...defaults.dj].reverse(), 2, true);
      await button(page, 'Save layout').click(); await button(page, 'Keep my arrangement').waitFor();
      await expectOrder(page, draft);
      await button(page, 'Keep my arrangement').click();
      await until(async () => await button(page, 'Save layout').isEnabled(), 'Successful rebase allows explicit Save');
      await expectOrder(page, draft); assert.equal(state.writes.length, 1, 'Keeping a draft must not write it automatically');
      assert.equal(state.saved.revision, 2);
      await button(page, 'Save layout').click(); await button(page, 'Arrange profile').waitFor();
      assert.equal(state.writes.length, 2); assert.equal(state.writes[1].expectedRevision, 2);
      assert.deepEqual(state.writes[1].sectionOrder, draft);
      await page.reload({ waitUntil: 'domcontentloaded' }); await expectOrder(page, draft);
    });
    await run('revoked-access-removes-edit-controls', viewport, 'dj', state => { state.postMode = 'denied'; }, async (page, state) => {
      await button(page, 'Arrange profile').click(); await button(page, 'Move Live room earlier').click(); await button(page, 'Save layout').click();
      await until(async () => await button(page, 'Save layout').count() === 0, '403 must leave edit mode');
      await expectOrder(page, defaults.dj);
      assert.equal(await button(page, 'Arrange profile').count(), 0); assert.equal(await page.locator('[data-arrange-target]').count(), 0);
      assert.equal(state.writes.length, 1);
    });
    await run('locked-booking-survives-reorder', viewport, 'musician', state => {
      state.data.performer.booking = { email: null, phone: null, available: false, verificationRequired: true };
      state.data.performer.claimState = 'pending';
    }, async (page, state) => {
      await button(page, 'Arrange profile').click();
      await button(page, 'Move Booking earlier').click();
      assert.equal(await page.locator('a[href^="mailto:"], a[href^="tel:"]').count(), 0);
      await button(page, 'Save layout').click(); await button(page, 'Arrange profile').waitFor();
      assert.match(await page.locator('[data-profile-section="booking"]').innerText(), /claims? and verifies|verif/i);
      assert.equal(await page.locator('a[href^="mailto:"], a[href^="tel:"]').count(), 0);
      assert.equal(state.writes.length, 1);
      assert.equal(await page.locator('[data-profile-section="live"], [data-profile-section="events"], [data-profile-section="media"]').count(), 0, 'Empty sections remain absent after reordering');
    });
    for (const native of [false, true]) await run(native ? 'native-share-error-selectable-link' : 'clipboard-error-selectable-link', viewport, 'musician', state => { state.owner = false; }, async (page, state) => {
      await page.evaluate(native => {
        Object.defineProperty(navigator, 'share', { configurable: true, value: native ? async () => { throw new Error('Synthetic native share failure'); } : undefined });
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Synthetic clipboard failure'); } } });
      }, native);
      await button(page, 'Share').click();
      const input = page.getByLabel('Profile link to copy', { exact: true });
      await input.waitFor();
      const expected = `${base}/p/${state.data.performer.handle}`;
      assert.equal(await input.inputValue(), expected);
      assert.equal(await input.evaluate(node => node.selectionEnd - node.selectionStart), expected.length, 'Fallback must select the complete address');
      assert.equal(state.writes.length, 0);
    });
    await run('public-load-error-retry', viewport, 'musician', state => { state.publicStatus = 503; state.owner = false; }, async (page, state) => {
      await page.getByRole('heading', { name: 'Profile could not load', exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Profile unavailable', exact: true }).count(), 0);
      state.publicStatus = 200;
      await button(page, 'Try again').click(); await expectOrder(page, defaults.musician, visibleKeys(state.data));
      assert.ok(state.publicReads >= 2); assert.equal(state.writes.length, 0);
    });
    await run('public-404-has-no-profile-or-owner-controls', viewport, 'musician', state => { state.publicStatus = 404; state.owner = false; }, async (page, state) => {
      await page.getByRole('heading', { name: 'Profile unavailable', exact: true }).waitFor();
      assert.equal(await button(page, 'Arrange profile').count(), 0);
      assert.equal(await button(page, 'Try again').count(), 0);
      assert.deepEqual(await contentOrder(page), []); assert.equal(state.reads, 0); assert.equal(state.writes.length, 0);
    });
  }
} finally {
  await browser?.close(); await vite?.close();
  const source = 'src/components/PerformerPublicProfilePage.tsx';
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ evidenceBoundary: 'Real patron UI with synthetic intercepted API and artwork; no server, DB, auth, external provider or production acceptance claim.', source, sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'), results }, null, 2));
}
const failed = results.filter(result => !result.passed);
console.log('PROFILE_LAYOUT_BROWSER_SUMMARY', JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, directory }));
assert.equal(results.length, 36, 'Every profile browser scenario must run.');
assert.equal(failed.length, 0, 'Public profile layout browser acceptance failed.');
