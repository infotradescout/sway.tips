import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = join(root, 'artifacts', 'demo-live-room-smoke', stamp);
mkdirSync(artifactRoot, { recursive: true });

const port = 3000;
const healthUrl = `http://127.0.0.1:${port}`;
const demoGigPath = '/g/00000000-0000-4000-8000-000000000001';
const overlayPath = '/overlay/00000000-0000-4000-8000-000000000001';
const demoOffForbiddenText = ['Demo data', 'preview-only data', 'demo preview state'];

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
        expectedText: ['Sway', 'Audience: start request', 'Performer: open console', 'Venue: operator tools'],
        absentText: demoOffForbiddenText
      },
      {
        surface: 'app shell home',
        path: '/home',
        host: 'app.sway.tips',
        screenshot: 'demo-off-app-home.png',
        expectedText: ['Live room', 'No live records yet'],
        absentText: [...demoOffForbiddenText, 'Aria Neon']
      },
      {
        surface: 'patron Split View',
        path: demoGigPath,
        host: 'app.sway.tips',
        screenshot: 'demo-off-patron.png',
        expectedText: ['Live room', 'No live records yet', 'Room status'],
        absentText: [...demoOffForbiddenText, 'Midnight City']
      },
      {
        surface: 'talent protected shell guard',
        path: '/talent/gigs',
        host: 'app.sway.tips',
        screenshot: 'demo-off-talent.png',
        expectedText: ['Sway actor resolution required'],
        absentText: [...demoOffForbiddenText, 'Aria Neon']
      },
      {
        surface: 'admin protected shell guard',
        path: '/admin',
        host: 'app.sway.tips',
        screenshot: 'demo-off-admin.png',
        expectedText: ['Sway actor resolution required'],
        absentText: [...demoOffForbiddenText, 'Request lifecycle']
      },
      {
        surface: 'overlay empty state',
        path: overlayPath,
        host: 'app.sway.tips',
        screenshot: 'demo-off-overlay.png',
        expectedText: ['Session needed', 'Sign in to continue'],
        absentText: [...demoOffForbiddenText, 'Midnight City']
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
        expectedText: ['Sway', 'Audience: start request', 'Performer: open console', 'Venue: operator tools'],
        absentText: []
      },
      {
        surface: 'app shell home',
        path: '/home',
        host: 'app.sway.tips',
        screenshot: 'demo-on-app-home.png',
        expectedText: ['Live room', 'Demo data', 'Aria Neon', 'Midnight City'],
        absentText: ['No live records yet']
      },
      {
        surface: 'patron Split View',
        path: demoGigPath,
        host: 'app.sway.tips',
        screenshot: 'demo-on-patron.png',
        expectedText: ['Live room', 'Demo data', 'Demo data only. No payment or moderation action will be sent.', 'Midnight City'],
        absentText: ['No live records yet']
      },
      {
        surface: 'talent Split View',
        path: '/talent/gigs',
        host: 'app.sway.tips',
        screenshot: 'demo-on-talent.png',
        expectedText: ['Performer Console', 'Demo data', 'Demo data only; no live tips are being collected.', 'Midnight City', 'Demo only', 'Demo total shown'],
        absentText: ['No active session yet', 'Fulfill & Capture', 'Current captured total:', 'Veto / Cancel Promotion']
      },
      {
        surface: 'operator demo Split View',
        path: '/admin',
        host: 'app.sway.tips',
        screenshot: 'demo-on-admin.png',
        expectedText: ['Operator App', 'Operations overview', 'Operator access is protected', 'Read-only status is shown here until operator access is available.'],
        absentText: ['Operator features remain unavailable']
      },
      {
        surface: 'overlay demo live room',
        path: overlayPath,
        host: 'app.sway.tips',
        screenshot: 'demo-on-overlay.png',
        expectedText: ['Session needed', 'Sign in to continue'],
        absentText: ['Waiting for gig requests', 'Midnight City']
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

async function verifyBuildMarker(mode) {
  const response = await fetch(`${healthUrl}/api/build-marker`);
  const marker = await response.json();
  const swayBuildHeader = response.headers.get('x-sway-build');
  const commitHeader = response.headers.get('x-commit-sha');
  const failures = [];

  if (!response.ok) failures.push(`Build marker returned HTTP ${response.status}`);
  if (marker.service !== 'sway.tips') failures.push('Build marker service mismatch');
  if (!marker.commit || marker.commit === 'unknown') failures.push('Build marker commit is missing');
  if (!marker.branch || marker.branch === 'unknown') failures.push('Build marker branch is missing');
  if (!marker.buildTimestamp || Number.isNaN(Date.parse(marker.buildTimestamp))) failures.push('Build marker timestamp is missing or invalid');
  if (!swayBuildHeader || !swayBuildHeader.includes(marker.commit) || !swayBuildHeader.includes(marker.buildTimestamp)) {
    failures.push('x-sway-build header does not include commit and build timestamp');
  }
  if (commitHeader !== marker.commit) failures.push('x-commit-sha header does not match marker commit');

  return {
    mode,
    surface: 'build marker',
    route: '/api/build-marker',
    host: '127.0.0.1',
    expected: ['commit', 'branch', 'buildTimestamp', 'x-sway-build', 'x-commit-sha'],
    absent: [],
    screenshot: null,
    observed: [
      { text: 'commit', found: Boolean(marker.commit && marker.commit !== 'unknown') },
      { text: 'branch', found: Boolean(marker.branch && marker.branch !== 'unknown') },
      { text: 'buildTimestamp', found: Boolean(marker.buildTimestamp && !Number.isNaN(Date.parse(marker.buildTimestamp))) },
      { text: 'x-sway-build', found: Boolean(swayBuildHeader) },
      { text: 'x-commit-sha', found: Boolean(commitHeader) }
    ],
    pass: failures.length === 0,
    failures
  };
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
    results.push(await verifyBuildMarker(scenario.mode));

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

console.log(`Demo live room smoke report: ${reportPath}`);
for (const result of report.results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.mode} ${result.surface} -> ${result.screenshot}`);
  for (const failure of result.failures) {
    console.log(`  - ${failure}`);
  }
}

if (!passed) process.exit(1);
