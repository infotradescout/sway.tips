import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = (process.env.SWAY_PROD_BASE_URL || 'https://app.sway.tips').replace(/\/$/, '');
const outDir = join(process.cwd(), 'tmp', 'claim-onboarding-production-qa');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
});
const page = await context.newPage();

try {
  await page.goto(`${baseUrl}/account/signup`, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForSelector('text=Create your Sway account', { timeout: 60000 });

  const claimVisible = await page.getByText('Claim code (optional)').isVisible().catch(() => false);
  const helperVisible = await page.getByText('Have a performer profile waiting for you? Enter the code to claim it.').isVisible().catch(() => false);
  const shot = join(outDir, 'production-signup-390x844.png');
  await page.screenshot({ path: shot, fullPage: true });

  // Asset fingerprint: patron bundle should include the claim label once deployed.
  const html = await page.content();
  const scriptSrc = [...html.matchAll(/src="(\/assets\/patron-[^"]+\.js)"/g)].map((m) => m[1]);
  let assetHasClaim = false;
  for (const src of scriptSrc) {
    const response = await fetch(`${baseUrl}${src}`, { cache: 'no-store' });
    const body = await response.text();
    if (body.includes('Claim code (optional)')) {
      assetHasClaim = true;
      break;
    }
  }

  const result = {
    url: `${baseUrl}/account/signup`,
    claimVisible,
    helperVisible,
    assetHasClaim,
    scripts: scriptSrc,
    screenshot: shot
  };
  console.log(JSON.stringify(result, null, 2));
  if (!claimVisible || !helperVisible || !assetHasClaim) process.exit(2);
  console.log('Production claim-field verification passed.');
} finally {
  await browser.close();
}
