import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label} missing term: ${term}`);
}

function requireExcludes(source, term, label) {
  if (source.includes(term)) failures.push(`${label} must exclude term: ${term}`);
}

const requiredFiles = [
  'src/db/schema.ts',
  'drizzle/0021_pro_mode_universal_account.sql',
  'drizzle/0022_pro_mode_deletion_and_deployment_race_hardening.sql',
  'src/server/pro-mode.ts',
  'src/server/access-control.ts',
  'scripts/sway-universal-account-pro-mode.behavior.test.ts',
  'scripts/sway-pro-mode-migration.integration.test.mjs',
  'scripts/sway-pro-mode-concurrency.integration.test.mjs',
  'scripts/sway-pro-mode-account-lifecycle.integration.test.mjs'
];

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`Missing Phase 2 Slice 1A release-gate file: ${file}`);
}

const schema = read('src/db/schema.ts');
const migration0021 = read('drizzle/0021_pro_mode_universal_account.sql');
const migration0022 = read('drizzle/0022_pro_mode_deletion_and_deployment_race_hardening.sql');
const proMode = read('src/server/pro-mode.ts');
const accessControl = read('src/server/access-control.ts');
const server = read('server.ts');
const packageJson = read('package.json');
const ciWorkflow = read('.github/workflows/ci.yml');

// Schema: universal account model, not a separate account type.
for (const term of [
  "export const proModeStatusEnum = pgEnum('pro_mode_status', ['disabled', 'onboarding', 'active', 'suspended', 'revoked'])",
  "proModeStatus: proModeStatusEnum('pro_mode_status').notNull().default('disabled')",
  "export const proModeStatusEvents = pgTable('pro_mode_status_events'",
  "nextStatusAllowed: check('pro_mode_status_events_next_status_allowed'"
]) requireIncludes(schema, term, 'Pro Mode schema');

// Remediation 1: the audit table must not carry a live FK to users -- see
// 0022. Columns stay plain uuid, not .references(() => users.id). Scoped to
// just the proModeStatusEvents table definition -- other, unrelated tables
// in this schema legitimately use users.id foreign keys and must not be
// flagged.
const proModeEventsTableStart = schema.indexOf('export const proModeStatusEvents');
const proModeEventsTableEnd = schema.indexOf('}));', proModeEventsTableStart);
const proModeEventsTableSource = proModeEventsTableStart >= 0 && proModeEventsTableEnd > proModeEventsTableStart
  ? schema.slice(proModeEventsTableStart, proModeEventsTableEnd)
  : '';
if (!proModeEventsTableSource) failures.push('Unable to locate the proModeStatusEvents table definition.');
requireExcludes(proModeEventsTableSource, "userId: uuid('user_id').notNull().references(() => users.id)", 'Pro Mode schema (deletion decoupling)');
requireExcludes(proModeEventsTableSource, "actorUserId: uuid('actor_user_id').notNull().references(() => users.id)", 'Pro Mode schema (deletion decoupling)');
requireIncludes(proModeEventsTableSource, "userId: uuid('user_id').notNull(),", 'Pro Mode schema (deletion decoupling)');
requireIncludes(proModeEventsTableSource, "actorUserId: uuid('actor_user_id').notNull(),", 'Pro Mode schema (deletion decoupling)');

// The events table must never gain columns that look like copied PII.
for (const forbidden of ["email: text(", "displayName: text(", "phone: text("]) {
  requireExcludes(proModeEventsTableSource, forbidden, 'Pro Mode status events must not copy direct personal data');
}

// The users table itself must remain the one universal account table --
// Pro Mode must not be modeled as a second/parallel account table.
requireExcludes(schema, "pgTable('pro_accounts'", 'Universal account model');
requireExcludes(schema, "pgTable('patron_accounts'", 'Universal account model');

// Migration 0021: type, columns, backfill, and append-only trigger.
for (const term of [
  'CREATE TYPE "public"."pro_mode_status"',
  'ALTER TABLE "users" ADD COLUMN "pro_mode_status" "pro_mode_status" DEFAULT \'disabled\' NOT NULL',
  'CREATE TABLE "pro_mode_status_events"',
  'CONSTRAINT "pro_mode_status_events_next_status_allowed"',
  'UPDATE "users"',
  'CASE',
  "WHEN performer.\"onboarding_status\" = 'suspended' THEN 'suspended'::pro_mode_status",
  'INSERT INTO "pro_mode_status_events"',
  'CREATE OR REPLACE FUNCTION "sway_reject_immutable_pro_mode_status_event_mutation"',
  'CREATE TRIGGER "pro_mode_status_events_immutable"',
  'BEFORE UPDATE OR DELETE ON "pro_mode_status_events"'
]) requireIncludes(migration0021, term, 'Pro Mode migration 0021');

// 0021 is treated as immutable once committed (remediation decision: fix
// forward with 0022, not edit history) -- it must not itself contain the
// remediation's FK-drop or trigger statements.
requireExcludes(migration0021, 'DROP CONSTRAINT "pro_mode_status_events_user_id_users_id_fk"', '0021 must remain unedited; fixes belong in 0022');
requireExcludes(migration0021, 'sway_initialize_pro_mode_from_legacy_performer_creation', '0021 must remain unedited; fixes belong in 0022');

// Migration 0022: FK removal (Remediation 1) and the legacy-compatibility
// trigger (Remediation 4), with every onboarding_status value handled
// explicitly -- no silent catch-all mapping to 'active'.
for (const term of [
  'DROP CONSTRAINT "pro_mode_status_events_user_id_users_id_fk"',
  'DROP CONSTRAINT "pro_mode_status_events_actor_user_id_users_id_fk"',
  'CREATE OR REPLACE FUNCTION "sway_initialize_pro_mode_from_legacy_performer_creation"',
  'AFTER INSERT ON "performers"',
  'FOR UPDATE',
  "IF current_status IS DISTINCT FROM 'disabled' THEN",
  "WHEN 'created' THEN 'onboarding'::pro_mode_status",
  "WHEN 'profile_started' THEN 'onboarding'::pro_mode_status",
  "WHEN 'gig_ready' THEN 'active'::pro_mode_status",
  "WHEN 'payments_limited' THEN 'active'::pro_mode_status",
  "WHEN 'verification_required' THEN 'active'::pro_mode_status",
  "WHEN 'verified' THEN 'active'::pro_mode_status",
  "WHEN 'payouts_enabled' THEN 'active'::pro_mode_status",
  "WHEN 'restricted' THEN 'active'::pro_mode_status",
  "WHEN 'suspended' THEN 'suspended'::pro_mode_status",
  'RAISE EXCEPTION'
]) requireIncludes(migration0022, term, 'Pro Mode migration 0022');
requireExcludes(migration0022, 'ELSE NULL::pro_mode_status', 'Migration 0022 must not silently default an unmapped status');
requireExcludes(migration0022, 'DROP TABLE', 'Migration 0022 must not drop any existing table');
requireExcludes(migration0022, 'DROP COLUMN', 'Migration 0022 must not drop any existing column');

// Pure transition function must exist and stay exported for unit testing,
// and must not silently allow suspended/revoked accounts to self-reactivate.
// Self-activation goes straight to 'active' (corrected matrix), not a
// separate 'onboarding' stop, per the Gemini remediation conditions.
for (const term of [
  "export function resolveProModeTransition",
  "case 'performer_signup':",
  "case 'self_activate':",
  "if (input.currentStatus !== 'disabled')",
  "if (input.currentStatus === 'disabled' || input.currentStatus === 'onboarding')",
  "return { allowed: true, nextStatus: 'active', changed: true };"
]) requireIncludes(proMode, term, 'Pro Mode transition logic');
requireExcludes(proMode, "case 'admin_suspend'", 'Pro Mode transition logic (admin transitions are a later slice)');
requireExcludes(proMode, "case 'admin_revoke'", 'Pro Mode transition logic (admin transitions are a later slice)');

// This codebase's tsconfig requires === true/false to narrow a discriminated
// union on a boolean field -- bare truthiness silently fails to narrow (see
// project memory). Guard against regressing to the broken pattern.
for (const forbidden of ['if (!transition.allowed)', 'if (!result.allowed)']) {
  requireExcludes(proMode, forbidden, 'Pro Mode transition logic (boolean-discriminant narrowing)');
}

// Remediation 2: concurrency-safe row lock, and the boundary-isolation
// comment must be present and explicit.
requireIncludes(proMode, ".for('update')", 'Pro Mode transition logic must row-lock for concurrency safety');
for (const term of [
  'row-locking the target',
  'never reads or writes performers.*'
]) requireIncludes(proMode, term, 'Pro Mode boundary-isolation documentation');

// Access control: a generic, role-agnostic authenticated-account gate, not a
// talent/admin-specific one. Must not require a performer/admin role.
requireIncludes(accessControl, 'requireAuthenticatedAccountAccess: (req: Request) => Promise<GuardResult>;', 'AccessControl type');
requireIncludes(accessControl, 'async requireAuthenticatedAccountAccess(req)', 'AccessControl implementation');
const guardStart = accessControl.indexOf('async requireAuthenticatedAccountAccess(req)');
const guardEnd = accessControl.indexOf('async requireGigMutationAccess(req, gigId)');
const guardSource = guardStart >= 0 && guardEnd > guardStart ? accessControl.slice(guardStart, guardEnd) : '';
if (!guardSource) failures.push('Unable to locate requireAuthenticatedAccountAccess implementation.');
for (const forbidden of ['hasTalentRole', 'hasAdminRole', 'hasSupportRole']) {
  requireExcludes(guardSource, forbidden, 'Universal account gate must not require a specific role');
}

// server.ts: routes gated by the universal account guard (not talent-only),
// resolving identity only from the session (never from the request body),
// and performer signup wired to begin Pro Mode onboarding automatically.
for (const term of [
  "app.post('/api/account/signup'",
  "app.post('/api/account/login'",
  "app.get('/api/account/session'",
  "app.get('/api/account/pro-mode'",
  "app.post('/api/account/pro-mode/activate'",
  'accessControl.requireAuthenticatedAccountAccess(req)',
  'activateProModeWithPerformer'
]) requireIncludes(server, term, 'Pro Mode account routes');
requireIncludes(proMode, "onboardingStatus: 'gig_ready'", 'Pro Mode performer activation');

const accountRoutesSource = (() => {
  const start = server.indexOf("app.get('/api/account/pro-mode'");
  const end = server.indexOf("app.post('/api/talent/control-bridge/token'");
  return start >= 0 && end > start ? server.slice(start, end) : '';
})();
if (!accountRoutesSource) failures.push('Unable to locate the Pro Mode account routes block.');
for (const forbidden of ['req.body?.userId', 'req.body.userId', 'req.params.userId', 'req.query.userId']) {
  requireExcludes(accountRoutesSource, forbidden, 'Pro Mode account routes must resolve identity only from the session, never from caller-supplied input');
}

const signupRoute = (() => {
  const start = server.indexOf("app.post('/api/talent/signup'");
  const end = server.indexOf("app.post('/api/talent/login'");
  return start >= 0 && end > start ? server.slice(start, end) : '';
})();
if (!signupRoute) failures.push('Unable to locate the performer signup route.');
for (const term of [
  "proModeStatus: 'onboarding'",
  "proModeStatusEvents",
  "reason: 'performer_signup'"
]) requireIncludes(signupRoute, term, 'Performer signup Pro Mode onboarding');

// Scope boundary: this slice is schema + gate + activation + audit/migration
// hardening only. Billing, credits, publishing, collaboration, and feed are
// later, unauthorized slices and must not appear in these specific new files.
const newSliceFiles = [proMode, migration0021, migration0022].join('\n');
for (const forbidden of [
  'stripe', 'Stripe', 'STRIPE_SECRET_KEY',
  'sway_credit', 'SwayCredit', 'credit_ledger',
  'founding_pro', 'foundingPro',
  'release_published', 'promotion_campaign',
  'collaboration_workspace', 'feed_item'
]) {
  requireExcludes(newSliceFiles, forbidden, 'Slice 1A scope boundary');
}

requireIncludes(packageJson, 'node scripts/sway-universal-account-pro-mode.contract.test.mjs', 'package.json contract gate');
requireIncludes(packageJson, 'node scripts/sway-pro-mode-migration.integration.test.mjs', 'package.json migration integration script');
requireIncludes(packageJson, '"test:integration:pro-mode-concurrency"', 'package.json concurrency integration script');
requireIncludes(packageJson, '"test:integration:pro-mode-account-lifecycle"', 'package.json account-lifecycle integration script');

// Remediation 6: the Pro Mode migration proof must actually be wired into
// CI, not merely exist as a local script.
requireIncludes(ciWorkflow, 'test:integration:pro-mode-migration', 'CI workflow must run the Pro Mode migration proof');

if (!failures.length) {
  const behavior = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sway-universal-account-pro-mode.behavior.test.ts'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (behavior.status !== 0) {
    failures.push(`Universal account Pro Mode behavior test failed:\n${behavior.stdout || ''}${behavior.stderr || ''}`);
  }
}

if (failures.length) {
  console.error('Universal account Pro Mode contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Universal account Pro Mode contract passed.');
