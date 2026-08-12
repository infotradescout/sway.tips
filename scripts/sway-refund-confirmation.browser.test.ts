import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

async function reservePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve refund-confirmation test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function activeElement(page: Page) {
  return page.evaluate(() => ({
    text: document.activeElement?.textContent?.trim() ?? '',
    ariaLabel: document.activeElement?.getAttribute('aria-label') ?? ''
  }));
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
      server: { host: '127.0.0.1', port, strictPort: true }
    });
    await vite.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const body = path === '/api/payment/config'
        ? { mode: 'test', liveRoomMoneyEnabled: true, testModePlatformBalanceEnabled: true }
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
    await page.goto(`${baseUrl}/scripts/browser-fixtures/sway-refund-confirmation.html`, { waitUntil: 'networkidle' });

    const trigger = page.getByRole('button', { name: 'Remove Shoutout and reverse payment' }).filter({ visible: true });
    await trigger.waitFor({ state: 'visible' });
    assert.equal(await trigger.count(), 1, 'Exactly one responsive queue layout should expose the visible remove action.');

    await trigger.focus();
    await trigger.click();
    const dialog = page.locator('[data-sway-remove-confirmation="true"]');
    await dialog.waitFor({ state: 'visible' });
    assert.deepEqual(await activeElement(page), { text: 'Cancel', ariaLabel: '' }, 'Cancel must receive initial focus.');

    const dialogBox = await dialog.boundingBox();
    assert.ok(dialogBox, 'The confirmation dialog must have a rendered box.');
    assert.ok(dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= 844, 'The confirmation dialog must fit the mobile viewport.');

    await page.keyboard.press('Tab');
    assert.equal((await activeElement(page)).ariaLabel, 'Confirm remove Shoutout and reverse payment', 'Tab must reach the confirm action.');
    await page.keyboard.press('Tab');
    assert.equal((await activeElement(page)).text, 'Cancel', 'Tab must wrap from confirm to Cancel.');
    await page.keyboard.press('Shift+Tab');
    assert.equal((await activeElement(page)).ariaLabel, 'Confirm remove Shoutout and reverse payment', 'Shift+Tab must wrap from Cancel to confirm.');

    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Remove Shoutout and reverse payment');
    assert.equal((await activeElement(page)).ariaLabel, 'Remove Shoutout and reverse payment', 'Escape must restore focus to the queue action.');

    await trigger.click();
    await dialog.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Remove Shoutout and reverse payment');
    assert.equal((await activeElement(page)).ariaLabel, 'Remove Shoutout and reverse payment', 'Cancel must restore focus to the queue action.');

    await trigger.click();
    await dialog.waitFor({ state: 'visible' });
    const confirm = page.locator('[data-sway-confirm-remove="true"]');
    await confirm.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => document.querySelector('[data-sway-remove-submission-count="true"]')?.textContent === '1');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Queue action status');
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator('[data-sway-remove-submission-count="true"]').textContent(),
      '1',
      'A rapid duplicate confirmation must submit exactly one remove/refund action.'
    );
    assert.equal(await dialog.count(), 0, 'Confirm must close the dialog.');
    assert.deepEqual(pageErrors, [], `Refund confirmation raised page errors:\n${pageErrors.join('\n')}`);

    console.log('Sway refund confirmation browser interaction test passed.');
  } finally {
    await browser?.close().catch(() => undefined);
    await vite?.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
