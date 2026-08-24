import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = process.cwd();
const migrationDirectory = join(root, 'drizzle');
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

const ids = {
  owner: '10000000-0000-4000-8000-000000000001',
  intruder: '10000000-0000-4000-8000-000000000002',
  admin: '10000000-0000-4000-8000-000000000003',
  performer: '20000000-0000-4000-8000-000000000001',
  sourceEvent: '30000000-0000-4000-8000-000000000001',
  unverifiedSourceEvent: '30000000-0000-4000-8000-000000000002',
  qualificationEvent: '30000000-0000-4000-8000-000000000003',
  profileValueEvent: '30000000-0000-4000-8000-000000000004',
  lateQualificationEvent: '30000000-0000-4000-8000-000000000005',
  lateValueEvent: '30000000-0000-4000-8000-000000000006',
  forgedQualificationEvent: '30000000-0000-4000-8000-000000000007',
  invalidProfileValueEvent: '30000000-0000-4000-8000-000000000008',
  journey: '40000000-0000-4000-8000-000000000001',
  unverifiedJourney: '40000000-0000-4000-8000-000000000002'
} as const;

const accountCreatedAt = '2026-06-01T12:00:00.000Z';
const firstTouchAt = '2026-06-02T12:00:00.000Z';
const linkedAt = '2026-06-03T12:00:00.000Z';
const qualifiedAt = '2026-06-05T12:00:00.000Z';
const lateQualificationAt = '2026-06-18T12:00:00.000Z';
const lateValueAt = '2026-07-04T12:00:00.000Z';

const keyHash = (label: string) => createHash('sha256').update(label).digest('hex');

async function applyMigrations(database: PGlite) {
  for (const migrationFile of migrationFiles) {
    const migrationSql = readFileSync(join(migrationDirectory, migrationFile), 'utf8');
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const [statementIndex, statement] of statements.entries()) {
      try {
        await database.exec(statement);
      } catch (error) {
        throw new Error(`Migration failed: ${migrationFile}, statement ${statementIndex + 1}`, { cause: error });
      }
    }
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function expectDatabaseRejection(action: () => Promise<unknown>, expected: RegExp, label: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.match(errorText(error), expected, label);
    return true;
  });
}

async function insertAuditEvent(database: PGlite, input: {
  eventId: string;
  entityType: string;
  entityId: string;
  eventType: string;
  createdAt: string;
  actorType?: string;
  actorId?: string | null;
  previousStatus?: string | null;
  nextStatus?: string | null;
  metadata: Record<string, unknown>;
}) {
  await database.query(
    `insert into audit_events (
       event_id, actor_type, actor_id, entity_type, entity_id, event_type,
       previous_status, next_status, metadata, created_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz)`,
    [
      input.eventId,
      input.actorType ?? (input.actorId ? 'performer' : 'anonymous'),
      input.actorId ?? null,
      input.entityType,
      input.entityId,
      input.eventType,
      input.previousStatus ?? null,
      input.nextStatus ?? null,
      JSON.stringify(input.metadata),
      input.createdAt
    ]
  );
}

async function runProof(database: PGlite) {
  await applyMigrations(database);
  assert.equal(
    migrationFiles.includes('0037_talent_capability_foundation.sql'),
    true,
    'The capability foundation migration must remain in the complete migration chain.'
  );

  await database.query(
    `insert into users (id, email, display_name, role, email_verified_at, pro_mode_status, created_at, updated_at)
     values
       ($1, 'owner@example.test', 'Owner', 'performer', $4::timestamptz, 'active', $5::timestamptz, $5::timestamptz),
       ($2, 'intruder@example.test', 'Intruder', 'performer', $4::timestamptz, 'active', $5::timestamptz, $5::timestamptz),
       ($3, 'admin@example.test', 'Admin', 'admin', $4::timestamptz, 'disabled', $5::timestamptz, $5::timestamptz)`,
    [ids.owner, ids.intruder, ids.admin, '2026-06-02T00:00:00.000Z', accountCreatedAt]
  );
  await database.query(
    `insert into performers (
       id, owner_user_id, handle, display_name, bio, is_active, visibility_state,
       onboarding_status, created_at, updated_at
     ) values ($1, $2, 'comic-one', 'Comic One', $3, true, 'public', 'verified', $4::timestamptz, $4::timestamptz)`,
    [ids.performer, ids.owner, 'A working comedian with original material, real shows, and direct booking information.', accountCreatedAt]
  );
  await database.query(
    `insert into performer_public_profiles (performer_id, headline, city, created_at, updated_at)
     values ($1, 'Stand-up comedian and live host', 'Chicago', $2::timestamptz, $2::timestamptz)`,
    [ids.performer, accountCreatedAt]
  );

  await database.query(
    `insert into performer_identity_events (
       performer_id, identity_role, identity_kind, event_type, actor_user_id, idempotency_key_hash, created_at
     ) values ($1, 'primary', 'comedian', 'selected', $2, $3, '2026-06-02T01:00:00Z')`,
    [ids.performer, ids.owner, keyHash('identity-primary')]
  );
  await expectDatabaseRejection(
    () => database.query(
      `insert into performer_identity_events (
         performer_id, identity_role, identity_kind, event_type, actor_user_id, idempotency_key_hash
       ) values ($1, 'primary', 'comedian', 'selected', $2, $3)`,
      [ids.performer, ids.owner, keyHash('identity-primary-duplicate')]
    ),
    /already selected/i,
    'Duplicate primary identity must fail.'
  );
  await expectDatabaseRejection(
    () => database.query(
      `insert into performer_identity_events (
         performer_id, identity_role, identity_kind, event_type, actor_user_id, idempotency_key_hash
       ) values ($1, 'secondary', 'host', 'selected', $2, $3)`,
      [ids.performer, ids.intruder, keyHash('identity-intruder')]
    ),
    /only the performer owner/i,
    'A non-owner must not declare identity.'
  );
  await database.query(
    `insert into performer_identity_events (
       performer_id, identity_role, identity_kind, event_type, actor_user_id, idempotency_key_hash
     ) values ($1, 'secondary', 'host', 'selected', $2, $3)`,
    [ids.performer, ids.owner, keyHash('identity-secondary')]
  );
  await database.query(
    `insert into performer_identity_events (
       performer_id, identity_role, identity_kind, event_type, actor_user_id, idempotency_key_hash
     ) values ($1, 'secondary', 'host', 'withdrawn', $2, $3)`,
    [ids.performer, ids.owner, keyHash('identity-secondary-withdraw')]
  );

  await database.query(
    `insert into performer_intent_events (
       performer_id, intent_type, earning_mode, event_type, actor_user_id, idempotency_key_hash
     ) values ($1, 'earning_mode', 'bookings', 'selected', $2, $3)`,
    [ids.performer, ids.owner, keyHash('intent-bookings')]
  );
  await database.query(
    `insert into performer_intent_events (
       performer_id, intent_type, desired_capability, event_type, actor_user_id, idempotency_key_hash
     ) values ($1, 'desired_capability', 'live_money', 'selected', $2, $3)`,
    [ids.performer, ids.owner, keyHash('intent-live-money')]
  );

  await expectDatabaseRejection(
    () => database.query(
      `insert into performer_capability_grant_events (
         performer_id, capability, decision, actor_type, actor_user_id, reason, evidence, idempotency_key_hash
       ) values ($1, 'live_money', 'granted', 'admin', $2, 'Self grant', '{"source":"owner"}'::jsonb, $3)`,
      [ids.performer, ids.owner, keyHash('owner-self-grant')]
    ),
    /persisted admin access/i,
    'Identity or intent must never let an owner self-grant live money.'
  );
  await database.query(
    `insert into performer_capability_grant_events (
       performer_id, capability, decision, actor_type, actor_user_id, reason, evidence, idempotency_key_hash
     ) values ($1, 'live_money', 'granted', 'admin', $2, 'Policy evidence recorded', '{"policyVersion":"wave1-test"}'::jsonb, $3)`,
    [ids.performer, ids.admin, keyHash('admin-live-money-grant')]
  );
  await expectDatabaseRejection(
    () => database.query(
      `insert into performer_capability_grant_events (
         performer_id, capability, decision, actor_type, actor_user_id, reason, evidence, idempotency_key_hash
       ) values ($1, 'live_money', 'granted', 'admin', $2, 'Duplicate', '{"policyVersion":"wave1-test"}'::jsonb, $3)`,
      [ids.performer, ids.admin, keyHash('duplicate-live-money-grant')]
    ),
    /active capability grant/i,
    'A second active grant must fail.'
  );
  await database.query(
    `insert into performer_capability_grant_events (
       performer_id, capability, decision, actor_type, actor_user_id, reason, evidence, idempotency_key_hash
     ) values ($1, 'live_money', 'revoked', 'admin', $2, 'Evidence no longer current', '{"policyVersion":"wave1-test"}'::jsonb, $3)`,
    [ids.performer, ids.admin, keyHash('admin-live-money-revoke')]
  );
  await database.query(
    `insert into performer_capability_grant_events (
       performer_id, capability, decision, actor_type, actor_user_id, reason, evidence,
       expires_at, idempotency_key_hash, created_at
     ) values ($1, 'profile_publication', 'granted', 'admin', $2, 'Time-bound policy proof',
       '{"policyVersion":"wave1-test"}'::jsonb, '2026-06-04T00:00:00Z', $3, '2026-06-02T00:00:00Z')`,
    [ids.performer, ids.admin, keyHash('expiring-profile-publication-grant')]
  );
  await database.query(
    `insert into performer_capability_grant_events (
       performer_id, capability, decision, actor_type, actor_user_id, reason, evidence,
       idempotency_key_hash, created_at
     ) values ($1, 'profile_publication', 'granted', 'admin', $2, 'Renewed after recorded expiry',
       '{"policyVersion":"wave1-test-renewal"}'::jsonb, $3, '2026-06-05T00:00:00Z')`,
    [ids.performer, ids.admin, keyHash('renewed-profile-publication-grant')]
  );

  await expectDatabaseRejection(
    () => database.query(
      `insert into performer_authority_events (
         performer_id, authority_kind, subject_type, subject_id, decision, actor_type, actor_user_id,
         reason, evidence, idempotency_key_hash
       ) values ($1, 'venue_representative', 'venue', 'venue:chicago-one', 'granted', 'admin', $2,
         'Self claimed', '{"reference":"owner-label"}'::jsonb, $3)`,
      [ids.performer, ids.owner, keyHash('owner-self-authority')]
    ),
    /persisted admin access/i,
    'A profession label must never grant venue authority.'
  );
  await expectDatabaseRejection(
    () => database.query(
      `insert into performer_authority_events (
         performer_id, authority_kind, subject_type, subject_id, decision, actor_type, actor_user_id,
         reason, evidence, idempotency_key_hash
       ) values ($1, 'ticket_inventory', 'venue', 'venue:chicago-one', 'granted', 'admin', $2,
         'Mismatched subject', '{"reference":"mismatch-proof"}'::jsonb, $3)`,
      [ids.performer, ids.admin, keyHash('mismatched-ticket-authority')]
    ),
    /exact subject type/i,
    'Ticket inventory authority must not be recorded against a venue label.'
  );
  await expectDatabaseRejection(
    () => database.query(
      `insert into performer_authority_events (
         performer_id, authority_kind, subject_type, subject_id, decision, actor_type, actor_user_id,
         reason, evidence, idempotency_key_hash
       ) values ($1, 'event_organizer', 'event', $2, 'granted', 'admin', $3,
         'Missing event', '{"reference":"missing-event-proof"}'::jsonb, $4)`,
      [ids.performer, ids.performer, ids.admin, keyHash('missing-event-authority')]
    ),
    /existing event owned by the performer/i,
    'Internal event authority must point to an existing performer-owned event.'
  );
  await database.query(
    `insert into performer_authority_events (
       performer_id, authority_kind, subject_type, subject_id, decision, actor_type, actor_user_id,
       reason, evidence, idempotency_key_hash
     ) values ($1, 'venue_representative', 'venue', 'venue:chicago-one', 'granted', 'admin', $2,
       'Venue authorization reviewed', '{"reference":"authority-proof-1"}'::jsonb, $3)`,
    [ids.performer, ids.admin, keyHash('admin-venue-grant')]
  );
  await database.query(
    `insert into performer_authority_events (
       performer_id, authority_kind, subject_type, subject_id, decision, actor_type, actor_user_id,
       reason, evidence, idempotency_key_hash
     ) values ($1, 'venue_representative', 'venue', 'venue:chicago-one', 'revoked', 'admin', $2,
       'Venue authorization revoked', '{"reference":"authority-proof-1"}'::jsonb, $3)`,
    [ids.performer, ids.admin, keyHash('admin-venue-revoke')]
  );
  await database.query(
    `insert into performer_authority_events (
       performer_id, authority_kind, subject_type, subject_id, decision, actor_type, actor_user_id,
       reason, evidence, expires_at, idempotency_key_hash, created_at
     ) values ($1, 'seller', 'seller', 'seller:comic-one', 'granted', 'admin', $2,
       'Time-bound seller proof', '{"reference":"seller-proof-1"}'::jsonb,
       '2026-06-04T00:00:00Z', $3, '2026-06-02T00:00:00Z')`,
    [ids.performer, ids.admin, keyHash('expiring-seller-authority')]
  );
  await database.query(
    `insert into performer_authority_events (
       performer_id, authority_kind, subject_type, subject_id, decision, actor_type, actor_user_id,
       reason, evidence, idempotency_key_hash, created_at
     ) values ($1, 'seller', 'seller', 'seller:comic-one', 'granted', 'admin', $2,
       'Renewed after recorded expiry', '{"reference":"seller-proof-2"}'::jsonb,
       $3, '2026-06-05T00:00:00Z')`,
    [ids.performer, ids.admin, keyHash('renewed-seller-authority')]
  );

  await insertAuditEvent(database, {
    eventId: ids.sourceEvent,
    entityType: 'shell_friction',
    entityId: ids.journey,
    eventType: 'discovery_landing',
    createdAt: firstTouchAt,
    metadata: {
      stage: 'entry',
      source: 'google',
      source_class: 'organic_unpaid',
      utm_source: 'google',
      utm_medium: 'organic',
      entry_path: '/discover',
      entity_kind: 'performer',
      entity_key: 'comic-one',
      link_strength: 'direct_server_observed',
      occurred_at: firstTouchAt
    }
  });
  await expectDatabaseRejection(
    () => database.query(
      `insert into account_discovery_attributions (
         user_id, source_event_id, journey_entity_id, source_channel, source_class,
         utm_source, utm_medium, landing_path, entity_kind, entity_key,
         first_touch_at, linked_at, evidence_strength, idempotency_key_hash
       ) values ($1, $2, $3, 'google', 'paid', 'google', 'organic', '/discover',
         'performer', 'comic-one', $4::timestamptz, $5::timestamptz, 'direct_server_observed', $6)`,
      [ids.owner, ids.sourceEvent, ids.journey, firstTouchAt, linkedAt, keyHash('relabeled-attribution')]
    ),
    /including acquisition classification/i,
    'A durable discovery entry must not be relabeled during account attribution.'
  );
  await database.query(
    `insert into account_discovery_attributions (
       user_id, source_event_id, journey_entity_id, source_channel, source_class,
       utm_source, utm_medium, landing_path, entity_kind, entity_key,
       first_touch_at, linked_at, evidence_strength, idempotency_key_hash
     ) values ($1, $2, $3, 'google', 'organic_unpaid', 'google', 'organic', '/discover',
       'performer', 'comic-one', $4::timestamptz, $5::timestamptz, 'direct_server_observed', $6)`,
    [ids.owner, ids.sourceEvent, ids.journey, firstTouchAt, linkedAt, keyHash('owner-attribution')]
  );

  await insertAuditEvent(database, {
    eventId: ids.unverifiedSourceEvent,
    entityType: 'shell_friction',
    entityId: ids.unverifiedJourney,
    eventType: 'discovery_landing',
    createdAt: firstTouchAt,
    metadata: {
      stage: 'entry', source: 'google', source_class: 'organic_unpaid', entry_path: '/discover',
      link_strength: 'client_correlated_unverified', occurred_at: firstTouchAt
    }
  });
  await expectDatabaseRejection(
    () => database.query(
      `insert into account_discovery_attributions (
         user_id, source_event_id, journey_entity_id, source_channel, source_class,
         landing_path, first_touch_at, linked_at, evidence_strength, idempotency_key_hash
       ) values ($1, $2, $3, 'google', 'organic_unpaid', '/discover', $4::timestamptz,
         $5::timestamptz, 'client_correlated_unverified', $6)`,
      [ids.intruder, ids.unverifiedSourceEvent, ids.unverifiedJourney, firstTouchAt, linkedAt, keyHash('unverified-organic')]
    ),
    /organic acquisition requires direct server evidence/i,
    'Client-correlated traffic must not count as organic.'
  );

  const attribution = await database.query<{ id: string }>(
    'select id from account_discovery_attributions where user_id = $1',
    [ids.owner]
  );
  const attributionId = attribution.rows[0]?.id;
  assert.ok(attributionId);
  const qualificationSnapshot = JSON.stringify({
    evaluationVersion: 'oqps-v1',
    verified: true,
    active: true,
    unrestricted: true,
    ownsValidProfile: true,
    profileComplete: true,
    publiclyEligible: true
  });
  const forgedQualificationSnapshot = JSON.stringify({
    evaluationVersion: 'oqps-v1',
    verified: false,
    active: true,
    unrestricted: true,
    ownsValidProfile: true,
    profileComplete: true,
    publiclyEligible: true
  });
  await insertAuditEvent(database, {
    eventId: ids.forgedQualificationEvent,
    entityType: 'performer',
    entityId: ids.performer,
    eventType: 'growth.qualified_signup.evaluated',
    createdAt: qualifiedAt,
    actorType: 'system',
    metadata: {
      evaluationId: ids.forgedQualificationEvent,
      evaluationVersion: 'oqps-v1',
      attributionId,
      qualificationSnapshot: JSON.parse(forgedQualificationSnapshot)
    }
  });
  await expectDatabaseRejection(
    () => database.query(
      `insert into growth_milestones (
         user_id, performer_id, attribution_id, milestone_kind, evidence_event_id,
         occurred_at, environment, qualification_snapshot, idempotency_key_hash, created_at
       ) values ($1, $2, $3, 'qualified_signup', $4, $5::timestamptz, 'production',
         $6::jsonb, $7, '2026-08-01T00:00:00Z')`,
      [ids.owner, ids.performer, attributionId, ids.forgedQualificationEvent, qualifiedAt, forgedQualificationSnapshot, keyHash('forged-qualified-signup')]
    ),
    /server-derived current state/i,
    'Caller-shaped qualification evidence must not create a production OQPS milestone.'
  );
  await insertAuditEvent(database, {
    eventId: ids.qualificationEvent,
    entityType: 'performer',
    entityId: ids.performer,
    eventType: 'growth.qualified_signup.evaluated',
    createdAt: qualifiedAt,
    actorType: 'system',
    metadata: {
      evaluationId: ids.qualificationEvent,
      evaluationVersion: 'oqps-v1',
      attributionId,
      qualificationSnapshot: JSON.parse(qualificationSnapshot)
    }
  });
  await insertAuditEvent(database, {
    eventId: ids.invalidProfileValueEvent,
    entityType: 'performer',
    entityId: ids.performer,
    eventType: 'performer_visibility.update',
    createdAt: qualifiedAt,
    actorId: ids.owner,
    previousStatus: 'draft',
    nextStatus: 'public',
    metadata: { control: 'owner', visibilityState: 'public' }
  });
  await insertAuditEvent(database, {
    eventId: ids.profileValueEvent,
    entityType: 'performer',
    entityId: ids.performer,
    eventType: 'performer_visibility.update',
    createdAt: qualifiedAt,
    actorId: ids.owner,
    previousStatus: 'draft',
    nextStatus: 'public',
    metadata: { control: 'owner', visibilityState: 'public', publiclyEligible: true }
  });
  await database.query(
    `insert into growth_milestones (
       user_id, performer_id, attribution_id, milestone_kind, evidence_event_id,
       occurred_at, environment, qualification_snapshot, idempotency_key_hash, created_at
     ) values ($1, $2, $3, 'qualified_signup', $4, $5::timestamptz, 'production',
       $6::jsonb, $7, '2026-08-01T00:00:00Z')`,
    [ids.owner, ids.performer, attributionId, ids.qualificationEvent, qualifiedAt, qualificationSnapshot, keyHash('qualified-signup')]
  );
  await expectDatabaseRejection(
    () => database.query(
      `insert into growth_milestones (
         user_id, performer_id, attribution_id, milestone_kind, value_kind, evidence_event_id,
         occurred_at, environment, qualification_snapshot, idempotency_key_hash, created_at
       ) values ($1, $2, $3, 'first_value', 'profile_published', $4, $5::timestamptz,
         'production', $6::jsonb, $7, '2026-08-01T00:00:00Z')`,
      [ids.owner, ids.performer, attributionId, ids.invalidProfileValueEvent, qualifiedAt, qualificationSnapshot, keyHash('ineligible-profile-value')]
    ),
    /eligible-publication transition/i,
    'A nullable or missing eligibility flag must not count as profile-publication value.'
  );
  await database.query(
    `insert into growth_milestones (
       user_id, performer_id, attribution_id, milestone_kind, value_kind, evidence_event_id,
       occurred_at, environment, qualification_snapshot, idempotency_key_hash, created_at
     ) values ($1, $2, $3, 'first_value', 'profile_published', $4, $5::timestamptz,
       'production', $6::jsonb, $7, '2026-08-01T00:00:00Z')`,
    [ids.owner, ids.performer, attributionId, ids.profileValueEvent, qualifiedAt, qualificationSnapshot, keyHash('first-value')]
  );

  await insertAuditEvent(database, {
    eventId: ids.lateQualificationEvent,
    entityType: 'performer',
    entityId: ids.performer,
    eventType: 'growth.qualified_signup.evaluated',
    createdAt: lateQualificationAt,
    actorType: 'system',
    metadata: {
      evaluationId: ids.lateQualificationEvent,
      evaluationVersion: 'oqps-v1',
      attributionId,
      qualificationSnapshot: JSON.parse(qualificationSnapshot)
    }
  });
  await expectDatabaseRejection(
    () => database.query(
      `insert into growth_milestones (
         user_id, performer_id, attribution_id, milestone_kind, evidence_event_id,
         occurred_at, environment, qualification_snapshot, idempotency_key_hash, created_at
       ) values ($1, $2, $3, 'qualified_signup', $4, $5::timestamptz, 'test',
         $6::jsonb, $7, '2026-08-01T00:00:00Z')`,
      [ids.owner, ids.performer, attributionId, ids.lateQualificationEvent, lateQualificationAt, qualificationSnapshot, keyHash('late-qualified-signup')]
    ),
    /within 14 days/i,
    'Late qualification must not count.'
  );

  await insertAuditEvent(database, {
    eventId: ids.lateValueEvent,
    entityType: 'performer',
    entityId: ids.performer,
    eventType: 'performer_visibility.update',
    createdAt: lateValueAt,
    actorId: ids.owner,
    previousStatus: 'draft',
    nextStatus: 'public',
    metadata: { control: 'owner', visibilityState: 'public', publiclyEligible: true }
  });
  await expectDatabaseRejection(
    () => database.query(
      `insert into growth_milestones (
         user_id, performer_id, attribution_id, milestone_kind, value_kind, evidence_event_id,
         occurred_at, environment, qualification_snapshot, idempotency_key_hash, created_at
       ) values ($1, $2, $3, 'first_value', 'profile_published', $4, $5::timestamptz,
         'test', $6::jsonb, $7, '2026-08-01T00:00:00Z')`,
      [ids.owner, ids.performer, attributionId, ids.lateValueEvent, lateValueAt, qualificationSnapshot, keyHash('late-first-value')]
    ),
    /within 30 days/i,
    'Late first value must not count.'
  );

  await expectDatabaseRejection(
    () => database.query('update performer_capability_grant_events set reason = $1 where performer_id = $2', ['mutated', ids.performer]),
    /append-only/i,
    'Capability history must be immutable.'
  );
  await expectDatabaseRejection(
    () => database.query('delete from account_discovery_attributions where user_id = $1', [ids.owner]),
    /append-only/i,
    'First-touch attribution must be immutable.'
  );
  await expectDatabaseRejection(
    () => database.query('delete from growth_milestones where user_id = $1', [ids.owner]),
    /append-only/i,
    'Growth milestones must be immutable.'
  );
  await expectDatabaseRejection(
    () => database.query('update audit_events set event_type = $1 where event_id = $2', ['tampered', ids.sourceEvent]),
    /linked to acquisition or growth records is immutable/i,
    'Linked discovery evidence must be immutable.'
  );
  await expectDatabaseRejection(
    () => database.query('delete from audit_events where event_id = $1', [ids.qualificationEvent]),
    /linked to acquisition or growth records is immutable/i,
    'Linked milestone evidence must be immutable.'
  );

  await database.query(
    `update users set email = null, display_name = null, password_hash = null, phone = null, updated_at = now()
     where id = $1`,
    [ids.owner]
  );
  const retained = await database.query<{ identities: number; intents: number; grants: number; authorities: number; attributions: number; milestones: number }>(
    `select
       (select count(*)::int from performer_identity_events where performer_id = $1) as identities,
       (select count(*)::int from performer_intent_events where performer_id = $1) as intents,
       (select count(*)::int from performer_capability_grant_events where performer_id = $1) as grants,
       (select count(*)::int from performer_authority_events where performer_id = $1) as authorities,
       (select count(*)::int from account_discovery_attributions where user_id = $2) as attributions,
       (select count(*)::int from growth_milestones where user_id = $2) as milestones`,
    [ids.performer, ids.owner]
  );
  assert.deepEqual(retained.rows[0], {
    identities: 3,
    intents: 2,
    grants: 7,
    authorities: 4,
    attributions: 1,
    milestones: 2
  });

  const latestDecisions = await database.query<{ capability: string; authority: string }>(
    `select
       (select decision::text from performer_capability_grant_events where performer_id = $1 and capability = 'live_money' order by event_sequence desc limit 1) as capability,
       (select decision::text from performer_authority_events where performer_id = $1 and authority_kind = 'venue_representative' order by event_sequence desc limit 1) as authority`,
    [ids.performer]
  );
  assert.deepEqual(latestDecisions.rows[0], { capability: 'revoked', authority: 'revoked' });
}

const database = new PGlite();
try {
  await runProof(database);
  console.log(`Sway talent capability foundation integration test passed (${migrationFiles.length} migrations).`);
} finally {
  await database.close();
}
