import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page
} from 'playwright';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

const UI_TIMEOUT_MS = 30_000;

type RunningServer = {
  baseUrl: string;
  logs: () => string;
  stop: () => Promise<void>;
};

async function reservePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to reserve a local browser-proof port.');
  }
  await new Promise<void>((resolve, reject) => {
    socket.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 5_000)) return;
  child.kill('SIGKILL');
  await waitForExit(child, 5_000);
}

async function startSwayServer(databaseUrl: string, port: number): Promise<RunningServer> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      SWAY_APP_BASE_URL: baseUrl,
      APP_URL: baseUrl,
      APP_BASE_URL: baseUrl,
      VITE_SWAY_DEMO_MODE: 'false',
      SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED: 'false',
      STRIPE_SECRET_KEY: '',
      STRIPE_PUBLISHABLE_KEY: '',
      VITE_STRIPE_PUBLISHABLE_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      SWAY_EMAIL_PROVIDER: '',
      SWAY_EMAIL_API_KEY: '',
      SWAY_EMAIL_FROM: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams;

  const output: string[] = [];
  let spawnError: Error | null = null;
  const record = (chunk: Buffer) => {
    output.push(chunk.toString('utf8'));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  child.once('error', (error) => {
    spawnError = error;
  });

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Sway browser-proof server exited before readiness (code=${child.exitCode}, signal=${child.signalCode}).`);
      }
      try {
        const response = await fetch(`${baseUrl}/api/health/network-probe`, {
          signal: AbortSignal.timeout(1_000)
        });
        if (response.status === 204) {
          return {
            baseUrl,
            logs: () => output.join(''),
            stop: () => stopChild(child)
          };
        }
      } catch {
        // The listener or Vite middleware is not ready yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for the Sway browser-proof server.');
  } catch (error) {
    await stopChild(child);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join('')}`);
  }
}

async function restrictBrowserToLocalApp(context: BrowserContext, baseUrl: string) {
  const allowedOrigin = new URL(baseUrl).origin;
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) {
      await route.continue();
      return;
    }

    try {
      if (new URL(requestUrl).origin === allowedOrigin) {
        await route.continue();
        return;
      }
    } catch {
      // Unknown schemes are not needed by this proof.
    }
    await route.abort('blockedbyclient');
  });
}

function collectPageErrors(page: Page, label: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`${label}: ${error.stack || error.message}`));
  return errors;
}

async function waitVisible(locator: Locator, label: string, server: RunningServer, timeout = UI_TIMEOUT_MS) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
  } catch (error) {
    throw new Error(
      `${label} was not visible within ${timeout}ms: ${error instanceof Error ? error.message : String(error)}\n${server.logs()}`
    );
  }
}

function assertNoRealDatabaseProofVariables() {
  const configured = [
    'SWAY_REAL_POSTGRES_PROOF_DATABASE_URL',
    'SWAY_REQUIRE_REAL_POSTGRES_PROOF'
  ].filter((name) => {
    const value = process.env[name]?.trim();
    return name === 'SWAY_REQUIRE_REAL_POSTGRES_PROOF' ? value === 'true' : Boolean(value);
  });
  assert.deepEqual(
    configured,
    [],
    `This browser proof is embedded-only. Unset ${configured.join(', ')} before running it.`
  );
}

async function main() {
  assertNoRealDatabaseProofVariables();

  let proof: Awaited<ReturnType<typeof startEmbeddedPostgresProof>> | null = null;
  let server: RunningServer | null = null;
  let browser: Browser | null = null;

  try {
    proof = await startEmbeddedPostgresProof('simulated_live_night_browser');
    server = await startSwayServer(proof.databaseUrl, await reservePort());

    const runtimeResponse = await fetch(`${server.baseUrl}/api/runtime-config-status`);
    assert.equal(runtimeResponse.status, 200, `Runtime status failed.\n${server.logs()}`);
    const runtime = await runtimeResponse.json();
    assert.equal(runtime.liveRoomDurabilityWritesEnabled, true);
    assert.equal(runtime.liveRoomDurabilityKillSwitchActive, false);

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const performerName = `DJ Browser ${suffix.slice(0, 6)}`;
    const performerHandle = `dj-browser-${suffix}`;
    const email = `browser-${suffix}@example.test`;
    const password = `SwayBrowser!2026-${suffix}`;
    const requestTitle = `Browser Pilot Song ${suffix.slice(0, 6)}`;
    const patronName = `Browser Patron ${suffix.slice(0, 4)}`;

    browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage']
    });

    const performerContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block'
    });
    await performerContext.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: server.baseUrl
    });
    await restrictBrowserToLocalApp(performerContext, server.baseUrl);
    assert.equal((await performerContext.cookies()).length, 0, 'Performer proof must begin in a brand-new browser context.');

    const performerPage = await performerContext.newPage();
    const performerPageErrors = collectPageErrors(performerPage, 'performer page');
    await performerPage.goto(`${server.baseUrl}/account/signup?intent=performer`, {
      waitUntil: 'domcontentloaded'
    });

    await waitVisible(
      performerPage.getByRole('heading', { name: 'Create your Sway account' }),
      'canonical performer-intent signup heading',
      server
    );
    await waitVisible(
      performerPage.getByText(
        'Create one account, verify your email, then activate your performer identity and prepare your first room.',
        { exact: true }
      ),
      'canonical performer-intent signup copy',
      server
    );

    await Promise.all([
      performerPage.waitForURL((url) => url.pathname === '/account/login' && url.searchParams.get('next') === '/account?intent=performer'),
      performerPage.getByRole('link', { name: 'Already have an account?' }).click()
    ]);
    await Promise.all([
      performerPage.waitForURL((url) => url.pathname === '/account/signup'
        && url.searchParams.get('intent') === 'performer'
        && url.searchParams.get('next') === '/account?intent=performer'),
      performerPage.getByRole('link', { name: 'Create an account' }).click()
    ]);
    await waitVisible(
      performerPage.getByText(
        'Create one account, verify your email, then activate your performer identity and prepare your first room.',
        { exact: true }
      ),
      'performer-intent copy after login detour',
      server
    );

    await performerPage.getByLabel('Your name').fill(performerName);
    await performerPage.getByLabel('Email').fill(email);
    await performerPage.getByLabel('Password', { exact: true }).fill(password);
    await performerPage.getByLabel('Confirm password').fill(password);
    await performerPage.getByLabel('I accept the Sway Terms.').check();
    await performerPage.getByRole('button', { name: 'Create account' }).click();

    const verificationLink = performerPage.getByRole('link', { name: 'Open local verification link' });
    await waitVisible(verificationLink, 'local verification link', server);
    const verificationHref = await verificationLink.getAttribute('href');
    assert.ok(verificationHref, 'Local verification link must include an href.');
    assert.equal(new URL(verificationHref, server.baseUrl).origin, new URL(server.baseUrl).origin);
    await Promise.all([
      performerPage.waitForURL((url) => url.pathname === '/account/login' && url.searchParams.get('verified') === '1'),
      verificationLink.click()
    ]);

    await waitVisible(
      performerPage.getByText('Email verified. Log in to continue.', { exact: true }),
      'verified-account login truth',
      server
    );
    await performerPage.getByLabel('Email').fill(email);
    await performerPage.getByLabel('Password').fill(password);
    await Promise.all([
      performerPage.waitForURL((url) => url.pathname === '/account' && url.searchParams.get('intent') === 'performer'),
      performerPage.getByRole('button', { name: 'Log in' }).click()
    ]);

    await waitVisible(
      performerPage.getByRole('heading', { name: 'Activate Pro Mode' }),
      'Pro Mode activation form',
      server
    );
    await performerPage.getByLabel('Performer name').fill(performerName);
    await performerPage.getByLabel('Public handle').fill(performerHandle);
    await Promise.all([
      performerPage.waitForURL((url) => url.pathname === '/talent'),
      performerPage.getByRole('button', { name: 'Activate Pro Mode' }).click()
    ]);

    await waitVisible(
      performerPage.getByText(
        'Money actions are unavailable because Stripe test mode could not be verified. Free rooms still work.',
        { exact: true }
      ),
      'performer payment-unavailable copy',
      server
    );
    const startRoomButton = performerPage.getByRole('button', { name: 'Start first room' });
    await waitVisible(startRoomButton, 'first-room action', server);
    await startRoomButton.click();

    const setup = performerPage.locator('[data-sway-performer-room-setup="true"]');
    await waitVisible(setup, 'first-room setup', server);
    await waitVisible(
      setup.getByText(
        'Money actions unavailable — Sway could not verify Stripe test mode. You can still run a free room.',
        { exact: true }
      ),
      'room-setup payment-unavailable copy',
      server
    );
    await setup.getByRole('button', { name: 'Free requests' }).click();
    await setup.getByRole('button', { name: 'Next' }).click();
    await setup.getByRole('button', { name: 'Open requests' }).click();
    await setup.getByRole('button', { name: 'Next' }).click();
    await waitVisible(
      setup.getByText('Free requests and upvotes · money actions off', { exact: true }),
      'free-room pricing review',
      server
    );
    await waitVisible(
      setup.getByText('Customers can type any request; you approve or deny it', { exact: true }),
      'open-request review',
      server
    );
    await setup.getByRole('button', { name: 'Next' }).click();
    await waitVisible(setup.getByRole('heading', { name: 'Ready to go live' }), 'ready-to-start review', server);
    await setup.getByRole('button', { name: 'Create room' }).click();

    const showQrButton = performerPage.getByRole('button', { name: 'Show QR' });
    await waitVisible(showQrButton, 'live-room QR tab', server);
    await showQrButton.click();
    const sharePanel = performerPage
      .locator('[data-sway-performer-room-share="true"]')
      .filter({ visible: true });
    await waitVisible(sharePanel, 'live-room share panel', server);
    const openRoomLink = sharePanel.getByRole('link', { name: 'Open Room' });
    await waitVisible(openRoomLink, 'customer room link', server);
    const roomHref = await openRoomLink.getAttribute('href');
    assert.ok(roomHref, 'The live share panel must publish a customer room href.');
    const roomUrl = new URL(roomHref, server.baseUrl);
    assert.equal(roomUrl.origin, new URL(server.baseUrl).origin);
    assert.match(roomUrl.pathname, /^\/g\/[0-9a-f-]{36}$/i);
    const gigId = roomUrl.pathname.slice('/g/'.length);

    const roomQr = sharePanel
      .locator('[data-sway-compact-room-qr="true"]')
      .filter({ visible: true });
    await waitVisible(roomQr, 'rendered customer-room QR', server);
    assert.equal(await roomQr.getAttribute('title'), 'Scan to open this live Sway room');
    const copyRoomButton = sharePanel.getByRole('button', { name: 'Copy Room Link' });
    await copyRoomButton.click();
    await waitVisible(sharePanel.getByRole('button', { name: 'Copied' }), 'copied-room confirmation', server);
    assert.equal(await performerPage.evaluate(() => navigator.clipboard.readText()), roomUrl.toString());

    const customerContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block'
    });
    await restrictBrowserToLocalApp(customerContext, server.baseUrl);
    assert.equal(
      (await customerContext.cookies()).some((cookie) => cookie.name === 'sway_performer_session'),
      false,
      'Customer context must not inherit the performer session.'
    );
    const customerPage = await customerContext.newPage();
    const customerPageErrors = collectPageErrors(customerPage, 'customer page');
    const networkProbe = customerPage.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/health/network-probe' && response.status() === 204
    );
    await customerPage.goto(roomUrl.toString(), { waitUntil: 'domcontentloaded' });
    await networkProbe;

    await waitVisible(
      customerPage.getByRole('heading', { name: performerName }),
      'customer live-room performer heading',
      server
    );
    await waitVisible(
      customerPage.getByText(
        'Send a free request or upvote an approved queue item. Money actions are off for this room.',
        { exact: true }
      ),
      'customer free-room payment truth',
      server
    );
    await customerPage.getByRole('button', { name: 'Request', exact: true }).click();
    await waitVisible(
      customerPage.getByText('Request by song or artist', { exact: true }),
      'request search label',
      server
    );
    const searchInput = customerPage.getByPlaceholder('Type the song or artist you want...');
    await searchInput.fill(requestTitle);
    await customerPage.getByRole('button', { name: 'Find' }).click();
    const manualRequestResult = customerPage
      .getByRole('button')
      .filter({ has: customerPage.getByText('Manual song request', { exact: true }) })
      .filter({ hasText: requestTitle });
    await waitVisible(manualRequestResult, 'manual customer request result', server);
    await manualRequestResult.click();

    await waitVisible(customerPage.getByText('Your Name / Group', { exact: true }), 'customer-name label', server);
    await waitVisible(
      customerPage.getByText('Custom Note / Shoutout (Profanity Filtered)', { exact: true }),
      'customer-note label',
      server
    );
    await customerPage.getByLabel('Your Name / Group').fill(patronName);
    await waitVisible(
      customerPage.getByText(/^No payment needed for this request\./),
      'free-request no-payment disclosure',
      server
    );
    await customerPage.getByRole('button', { name: 'Send Free Request' }).click();
    await waitVisible(customerPage.getByRole('heading', { name: 'Confirm Request' }), 'free-request confirmation', server);
    await waitVisible(
      customerPage.getByText('Free event — no payment required.', { exact: true }),
      'free-event checkout truth',
      server
    );
    await customerPage.getByRole('button', { name: 'Confirm Request' }).click();
    await waitVisible(customerPage.getByRole('heading', { name: 'Request Submitted' }), 'request success', server);
    await waitVisible(
      customerPage.getByText(/^Sent\. Status: Pending\./),
      'truthful pending-request status',
      server
    );

    const liveButton = performerPage.getByRole('button', { name: 'Live', exact: true });
    await liveButton.click();
    await waitVisible(
      performerPage.getByText(requestTitle, { exact: true }).filter({ visible: true }).first(),
      'customer request in performer pending queue',
      server,
      20_000
    );

    const customerBoundary = await customerPage.evaluate(async ({ roomId, title }) => {
      const [privateRoomsResponse, publicRoomResponse] = await Promise.all([
        fetch('/api/talent/active-rooms', { cache: 'no-store' }),
        fetch(`/api/state/${roomId}`, { cache: 'no-store' })
      ]);
      const privateRoomsText = await privateRoomsResponse.text();
      const publicRoomText = await publicRoomResponse.text();
      return {
        privateRoomsStatus: privateRoomsResponse.status,
        privateRoomsText,
        publicRoomStatus: publicRoomResponse.status,
        publicRoomText,
        titleWasExposed: publicRoomText.includes(title)
      };
    }, { roomId: gigId, title: requestTitle });

    assert.ok(
      customerBoundary.privateRoomsStatus === 401 || customerBoundary.privateRoomsStatus === 403,
      `Unauthenticated customer received ${customerBoundary.privateRoomsStatus} from performer-private room registry: ${customerBoundary.privateRoomsText}`
    );
    assert.equal(customerBoundary.publicRoomStatus, 200);
    assert.equal(customerBoundary.titleWasExposed, false, 'A pending request must not leak through public room state.');
    for (const privateField of [
      'patronDeviceIdHash',
      'patron_device_id_hash',
      'patronStatusReceiptHash',
      'idempotencyKey',
      'idempotency_key',
      'clientRequestId',
      'client_request_id',
      'paymentId',
      'payment_id',
      'ownerActorUserId'
    ]) {
      assert.equal(
        customerBoundary.publicRoomText.includes(privateField),
        false,
        `Public room state exposed performer-private field ${privateField}.`
      );
    }

    const pageErrors = [...performerPageErrors, ...customerPageErrors];
    assert.deepEqual(pageErrors, [], `Browser page errors were raised:\n${pageErrors.join('\n')}\n${server.logs()}`);
    console.log('sway simulated live-night browser proof passed');
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await proof?.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
