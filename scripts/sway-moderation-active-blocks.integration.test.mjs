import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import { build } from 'esbuild';

function getDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error('DATABASE_URL is required for live Postgres moderation integration test.');
  }
  return value;
}

function splitStatements(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean);
}

async function resetDatabase(client) {
  await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
  await client.query('CREATE SCHEMA public;');
}

async function applyMigrations(client) {
  const migrationDir = join(process.cwd(), 'drizzle');
  const migrationFiles = readdirSync(migrationDir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();

  if (migrationFiles.length === 0) {
    throw new Error('No drizzle SQL migrations found.');
  }

  for (const filename of migrationFiles) {
    const sql = readFileSync(join(migrationDir, filename), 'utf8');
    const statements = splitStatements(sql);
    for (const statement of statements) {
      await client.query(statement);
    }
  }
}

async function loadModerationServiceFactory() {
  const tempDir = join(process.cwd(), '.tmp');
  const outfile = join(tempDir, 'moderation-service.integration.bundle.cjs');
  const require = createRequire(import.meta.url);
  mkdirSync(tempDir, { recursive: true });

  await build({
    entryPoints: ['src/server/moderation-service.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    sourcemap: false
  });

  const loaded = require(outfile);
  return loaded.createModerationService;
}

async function main() {
  const databaseUrl = getDatabaseUrl();
  const createModerationService = await loadModerationServiceFactory();
  const adminClient = new Client({ connectionString: databaseUrl });

  await adminClient.connect();
  try {
    await resetDatabase(adminClient);
    await applyMigrations(adminClient);
  } finally {
    await adminClient.end();
  }

  const firstService = createModerationService(databaseUrl);
  await firstService.addBlockRule({
    scope: 'patron_device_id_hash',
    value: 'device-live-999',
    reason: 'Integration durability proof'
  });

  const secondService = createModerationService(databaseUrl);
  const outcome = await secondService.evaluateSubmission({
    senderName: 'Any Sender',
    text: 'safe message',
    patronDeviceIdHash: 'device-live-999'
  });

  assert.equal(
    outcome.decision,
    'block_submission',
    'Expected block_submission after service reinitialization when active block exists in Postgres.'
  );

  console.log('Moderation active_blocks Postgres integration test passed.');
}

main().catch((error) => {
  console.error('Moderation active_blocks Postgres integration test failed:');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
