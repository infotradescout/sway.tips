import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const missingBrowsers = mkdtempSync(join(tmpdir(), 'sway-missing-proof-browser-'));
try {
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: missingBrowsers };
  delete env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL;
  delete env.SWAY_REQUIRE_REAL_POSTGRES_PROOF;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sway-music-sources.browser.test.mjs'], {
    env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  const summaryLine = result.stdout.split('\n').find(line => line.startsWith('SWAY_SOURCE_BROWSER_SUMMARY '));
  assert(summaryLine, 'The actual Sources runner must finish cleanup and report its result.');
  const summary = JSON.parse(summaryLine.slice('SWAY_SOURCE_BROWSER_SUMMARY '.length));
  assert.equal(summary.databaseKind, 'embedded-postgres');
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.checks, []);
  assert.match(summary.error, /Executable doesn't exist/);
  assert.equal(result.status, 1, 'Browser failure must stay nonzero after PGlite cleanup.');
  console.log('Sources acceptance correctly rejects missing Chromium after actual PGlite startup and cleanup.');
} finally {
  rmSync(missingBrowsers, { recursive: true, force: true });
}
