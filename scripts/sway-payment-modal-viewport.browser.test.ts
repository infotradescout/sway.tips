import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

async function reservePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve payment-modal viewport test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function activeElement(page: Page) {
  return page.evaluate(() => ({
    text: document.activeElement?.textContent?.trim() ?? '',
    ariaLabel: document.activeElement?.getAttribute('aria-label') ?? ''
  }));
}

async function openPaymentDialog(page: Page, trigger: Locator) {
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await trigger.click();
  const dialog = page.locator('[data-sway-payment-dialog="true"]');
  await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Cancel');
  return dialog;
}

async function viewportEvidence(page: Page, dialog: Locator) {
  await page.waitForTimeout(80);
  return dialog.evaluate((element) => {
    const dialogRect = element.getBoundingClientRect();
    const overlay = document.querySelector<HTMLElement>('[data-sway-payment-overlay="true"]');
    if (!overlay) throw new Error('Payment overlay missing.');
    const overlayRect = overlay.getBoundingClientRect();
    return {
      cssViewportHeight: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--sway-viewport-height')
      ),
      cssViewportWidth: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--sway-viewport-width')
      ),
      dialogLeft: dialogRect.left,
      dialogRight: dialogRect.right,
      dialogTop: dialogRect.top,
      dialogBottom: dialogRect.bottom,
      dialogClientHeight: element.clientHeight,
      dialogScrollHeight: element.scrollHeight,
      dialogOverflowY: getComputedStyle(element).overflowY,
      overlayLeft: overlayRect.left,
      overlayRight: overlayRect.right,
      overlayTop: overlayRect.top,
      overlayBottom: overlayRect.bottom,
      overlayHeight: overlayRect.height,
      overlayOverflowY: getComputedStyle(overlay).overflowY
    };
  });
}

async function assertBoundedDialog(
  page: Page,
  dialog: Locator,
  expectedHeight: number,
  label: string,
  expectScroll: boolean,
  expectedOffset = { left: 0, top: 0 },
  expectedWidth?: number
) {
  const evidence = await viewportEvidence(page, dialog);
  const visibleWidth = expectedWidth ?? evidence.cssViewportWidth;
  assert.ok(Math.abs(evidence.cssViewportHeight - expectedHeight) <= 1, `${label}: Sway viewport variable must be ${expectedHeight}px.`);
  assert.ok(Math.abs(evidence.cssViewportWidth - visibleWidth) <= 1, `${label}: Sway viewport width variable must be ${visibleWidth}px.`);
  assert.ok(evidence.dialogLeft >= expectedOffset.left - 1, `${label}: dialog must not render left of the visible viewport.`);
  assert.ok(evidence.dialogRight <= expectedOffset.left + visibleWidth + 1, `${label}: dialog must not render right of the visible viewport.`);
  assert.ok(evidence.dialogTop >= expectedOffset.top - 1, `${label}: dialog must not render above the visible viewport.`);
  assert.ok(evidence.dialogBottom <= expectedOffset.top + expectedHeight + 1, `${label}: dialog controls must stay inside the visible viewport.`);
  assert.ok(Math.abs(evidence.overlayLeft - expectedOffset.left) <= 1, `${label}: overlay must track visualViewport offsetLeft.`);
  assert.ok(Math.abs(evidence.overlayRight - (expectedOffset.left + visibleWidth)) <= 1, `${label}: overlay must track the visual viewport right edge.`);
  assert.ok(Math.abs(evidence.overlayTop - expectedOffset.top) <= 1, `${label}: overlay must track visualViewport offsetTop.`);
  assert.ok(Math.abs(evidence.overlayHeight - expectedHeight) <= 1, `${label}: overlay must use the Sway visual viewport height.`);
  assert.ok(evidence.overlayBottom <= expectedOffset.top + expectedHeight + 1, `${label}: overlay must not extend below the visible viewport.`);
  assert.equal(evidence.dialogOverflowY, 'auto', `${label}: dialog must be vertically scrollable.`);
  assert.equal(evidence.overlayOverflowY, 'auto', `${label}: overlay must be vertically scrollable.`);
  if (expectScroll) {
    assert.ok(evidence.dialogScrollHeight > evidence.dialogClientHeight, `${label}: constrained dialog must have a real scroll range.`);
  }
}

async function cancelFromBottom(page: Page, dialog: Locator, expectedHeight: number, label: string) {
  await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.scrollIntoViewIfNeeded();
  const cancelBox = await cancel.boundingBox();
  assert.ok(cancelBox, `${label}: Cancel must have a rendered box.`);
  assert.ok(cancelBox.y >= -1 && cancelBox.y + cancelBox.height <= expectedHeight + 1, `${label}: Cancel must be reachable inside the visible viewport.`);
  await cancel.click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.textContent?.trim()?.startsWith('Send Request'));
}

async function main() {
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  const pageErrors: string[] = [];

  try {
    const port = await reservePort();
    vite = await createViteServer({
      root: process.cwd(),
      logLevel: 'silent',
      resolve: {
        alias: [
          {
            find: '@stripe/react-stripe-js',
            replacement: resolve(process.cwd(), 'scripts/browser-fixtures/stripe-react-js-stub.tsx')
          },
          {
            find: '@stripe/stripe-js',
            replacement: resolve(process.cwd(), 'scripts/browser-fixtures/stripe-js-stub.ts')
          }
        ]
      },
      server: { host: '127.0.0.1', port, strictPort: true }
    });
    await vite.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    const context = await browser.newContext({
      viewport: { width: 320, height: 568 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block'
    });
    await context.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/health/network-probe') {
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      const body = path === '/api/payment/config'
        ? {
            mode: 'test',
            liveRoomMoneyEnabled: true,
            testModePlatformBalanceEnabled: true,
            publishableKey: 'pk_test_fixture'
          }
        : path.endsWith('/sources')
        ? { sources: [] }
        : path.endsWith('/tracks')
          ? { tracks: [] }
          : path.endsWith('/source-capabilities')
            ? { capabilities: [] }
            : {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });

    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    await page.goto(`${baseUrl}/scripts/browser-fixtures/sway-payment-modal-viewport.html`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: 'Request', exact: true }).first().click();
    await page.getByLabel('Your Name / Group').fill('Viewport QA');
    const trigger = page.getByRole('button', { name: /^Send Request/ }).filter({ visible: true });
    await trigger.waitFor({ state: 'visible' });

    let dialog = await openPaymentDialog(page, trigger);
    assert.equal(await dialog.getAttribute('role'), 'dialog', 'Payment confirmation must expose dialog semantics.');
    assert.equal(await dialog.getAttribute('aria-modal'), 'true', 'Payment confirmation must be modal to assistive technology.');
    assert.deepEqual(await activeElement(page), { text: 'Cancel', ariaLabel: '' }, 'Cancel must receive initial focus.');
    await assertBoundedDialog(page, dialog, 568, 'compact portrait', false);

    await page.keyboard.press('Tab');
    assert.equal((await activeElement(page)).text, 'Confirm Payment', 'Tab from Cancel must wrap to the first payment action.');
    await page.keyboard.press('Tab');
    assert.equal((await activeElement(page)).text, 'Cancel', 'Tab from the final payment action must remain trapped in the dialog.');
    await page.keyboard.press('Shift+Tab');
    assert.equal((await activeElement(page)).text, 'Confirm Payment', 'Shift+Tab must move backward within the dialog.');

    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim()?.startsWith('Send Request'));
    assert.ok((await activeElement(page)).text.startsWith('Send Request'), 'Escape must restore focus to the payment trigger.');

    dialog = await openPaymentDialog(page, trigger);
    await cancelFromBottom(page, dialog, 568, 'compact portrait');

    await page.setViewportSize({ width: 667, height: 320 });
    dialog = await openPaymentDialog(page, trigger);
    await assertBoundedDialog(page, dialog, 320, 'short landscape', true);
    await cancelFromBottom(page, dialog, 320, 'short landscape');

    await page.setViewportSize({ width: 390, height: 700 });
    dialog = await openPaymentDialog(page, trigger);
    await page.evaluate(({ keyboardHeight, keyboardWidth, offsetLeft, offsetTop }) => {
      const viewport = window.visualViewport;
      if (!viewport) throw new Error('visualViewport is unavailable in the browser test.');
      Object.defineProperty(viewport, 'height', { configurable: true, value: keyboardHeight });
      Object.defineProperty(viewport, 'width', { configurable: true, value: keyboardWidth });
      Object.defineProperty(viewport, 'offsetLeft', { configurable: true, value: offsetLeft });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: offsetTop });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    }, { keyboardHeight: 260, keyboardWidth: 360, offsetLeft: 7, offsetTop: 94 });
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--sway-viewport-height').trim() === '260px');
    await assertBoundedDialog(page, dialog, 260, 'keyboard-shrunken visual viewport', true, { left: 7, top: 94 }, 360);
    await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const shiftedCancel = page.getByRole('button', { name: 'Cancel', exact: true });
    await shiftedCancel.scrollIntoViewIfNeeded();
    const shiftedCancelBox = await shiftedCancel.boundingBox();
    assert.ok(shiftedCancelBox, 'keyboard-shrunken visual viewport: Cancel must render.');
    assert.ok(shiftedCancelBox.y >= 93 && shiftedCancelBox.y + shiftedCancelBox.height <= 355, 'keyboard-shrunken visual viewport: Cancel must remain reachable inside the shifted viewport.');
    await shiftedCancel.click();
    await dialog.waitFor({ state: 'detached' });

    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (!viewport) throw new Error('visualViewport is unavailable in the browser test.');
      Object.defineProperty(viewport, 'height', { configurable: true, value: 700 });
      Object.defineProperty(viewport, 'width', { configurable: true, value: 390 });
      Object.defineProperty(viewport, 'offsetLeft', { configurable: true, value: 0 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 0 });
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    });

    dialog = await openPaymentDialog(page, trigger);
    await page.getByRole('button', { name: 'Confirm Payment' }).click();
    await page.waitForFunction(() => document.querySelector('[data-sway-payment-submission-count="true"]')?.textContent === '1');
    await page.getByRole('heading', { name: 'Request Submitted' }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-sway-payment-dialog') === 'true');
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-sway-payment-dialog')),
      'true',
      'Backend-confirmed success must move focus to the status dialog.'
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    await page.getByRole('button', { name: 'Request', exact: true }).first().click();
    await page.getByLabel('Your Name / Group').fill('Viewport QA again');
    const secondTrigger = page.getByRole('button', { name: /^Send Request/ }).filter({ visible: true });
    const secondDialog = await openPaymentDialog(page, secondTrigger);
    await page.waitForTimeout(2200);
    assert.equal(await secondDialog.count(), 1, 'A completed checkout timer must not close a newly opened checkout.');
    assert.equal(
      await page.locator('[data-sway-payment-submission-count="true"]').textContent(),
      '1',
      'Success dismissal and reopen must not duplicate the completed submission.'
    );
    await page.keyboard.press('Escape');
    await secondDialog.waitFor({ state: 'detached' });

    const stripeFixturePage = await context.newPage();
    stripeFixturePage.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    await stripeFixturePage.goto(`${baseUrl}/scripts/browser-fixtures/sway-payment-modal-viewport.html?stripe-frame=1`, { waitUntil: 'domcontentloaded' });
    await stripeFixturePage.getByRole('button', { name: 'Request', exact: true }).first().click();
    await stripeFixturePage.getByLabel('Your Name / Group').fill('Stripe Frame QA');
    const stripeTrigger = stripeFixturePage.getByRole('button', { name: /^Send Request/ }).filter({ visible: true });
    const stripeDialog = await openPaymentDialog(stripeFixturePage, stripeTrigger);
    await stripeFixturePage.locator('[data-sway-inject-provider-frame="true"]').evaluate((element) => (element as HTMLButtonElement).click());
    const providerFrame = stripeFixturePage.locator('[data-sway-provider-frame-fixture="true"]');
    await providerFrame.waitFor({ state: 'visible' });
    const providerFrameBody = stripeFixturePage.frameLocator('[data-sway-provider-frame-fixture="true"]');
    await providerFrameBody.getByLabel('Card number').focus();
    await stripeFixturePage.keyboard.press('Shift+Tab');
    assert.equal((await activeElement(stripeFixturePage)).text, 'Cancel', 'Shift+Tab leaving the first secure provider field must wrap to the last dialog action.');
    await providerFrameBody.getByRole('button', { name: 'Provider next' }).focus();
    assert.equal(await stripeFixturePage.evaluate(() => document.activeElement?.tagName), 'IFRAME', 'The secure provider iframe must receive parent-document focus.');
    await stripeFixturePage.keyboard.press('Tab');
    assert.equal((await activeElement(stripeFixturePage)).text, 'Confirm Payment', 'Tab leaving the secure provider iframe must reach the next action inside the dialog.');
    await stripeFixturePage.keyboard.press('Shift+Tab');
    assert.equal(await stripeFixturePage.evaluate(() => document.activeElement?.tagName), 'IFRAME', 'Shift+Tab must return focus to the secure provider iframe.');
    await stripeFixturePage.keyboard.press('Tab');
    assert.equal((await activeElement(stripeFixturePage)).text, 'Confirm Payment', 'Focus must return from the provider frame before Escape closes the dialog.');
    await stripeFixturePage.keyboard.press('Escape');
    await stripeDialog.waitFor({ state: 'detached' });
    await stripeFixturePage.waitForFunction(() => document.activeElement?.textContent?.trim()?.startsWith('Send Request'));
    await stripeFixturePage.close();

    const authorizationPage = await context.newPage();
    authorizationPage.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    await authorizationPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-payment-modal-viewport.html?stripe-authorization=1`, { waitUntil: 'domcontentloaded' });
    await authorizationPage.getByRole('button', { name: 'Request', exact: true }).first().click();
    await authorizationPage.getByLabel('Your Name / Group').fill('Authorization QA');
    const authorizationTrigger = authorizationPage.getByRole('button', { name: /^Send Request/ }).filter({ visible: true });
    const authorizationDialog = await openPaymentDialog(authorizationPage, authorizationTrigger);
    await authorizationPage.getByRole('button', { name: 'Confirm Payment' }).click();
    const authorizePayment = authorizationPage.getByRole('button', { name: 'Authorize Payment' });
    await authorizePayment.waitFor({ state: 'visible' });
    await authorizePayment.click();
    await authorizationPage.waitForFunction(() => (window as any).__swayStripeAuthorizationStarted === true);
    await authorizationPage.keyboard.press('Escape');
    assert.equal(await authorizationDialog.count(), 1, 'Escape must not close the dialog while Stripe authorization is in flight.');
    assert.equal(await authorizationPage.getByRole('button', { name: 'Cancel' }).isDisabled(), true, 'Cancel must remain disabled while Stripe authorization is in flight.');
    await authorizationPage.evaluate(() => (window as any).__swayResolveStripeAuthorization());
    await authorizationPage.getByRole('heading', { name: 'Request Submitted' }).waitFor({ state: 'visible' });
    assert.equal(await authorizationPage.locator('[data-sway-payment-submission-count="true"]').textContent(), '1', 'Delayed Stripe authorization must finalize exactly one submission.');
    await authorizationPage.waitForFunction(() => document.activeElement?.getAttribute('data-sway-payment-dialog') === 'true');
    assert.equal(await authorizationPage.evaluate(() => document.activeElement?.getAttribute('data-sway-payment-dialog')), 'true', 'Stripe success must focus the status dialog.');
    await authorizationPage.keyboard.press('Escape');
    await authorizationDialog.waitFor({ state: 'detached' });
    await authorizationPage.close();

    const restoredPage = await context.newPage();
    restoredPage.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    await restoredPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-payment-modal-viewport.html?restored-reconciliation=1`, { waitUntil: 'domcontentloaded' });
    await restoredPage.waitForFunction(() => !localStorage.getItem('sway.pendingAction'));
    assert.equal(await restoredPage.locator('[data-sway-payment-dialog="true"]').count(), 0, 'Restored reconciliation must not open a stale success dialog.');
    await restoredPage.getByRole('button', { name: 'Request', exact: true }).first().click();
    await restoredPage.getByLabel('Your Name / Group').fill('Restored QA');
    const restoredTrigger = restoredPage.getByRole('button', { name: /^Send Request/ }).filter({ visible: true });
    const restoredDialog = await openPaymentDialog(restoredPage, restoredTrigger);
    assert.equal(await restoredPage.getByRole('heading', { name: 'Confirm Request' }).count(), 1, 'A new checkout after restored reconciliation must show payment controls, not stale success.');
    await restoredPage.keyboard.press('Escape');
    await restoredDialog.waitFor({ state: 'detached' });
    await restoredPage.close();

    assert.deepEqual(pageErrors, [], `Payment modal viewport test raised page errors:\n${pageErrors.join('\n')}`);
    console.log('Sway payment modal rendered viewport interaction test passed.');
  } finally {
    await browser?.close().catch(() => undefined);
    await vite?.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
