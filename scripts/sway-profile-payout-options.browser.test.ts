import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';

async function reservePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve profile/payout browser-test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function assertHealthyPage(page: import('playwright').Page, label: string) {
  assert.equal(await page.evaluate(() => document.body.innerText.trim().length > 0), true, `${label}: page must not be blank.`);
  assert.equal(
    await page.evaluate(() => Boolean(document.querySelector('.vite-error-overlay, #webpack-dev-server-client-overlay'))),
    false,
    `${label}: page must not show a framework error overlay.`
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    true,
    `${label}: page must not overflow the mobile viewport horizontally.`
  );
}

async function main() {
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  const pageErrors: string[] = [];
  let savedProfileBody: Record<string, unknown> | null = null;
  let payoutSetupBody: Record<string, unknown> | null = null;
  let paymentConfigGate: Promise<void> | null = null;
  let paymentConfig = {
    mode: 'test',
    liveRoomMoneyEnabled: true,
    testModePlatformBalanceEnabled: false,
    payoutDestinationCapabilities: {
      bank_account: true,
      debit_card: true,
      cash_app_direct_deposit: true,
      venmo_direct_deposit: true
    }
  };

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
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block'
    });
    await context.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/payment/config') {
        if (paymentConfigGate) await paymentConfigGate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(paymentConfig)
        });
        return;
      }
      if (path === '/api/talent/connect/onboard' && request.method() === 'POST') {
        payoutSetupBody = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            destinationKind: payoutSetupBody.destinationKind,
            setupSurface: 'onboarding',
            url: `${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout&connect=pending`
          })
        });
        return;
      }
      if (path === '/api/talent/profile/public' && request.method() === 'POST') {
        savedProfileBody = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ success: true }) });
        return;
      }
      if (path === '/api/talent/profile/public') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            profile: {
              handle: 'multi-talent-test',
              displayName: 'Multi-Talent Test',
              visibilityState: 'draft',
              stageName: null,
              primaryRole: 'creator',
              roles: ['creator'],
              headline: 'Creator, DJ, and host',
              specialties: [],
              bio: '',
              city: '',
              avatarUrl: '',
              booking: { email: null, phone: null },
              socialLinks: {},
              links: [],
              partner: { granted: false, active: false, accepted: false, suspended: false, acceptanceRequired: false }
            }
          })
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

    let releasePaymentConfig!: () => void;
    paymentConfigGate = new Promise<void>((resolve) => {
      releasePaymentConfig = resolve;
    });
    const loadingPayoutPage = await context.newPage();
    loadingPayoutPage.on('pageerror', (error) => pageErrors.push(`loading payout: ${error.stack || error.message}`));
    await loadingPayoutPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'domcontentloaded' });
    await loadingPayoutPage.getByText('Checking secure payout availability. Nothing has been changed.', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await loadingPayoutPage.getByText('Choose one destination to continue.', { exact: true }).count(), 0, 'Loading mode must not instruct a performer to choose a disabled option.');
    assert.equal(await loadingPayoutPage.locator('[data-sway-payout-steps="true"]').count(), 0, 'Loading mode must not render actionable setup steps before availability is known.');
    releasePaymentConfig();
    paymentConfigGate = null;
    await loadingPayoutPage.getByText(/This is a rehearsal\./).waitFor({ state: 'visible' });
    await loadingPayoutPage.close();

    paymentConfig = {
      mode: 'test',
      liveRoomMoneyEnabled: false,
      testModePlatformBalanceEnabled: false,
      payoutDestinationCapabilities: {
        bank_account: false,
        debit_card: false,
        cash_app_direct_deposit: false,
        venmo_direct_deposit: false
      }
    };
    const unavailablePayoutPage = await context.newPage();
    unavailablePayoutPage.on('pageerror', (error) => pageErrors.push(`unavailable payout: ${error.stack || error.message}`));
    await unavailablePayoutPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    await unavailablePayoutPage.getByText('Secure payout setup is temporarily unavailable. Your current payout preference is unchanged. Free rooms remain available.', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await unavailablePayoutPage.getByRole('radio').count(), 4, 'Unavailable mode must keep all four payout preferences visible.');
    assert.equal(await unavailablePayoutPage.getByRole('radio').evaluateAll((radios) => radios.every((radio) => (radio as HTMLInputElement).disabled)), true, 'Unavailable mode must disable every payout preference.');
    assert.equal(await unavailablePayoutPage.getByText('Choose one destination to continue.', { exact: true }).count(), 0, 'Unavailable mode must not instruct a performer to choose a disabled option.');
    assert.equal(await unavailablePayoutPage.locator('[data-sway-payout-steps="true"]').count(), 0, 'Unavailable mode must not render actionable setup steps.');
    await unavailablePayoutPage.close();

    paymentConfig = {
      mode: 'test',
      liveRoomMoneyEnabled: true,
      testModePlatformBalanceEnabled: false,
      payoutDestinationCapabilities: {
        bank_account: false,
        debit_card: false,
        cash_app_direct_deposit: false,
        venmo_direct_deposit: false
      }
    };
    const zeroCapabilityPayoutPage = await context.newPage();
    zeroCapabilityPayoutPage.on('pageerror', (error) => pageErrors.push(`zero-capability payout: ${error.stack || error.message}`));
    await zeroCapabilityPayoutPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    await zeroCapabilityPayoutPage.getByText(/No simulated payout option is enabled right now/).waitFor({ state: 'visible' });
    assert.equal(await zeroCapabilityPayoutPage.getByRole('radio').evaluateAll((radios) => radios.every((radio) => (radio as HTMLInputElement).disabled)), true, 'Zero-capability test mode must disable every payout preference.');
    assert.equal(await zeroCapabilityPayoutPage.getByText('Choose one destination to continue.', { exact: true }).count(), 0, 'Zero-capability mode must not instruct a performer to choose a disabled option.');
    assert.equal(await zeroCapabilityPayoutPage.locator('[data-sway-payout-steps="true"]').count(), 0, 'Zero-capability mode must not render setup steps that cannot be completed.');
    await zeroCapabilityPayoutPage.close();

    paymentConfig = {
      mode: 'test',
      liveRoomMoneyEnabled: true,
      testModePlatformBalanceEnabled: false,
      payoutDestinationCapabilities: {
        bank_account: true,
        debit_card: true,
        cash_app_direct_deposit: true,
        venmo_direct_deposit: true
      }
    };
    const payoutPage = await context.newPage();
    payoutPage.on('pageerror', (error) => pageErrors.push(`payout: ${error.stack || error.message}`));
    await payoutPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    await payoutPage.getByRole('heading', { name: 'Where should your earnings go?' }).waitFor({ state: 'visible' });
    const payoutLabels = await payoutPage.getByRole('radio').evaluateAll((radios) => radios.map((radio) => (
      radio.closest('label')?.innerText.trim() ?? ''
    )));
    assert.equal(payoutLabels.length, 4, 'Payout page must explain all four destinations.');
    for (const label of ['Test bank account (simulated)', 'Test debit card (simulated)', 'Cash App direct deposit', 'Venmo direct deposit']) {
      assert.equal(payoutLabels.some((value) => value.includes(label)), true, `Payout page must include ${label}.`);
    }
    assert.equal(await payoutPage.getByRole('radio').evaluateAll((radios) => radios.filter((radio) => !(radio as HTMLInputElement).disabled).length), 2, 'Test mode must enable only simulated bank and debit-card setup.');
    const venmo = payoutPage.getByRole('radio', { name: /Venmo direct deposit/ });
    assert.equal(await venmo.isDisabled(), true, 'Venmo direct deposit must stay disabled in test mode.');
    assert.equal(await payoutPage.getByRole('radio', { name: /Cash App direct deposit/ }).isDisabled(), true, 'Cash App direct deposit must stay disabled in test mode.');
    assert.equal(await payoutPage.getByRole('link', { name: 'Find direct-deposit details' }).count(), 0, 'Test mode must not link to real wallet direct-deposit details.');
    await payoutPage.getByRole('radio', { name: /Test bank account/ }).check();
    assert.equal(await payoutPage.getByRole('radio', { name: /Test bank account/ }).isChecked(), true, 'Simulated test bank setup must be selectable.');
    await payoutPage.getByText(/choose an enabled simulated option/i).waitFor({ state: 'visible' });
    await payoutPage.getByText(/if setup does not offer a test value, stop and return to Sway/i).waitFor({ state: 'visible' });
    await payoutPage.getByText(/It remains unverified until secure setup accepts an actual destination/i).waitFor({ state: 'visible' });
    await payoutPage.getByText('Rehearse payout setup in 3 steps', { exact: true }).waitFor({ state: 'visible' });
    await payoutPage.getByText('No real money moves in this rehearsal.', { exact: false }).waitFor({ state: 'visible' });
    assert.equal(await payoutPage.getByText(/You can start earning then/).count(), 0, 'Test mode must never claim that rehearsal readiness starts real earnings.');
    await Promise.all([
      payoutPage.waitForURL((url) => url.searchParams.get('connect') === 'pending'),
      payoutPage.getByRole('button', { name: 'Set up payout destination' }).click()
    ]);
    assert.deepEqual(payoutSetupBody, { destinationKind: 'bank_account' }, 'Payout setup request must contain only the selected reusable preference, never a provider account id.');
    await assertHealthyPage(payoutPage, 'payout options');

    const evidenceDirectory = join(process.cwd(), '.tmp');
    mkdirSync(evidenceDirectory, { recursive: true });
    await payoutPage.screenshot({ path: join(evidenceDirectory, 'payout-options-mobile.png'), fullPage: true });

    paymentConfig = {
      ...paymentConfig,
      mode: 'live',
      payoutDestinationCapabilities: {
        bank_account: true,
        debit_card: false,
        cash_app_direct_deposit: false,
        venmo_direct_deposit: false
      }
    };
    const uncertifiedLivePayoutPage = await context.newPage();
    uncertifiedLivePayoutPage.on('pageerror', (error) => pageErrors.push(`uncertified live payout: ${error.stack || error.message}`));
    await uncertifiedLivePayoutPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    await uncertifiedLivePayoutPage.getByRole('heading', { name: 'Where should your earnings go?' }).waitFor({ state: 'visible' });
    assert.equal(
      await uncertifiedLivePayoutPage.getByRole('link', { name: 'Find direct-deposit details' }).count(),
      0,
      'Live mode must not expose wallet direct-deposit links when those payout rails are uncertified.'
    );
    assert.equal(await uncertifiedLivePayoutPage.getByRole('radio', { name: /Cash App direct deposit/ }).isDisabled(), true);
    assert.equal(await uncertifiedLivePayoutPage.getByRole('radio', { name: /Venmo direct deposit/ }).isDisabled(), true);
    await uncertifiedLivePayoutPage.getByText(/you do not need an existing Stripe account/i).waitFor({ state: 'visible' });
    await uncertifiedLivePayoutPage.getByText(/It remains unverified until secure setup accepts an actual destination/i).waitFor({ state: 'visible' });
    await uncertifiedLivePayoutPage.getByText('Get paid in 3 steps', { exact: true }).waitFor({ state: 'visible' });
    await uncertifiedLivePayoutPage.getByText(/You can start earning then/).waitFor({ state: 'visible' });
    await assertHealthyPage(uncertifiedLivePayoutPage, 'uncertified live payout options');

    paymentConfig = {
      ...paymentConfig,
      payoutDestinationCapabilities: {
        bank_account: true,
        debit_card: false,
        cash_app_direct_deposit: true,
        venmo_direct_deposit: false
      }
    };
    const cashAppOnlyPage = await context.newPage();
    await cashAppOnlyPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    assert.equal(await cashAppOnlyPage.getByRole('radio', { name: /Cash App direct deposit/ }).isDisabled(), false, 'Cash App must be enabled only by its independent attestation.');
    assert.equal(await cashAppOnlyPage.getByRole('radio', { name: /Venmo direct deposit/ }).isDisabled(), true, 'Cash App attestation must not enable Venmo.');
    assert.equal(await cashAppOnlyPage.getByRole('link', { name: 'Find direct-deposit details' }).count(), 1);
    await cashAppOnlyPage.close();

    paymentConfig = {
      ...paymentConfig,
      payoutDestinationCapabilities: {
        bank_account: true,
        debit_card: false,
        cash_app_direct_deposit: false,
        venmo_direct_deposit: true
      }
    };
    const venmoOnlyPage = await context.newPage();
    await venmoOnlyPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    assert.equal(await venmoOnlyPage.getByRole('radio', { name: /Cash App direct deposit/ }).isDisabled(), true, 'Venmo attestation must not enable Cash App.');
    assert.equal(await venmoOnlyPage.getByRole('radio', { name: /Venmo direct deposit/ }).isDisabled(), false, 'Venmo must be enabled only by its independent attestation.');
    assert.equal(await venmoOnlyPage.getByRole('link', { name: 'Find direct-deposit details' }).count(), 1);
    await venmoOnlyPage.close();

    const sourcesPage = await context.newPage();
    sourcesPage.on('pageerror', (error) => pageErrors.push(`sources: ${error.stack || error.message}`));
    await sourcesPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=sources`, { waitUntil: 'networkidle' });
    await sourcesPage.getByRole('heading', { name: 'Your music' }).waitFor({ state: 'visible' });
    assert.equal(await sourcesPage.getByText('Saved for every room').isVisible(), true, 'Sources must explain that saved music is reused across rooms.');
    assert.equal(await sourcesPage.getByText('VirtualDJ library').isVisible(), true, 'Saved DJ library must render on Sources.');
    assert.equal(await sourcesPage.getByText('Spotify: Saturday set').isVisible(), true, 'Saved Spotify playlist must render on Sources.');
    assert.equal(await sourcesPage.getByText('Room tools', { exact: true }).count(), 0, 'Account-level Sources must not contain live-room tools.');
    assert.equal(await sourcesPage.getByRole('button', { name: /Music uploaded to Sway/ }).isVisible(), true, 'Sources must offer a plain path to uploaded music.');
    await assertHealthyPage(sourcesPage, 'account-level sources');
    await sourcesPage.screenshot({ path: join(evidenceDirectory, 'performer-sources-mobile.png'), fullPage: true });

    const uploadsOnlyPage = await context.newPage();
    uploadsOnlyPage.on('pageerror', (error) => pageErrors.push(`uploads-only sources: ${error.stack || error.message}`));
    await uploadsOnlyPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=sources_uploads`, { waitUntil: 'networkidle' });
    await uploadsOnlyPage.getByText('Sway uploads', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await uploadsOnlyPage.getByText('1 requestable track stored in Sway').isVisible(), true, 'Sway uploads alone must count as ready music.');
    assert.equal(await uploadsOnlyPage.getByText('No music added yet').count(), 0, 'Uploaded request music must never be shown as empty.');
    await assertHealthyPage(uploadsOnlyPage, 'uploads-only sources');

    const sourcesErrorPage = await context.newPage();
    sourcesErrorPage.on('pageerror', (error) => pageErrors.push(`sources error: ${error.stack || error.message}`));
    await sourcesErrorPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=sources_error`, { waitUntil: 'networkidle' });
    await sourcesErrorPage.getByText('Couldn’t check all of your saved music').waitFor({ state: 'visible' });
    assert.equal(await sourcesErrorPage.getByRole('button', { name: 'Try again' }).isVisible(), true, 'A failed source check must offer an in-place retry.');
    assert.equal(await sourcesErrorPage.getByText('No music added yet').count(), 0, 'A source load failure must never be rendered as an empty account.');
    await assertHealthyPage(sourcesErrorPage, 'source loading failure');

    const roomPage = await context.newPage();
    roomPage.on('pageerror', (error) => pageErrors.push(`room tools: ${error.stack || error.message}`));
    await roomPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=room`, { waitUntil: 'networkidle' });
    const roomToolsTrigger = roomPage.getByRole('button', { name: 'Room tools' });
    await roomToolsTrigger.click();
    const roomToolsDialog = roomPage.getByRole('dialog', { name: 'Room tools' });
    await roomToolsDialog.waitFor({ state: 'visible' });
    const closeRoomTools = roomToolsDialog.getByRole('button', { name: 'Close room tools' });
    assert.equal(await closeRoomTools.evaluate((element) => element === document.activeElement), true, 'Room Tools must place keyboard focus inside the dialog.');
    assert.equal(await roomPage.locator('[data-sway-performer-live-cockpit="true"] > div[inert]').count(), 1, 'Live-room controls behind Room Tools must be inert.');
    await roomPage.keyboard.press('Shift+Tab');
    await roomPage.keyboard.press('Tab');
    assert.equal(await closeRoomTools.evaluate((element) => element === document.activeElement), true, 'Tab must remain contained inside Room Tools.');
    assert.equal(await roomToolsDialog.getByText('Your saved music sources are not changed here.').isVisible(), true);
    assert.equal(await roomToolsDialog.getByRole('button', { name: 'Prepare VirtualDJ connection' }).isVisible(), true);
    assert.equal(await roomToolsDialog.getByText('Saved for every room').count(), 0, 'Room Tools must not duplicate account-level source setup.');
    await assertHealthyPage(roomPage, 'live room tools');
    await roomPage.screenshot({ path: join(evidenceDirectory, 'performer-room-tools-mobile.png'), fullPage: true });
    await closeRoomTools.click();
    await roomToolsDialog.waitFor({ state: 'hidden' });
    assert.equal(await roomPage.locator('[data-sway-performer-live-cockpit="true"]').isVisible(), true, 'Closing Room Tools must return to the same live room.');
    assert.equal(await roomToolsTrigger.evaluate((element) => element === document.activeElement), true, 'Closing Room Tools must return focus to its opener.');

    const rolesPage = await context.newPage();
    rolesPage.on('pageerror', (error) => pageErrors.push(`roles: ${error.stack || error.message}`));
    await rolesPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=roles`, { waitUntil: 'networkidle' });
    await rolesPage.getByText('Select all that apply.').waitFor({ state: 'visible' });
    const roleCheckboxes = rolesPage.getByRole('checkbox', { name: /DJ|Musician|Comedian|Host \/ MC|Creator|Dancer|Magician|Speaker|Producer|Other/ });
    assert.equal(await roleCheckboxes.count(), 10, 'Profile editor must render all ten performer roles as checkboxes.');
    assert.equal(await rolesPage.getByRole('checkbox', { name: 'Creator', exact: true }).isChecked(), true, 'Saved Creator role must load checked.');
    await rolesPage.getByRole('checkbox', { name: 'DJ', exact: true }).check();
    await rolesPage.getByRole('checkbox', { name: 'Host / MC', exact: true }).check();
    await rolesPage.getByRole('button', { name: 'Save public page' }).click();
    await rolesPage.getByText('Public page saved.').waitFor({ state: 'visible' });
    assert.deepEqual(savedProfileBody?.roles, ['creator', 'dj', 'host']);
    assert.equal(savedProfileBody?.primaryRole, 'creator', 'The first selected role must remain the backward-compatible primary role.');
    await assertHealthyPage(rolesPage, 'performer roles');
    await rolesPage.screenshot({ path: join(evidenceDirectory, 'performer-roles-mobile.png'), fullPage: true });

    assert.deepEqual(pageErrors, [], `Profile/payout browser verification raised page errors:\n${pageErrors.join('\n')}`);
    console.log('Sway profile and payout options browser verification passed.');
  } finally {
    await browser?.close().catch(() => undefined);
    await vite?.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
