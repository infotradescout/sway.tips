import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = join(root, 'artifacts', 'demo-preview-smoke', stamp);
mkdirSync(artifactRoot, { recursive: true });

const port = 3000;
const healthUrl = `http://127.0.0.1:${port}`;
const demoGigPath = '/g/00000000-0000-4000-8000-000000000001';
const overlayPath = '/overlay/00000000-0000-4000-8000-000000000001';

const scenarios = [
  {
    mode: 'demo-off',
    env: { VITE_SWAY_DEMO_MODE: 'false', DISABLE_HMR: 'true' },
    checks: [
      {
        surface: 'public landing/default host',
        path: '/',
        host: 'sway.tips',
        screenshot: 'demo-off-public.png',
        expectedText: ['Sway', 'Talent login', 'Open patron gig route'],
        absentText: ['Demo preview data']
      },
      {
        surface: 'app shell home',
        path: '/home',
        host: 'app.sway.tips',
        screenshot: 'demo-off-app-home.png',
        expectedText: ['Patron Preview', 'No live records yet'],
        absentText: ['Demo preview data', 'Aria Neon']
      },
      {
        surface: 'patron Split View',
        path: demoGigPath,
        host: 'app.sway.tips',
        screenshot: 'demo-off-patron.png',
        expectedText: ['Patron Preview', 'No live records yet', 'Selected gig inspector'],
        absentText: ['Demo preview data', 'Midnight City']
      },
      {
        surface: 'talent protected shell guard',
        path: '/talent/gigs',
        host: 'app.sway.tips',
        screenshot: 'demo-off-talent.png',
        expectedText: ['Sway actor resolution required'],
        absentText: ['Demo preview data', 'Aria Neon']
      },
      {
        surface: 'admin protected shell guard',
        path: '/admin',
        host: 'app.sway.tips',
        screenshot: 'demo-off-admin.png',
        expectedText: ['Sway actor resolution required'],
        absentText: ['Demo preview data', 'Payment lifecycle preview']
      },
      {
        surface: 'overlay empty state',
        path: overlayPath,
        host: 'app.sway.tips',
        screenshot: 'demo-off-overlay.png',
        expectedText: ['SWAY LIVE LADDER', 'Waiting for gig requests'],
        absentText: ['Demo preview data', 'Midnight City']
      }
    ]
  },
  {
    mode: 'demo-on',
    env: { VITE_SWAY_DEMO_MODE: 'true', DISABLE_HMR: 'true' },
    checks: [
      {
        surface: 'public landing/default host',
        path: '/',
        host: 'sway.tips',
        screenshot: 'demo-on-public.png',
        expectedText: ['Sway', 'Talent login', 'Open patron gig route', 'Demo preview data'],
        absentText: []
      },
      {
        surface: 'app shell home',
        path: '/home',
        host: 'app.sway.tips',
        screenshot: 'demo-on-app-home.png',
        expectedText: ['Patron Preview', 'Demo preview data', 'Aria Neon', 'Midnight City'],
        absentText: ['No live records yet']
      },
      {
        surface: 'patron Split View',
        path: demoGigPath,
        host: 'app.sway.tips',
        screenshot: 'demo-on-patron.png',
        expectedText: ['Patron Preview', 'Demo preview data', 'Preview data only. No checkout/payment/moderation action will be sent.', 'Midnight City'],
        absentText: ['No live records yet']
      },
      {
        surface: 'talent Split View',
        path: '/talent/gigs',
        host: 'app.sway.tips',
        screenshot: 'demo-on-talent.png',
        expectedText: ['Performer Console', 'Demo preview data', 'Preview data only; no live tips are being collected.', 'Midnight City', 'Preview only', 'Preview total shown'],
        absentText: ['No active session yet', 'Fulfill & Capture', 'Current captured total:', 'Veto / Cancel Promotion']
      },
      {
        surface: 'admin preview Split View',
        path: '/admin',
        host: 'app.sway.tips',
        screenshot: 'demo-on-admin.png',
        expectedText: ['Admin Preview', 'Demo preview data', 'Admin authority remains locked', 'Preview data only. No admin mutation route is enabled here.'],
        absentText: ['Operator features remain unavailable']
      },
      {
        surface: 'overlay demo ladder',
        path: overlayPath,
        host: 'app.sway.tips',
        screenshot: 'demo-on-overlay.png',
        expectedText: ['SWAY LIVE LADDER', 'Demo preview data', 'Midnight City'],
        absentText: ['Waiting for gig requests']
      }
    ]
  }
];

function startServer(env) {
  const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, 'server.ts'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  return { child, getOutput: () => output };
}

async function waitForServer(getOutput) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${healthUrl}/api/state`);
      if (response.ok) return;
    } catch {
      // keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Server did not become ready. Output:\n${getOutput()}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 800));
}

async function runScenario(browser, scenario) {
  const server = startServer(scenario.env);
  const results = [];

  try {
    await waitForServer(server.getOutput);

    for (const check of scenario.checks) {
      const context = await browser.newContext({
        viewport: { width: check.surface.includes('overlay') ? 640 : 1440, height: check.surface.includes('overlay') ? 360 : 1000 }
      });
      const page = await context.newPage();
      const url = `http://${check.host}:${port}${check.path}`;
      const screenshotPath = join(artifactRoot, check.screenshot);
      const result = {
        mode: scenario.mode,
        surface: check.surface,
        route: check.path,
        host: check.host,
        expected: check.expectedText,
        absent: check.absentText,
        screenshot: check.screenshot,
        observed: [],
        pass: true,
        failures: []
      };

      await page.goto(url, { waitUntil: 'networkidle' });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const bodyText = await page.locator('body').innerText();
      const normalizedBodyText = bodyText.toLowerCase().replace(/\s+/g, ' ');

      for (const text of check.expectedText) {
        const normalizedText = text.toLowerCase().replace(/\s+/g, ' ');
        const found = normalizedBodyText.includes(normalizedText);
        result.observed.push({ text, found });
        if (!found) {
          result.pass = false;
          result.failures.push(`Missing expected text: ${text}`);
        }
      }

      for (const text of check.absentText) {
        const normalizedText = text.toLowerCase().replace(/\s+/g, ' ');
        const found = normalizedBodyText.includes(normalizedText);
        result.observed.push({ text, found });
        if (found) {
          result.pass = false;
          result.failures.push(`Unexpected text present: ${text}`);
        }
      }

      await context.close();
      results.push(result);
    }
  } finally {
    await stopServer(server.child);
  }

  return results;
}

const browser = await chromium.launch({
  args: [
    '--host-resolver-rules=MAP sway.tips 127.0.0.1,MAP app.sway.tips 127.0.0.1,MAP www.sway.tips 127.0.0.1'
  ]
});
const report = {
  generatedAt: new Date().toISOString(),
  artifactRoot,
  commit: process.env.GIT_COMMIT ?? null,
  results: []
};

try {
  for (const scenario of scenarios) {
    report.results.push(...await runScenario(browser, scenario));
  }
} finally {
  await browser.close();
}

const reportPath = join(artifactRoot, 'report.json');
const passed = report.results.every((result) => result.pass);
writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`Demo preview smoke report: ${reportPath}`);
for (const result of report.results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.mode} ${result.surface} -> ${result.screenshot}`);
  for (const failure of result.failures) {
    console.log(`  - ${failure}`);
  }
}

if (!passed) process.exit(1);
