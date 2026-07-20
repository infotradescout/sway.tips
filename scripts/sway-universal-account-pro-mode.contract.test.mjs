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
  'src/server/pro-mode.ts',
  'src/server/access-control.ts',
  'scripts/sway-universal-account-pro-mode.behavior.test.ts',
  'scripts/sway-pro-mode-migration.integration.test.mjs'
];

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`Missing Phase 2 Slice 1 release-gate file: ${file}`);
}

const schema = read('src/db/schema.ts');
const migration = read('drizzle/0021_pro_mode_universal_account.sql');
const proMode = read('src/server/pro-mode.ts');
const accessControl = read('src/server/access-control.ts');
const server = read('server.ts');
const packageJson = read('package.json');

// Schema: universal account model, not a separate account type.
for (const term of [
  "export const proModeStatusEnum = pgEnum('pro_mode_status', ['disabled', 'onboarding', 'active', 'suspended', 'revoked'])",
  "proModeStatus: proModeStatusEnum('pro_mode_status').notNull().default('disabled')",
  "export const proModeStatusEvents = pgTable('pro_mode_status_events'",
  "nextStatusAllowed: check('pro_mode_status_events_next_status_allowed'"
]) requireIncludes(schema, term, 'Pro Mode schema');

// The users table itself must remain the one universal account table --
// Pro Mode must not be modeled as a second/parallel account table.
requireExcludes(schema, "pgTable('pro_accounts'", 'Universal account model');
requireExcludes(schema, "pgTable('patron_accounts'", 'Universal account model');

// Migration: type, columns, backfill, and append-only trigger.
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
]) requireIncludes(migration, term, 'Pro Mode migration');

// Pure transition function must exist and stay exported for unit testing,
// and must not silently allow suspended/revoked accounts to self-reactivate.
for (const term of [
  "export function resolveProModeTransition",
  "case 'performer_signup':",
  "case 'self_activate':",
  "if (input.currentStatus !== 'disabled')",
  "input.currentStatus === 'onboarding' || input.currentStatus === 'active'"
]) requireIncludes(proMode, term, 'Pro Mode transition logic');
requireExcludes(proMode, "case 'admin_suspend'", 'Pro Mode transition logic (admin transitions are a later slice)');
requireExcludes(proMode, "case 'admin_revoke'", 'Pro Mode transition logic (admin transitions are a later slice)');

// This codebase's tsconfig requires === true/false to narrow a discriminated
// union on a boolean field -- bare truthiness silently fails to narrow (see
// project memory). Guard against regressing to the broken pattern.
for (const forbidden of ['if (!transition.allowed)', 'if (!result.allowed)']) {
  requireExcludes(proMode, forbidden, 'Pro Mode transition logic (boolean-discriminant narrowing)');
}

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
// and performer signup wired to begin Pro Mode onboarding automatically.
for (const term of [
  "app.get('/api/account/pro-mode'",
  "app.post('/api/account/pro-mode/activate'",
  'accessControl.requireAuthenticatedAccountAccess(req)',
  "action: 'self_activate'"
]) requireIncludes(server, term, 'Pro Mode account routes');

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

// Scope boundary: this slice is schema + gate + activation only. Billing,
// credits, publishing, collaboration, and feed are later, unauthorized
// slices and must not appear in these specific new files.
const newSliceFiles = [proMode, migration].join('\n');
for (const forbidden of [
  'stripe', 'Stripe', 'STRIPE_SECRET_KEY',
  'sway_credit', 'SwayCredit', 'credit_ledger',
  'founding_pro', 'foundingPro',
  'release_published', 'promotion_campaign',
  'collaboration_workspace', 'feed_item'
]) {
  requireExcludes(newSliceFiles, forbidden, 'Slice 1 scope boundary')
    ;
}

requireIncludes(packageJson, 'node scripts/sway-universal-account-pro-mode.contract.test.mjs', 'package.json contract gate');
requireIncludes(packageJson, 'node scripts/sway-pro-mode-migration.integration.test.mjs', 'package.json migration integration script');

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
