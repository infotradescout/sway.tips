import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { queryAcquisitionQuality } from './report-acquisition-quality.mjs';

// Exact production SQL on disposable PostgreSQL-engine fixtures. The existing
// acquisition-quality test separately exercises real server ingress/migrations.
const start = '2026-08-01T00:00:00Z';
const end = '2026-08-02T00:00:00Z';
const quality = classification => ({ version: 1, basis: 'server_observed_request_signals', classification });

test('retained journey taints cannot be hidden by a reporting filter', async t => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE audit_events (
      event_id text PRIMARY KEY, entity_id text NOT NULL, entity_type text NOT NULL,
      event_type text NOT NULL, created_at timestamptz NOT NULL, metadata jsonb
    )`);
    async function insert(journey, event, at, metadata = {}, entityType = 'shell_friction') {
      await db.query('INSERT INTO audit_events VALUES($1,$2,$3,$4,$5::timestamptz,$6::jsonb)',
        [randomUUID(), journey, entityType, event, at, JSON.stringify({ journey_id: journey, source: 'google', ...metadata })]);
    }
    async function seed() {
      await db.exec('TRUNCATE audit_events');
      const journey = randomUUID();
      const entity = { entity_kind: 'live_room', entity_key: 'fixture-room', action_kind: 'room_entry' };
      for (const at of ['02:00:00', '02:00:01']) {
        await insert(journey, 'discovery_landing', `2026-08-01T${at}Z`, { stage: 'entry', traffic_quality: quality('browser_candidate') });
      }
      await insert(journey, 'discovery_primary_action', '2026-08-01T02:01:00Z', { ...entity, stage: 'action', traffic_quality: quality('browser_candidate') });
      await insert(journey, 'room_entry_completed', '2026-08-01T02:02:00Z', { ...entity, stage: 'outcome', outcome_status: 'completed', link_strength: 'direct_server_observed' });
      return journey;
    }
    function check(report, journey, excluded, extraRecorded = 0) {
      assert.equal(report.recorded_events, 4 + extraRecorded, 'Raw totals remain limited to the original event/window set');
      assert.equal(report.recorded_landing_events, 2, 'Repeated entries remain visible as raw events');
      assert.equal(report.browser_candidate_journeys, excluded ? 0 : 1, 'retained-taint admission');
      assert.equal(report.linked_durable_outcomes, excluded ? 0 : 1, 'Tainted candidates cannot carry linked outcomes');
      assert.equal(report.unlinked_durable_outcomes, excluded ? 1 : 0, 'Existing completion evidence is not erased');
      assert.equal(report.candidate_sources.length, excluded ? 0 : 1);
      if (!excluded) {
        assert.equal(report.candidate_sources[0].browser_candidate_journeys, 1);
        assert.equal(report.candidate_sources[0].journeys_with_recorded_action, 1);
        assert.equal(report.candidate_sources[0].journeys_with_linked_durable_outcome, 1);
      }
      for (const field of ['verified_unique_people', 'search_console_impressions', 'search_console_clicks']) assert.equal(report[field], null);
      assert.equal(JSON.stringify(report).includes(journey), false, 'Aggregate output cannot disclose journey IDs');
    }
    const cases = [
      { name: 'pre-window automation on an included event', at: '2026-07-31T23:59:59Z', event: 'discovery_entity_view', classification: 'automation_signal', excluded: true },
      { name: 'pre-window diagnostic on an excluded event', at: '2026-07-31T23:59:59Z', event: 'share_link_copied', classification: 'qa_signal', excluded: true },
      { name: 'in-window diagnostic on an excluded event', at: '2026-08-01T01:00:00Z', event: 'share_link_copied', classification: 'qa_signal', excluded: true },
      { name: 'post-window retained automation revises history', at: '2026-08-03T00:00:00Z', event: 'share_link_copied', classification: 'automation_signal', excluded: true },
      { name: 'in-window included diagnostic still excludes', at: '2026-08-01T03:00:00Z', event: 'discovery_entity_view', classification: 'qa_signal', excluded: true, extraRecorded: 1 },
      { name: 'same ID on unrelated entity type is not a journey taint', at: '2026-08-01T01:00:00Z', event: 'share_link_copied', classification: 'qa_signal', entityType: 'unrelated_fixture', excluded: false },
      { name: 'another journey cannot taint this one', at: '2026-07-31T01:00:00Z', event: 'share_link_copied', classification: 'automation_signal', foreign: true, excluded: false },
      { name: 'unclassified evidence remains unknown', at: '2026-07-31T01:00:00Z', event: 'share_link_copied', classification: 'unclassified', excluded: false },
      { name: 'unsupported version is not server authority', at: '2026-07-31T01:00:00Z', event: 'share_link_copied', classification: 'qa_signal', override: { version: 999 }, excluded: false },
      { name: 'client-claimed classification is not server authority', at: '2026-07-31T01:00:00Z', event: 'share_link_copied', classification: 'qa_signal', override: { basis: 'client_claim' }, excluded: false },
    ];
    for (const scenario of cases) await t.test(scenario.name, async () => {
      const journey = await seed();
      await insert(scenario.foreign ? randomUUID() : journey, scenario.event, scenario.at,
        { traffic_quality: { ...quality(scenario.classification), ...scenario.override } }, scenario.entityType);
      check(await queryAcquisitionQuality(db, start, end), journey, scenario.excluded, scenario.extraRecorded);
    });
    await t.test('a newly retained taint changes candidates, not the raw historical facts', async () => {
      const journey = await seed();
      const before = await queryAcquisitionQuality(db, start, end);
      check(before, journey, false);
      await insert(journey, 'share_link_copied', '2026-08-04T00:00:00Z', { traffic_quality: quality('qa_signal') });
      const after = await queryAcquisitionQuality(db, start, end);
      check(after, journey, true);
      assert.deepEqual(before.quality_totals, after.quality_totals);
      assert.match(after.limitations, /expired or deleted history is unavailable/);
    });
    await t.test('out-of-window taints alone cannot invent a classified audience baseline', async () => {
      await db.exec('TRUNCATE audit_events');
      await insert(randomUUID(), 'share_link_copied', '2026-07-31T00:00:00Z', { traffic_quality: quality('qa_signal') });
      const report = await queryAcquisitionQuality(db, start, end);
      assert.equal(report.recorded_events, 0);
      assert.equal(report.quality_available, false);
      assert.equal(report.browser_candidate_journeys, null);
      assert.deepEqual(report.candidate_sources, []);
    });
  } finally { await db.close(); }
});
