import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, devices } from 'playwright';

const baseUrl = (process.env.SWAY_LOCAL_BASE_URL || 'http://127.0.0.1:3017').replace(/\/$/, '');
const outDir = join(process.cwd(), 'tmp', 'claim-onboarding-mobile-qa');
mkdirSync(outDir, { recursive: true });

const viewports = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '412x915', width: 412, height: 915 }
];

const browser = await chromium.launch({ headless: true });
const results = [];

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/account/signup`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('text=Create your Sway account', { timeout: 30000 });
    const claimLabel = page.getByText('Claim code (optional)');
    const claimVisible = await claimLabel.isVisible();
    const confirm = page.getByPlaceholder('Confirm password');
    const terms = page.getByText('I accept the Sway Terms.');
    const create = page.getByRole('button', { name: 'Create account' });
    const login = page.getByText('Already have an account?');

    const claimBox = await claimLabel.boundingBox();
    const confirmBox = await confirm.boundingBox();
    const termsBox = await terms.boundingBox();

    const orderOk = Boolean(
      claimBox && confirmBox && termsBox
      && confirmBox.y < claimBox.y
      && claimBox.y < termsBox.y
    );

    const shot = join(outDir, `signup-${viewport.name}.png`);
    await page.screenshot({ path: shot, fullPage: true });

    results.push({
      viewport: viewport.name,
      claimVisible,
      orderOk,
      createVisible: await create.isVisible(),
      termsVisible: await terms.isVisible(),
      loginVisible: await login.isVisible(),
      screenshot: shot
    });
    await context.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((row) => !row.claimVisible || !row.orderOk || !row.createVisible || !row.termsVisible || !row.loginVisible);
console.log(JSON.stringify({ results, failed: failed.length }, null, 2));
if (failed.length) process.exit(1);
console.log('Mobile claim-field QA passed.');
