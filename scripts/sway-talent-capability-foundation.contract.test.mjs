import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const schema = read('src/db/schema.ts');
const migration = read('drizzle/0037_talent_capability_foundation.sql');
const capabilityModel = read('docs/SWAY_TALENT_CAPABILITY_MODEL.md');
const packageJson = JSON.parse(read('package.json'));
const failures = [];

function requireText(source, text, label) {
  if (!source.includes(text)) failures.push(`${label}: missing ${text}`);
}

function rejectText(source, text, label) {
  if (source.includes(text)) failures.push(`${label}: prohibited ${text}`);
}

for (const term of [
  "export const professionalIdentityKindEnum = pgEnum('professional_identity_kind'",
  "'comedian'",
  "'singer'",
  "'songwriter'",
  "'bartender'",
  "'service_professional'",
  "export const performerIdentityEvents = pgTable('performer_identity_events'",
  "export const performerIntentEvents = pgTable('performer_intent_events'",
  "export const performerCapabilityGrantEvents = pgTable('performer_capability_grant_events'",
  "export const performerAuthorityEvents = pgTable('performer_authority_events'",
  "export const accountDiscoveryAttributions = pgTable('account_discovery_attributions'",
  "export const growthMilestones = pgTable('growth_milestones'",
  "eventSequence: bigserial('event_sequence'",
  "idempotencyKeyHash: text('idempotency_key_hash').notNull()"
]) {
  requireText(schema, term, 'Wave 1 schema');
}

rejectText(schema, "primaryIdentityKind: professionalIdentityKindEnum('primary_identity_kind').notNull().default('other')", 'identity truth');
rejectText(migration, 'ON DELETE cascade', 'deletion-safe Wave 1 history');

for (const table of [
  'performer_identity_events',
  'performer_intent_events',
  'performer_capability_grant_events',
  'performer_authority_events',
  'account_discovery_attributions',
  'growth_milestones'
]) {
  requireText(migration, `CREATE TABLE "${table}"`, 'Wave 1 migration');
  requireText(migration, `CREATE TRIGGER "${table}_append_only"`, `${table} immutability`);
  requireText(migration, `BEFORE UPDATE OR DELETE ON "${table}"`, `${table} immutability`);
}

for (const term of [
  'Only the performer owner may declare professional identity.',
  'Only the performer owner may declare earning modes or desired capabilities.',
  'Capability and authority decisions require persisted admin access.',
  "nextval(pg_get_serial_sequence('performer_identity_events', 'event_sequence'))",
  "nextval(pg_get_serial_sequence('performer_capability_grant_events', 'event_sequence'))",
  'An active capability grant must be revoked or expired before another grant.',
  'Active subject authority must be revoked or expired before another grant.',
  "latest_is_active := latest_decision = 'granted'",
  "latest_expiry IS NULL OR latest_expiry > NEW.created_at",
  'Authority kind must match its exact subject type.',
  'Authority decisions require a non-empty durable evidence reference.',
  'Ticket inventory authority requires an existing offer owned by the performer.',
  'Account attribution requires prior durable discovery entry evidence.',
  'Account attribution must snapshot the exact prior discovery entry, including acquisition classification.',
  "AND metadata->>'stage' = 'entry'\n  FOR KEY SHARE;",
  'SELECT * INTO evidence_row FROM audit_events WHERE event_id = NEW.evidence_event_id\n  FOR KEY SHARE;',
  'Organic acquisition requires direct server evidence and a known non-direct source.',
  "interval '14 days'",
  "interval '30 days'",
  'Production OQPS requires directly observed unpaid-organic attribution.',
  "attribution_row.linked_at + interval '14 days'",
  "attribution_row.linked_at + interval '30 days'",
  'growth.qualified_signup.evaluated',
  'same-time authoritative server evaluation',
  'Qualified signup snapshot must exactly match server-derived current state.',
  "'evaluationVersion', 'oqps-v1'",
  "(evidence_row.metadata->>'evaluationId') IS DISTINCT FROM NEW.evidence_event_id::text",
  'AND NOT coalesce((',
  'Profile publication value requires an authoritative eligible-publication transition.',
  'Event publication value requires an authoritative published event.',
  'Live-room value requires an authoritative completed room.',
  'Release value requires authoritative readiness evidence.',
  'Inquiry value requires an authoritative non-money inquiry event.'
]) {
  requireText(migration, term, 'Wave 1 persistence policy');
}

const tableBlock = (tableName) => {
  const start = migration.indexOf(`CREATE TABLE "${tableName}"`);
  if (start < 0) return '';
  const end = migration.indexOf('--> statement-breakpoint', start);
  return migration.slice(start, end < 0 ? undefined : end);
};

for (const [tableName, block] of [
  ['performer_capability_grant_events', tableBlock('performer_capability_grant_events')],
  ['performer_authority_events', tableBlock('performer_authority_events')]
]) {
  for (const descriptiveField of ['identity_kind', 'identity_role', 'earning_mode', 'intent_type']) {
    rejectText(block, descriptiveField, `${tableName} authorization separation`);
  }
}

requireText(capabilityModel, 'Labels never grant money, ticketing, publication, venue, catalog, payout, moderation, or administrative authority.', 'capability model');
requireText(capabilityModel, 'A capability grant alone is never sufficient for a consequential action.', 'capability conjunction boundary');
requireText(capabilityModel, 'Live-money and native-ticket actions remain separately gated', 'money and ticket conjunction boundary');
requireText(migration, 'performer_capability_grant_events_validate', 'server capability grant trigger');
requireText(migration, 'performer_authority_events_validate', 'subject authority trigger');
requireText(migration, 'account_discovery_attributions_user_idx', 'one first-touch attribution per account');
requireText(migration, 'growth_milestones_user_kind_environment_idx', 'deduped growth milestones');
requireText(migration, 'audit_events_protect_wave1_linked_evidence', 'linked attribution and milestone evidence protection');
requireText(migration, 'Audit evidence linked to acquisition or growth records is immutable.', 'linked attribution and milestone evidence protection');

const integrationCommand = 'node --import tsx scripts/sway-talent-capability-foundation.integration.test.ts';
if (packageJson.scripts?.['test:integration:talent-capability-foundation'] !== integrationCommand) {
  failures.push('package scripts: Wave 1 disposable-database integration command is missing');
}
if (packageJson.scripts?.['test:talent-capability-foundation'] !== 'node scripts/sway-talent-capability-foundation.contract.test.mjs && npm run test:integration:talent-capability-foundation') {
  failures.push('package scripts: Wave 1 aggregate command is missing');
}
const expectedContractCommand = 'node scripts/sway-talent-capability-foundation.contract.test.mjs';
const hardCommands = (packageJson.scripts?.['test:contracts'] ?? '').split('&&').map((command) => command.trim());
if (!hardCommands.includes(expectedContractCommand)) {
  failures.push('package scripts: Wave 1 contract is not directly registered in test:contracts');
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join('\n'));
  process.exit(1);
}

console.log('PASS sway-talent-capability-foundation contract');
