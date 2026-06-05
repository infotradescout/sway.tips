import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const requiredFiles = [
  'drizzle.config.ts',
  'src/db/schema.ts',
  'src/db/client.ts',
  'drizzle/meta/_journal.json'
];

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`Missing database schema file: ${file}`);
}

const schema = existsSync(join(root, 'src/db/schema.ts'))
  ? readFileSync(join(root, 'src/db/schema.ts'), 'utf8')
  : '';
const config = existsSync(join(root, 'drizzle.config.ts'))
  ? readFileSync(join(root, 'drizzle.config.ts'), 'utf8')
  : '';
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const migrationFiles = existsSync(join(root, 'drizzle'))
  ? readdirSync(join(root, 'drizzle')).filter((name) => name.endsWith('.sql'))
  : [];
const migrations = migrationFiles
  .map((name) => readFileSync(join(root, 'drizzle', name), 'utf8'))
  .join('\n');

for (const dependency of ['drizzle-orm', 'pg']) {
  if (!packageJson.dependencies?.[dependency]) failures.push(`Missing runtime database dependency: ${dependency}`);
}

for (const dependency of ['drizzle-kit', '@types/pg']) {
  if (!packageJson.devDependencies?.[dependency]) failures.push(`Missing database development dependency: ${dependency}`);
}

for (const term of [
  "dialect: 'postgresql'",
  "schema: './src/db/schema.ts'",
  "out: './drizzle'",
  'DATABASE_URL'
]) {
  if (!config.includes(term)) failures.push(`Drizzle config missing term: ${term}`);
}

if (!migrationFiles.length) failures.push('Drizzle migration SQL file is required.');

const requiredTables = [
  'users',
  'performers',
  'performer_memberships',
  'gig_sessions',
  'gig_access_grants',
  'requests',
  'request_boosts',
  'payments',
  'payment_events',
  'payouts',
  'moderation_events',
  'audit_events',
  'idempotency_keys',
  'client_pending_actions'
];

for (const table of requiredTables) {
  if (!new RegExp(`CREATE TABLE "${table}"`).test(migrations)) {
    failures.push(`Migration missing required table: ${table}`);
  }
}

const requiredEnums = {
  request_status: [
    'submitted',
    'payment_pending',
    'payment_authorized',
    'held_for_review',
    'approved',
    'denied',
    'voided_or_refunded',
    'fulfilled',
    'captured',
    'paid_out',
    'disputed'
  ],
  payment_status: [
    'created',
    'payment_pending',
    'authorized',
    'captured',
    'voided',
    'refunded',
    'failed',
    'disputed',
    'paid_out'
  ],
  gig_session_status: ['draft', 'scheduled', 'active', 'closeout_pending', 'closed', 'expired', 'canceled'],
  performer_onboarding_status: [
    'created',
    'profile_started',
    'gig_ready',
    'payments_limited',
    'verification_required',
    'verified',
    'payouts_enabled',
    'restricted',
    'suspended'
  ]
};

for (const [enumName, values] of Object.entries(requiredEnums)) {
  if (!new RegExp(`CREATE TYPE "public"\\."${enumName}" AS ENUM`).test(migrations)) {
    failures.push(`Migration missing required enum: ${enumName}`);
  }
  for (const value of values) {
    if (!migrations.includes(`'${value}'`)) failures.push(`Enum ${enumName} missing value: ${value}`);
  }
}

const requiredTableColumns = {
  gig_sessions: [
    'status',
    'started_at',
    'scheduled_end_at',
    'last_activity_at',
    'manual_closeout_started_at',
    'manual_closeout_completed_at',
    'auto_closeout_at',
    'auto_closeout_reason',
    'closeout_policy'
  ],
  performers: [
    'onboarding_status',
    'payment_account_status',
    'kyc_status',
    'payouts_enabled',
    'charges_enabled',
    'lifetime_gross_volume',
    'payout_hold_reason',
    'verification_required_at_amount'
  ],
  idempotency_keys: [
    'idempotency_key',
    'patron_device_id_hash',
    'actor_id',
    'session_id',
    'gig_id',
    'action_type',
    'amount_cents',
    'currency',
    'target_entity_type',
    'target_entity_id',
    'payload_hash',
    'intent_fingerprint',
    'first_response_status',
    'first_response_body_hash',
    'expires_at'
  ],
  client_pending_actions: [
    'client_request_id',
    'idempotency_key',
    'gig_id',
    'action_type',
    'payload_hash',
    'expires_at',
    'created_at',
    'last_attempt_at',
    'attempt_count',
    'status',
    'last_error'
  ],
  payments: [
    'payment_status',
    'processor',
    'processor_payment_intent_id',
    'processor_charge_id',
    'amount_subtotal',
    'platform_fee',
    'amount_total',
    'currency',
    'capture_mode',
    'refund_status',
    'payout_status',
    'created_at',
    'updated_at'
  ],
  audit_events: [
    'event_id',
    'actor_type',
    'actor_id',
    'entity_type',
    'entity_id',
    'event_type',
    'previous_status',
    'next_status',
    'metadata',
    'created_at'
  ]
};

for (const [table, columns] of Object.entries(requiredTableColumns)) {
  const tableStart = migrations.indexOf(`CREATE TABLE "${table}"`);
  const tableEnd = tableStart === -1 ? -1 : migrations.indexOf(');', tableStart);
  const tableSql = tableStart === -1 || tableEnd === -1 ? '' : migrations.slice(tableStart, tableEnd);
  for (const column of columns) {
    if (!tableSql.includes(`"${column}"`)) {
      failures.push(`Table ${table} missing required column: ${column}`);
    }
  }
}

for (const term of [
  "verificationRequiredAtAmount: integer('verification_required_at_amount').notNull().default(10000)",
  "autoCloseoutAt: timestamp('auto_closeout_at'",
  "expiresAt: timestamp('expires_at'",
  'export const idempotencyKeys',
  'export const clientPendingActions'
]) {
  if (!schema.includes(term)) failures.push(`Schema source missing required term: ${term}`);
}

for (const forbidden of [/app\.use\(/, /app\.post\(/, /app\.put\(/, /new Stripe/i, /stripe\.paymentIntents/i, /createPaymentIntent/i, /seed/i]) {
  if (forbidden.test(schema)) failures.push(`Schema source contains forbidden Slice 1 implementation pattern: ${forbidden}`);
}

if (failures.length) {
  console.error('Database schema contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Database schema contract passed.');
