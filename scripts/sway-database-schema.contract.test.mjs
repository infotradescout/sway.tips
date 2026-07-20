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
const migrationJournal = existsSync(join(root, 'drizzle/meta/_journal.json'))
  ? JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8'))
  : { entries: [] };
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

const journalEntries = Array.isArray(migrationJournal.entries) ? migrationJournal.entries : [];
const journalTags = new Set(journalEntries.map((entry) => entry?.tag).filter(Boolean));
for (const migrationFile of migrationFiles) {
  const tag = migrationFile.replace(/\.sql$/, '');
  if (!journalTags.has(tag)) {
    failures.push(`Drizzle migration journal missing SQL file tag: ${tag}`);
  }
}

for (const entry of journalEntries) {
  if (typeof entry?.idx !== 'number' || typeof entry?.tag !== 'string') {
    failures.push('Drizzle migration journal entries must include numeric idx and string tag.');
    continue;
  }
  const numericPrefix = Number(entry.tag.slice(0, 4));
  if (!Number.isInteger(numericPrefix) || numericPrefix !== entry.idx) {
    failures.push(`Drizzle migration journal idx must match tag prefix: idx ${entry.idx}, tag ${entry.tag}`);
  }
}

// "drizzle-kit generate" diffs against the newest snapshot file it can find in
// drizzle/meta/ -- if that snapshot is missing (e.g. never committed), it silently
// diffs against an OLDER, stale one instead of erroring, producing a migration that
// re-creates schema already applied by intervening migrations. This has bitten this
// repo twice already (migrations 0016 and 0019 both had to be hand-corrected after
// generate produced a bogus "recreate everything since the stale snapshot" diff).
// This check only requires the LATEST entry to have a snapshot -- that's the one
// future "db:generate" runs actually diff against, so it's the one that matters.
const metaDir = join(root, 'drizzle/meta');
const snapshotFiles = existsSync(metaDir)
  ? new Set(readdirSync(metaDir).filter((name) => name.endsWith('_snapshot.json')))
  : new Set();
const latestJournalEntry = journalEntries.reduce((latest, entry) => (
  typeof entry?.idx === 'number' && (!latest || entry.idx > latest.idx) ? entry : latest
), null);
if (latestJournalEntry) {
  const expectedSnapshot = `${String(latestJournalEntry.idx).padStart(4, '0')}_snapshot.json`;
  if (!snapshotFiles.has(expectedSnapshot)) {
    failures.push(
      `Missing drizzle/meta/${expectedSnapshot} for the latest migration journal entry (idx ${latestJournalEntry.idx}, ` +
      `tag ${latestJournalEntry.tag}). Without it, the next "npm run db:generate" will silently diff against a ` +
      `stale snapshot and produce a migration that re-creates already-applied schema. Regenerate and commit it.`
    );
  }
}

const requiredTables = [
  'users',
  'performers',
  'performer_memberships',
  'gig_sessions',
  'gig_access_grants',
  'performer_sessions',
  'performer_login_challenges',
  'requests',
  'request_boosts',
  'payments',
  'payment_events',
  'payouts',
  'moderation_events',
  'active_blocks',
  'audit_events',
  'idempotency_keys',
  'client_pending_actions',
  'promotion_campaigns'
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
  campaign_status: ['draft', 'active', 'paused', 'ended'],
  attribution_source: ['creator_direct', 'sway_promoted'],
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
  users: [
    'email',
    'display_name',
    'password_hash',
    'email_verified_at',
    'terms_accepted_at',
    'role'
  ],
  gig_sessions: [
    'owner_actor_user_id',
    'last_mutation_actor_user_id',
    'status',
    'runtime_session_state',
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
    'is_active',
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
    'first_response_body',
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
    'attribution_source',
    'campaign_id',
    'commission_bps_applied',
    'capture_mode',
    'refund_status',
    'payout_status',
    'created_at',
    'updated_at'
  ],
  promotion_campaigns: [
    'id',
    'performer_id',
    'campaign_code',
    'label',
    'commission_bps',
    'status',
    'expires_at',
    'created_at',
    'updated_at'
  ],
  requests: [
    'last_mutation_actor_user_id',
    'runtime_request_state'
  ],
  request_boosts: [
    'actor_user_id',
    'runtime_boost_state'
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
  ],
  active_blocks: [
    'id',
    'scope',
    'normalized_value',
    'reason',
    'actor_user_id',
    'status',
    'created_at',
    'updated_at',
    'revoked_at',
    'metadata'
  ],
  performer_sessions: [
    'id',
    'actor_user_id',
    'token_hash',
    'expires_at',
    'revoked_at',
    'last_seen_at',
    'issued_by',
    'created_at'
  ],
  performer_login_challenges: [
    'id',
    'target_email',
    'actor_user_id',
    'challenge_type',
    'token_hash',
    'challenge_metadata',
    'expires_at',
    'consumed_at',
    'revoked_at',
    'send_count',
    'requested_at',
    'requester_ip_hash',
    'created_at'
  ]
};

for (const [table, columns] of Object.entries(requiredTableColumns)) {
  const tableStart = migrations.indexOf(`CREATE TABLE "${table}"`);
  const tableEnd = tableStart === -1 ? -1 : migrations.indexOf(');', tableStart);
  const tableSql = tableStart === -1 || tableEnd === -1 ? '' : migrations.slice(tableStart, tableEnd);
  for (const column of columns) {
    const alterColumnSql = `ALTER TABLE "${table}" ADD COLUMN "${column}"`;
    if (!tableSql.includes(`"${column}"`) && !migrations.includes(alterColumnSql)) {
      failures.push(`Table ${table} missing required column: ${column}`);
    }
  }
}

for (const term of [
  "verificationRequiredAtAmount: integer('verification_required_at_amount').notNull().default(10000)",
  "passwordHash: text('password_hash')",
  "emailVerifiedAt: timestamp('email_verified_at'",
  "termsAcceptedAt: timestamp('terms_accepted_at'",
  "handle: text('handle')",
  "isActive: boolean('is_active').notNull().default(false)",
  `uniqueIndex('idx_performers_handle').on(table.handle).where(sql`,
  "autoCloseoutAt: timestamp('auto_closeout_at'",
  "expiresAt: timestamp('expires_at'",
  "runtimeSessionState: jsonb('runtime_session_state')",
  "runtimeRequestState: jsonb('runtime_request_state')",
  "runtimeBoostState: jsonb('runtime_boost_state')",
  "ownerActorUserId: uuid('owner_actor_user_id')",
  "lastMutationActorUserId: uuid('last_mutation_actor_user_id')",
  "actorUserId: uuid('actor_user_id')",
  "export const performerSessions",
  "tokenHash: text('token_hash').notNull()",
  "expiresAt: timestamp('expires_at'",
  "revokedAt: timestamp('revoked_at'",
  'export const performerLoginChallenges',
  "targetEmail: text('target_email').notNull()",
  "challengeType: text('challenge_type').notNull().default('login')",
  "challengeMetadata: jsonb('challenge_metadata')",
  "consumedAt: timestamp('consumed_at'",
  "requesterIpHash: text('requester_ip_hash').notNull()",
  "export const activeBlocks",
  'export const idempotencyKeys',
  'export const clientPendingActions',
  'export const promotionCampaigns',
  "commissionBps: integer('commission_bps').notNull()",
  "attributionSource: attributionSourceEnum('attribution_source').notNull().default('creator_direct')",
  "campaignId: uuid('campaign_id').references(() => promotionCampaigns.id)"
]) {
  if (!schema.includes(term)) failures.push(`Schema source missing required term: ${term}`);
}

// Sway must never invent the promoted commission rate -- commissionBps is a required
// input on every campaign (an explicit deal term), not a code-level default.
if (/commissionBps:\s*integer\('commission_bps'\)[^,\n]*\.default\(/.test(schema)) {
  failures.push('promotionCampaigns.commissionBps must not have a code-level default -- it is always an explicit deal term.');
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
