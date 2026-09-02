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
  let savedPayoutBody: Record<string, unknown> | null = null;
  let cashOutBody: Record<string, unknown> | null = null;
  let paymentConfigGate: Promise<void> | null = null;
  let paymentConfig = {
    mode: 'test',
    liveRoomMoneyEnabled: true,
    testModePlatformBalanceEnabled: false,
    payoutDestinationCapabilities: {
      paypal: true,
      venmo: true
    }
  };
  let payoutBalance = {
    pendingCents: 500,
    availableCents: 2_500,
    reservedCents: 0,
    deficitCents: 0,
    minimumWithdrawalCents: 1_000,
    providerFeeCents: 25,
    payoutMarkupCents: 0,
    withdrawalsEnabled: true,
    withdrawalRestriction: null as null | 'email_verification_required' | 'account_restricted',
    providerMode: 'test'
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
      if (path === '/api/talent/payouts/balance' && request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(payoutBalance)
        });
        return;
      }
      if (path === '/api/talent/payouts/destination' && request.method() === 'POST') {
        savedPayoutBody = request.postDataJSON() as Record<string, unknown>;
        const destinationKind = savedPayoutBody.destinationKind === 'venmo' ? 'venmo' : 'paypal';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            destinationKind,
            recipientType: savedPayoutBody.recipientType,
            recipientPreview: destinationKind === 'venmo' ? '@sa•••t' : 's***@example.test',
            encryptedAtRest: true
          })
        });
        return;
      }
      if (path === '/api/talent/payouts/withdrawals' && request.method() === 'POST') {
        cashOutBody = request.postDataJSON() as Record<string, unknown>;
        const grossAmountCents = Number(cashOutBody.grossAmountCents);
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            replayed: false,
            withdrawal: {
              id: '55555555-5555-4555-8555-555555555551',
              status: 'processing',
              destinationKind: cashOutBody.destinationKind,
              recipientPreview: 's***@example.test',
              grossAmountCents,
              providerFeeCents: 25,
              actualProviderFeeCents: null,
              payoutMarkupCents: 0,
              netAmountCents: grossAmountCents - 25,
              currency: 'USD',
              provider: 'paypal_payouts',
              paymentMode: paymentConfig.mode
            }
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
    await loadingPayoutPage.getByText(/This is PayPal Sandbox\./).waitFor({ state: 'visible' });
    await loadingPayoutPage.close();

    paymentConfig = {
      mode: 'unavailable',
      liveRoomMoneyEnabled: false,
      testModePlatformBalanceEnabled: false,
      payoutDestinationCapabilities: {
        paypal: false,
        venmo: false
      }
    };
    const unavailablePayoutPage = await context.newPage();
    unavailablePayoutPage.on('pageerror', (error) => pageErrors.push(`unavailable payout: ${error.stack || error.message}`));
    await unavailablePayoutPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    await unavailablePayoutPage.getByText('Secure payout setup is temporarily unavailable. Your current payout preference is unchanged. Free rooms remain available.', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await unavailablePayoutPage.getByRole('radio').count(), 2, 'Unavailable mode must keep only PayPal and Venmo visible.');
    assert.equal(await unavailablePayoutPage.getByRole('radio').evaluateAll((radios) => radios.every((radio) => (radio as HTMLInputElement).disabled)), true, 'Unavailable mode must disable every payout preference.');
    assert.equal(await unavailablePayoutPage.getByText('Choose one destination to continue.', { exact: true }).count(), 0, 'Unavailable mode must not instruct a performer to choose a disabled option.');
    assert.equal(await unavailablePayoutPage.locator('[data-sway-payout-steps="true"]').count(), 0, 'Unavailable mode must not render actionable setup steps.');
    await unavailablePayoutPage.close();

    paymentConfig = {
      mode: 'test',
      liveRoomMoneyEnabled: true,
      testModePlatformBalanceEnabled: false,
      payoutDestinationCapabilities: {
        paypal: false,
        venmo: false
      }
    };
    const zeroCapabilityPayoutPage = await context.newPage();
    zeroCapabilityPayoutPage.on('pageerror', (error) => pageErrors.push(`zero-capability payout: ${error.stack || error.message}`));
    await zeroCapabilityPayoutPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    await zeroCapabilityPayoutPage.getByText('PayPal Payouts is not enabled for this deployment yet. Free rooms remain available.', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await zeroCapabilityPayoutPage.getByRole('radio').evaluateAll((radios) => radios.every((radio) => (radio as HTMLInputElement).disabled)), true, 'Zero-capability test mode must disable every payout preference.');
    assert.equal(await zeroCapabilityPayoutPage.getByText('Choose one destination to continue.', { exact: true }).count(), 0, 'Zero-capability mode must not instruct a performer to choose a disabled option.');
    assert.equal(await zeroCapabilityPayoutPage.locator('[data-sway-payout-steps="true"]').count(), 0, 'Zero-capability mode must not render setup steps that cannot be completed.');
    await zeroCapabilityPayoutPage.close();

    paymentConfig = {
      mode: 'test',
      liveRoomMoneyEnabled: true,
      testModePlatformBalanceEnabled: false,
      payoutDestinationCapabilities: {
        paypal: true,
        venmo: true
      }
    };
    payoutBalance = {
      ...payoutBalance,
      withdrawalsEnabled: true,
      withdrawalRestriction: null,
      providerMode: 'test'
    };
    const payoutPage = await context.newPage();
    payoutPage.on('pageerror', (error) => pageErrors.push(`payout: ${error.stack || error.message}`));
    await payoutPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    await payoutPage.getByRole('heading', { name: 'Where should your earnings go?' }).waitFor({ state: 'visible' });
    const payoutLabels = await payoutPage.getByRole('radio').evaluateAll((radios) => radios.map((radio) => (
      radio.closest('label')?.innerText.trim() ?? ''
    )));
    assert.equal(payoutLabels.length, 2, 'Payout page must expose only PayPal and genuine Venmo.');
    for (const label of ['PayPal (Sandbox)', 'Venmo (Sandbox)']) {
      assert.equal(payoutLabels.some((value) => value.includes(label)), true, `Payout page must include ${label}.`);
    }
    assert.equal(await payoutPage.getByRole('radio').evaluateAll((radios) => radios.every((radio) => !(radio as HTMLInputElement).disabled)), true, 'PayPal Sandbox must enable only provider-confirmed PayPal and Venmo destinations.');
    await payoutPage.getByText('Your paid interactions accumulate here. PayPal’s quoted payout fee is $0.25 once per cash-out. Sway payout markup: $0.', { exact: true }).waitFor({ state: 'visible' });
    await payoutPage.getByText('Cash out $25.00 → receive about $24.75. PayPal’s actual fee is reconciled on completion.', { exact: true }).waitFor({ state: 'visible' });
    await payoutPage.getByRole('radio', { name: /Venmo \(Sandbox\)/ }).check();
    assert.equal(await payoutPage.getByRole('button', { name: 'U.S. mobile (live only)' }).isDisabled(), true, 'PayPal Sandbox does not support Venmo phone recipients.');
    await payoutPage.getByRole('radio', { name: /PayPal \(Sandbox\)/ }).check();
    await payoutPage.getByLabel('PayPal email').fill('sandbox-recipient@example.test');
    await payoutPage.getByRole('button', { name: 'Save payout destination' }).click();
    await payoutPage.getByText('Saved: s***@example.test', { exact: true }).waitFor({ state: 'visible' });
    assert.deepEqual(savedPayoutBody, {
      destinationKind: 'paypal',
      recipientType: 'email',
      recipientValue: 'sandbox-recipient@example.test'
    }, 'Sway must submit the exact PayPal recipient only to its own encrypted destination route.');
    assert.equal(await payoutPage.getByLabel('PayPal email').inputValue(), '', 'The raw recipient must leave the browser field after encrypted storage succeeds.');
    payoutPage.once('dialog', async (dialog) => {
      assert.match(dialog.message(), /Re-enter the exact PayPal email/i);
      await dialog.accept('sandbox-recipient@example.test');
    });
    await payoutPage.getByRole('button', { name: 'Cash out to PayPal' }).click();
    await payoutPage.getByText("$24.75 is being sent after PayPal's $0.25 payout fee. Sway added $0.", { exact: true }).waitFor({ state: 'visible' });
    assert.equal(cashOutBody?.destinationKind, 'paypal');
    assert.equal(cashOutBody?.recipientType, 'email');
    assert.equal(cashOutBody?.recipientConfirmationValue, 'sandbox-recipient@example.test', 'Cash-out must require exact server-verified recipient re-entry.');
    assert.equal(cashOutBody?.grossAmountCents, 2_500, 'One cash-out must combine the full available balance.');
    assert.match(String(cashOutBody?.idempotencyKey), /^withdrawal:[0-9a-f-]{36}$/i, 'Cash-out must carry one stable request identity.');
    assert.equal(await payoutPage.locator('a[href*="connect"]').count(), 0, 'Performer payout setup must never leave Sway for Stripe Connect.');
    await assertHealthyPage(payoutPage, 'payout options');

    const evidenceDirectory = join(process.cwd(), '.tmp');
    mkdirSync(evidenceDirectory, { recursive: true });
    await payoutPage.screenshot({ path: join(evidenceDirectory, 'payout-options-mobile.png'), fullPage: true });

    paymentConfig = {
      ...paymentConfig,
      mode: 'live',
      payoutDestinationCapabilities: {
        paypal: false,
        venmo: true
      }
    };
    const venmoOnlyPage = await context.newPage();
    venmoOnlyPage.on('pageerror', (error) => pageErrors.push(`Venmo-only payout: ${error.stack || error.message}`));
    await venmoOnlyPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    assert.equal(await venmoOnlyPage.getByRole('radio', { name: /^PayPal/ }).isDisabled(), true, 'PayPal and Venmo approvals must stay independently gated.');
    assert.equal(await venmoOnlyPage.getByRole('radio', { name: /^Venmo/ }).isDisabled(), false, 'Genuine Venmo must be enabled by its own PayPal approval flag.');
    await venmoOnlyPage.getByRole('radio', { name: /^Venmo/ }).check();
    await venmoOnlyPage.getByRole('button', { name: 'Venmo handle' }).click();
    await venmoOnlyPage.getByLabel('Venmo handle').fill('@sandbox-artist');
    await venmoOnlyPage.getByRole('button', { name: 'Save payout destination' }).click();
    await venmoOnlyPage.getByText('Saved: @sa•••t', { exact: true }).waitFor({ state: 'visible' });
    assert.deepEqual(savedPayoutBody, {
      destinationKind: 'venmo',
      recipientType: 'user_handle',
      recipientValue: '@sandbox-artist'
    }, 'Venmo must use a real Venmo recipient identifier, not bank-routing details.');
    await venmoOnlyPage.close();

    paymentConfig = {
      ...paymentConfig,
      payoutDestinationCapabilities: { paypal: true, venmo: true }
    };
    payoutBalance = {
      ...payoutBalance,
      withdrawalsEnabled: false,
      withdrawalRestriction: 'email_verification_required',
      providerMode: 'live'
    };
    const restrictedPayoutPage = await context.newPage();
    restrictedPayoutPage.on('pageerror', (error) => pageErrors.push(`restricted payout: ${error.stack || error.message}`));
    await restrictedPayoutPage.goto(`${baseUrl}/scripts/browser-fixtures/sway-profile-payout-options.html?view=payout`, { waitUntil: 'networkidle' });
    await restrictedPayoutPage.getByText('Verify the performer account email before cashing out.', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await restrictedPayoutPage.getByRole('button', { name: 'Cash out to PayPal' }).isDisabled(), true, 'Unverified accounts must never cash out.');
    await restrictedPayoutPage.close();

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
