import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

type RunningServer = { baseUrl: string; stop: () => Promise<void> };
type Actor = { name: string; handle: string; email: string; password: string };
const TIMEOUT = 30_000;

async function reservePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const wait = (timeout: number) => new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, timeout);
    child.once('exit', onExit);
  });
  child.kill('SIGTERM');
  if (await wait(5_000)) return;
  child.kill('SIGKILL');
  await wait(5_000);
}

async function startServer(databaseUrl: string, port: number): Promise<RunningServer> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port), DATABASE_URL: databaseUrl,
      SWAY_APP_BASE_URL: baseUrl, APP_URL: baseUrl, APP_BASE_URL: baseUrl,
      VITE_SWAY_DEMO_MODE: 'false', SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED: 'false',
      SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED: 'false', SWAY_NATIVE_TICKETS_ENABLED: 'false',
      SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED: 'false',
      SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED: 'false',
      SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED: 'false',
      STRIPE_SECRET_KEY: '', STRIPE_PUBLISHABLE_KEY: '', VITE_STRIPE_PUBLISHABLE_KEY: '',
      STRIPE_WEBHOOK_SECRET: '', SWAY_EMAIL_PROVIDER: '', SWAY_EMAIL_API_KEY: '', SWAY_EMAIL_FROM: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams;
  // Drain output without publishing account data or session/verification tokens.
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', () => undefined);
  let spawnError: Error | null = null;
  child.once('error', (error) => { spawnError = error; });
  try {
    const deadline = Date.now() + TIMEOUT;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Profile proof server exited before readiness.');
      try {
        const response = await fetch(`${baseUrl}/api/health/network-probe`, { signal: AbortSignal.timeout(1_000) });
        if (response.status === 204) return { baseUrl, stop: () => stopChild(child) };
      } catch { /* The local listener is not ready yet. */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Profile proof server readiness deadline exceeded.');
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function newContext(browser: Browser, baseUrl: string, width = 390, height = 844) {
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  const origin = new URL(baseUrl).origin;
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    try { if (new URL(url).origin === origin) return route.continue(); } catch { /* Block unknown schemes. */ }
    await route.abort('blockedbyclient');
  });
  assert.equal((await context.cookies()).length, 0);
  return context;
}

async function login(page: Page, baseUrl: string, actor: Actor) {
  await page.goto(`${baseUrl}/account/login?next=%2Ftalent%2Fprofile`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email', { exact: true }).fill(actor.email);
  await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/talent/profile', { timeout: TIMEOUT }),
    page.getByRole('button', { name: 'Log in', exact: true }).click()
  ]);
}

async function signup(page: Page, baseUrl: string, actor: Actor) {
  await page.goto(`${baseUrl}/account/signup?intent=performer`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Your name', { exact: true }).fill(actor.name);
  await page.getByLabel('Email', { exact: true }).fill(actor.email);
  await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await page.getByLabel('Confirm password', { exact: true }).fill(actor.password);
  await page.getByLabel('I accept the Sway Terms.', { exact: true }).check();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  const verification = page.getByRole('link', { name: 'Open local verification link', exact: true });
  await verification.waitFor({ state: 'visible', timeout: TIMEOUT });
  const href = await verification.getAttribute('href');
  assert.ok(href);
  assert.equal(new URL(href, baseUrl).origin, new URL(baseUrl).origin);
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/account/login' && url.searchParams.get('verified') === '1', { timeout: TIMEOUT }),
    verification.click()
  ]);
  await page.getByLabel('Email', { exact: true }).fill(actor.email);
  await page.getByLabel('Password', { exact: true }).fill(actor.password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/account', { timeout: TIMEOUT }),
    page.getByRole('button', { name: 'Log in', exact: true }).click()
  ]);
  await page.getByRole('heading', { name: 'Activate Pro Mode', exact: true }).waitFor({ state: 'visible', timeout: TIMEOUT });
  await page.getByLabel('Performer name', { exact: true }).fill(actor.name);
  await page.getByLabel('Public handle', { exact: true }).fill(actor.handle);
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/talent', { timeout: TIMEOUT }),
    page.getByRole('button', { name: 'Activate Pro Mode', exact: true }).click()
  ]);
}

async function openEditor(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/talent/profile`, { waitUntil: 'domcontentloaded' });
  const editor = page.locator('[data-sway-public-profile-editor="true"]');
  await editor.waitFor({ state: 'visible', timeout: TIMEOUT });
  const headline = editor.getByLabel('Headline', { exact: true });
  await headline.waitFor({ state: 'visible', timeout: TIMEOUT });
  await page.waitForFunction(() => {
    const fieldset = document.querySelector('[data-sway-public-profile-editor="true"] fieldset');
    return fieldset instanceof HTMLFieldSetElement && !fieldset.disabled;
  }, { timeout: TIMEOUT });
  return editor;
}

async function readProfile(context: BrowserContext, baseUrl: string) {
  const response = await context.request.get(`${baseUrl}/api/talent/profile/public`);
  assert.equal(response.status(), 200, 'Authenticated owner profile read must succeed.');
  const data = await response.json();
  assert.ok(data.profile && typeof data.profile === 'object');
  return data.profile;
}

async function main() {
  assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true', 'Use only the isolated validation service.');
  const forbidden = Object.keys(process.env).filter((name) => (
    /DATABASE_URL$/.test(name) || /^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SWAY_EMAIL_API_KEY)$/.test(name)
    || /PAYPAL.*(?:SECRET|TOKEN)$/.test(name)
  ) && Boolean(process.env[name]?.trim()));
  assert.deepEqual(forbidden, [], 'Real database and payment credentials are forbidden.');
  let proof: Awaited<ReturnType<typeof startEmbeddedPostgresProof>> | null = null;
  let server: RunningServer | null = null;
  let browser: Browser | null = null;
  const pageErrors: string[] = [];
  const passed: string[] = [];
  const record = (name: string) => { passed.push(name); console.log(`SWAY_PROFILE_INTEGRATION_PASS ${name}`); };
  try {
    proof = await startEmbeddedPostgresProof('profile_editor_real_browser');
    const port = await reservePort();
    server = await startServer(proof.databaseUrl, port);
    const baseUrl = server.baseUrl;
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const actor = (kind: string): Actor => ({
      name: `Profile ${kind} ${suffix}`, handle: `profile-${kind}-${suffix}`,
      email: `profile-${kind}-${suffix}@example.test`, password: `SwayProfile!2026-${kind}-${suffix}`
    });
    const first = actor('first');
    const second = actor('second');
    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    const firstContext = await newContext(browser, baseUrl);
    const firstPage = await firstContext.newPage();
    firstPage.setDefaultTimeout(TIMEOUT);
    firstPage.on('pageerror', (error) => pageErrors.push(error.message));
    await signup(firstPage, baseUrl, first);
    let editor = await openEditor(firstPage, baseUrl);
    await editor.getByRole('checkbox', { name: 'DJ', exact: true }).check();
    await editor.getByRole('checkbox', { name: 'Host / MC', exact: true }).check();
    const originalHeadline = `Verified saved headline ${suffix}`;
    const recoveredHeadline = `Recovered saved headline ${suffix}`;
    const bio = `Original work and booking details ${suffix}.`;
    await editor.getByLabel('Headline', { exact: true }).fill(originalHeadline);
    await editor.getByLabel('About / vision', { exact: true }).fill(bio);
    await editor.getByLabel('City', { exact: true }).fill('Synthetic test city');
    await editor.getByLabel('Public booking email', { exact: true }).fill(first.email);
    await editor.getByLabel('Public booking phone', { exact: true }).fill('(850) 555-0123');
    await editor.getByLabel('Website', { exact: true }).fill(`https://example.com/${suffix}`);
    await editor.getByRole('button', { name: 'Save public page', exact: true }).click();
    await editor.getByText('Public page saved.', { exact: true }).waitFor({ state: 'visible' });
    let stored = await readProfile(firstContext, baseUrl);
    assert.equal(stored.headline, originalHeadline);
    assert.equal(stored.bio, bio);
    assert.equal(stored.booking.email, first.email);
    assert.deepEqual([...stored.roles].sort(), ['dj', 'host']);
    record('real-signup-and-profile-save');

    editor = await openEditor(firstPage, baseUrl);
    assert.equal(await editor.getByLabel('Headline', { exact: true }).inputValue(), originalHeadline);
    assert.equal(await editor.getByLabel('Public booking email', { exact: true }).inputValue(), first.email);
    record('saved-fields-survive-page-reload');

    await firstContext.setOffline(true);
    await editor.getByLabel('Headline', { exact: true }).fill(recoveredHeadline);
    await editor.getByRole('button', { name: 'Save public page', exact: true }).click();
    await editor.getByText(/Failed to fetch|Unable to save your public page|NetworkError|Load failed/).waitFor({ state: 'visible' });
    assert.equal(await editor.getByLabel('Headline', { exact: true }).inputValue(), recoveredHeadline);
    assert.equal(await editor.getByLabel('Public booking email', { exact: true }).inputValue(), first.email);
    await firstContext.setOffline(false);
    assert.equal((await readProfile(firstContext, baseUrl)).headline, originalHeadline, 'Offline failure must not claim or cause a successful save.');
    await editor.getByRole('button', { name: 'Save public page', exact: true }).click();
    await editor.getByText('Public page saved.', { exact: true }).waitFor({ state: 'visible' });
    assert.equal((await readProfile(firstContext, baseUrl)).headline, recoveredHeadline);
    record('offline-failure-preserves-edits-and-explicit-retry-saves');

    const secondContext = await newContext(browser, baseUrl, 1280, 800);
    const secondPage = await secondContext.newPage();
    secondPage.setDefaultTimeout(TIMEOUT);
    secondPage.on('pageerror', (error) => pageErrors.push(error.message));
    await signup(secondPage, baseUrl, second);
    const secondEditor = await openEditor(secondPage, baseUrl);
    assert.equal(await secondEditor.getByLabel('Headline', { exact: true }).inputValue(), '');
    assert.equal(await secondEditor.getByLabel('Public booking email', { exact: true }).inputValue(), '');
    const secondStored = await readProfile(secondContext, baseUrl);
    assert.notEqual(secondStored.headline, recoveredHeadline);
    assert.notEqual(secondStored.booking?.email, first.email);
    assert.equal((await readProfile(firstContext, baseUrl)).headline, recoveredHeadline);
    record('separate-authenticated-owner-cannot-see-first-owner-draft');

    await firstContext.clearCookies();
    await editor.getByLabel('Headline', { exact: true }).fill(`Must not persist ${suffix}`);
    await editor.getByRole('button', { name: 'Save public page', exact: true }).click();
    await editor.getByText('Your access changed. Reload your profile before editing.', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await editor.getByLabel('Headline', { exact: true }).inputValue(), '');
    assert.equal(await editor.getByLabel('Public booking email', { exact: true }).inputValue(), '');
    assert.equal(await editor.getByRole('button', { name: 'Save public page', exact: true }).isDisabled(), true);
    const denied = await firstContext.request.get(`${baseUrl}/api/talent/profile/public`);
    assert.ok(denied.status() === 401 || denied.status() === 403);
    record('expired-session-denied-and-private-editor-fields-cleared');

    await firstContext.close();
    await secondContext.close();
    await server.stop();
    server = await startServer(proof.databaseUrl, port);
    const restoredContext = await newContext(browser, baseUrl, 844, 390);
    const restoredPage = await restoredContext.newPage();
    restoredPage.setDefaultTimeout(TIMEOUT);
    restoredPage.on('pageerror', (error) => pageErrors.push(error.message));
    await login(restoredPage, baseUrl, first);
    editor = await openEditor(restoredPage, baseUrl);
    assert.equal(await editor.getByLabel('Headline', { exact: true }).inputValue(), recoveredHeadline);
    assert.equal(await editor.getByLabel('Public booking email', { exact: true }).inputValue(), first.email);
    stored = await readProfile(restoredContext, baseUrl);
    assert.equal(stored.headline, recoveredHeadline);
    assert.equal(stored.bio, bio);
    await editor.getByRole('button', { name: 'Save public page', exact: true }).scrollIntoViewIfNeeded();
    await editor.getByRole('button', { name: 'Save public page', exact: true }).click();
    await editor.getByText('Public page saved.', { exact: true }).waitFor({ state: 'visible' });
    record('stored-profile-survives-server-restart-and-new-session');
    assert.deepEqual(pageErrors, [], 'Actual application pages must not raise unhandled browser errors.');
    console.log(`SWAY_PROFILE_INTEGRATION_SUMMARY ${JSON.stringify({ passed: passed.length, failed: 0, database: 'embedded-disposable', http: 'real-loopback-app', payments: 'disabled' })}`);
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await proof?.close().catch(() => undefined);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
