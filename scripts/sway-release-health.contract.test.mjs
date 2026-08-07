import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  buildReleaseHealthReport,
  evaluateMigrationCompatibility,
  loadExpectedMigrations
} from '../src/server/release-health.ts';

const root = process.cwd();
const failures = [];
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const renderYaml = readFileSync(join(root, 'render.yaml'), 'utf8');
const releaseControl = readFileSync(join(root, 'RELEASE_CONTROL.md'), 'utf8');
const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
const ciWorkflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const driftGuard = readFileSync(join(root, '.github/workflows/production-deploy-drift-guard.yml'), 'utf8');
const holdDoc = readFileSync(join(root, 'docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md'), 'utf8');
const structure = readFileSync(join(root, 'docs/SWAY_PRODUCT_STRUCTURE.md'), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label}: missing ${term}`);
}

requireIncludes(server, 'app.get("/api/release-health"', 'server.ts release-health route');
requireIncludes(server, 'app.get("/api/build-marker"', 'server.ts build-marker route');
requireIncludes(server, 'drizzle.__drizzle_migrations', 'server.ts migration ledger probe');
requireIncludes(renderYaml, 'healthCheckPath: /api/release-health', 'render.yaml health path');
requireIncludes(renderYaml, 'preDeployCommand: npm run db:migrate', 'render.yaml migration gate');

for (const term of [
  'Minimum release contract',
  'Exact proposed commit',
  'Clean dependency installation',
  'Type and build validation',
  'Database compatibility proof',
  'Browser proof for changed user paths',
  'GET /api/release-health',
  'GET /api/build-marker',
  'Post-deployment smoke',
  'Rollback or roll-forward',
  'required check `validate`',
  'Empty CI jobs',
  'does **not** authorize live Stripe',
  'Stripe **test-mode**',
  'SWAY_PRODUCT_STRUCTURE.md'
]) {
  requireIncludes(releaseControl, term, 'RELEASE_CONTROL.md');
}

for (const term of [
  'minimum release contract',
  'Empty CI jobs',
  'GET /api/release-health',
  'does **not** authorize live Stripe',
  'TEST_MODE_PILOT_MILESTONE_HOLD.md',
  'SWAY_PRODUCT_STRUCTURE.md'
]) {
  requireIncludes(agents, term, 'AGENTS.md');
}

for (const term of [
  'HOLD until proven',
  'does **not** authorize live Stripe',
  'One performer account',
  'One separate audience account',
  'Stripe test-mode',
  'Live Rooms',
  'Self-Production'
]) {
  requireIncludes(holdDoc, term, 'TEST_MODE_PILOT_MILESTONE_HOLD.md');
}

requireIncludes(structure, 'Live Rooms', 'product structure');
requireIncludes(structure, 'Self-Production', 'product structure');

for (const term of [
  'npm ci',
  'npm run test:contracts',
  'npm run lint',
  'npm run build',
  'npm run db:check',
  'test:integration:pro-mode-migration',
  'Assert CI executed substantive steps'
]) {
  requireIncludes(ciWorkflow, term, 'ci.yml substantive gate');
}

requireIncludes(driftGuard, '/api/release-health', 'drift guard must observe release-health');
requireIncludes(driftGuard, 'releaseActive', 'drift guard must require releaseActive');

const expectedFromRepo = loadExpectedMigrations();
assert.ok(expectedFromRepo.length > 0, 'repo must expose expected migrations from drizzle journal');
assert.ok(expectedFromRepo.every((entry) => entry.tag && entry.hash.length === 64));

const compatible = evaluateMigrationCompatibility(expectedFromRepo, expectedFromRepo.map((entry) => entry.hash));
assert.equal(compatible.status, 'compatible');
assert.equal(compatible.compatible, true);
assert.equal(compatible.missingCount, 0);

const pending = evaluateMigrationCompatibility(expectedFromRepo, expectedFromRepo.slice(0, -1).map((entry) => entry.hash));
assert.equal(pending.status, 'pending');
assert.equal(pending.compatible, false);
assert.equal(pending.missingCount, 1);

const tempDir = mkdtempSync(join(tmpdir(), 'sway-release-health-'));
try {
  mkdirSync(join(tempDir, 'meta'), { recursive: true });
  const tag = '0000_contract_probe';
  const sqlBody = 'SELECT 1;';
  writeFileSync(join(tempDir, `${tag}.sql`), sqlBody);
  writeFileSync(
    join(tempDir, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries: [{ idx: 0, tag }] })
  );
  const loaded = loadExpectedMigrations(tempDir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].hash, createHash('sha256').update(sqlBody).digest('hex'));
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const healthy = buildReleaseHealthReport({
  buildMarker: {
    service: 'sway.tips',
    commit: 'abcdefghijklmnopqrstuvwxyz0123456789abcd',
    branch: 'main',
    buildTimestamp: '2026-08-07T00:00:00.000Z',
    nodeEnv: 'production'
  },
  databaseConfigured: true,
  databaseReachable: true,
  migrationQueryOk: true,
  appliedHashes: expectedFromRepo.map((entry) => entry.hash),
  expectedMigrations: expectedFromRepo
});
assert.equal(healthy.releaseActive, true);
assert.equal(healthy.ok, true);
assert.equal(healthy.status, 'ok');

const unhealthy = buildReleaseHealthReport({
  buildMarker: {
    service: 'sway.tips',
    commit: 'abcdefghijklmnopqrstuvwxyz0123456789abcd',
    branch: 'main',
    buildTimestamp: '2026-08-07T00:00:00.000Z',
    nodeEnv: 'production'
  },
  databaseConfigured: true,
  databaseReachable: false,
  migrationQueryOk: false,
  appliedHashes: [],
  expectedMigrations: expectedFromRepo
});
assert.equal(unhealthy.releaseActive, false);
assert.equal(unhealthy.status, 'unavailable');

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!String(packageJson.scripts?.['test:contracts'] || '').includes('sway-release-health.contract.test')) {
  failures.push('package.json test:contracts must include release-health contract');
}

if (failures.length) {
  console.error('Release health contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Release health contract passed.');
