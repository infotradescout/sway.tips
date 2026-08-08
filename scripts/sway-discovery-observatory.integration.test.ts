import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema';
import { createDiscoveryObservatoryStore } from '../src/server/discovery-observatory-store';
import { buildDiscoveryObservatorySnapshot } from '../src/server/discovery-observatory';

const root = process.cwd();
const migrationDirectory = join(root, 'drizzle');
const migrationFiles = readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const evidencePath = join(root, 'docs/process/SWAY_DISCOVERY_OBSERVATORY_WAVE1_LOCAL_EVIDENCE.json');
const actorUserId = '10000000-0000-4000-8000-000000000001';
const experimentKey = 'sway-performer-named-link-discovery-v1';
const assignmentJourney = '20000000-0000-4000-8000-000000000001';
const roomJourney = '20000000-0000-4000-8000-000000000002';
const tipJourney = '20000000-0000-4000-8000-000000000003';
const ticketJourney = '20000000-0000-4000-8000-000000000004';
const roomId = '30000000-0000-4000-8000-000000000001';
const eventId = '30000000-0000-4000-8000-000000000002';

async function applyAllMigrations(database: PGlite) {
  for (const migrationFile of migrationFiles) {
    const migrationSql = readFileSync(join(migrationDirectory, migrationFile), 'utf8');
    for (const [index, statement] of migrationSql.split('--> statement-breakpoint').map((value) => value.trim()).filter(Boolean).entries()) {
      try {
        await database.exec(statement);
      } catch (error) {
        throw new Error(`Migration failed: ${migrationFile}, statement ${index + 1}`, { cause: error });
      }
    }
  }
}

async function main() {
  const database = new PGlite();
  try {
    await applyAllMigrations(database);
    const db = drizzle(database, { schema });
    const store = createDiscoveryObservatoryStore(db);
    const fixture = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      automaticImport: boolean;
      productionMetric: boolean;
      observations: Array<Record<string, unknown>>;
    };
    assert.equal(fixture.automaticImport, false);
    assert.equal(fixture.productionMetric, false);

    // Real ingestion contract, disposable database only. Concurrent duplicates
    // remain one observation because the record grain has a deterministic ID.
    await Promise.all(fixture.observations.flatMap((observation) => [
      store.recordObservation({ actorUserId, observation: observation as never }),
      store.recordObservation({ actorUserId, observation: observation as never })
    ]));
    const observationCount = await database.query<{ count: number }>(
      `select count(*)::int as count from audit_events where event_type = 'discovery_observation.recorded'`
    );
    assert.equal(Number(observationCount.rows[0]?.count), fixture.observations.length);
    const dayPrecisionCount = await database.query<{ count: number }>(
      `select count(*)::int as count from audit_events where event_type = 'discovery_observation.recorded' and metadata->>'observed_precision' = 'day'`
    );
    assert.equal(Number(dayPrecisionCount.rows[0]?.count), fixture.observations.length);

    await store.recordExperimentDecision({
      actorUserId,
      experimentKey,
      decision: 'activate',
      evidenceNote: 'Disposable concurrency proof only; no public change is applied.'
    });
    const assignments = await Promise.all(Array.from({ length: 24 }, () => store.assignExperiment({
      journeyId: assignmentJourney,
      experimentKey
    })));
    assert.equal(assignments.filter((result) => result.created).length, 1);
    assert.equal(new Set(assignments.map((result) => result.variant)).size, 1, 'Server-derived cohort must be stable across concurrent retries.');
    assert.equal(new Set(assignments.map((result) => result.controlledChangeKey)).size, 1);
    assert.equal(assignments[0]?.controlledChangeKey, 'eligible-exact-name-discover-link-v1');
    const assignmentCount = await database.query<{ count: number }>(
      `select count(*)::int as count from audit_events where event_type = 'discovery_experiment.assignment'`
    );
    assert.equal(Number(assignmentCount.rows[0]?.count), 1, 'Concurrent assignment must be database-enforced idempotent.');

    const assignedAt = assignments[0]!.assignedAt;
    await assert.rejects(() => store.recordJourneyEvent({
      journeyId: assignmentJourney,
      stage: 'entry',
      eventType: 'discovery_landing',
      occurredAt: new Date(new Date(assignedAt).getTime() - 1).toISOString(),
      source: 'web_search',
      surface: 'public-profile',
      entryPath: '/p/proof',
      entityKind: 'performer',
      entityKey: 'proof',
      experimentKey,
      visibilityEligibility: 'eligible',
      linkStrength: 'client_correlated_unverified'
    }), /must precede/);
    await store.recordJourneyEvent({
      journeyId: assignmentJourney,
      stage: 'entry',
      eventType: 'discovery_landing',
      source: 'web_search',
      surface: 'public-profile',
      entryPath: '/p/proof',
      entityKind: 'performer',
      entityKey: 'proof',
      experimentKey,
      visibilityEligibility: 'eligible',
      linkStrength: 'client_correlated_unverified'
    });

    await assert.rejects(() => store.recordJourneyEvent({
      journeyId: roomJourney,
      stage: 'outcome',
      eventType: 'room_entry_completed',
      surface: 'room-entry',
      entryPath: `/g/${roomId}`,
      entityKind: 'live_room',
      entityKey: roomId,
      actionKind: 'room_entry',
      outcomeStatus: 'completed',
      visibilityEligibility: 'eligible',
      linkStrength: 'client_correlated_unverified'
    }), /direct server evidence/);

    const roomEvents = [
      { stage: 'entry' as const, eventType: 'discovery_landing', linkStrength: 'client_correlated_unverified' as const },
      { stage: 'action' as const, eventType: 'room_entry_attempted', actionKind: 'room_entry' as const, linkStrength: 'direct_server_observed' as const },
      { stage: 'outcome' as const, eventType: 'room_entry_completed', actionKind: 'room_entry' as const, outcomeStatus: 'completed' as const, linkStrength: 'direct_server_observed' as const }
    ];
    for (const event of roomEvents) {
      for (let retry = 0; retry < 2; retry += 1) {
        await store.recordJourneyEvent({
          journeyId: roomJourney,
          ...event,
          source: 'direct',
          surface: 'room-entry',
          entryPath: `/g/${roomId}`,
          entityKind: 'live_room',
          entityKey: roomId,
          visibilityEligibility: 'eligible'
        }, undefined, { idempotencyKey: `room:${roomId}:${event.stage}` });
      }
    }

    await store.recordJourneyEvent({
      journeyId: tipJourney, stage: 'entry', eventType: 'discovery_landing', source: 'direct', surface: 'room-entry',
      entryPath: `/g/${roomId}`, entityKind: 'live_room', entityKey: roomId,
      visibilityEligibility: 'eligible', linkStrength: 'client_correlated_unverified'
    }, undefined, { idempotencyKey: `tip:proof:entry` });
    await store.recordJourneyEvent({
      journeyId: tipJourney, stage: 'action', eventType: 'discovery_primary_action', source: 'direct', surface: 'room-entry',
      entryPath: `/g/${roomId}`, entityKind: 'live_room', entityKey: roomId, actionKind: 'tip',
      visibilityEligibility: 'eligible', linkStrength: 'direct_server_observed'
    }, undefined, { idempotencyKey: `tip:proof:action` });
    await store.recordJourneyEvent({
      journeyId: tipJourney, stage: 'outcome', eventType: 'tip_action_completed', source: 'direct', surface: 'room-entry',
      entryPath: `/g/${roomId}`, entityKind: 'live_room', entityKey: roomId, actionKind: 'tip', outcomeStatus: 'completed',
      visibilityEligibility: 'eligible', linkStrength: 'direct_server_observed'
    }, undefined, { idempotencyKey: `tip:proof:outcome` });
    await store.recordJourneyEvent({
      journeyId: ticketJourney, stage: 'entry', eventType: 'discovery_landing', source: 'web_search', surface: 'public-event',
      entryPath: `/e/${eventId}`, entityKind: 'event', entityKey: eventId,
      visibilityEligibility: 'eligible', linkStrength: 'client_correlated_unverified'
    }, undefined, { idempotencyKey: 'ticket:proof:entry' });
    await store.recordJourneyEvent({
      journeyId: ticketJourney, stage: 'action', eventType: 'discovery_primary_action', source: 'web_search', surface: 'public-event',
      entryPath: `/e/${eventId}`, entityKind: 'event', entityKey: eventId, actionKind: 'ticket',
      visibilityEligibility: 'eligible', linkStrength: 'client_correlated_unverified'
    }, undefined, { idempotencyKey: 'ticket:proof:action' });

    const grain = await database.query<{ total: number; unique_ids: number }>(
      `select count(*)::int as total, count(distinct event_id)::int as unique_ids from audit_events`
    );
    assert.equal(Number(grain.rows[0]?.total), Number(grain.rows[0]?.unique_ids), 'Every persisted record must have a unique event ID.');

    const auditRows = await store.listDiscoveryAuditRows({ since: new Date(Date.now() - 60 * 60 * 1000) });
    const snapshot = buildDiscoveryObservatorySnapshot({
      auditRows: auditRows as never,
      queryCollection: [],
      visibilitySchema: 'explicit_visibility_unavailable',
      visibilityCounts: { eligible: 0, ineligible: 0, unknown: 1 },
      freshnessFailures: [],
      sourceAvailability: [
        { source: 'audit_store', state: 'available', asOf: new Date().toISOString(), note: 'Disposable PGlite proof.' },
        { source: 'google_search_console', state: 'unavailable', asOf: null, note: 'Not connected.' }
      ]
    });
    const roomFunnel = snapshot.funnels.find((funnel) => funnel.name === 'event_room_entry')!;
    const tipFunnel = snapshot.funnels.find((funnel) => funnel.name === 'ticket_tip')!;
    assert.equal(roomFunnel.entries, 3);
    assert.equal(roomFunnel.actions, 1);
    assert.equal(roomFunnel.completedOutcomes, 1);
    assert.equal(tipFunnel.entries, 3);
    assert.equal(tipFunnel.actions, 2);
    assert.equal(tipFunnel.completedOutcomes, 1);
    assert.equal(tipFunnel.actionToOutcomeRate, 0.5, 'External ticket action remains observed while its outcome stays unknown.');
    assert.equal(snapshot.observedPages.length, fixture.observations.length);
    assert.ok(snapshot.observedPages.every((observation) => observation.observedPrecision === 'day'));
    assert.equal(snapshot.quality.invalidExperimentOrderRowsExcluded, 0);
    const rankedExperiment = snapshot.experiments.find((experiment) => experiment.key === experimentKey)!;
    assert.equal(rankedExperiment.assignments.total, 1);
    assert.equal(rankedExperiment.assignments.control + rankedExperiment.assignments.treatment, 1);
    assert.equal(snapshot.unclaimedEntitiesReceivingDemand.state, 'unavailable');
    assert.equal(snapshot.unclaimedEntitiesReceivingDemand.count, null);

    const persistedRoomEvents = await database.query<{ event_type: string; count: number }>(
      `select event_type, count(*)::int as count from audit_events where metadata->>'journey_id' = $1 group by event_type order by event_type`,
      [roomJourney]
    );
    assert.ok(persistedRoomEvents.rows.every((row) => Number(row.count) === 1), 'Authoritative room retries must not duplicate record grain.');

    // A corrupt/conflicting deterministic row is rejected on replay rather
    // than silently accepted into a different cohort.
    await database.query(
      `update audit_events
          set metadata = jsonb_set(metadata, '{variant}', to_jsonb(case when metadata->>'variant' = 'control' then 'treatment'::text else 'control'::text end))
        where event_type = 'discovery_experiment.assignment'
          and metadata->>'journey_id' = $1`,
      [assignmentJourney]
    );
    await assert.rejects(
      () => store.assignExperiment({ journeyId: assignmentJourney, experimentKey }),
      /conflicts with the deterministic cohort contract/
    );

    console.log('Sway Discovery Observatory disposable integration proof passed.');
  } finally {
    await database.close();
  }
}

await main();
