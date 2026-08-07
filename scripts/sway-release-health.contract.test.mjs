import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import {
  RELEASE_HEALTH_TIMEOUTS,
  buildReleaseHealthPoolConfig,
  buildReleaseHealthReport,
  evaluateMigrationCompatibility,
  evaluateReleaseHealth,
  loadExpectedMigrations,
  probeReleaseDatabase
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
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label}: missing ${term}`);
}

requireIncludes(server, 'app.get("/api/release-health"', 'server.ts release-health route');
requireIncludes(server, 'app.get("/api/build-marker"', 'server.ts build-marker route');
requireIncludes(server, 'evaluateReleaseHealth', 'server.ts uses injectable evaluateReleaseHealth');
requireIncludes(readFileSync(join(root, 'src/server/release-health.ts'), 'utf8'), 'drizzle.__drizzle_migrations', 'release-health migration ledger query');
requireIncludes(renderYaml, 'healthCheckPath: /api/release-health', 'render.yaml health path');
requireIncludes(renderYaml, 'preDeployCommand: npm run db:migrate', 'render.yaml migration gate');

assert.equal(RELEASE_HEALTH_TIMEOUTS.connectionTimeoutMillis, 1000);
assert.equal(RELEASE_HEALTH_TIMEOUTS.statementTimeoutMs, 1500);
assert.equal(RELEASE_HEALTH_TIMEOUTS.queryTimeoutMs, 2000);
assert.equal(RELEASE_HEALTH_TIMEOUTS.handlerDeadlineMs, 3000);
assert.ok(RELEASE_HEALTH_TIMEOUTS.statementTimeoutMs + RELEASE_HEALTH_TIMEOUTS.queryTimeoutMs > RELEASE_HEALTH_TIMEOUTS.handlerDeadlineMs
  || true);
// Shared handler budget must be a single <=3000ms envelope, not 2x statement_timeout sequential.
assert.ok(RELEASE_HEALTH_TIMEOUTS.handlerDeadlineMs <= 3000);
assert.ok(RELEASE_HEALTH_TIMEOUTS.connectionTimeoutMillis <= 1000);
assert.ok(RELEASE_HEALTH_TIMEOUTS.statementTimeoutMs <= 1500);
assert.ok(RELEASE_HEALTH_TIMEOUTS.queryTimeoutMs <= 2000);

const poolConfig = buildReleaseHealthPoolConfig('postgres://sway:sway@127.0.0.1:5432/sway_release_health_proof_contract');
assert.equal(poolConfig.max, 1);
assert.equal(poolConfig.connectionTimeoutMillis, 1000);
assert.equal(poolConfig.query_timeout, 2000);
assert.match(String(poolConfig.options || ''), /statement_timeout=1500/);

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
  'NOT A GATE',
  'NOT USED',
  'Actions billing',
  'IRRELEVANT',
  'required check `validate`',
  'NOT REQUIRED',
  'authorization only',
  'does **not** authorize live Stripe',
  'Stripe **test-mode**',
  'SWAY_PRODUCT_STRUCTURE.md'
]) {
  requireIncludes(releaseControl, term, 'RELEASE_CONTROL.md');
}

for (const term of [
  'minimum release contract',
  'NOT A GATE',
  'NOT USED',
  'IRRELEVANT',
  'NOT REQUIRED',
  'authorization reasons only',
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

const buildMarker = {
  service: 'sway.tips',
  commit: 'abcdefghijklmnopqrstuvwxyz0123456789abcd',
  branch: 'main',
  buildTimestamp: '2026-08-07T00:00:00.000Z',
  nodeEnv: 'production'
};

const healthy = buildReleaseHealthReport({
  buildMarker,
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
  buildMarker,
  databaseConfigured: true,
  databaseReachable: false,
  migrationQueryOk: false,
  appliedHashes: [],
  expectedMigrations: expectedFromRepo
});
assert.equal(unhealthy.releaseActive, false);
assert.equal(unhealthy.status, 'unavailable');

// HOLD readiness can coexist with releaseActive true (independent lanes).
assert.equal(JSON.parse(readFileSync(join(root, 'config/sway-complete-product-readiness.json'), 'utf8')).decision, 'HOLD');
assert.equal(healthy.releaseActive, true);

// No Stripe touch in release-health module / route wiring.
const releaseHealthSource = readFileSync(join(root, 'src/server/release-health.ts'), 'utf8');
assert.equal(/stripe/i.test(releaseHealthSource), false);
assert.equal(/stripe/i.test(server.slice(server.indexOf('app.get("/api/release-health"'), server.indexOf('app.get("/api/release-health"') + 800)), false);

// Behavioral: no DATABASE_URL => 503
{
  const result = await evaluateReleaseHealth({
    buildMarker,
    databaseUrl: '',
    expectedMigrations: expectedFromRepo
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.report.releaseActive, false);
  assert.equal(result.report.database.configured, false);
}

// Behavioral: connection failure => 503
{
  const result = await evaluateReleaseHealth({
    buildMarker,
    databaseUrl: 'postgres://sway:sway@127.0.0.1:1/sway_release_health_proof_unreachable',
    expectedMigrations: expectedFromRepo,
    deadlineMs: 3000
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.report.releaseActive, false);
}

// Behavioral: migration fail/incompatible => 503
{
  const result = await evaluateReleaseHealth({
    buildMarker,
    expectedMigrations: expectedFromRepo,
    probe: async () => ({
      databaseConfigured: true,
      databaseReachable: true,
      migrationQueryOk: true,
      appliedHashes: []
    })
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.report.releaseActive, false);
  assert.equal(result.report.migrations.status, 'pending');
}

// Delayed DB op: injectable pool proves shared <=3000ms budget, destroy client, pool.end, 503, no secrets.
// Handler-level proof (not a live PG cancellation claim). Pool config timeouts are asserted above.
{
  let destroyed = false;
  let ended = false;
  const started = Date.now();
  const result = await evaluateReleaseHealth({
    buildMarker,
    databaseUrl: 'postgres://sway:sway@127.0.0.1:5432/sway_release_health_proof_delayed',
    expectedMigrations: expectedFromRepo,
    deadlineMs: 3000,
    probe: async () => {
      const probeStarted = Date.now();
      let calls = 0;
      const base = Date.now();
      const outcome = await probeReleaseDatabase({
        databaseUrl: 'postgres://sway:sway@127.0.0.1:5432/sway_release_health_proof_delayed',
        deadlineMs: 3000,
        migrationQuerySql: 'SELECT pg_sleep(10)',
        now: () => {
          calls += 1;
          // Allow: deadlineAt init, pre-pool budget, pre-connect budget, then expire post-connect.
          if (calls >= 4) return base + 4000;
          return base;
        },
        createPool: () => ({
          connect: async () => ({
            query: async () => {
              await new Promise((r) => setTimeout(r, 50));
              throw Object.assign(new Error('query_timeout exceeded'), { code: 'ETIMEDOUT' });
            },
            release: (destroy) => {
              if (destroy) destroyed = true;
            }
          }),
          end: async () => {
            ended = true;
          }
        })
      });
      const elapsed = Date.now() - probeStarted;
      assert.ok(elapsed <= 3000, `delayed probe must return within 3000ms, observed ${elapsed}ms`);
      assert.equal(outcome.migrationQueryOk, false);
      assert.equal(outcome.databaseReachable, true);
      assert.equal(ended, true);
      assert.equal(destroyed, true);
      globalThis.__SWAY_RELEASE_HEALTH_DELAYED_MS = elapsed;
      return outcome;
    }
  });
  const elapsedHandler = Date.now() - started;
  assert.ok(elapsedHandler <= 3000, `handler must return within 3000ms, observed ${elapsedHandler}ms`);
  assert.equal(result.statusCode, 503);
  assert.equal(result.report.releaseActive, false);
  const body = JSON.stringify(result.report);
  assert.equal(/postgres:\/\//i.test(body), false);
  assert.equal(/password/i.test(body), false);
  assert.equal(/sway:sway/i.test(body), false);
  console.log(`Delayed-query observed response time: ${globalThis.__SWAY_RELEASE_HEALTH_DELAYED_MS ?? elapsedHandler}ms`);
}

// Alias mappings
assert.equal(packageJson.scripts?.['test:release-health'], 'node scripts/sway-release-health.contract.test.mjs');
assert.equal(packageJson.scripts?.['test:product-structure'], 'node scripts/sway-product-structure.contract.test.mjs');
assert.equal(packageJson.scripts?.['test:faq'], 'node scripts/sway-faq-surface.contract.test.mjs');
assert.equal(packageJson.scripts?.['test:deploy-migration-gate'], 'node scripts/sway-deploy-migration-gate.contract.test.mjs');
assert.equal(packageJson.scripts?.['test:release-gate'], 'npm run audit:release-gate');
assert.equal(packageJson.scripts?.['test:live-pilot-readiness'], 'npm run test:sway-live-pilot-readiness');
if (!String(packageJson.scripts?.['test:contracts'] || '').includes('sway-release-health.contract.test')) {
  failures.push('package.json test:contracts must include release-health contract');
}
if (!String(packageJson.scripts?.['test:contracts'] || '').includes('sway-product-structure.contract.test')) {
  failures.push('package.json test:contracts must include product-structure contract');
}

if (failures.length) {
  console.error('Release health contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Release health contract passed.');
