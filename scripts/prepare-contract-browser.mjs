// Contract tests include real Chromium interactions. Provision the browser and
// headless shell belonging to this checkout's locked Playwright version.
// Playwright reuses its cache. This is a test hook, never a production build hook.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const cli = fileURLToPath(new URL('../node_modules/playwright/cli.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  stdio: 'inherit', shell: false, timeout: 180000,
});
if (result.error || result.status !== 0 || !existsSync(chromium.executablePath())) {
  console.error('Required contract-test Chromium installation failed.', result.error?.message || `exit ${result.status}`);
  process.exit(1);
}
console.log('Contract-test Chromium prerequisite is available. No tests were skipped.');
