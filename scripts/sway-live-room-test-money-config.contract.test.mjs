import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

try {
  await import('tsx/esm');
  await import('./sway-live-room-test-money-config.behavior.test.ts');
  await import('./sway-live-room-recap.behavior.test.ts');

  const root = process.cwd();
  const migrationName = readdirSync(join(root, 'drizzle'))
    .find((name) => /^0042_.+\.sql$/.test(name));
  assert.ok(migrationName, 'Live-money mode isolation migration 0042 must exist.');
  const migration = readFileSync(join(root, 'drizzle', migrationName), 'utf8');

  for (const required of [
    'CREATE TABLE "performer_stripe_connect_bindings"',
    'CREATE TABLE "stripe_connect_mode_onboarding_operations"',
    'ALTER TABLE "payments" ADD COLUMN "payment_mode" text DEFAULT \'test\' NOT NULL',
    'ALTER TABLE "live_room_payment_operations" ADD COLUMN "payment_mode" text DEFAULT \'test\' NOT NULL',
    'COALESCE(p."stripe_connected_account_id", o."stripe_account_id")',
    'p."payment_account_status"',
    'p."charges_enabled"',
    'p."payouts_enabled"',
    'p."stripe_connect_status_checked_at"',
    '"operation_key"',
    '"lease_token"',
    '"lease_expires_at"',
    '"attempt_count"',
    '"last_error"',
    '"created_at"',
    '"updated_at"',
    'CREATE FUNCTION "sway_enforce_live_room_payment_operation_mode"()',
    'SELECT "payment_mode"',
    'NEW."payment_mode" <> durable_payment_mode',
    'CREATE TRIGGER "live_room_payment_operations_mode_guard"',
    'BEFORE INSERT OR UPDATE OF "payment_id", "payment_mode"',
    'CREATE TRIGGER "payments_mode_immutable"'
  ]) {
    assert.ok(migration.includes(required), `Migration 0042 must preserve mode-isolation invariant: ${required}`);
  }

  assert.match(
    migration,
    /INSERT INTO "performer_stripe_connect_bindings"[\s\S]*?SELECT[\s\S]*?p\."id",\s*'test',[\s\S]*?FROM "performers" p/,
    'Every legacy performer Connect binding must be explicitly backfilled into test mode.'
  );
  assert.match(
    migration,
    /INSERT INTO "stripe_connect_mode_onboarding_operations"[\s\S]*?SELECT\s*"performer_id",\s*'test',\s*"owner_user_id",\s*"operation_key",\s*"status",\s*"stripe_account_id",\s*"lease_token",\s*"lease_expires_at",\s*"attempt_count",\s*"last_error",\s*"created_at",\s*"updated_at"[\s\S]*?FROM "stripe_connect_onboarding_operations"/,
    'Legacy Connect operations must retain their exact key, state, lease, error, attempts, and timestamps in test mode.'
  );

  const lockOffset = migration.indexOf('LOCK TABLE "performers", "stripe_connect_onboarding_operations"');
  const preflightOffset = migration.indexOf('DO $$');
  const operationMirrorOffset = migration.indexOf('CREATE TRIGGER "stripe_connect_legacy_operation_test_mode_mirror"');
  const performerMirrorOffset = migration.indexOf('CREATE TRIGGER "performers_legacy_connect_test_binding_mirror"');
  const bindingBackfillOffset = migration.lastIndexOf('INSERT INTO "performer_stripe_connect_bindings"');
  const operationBackfillOffset = migration.lastIndexOf('INSERT INTO "stripe_connect_mode_onboarding_operations"');
  assert.ok(lockOffset >= 0 && lockOffset < preflightOffset,
    '0042 must lock legacy Connect writer tables before identity preflight.');
  assert.ok(operationMirrorOffset >= 0 && operationMirrorOffset < operationBackfillOffset,
    '0042 must install the legacy operation mirror before operation backfill.');
  assert.ok(performerMirrorOffset >= 0 && performerMirrorOffset < bindingBackfillOffset,
    '0042 must install the legacy performer mirror before binding backfill.');
} catch (error) {
  console.error(error);
  process.exit(1);
}
