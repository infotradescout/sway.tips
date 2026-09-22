import { pathToFileURL } from 'node:url';

// Aggregate-only output. No raw journey IDs, IPs, UAs, private paths, or arbitrary source text leave the database.
export const ACQUISITION_QUALITY_SQL = `
WITH events AS (
  SELECT event_id, entity_id, event_type, created_at, metadata,
    CASE
      WHEN NOT (coalesce(metadata, '{}'::jsonb) ? 'traffic_quality') THEN 'legacy_unclassified'
      WHEN metadata#>>'{traffic_quality,version}' = '1'
        AND metadata#>>'{traffic_quality,basis}' = 'server_observed_request_signals'
        AND metadata#>>'{traffic_quality,classification}' IN ('browser_candidate','automation_signal','qa_signal','unclassified')
        THEN metadata#>>'{traffic_quality,classification}'
      ELSE 'unclassified'
    END AS quality,
    CASE
      WHEN lower(coalesce(metadata->>'source',metadata->>'attribution_channel','')) IN ('google','bing','duckduckgo','web_search','organic_search') THEN 'search_labeled'
      WHEN lower(coalesce(metadata->>'source',metadata->>'attribution_channel','')) IN ('chatgpt','openai','perplexity','claude','ai_search') THEN 'ai_labeled'
      WHEN lower(coalesce(metadata->>'source',metadata->>'attribution_channel','')) IN ('facebook','instagram','social','referral') THEN 'social_or_referral_labeled'
      WHEN lower(coalesce(metadata->>'source',metadata->>'attribution_channel','')) IN ('','direct','unknown') THEN 'direct_or_unknown'
      ELSE 'other_labeled'
    END AS source_group
  FROM public.audit_events
  WHERE entity_type = 'shell_friction' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
    AND (event_type IN ('discovery_landing','discovery_entity_view','discovery_primary_action','room_entry_viewed',
      'room_entry_attempted','room_entry_completed','request_started','boost_started','tip_action_completed','internal_search_zero_result'))
), quality_totals AS (
  SELECT quality, count(*)::int AS recorded_events,
    count(*) FILTER (WHERE event_type='discovery_landing')::int AS landing_events
  FROM events GROUP BY quality
), candidate_entries AS (
  SELECT DISTINCT ON (e.entity_id) e.entity_id, e.created_at, e.source_group
  FROM events e
  WHERE e.quality='browser_candidate' AND e.metadata->>'stage'='entry'
    AND e.event_type='discovery_landing' AND e.metadata->>'journey_id' IS NOT NULL
    -- Exclusions use all retained shell-friction events, not the reporting subset.
    -- A later retained signal can revise an earlier candidate; deleted history is unknown.
    AND NOT EXISTS (
      SELECT 1 FROM public.audit_events bad
      WHERE bad.entity_type='shell_friction' AND bad.entity_id=e.entity_id
        AND bad.metadata#>>'{traffic_quality,version}'='1'
        AND bad.metadata#>>'{traffic_quality,basis}'='server_observed_request_signals'
        AND bad.metadata#>>'{traffic_quality,classification}' IN ('automation_signal','qa_signal')
    )
  ORDER BY e.entity_id,e.created_at,e.event_id
), durable AS (
  SELECT o.*, c.source_group AS entry_source,
    EXISTS (SELECT 1 FROM events a
      WHERE a.entity_id=o.entity_id AND a.metadata->>'stage'='action'
        AND a.quality='browser_candidate'
        AND a.created_at >= c.created_at AND a.created_at <= o.created_at
        AND a.metadata->>'entity_kind'=o.metadata->>'entity_kind'
        AND a.metadata->>'entity_key'=o.metadata->>'entity_key'
        AND a.metadata->>'action_kind'=o.metadata->>'action_kind'
    ) AS prior_matching_action
  FROM events o LEFT JOIN candidate_entries c ON c.entity_id=o.entity_id AND c.created_at <= o.created_at
  WHERE o.metadata->>'stage'='outcome' AND o.metadata->>'outcome_status'='completed'
    AND o.metadata->>'link_strength'='direct_server_observed'
    AND o.event_type IN ('room_entry_completed','tip_action_completed')
), candidate_sources AS (
  SELECT c.source_group,count(*)::int AS browser_candidate_journeys,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM events a WHERE a.entity_id=c.entity_id
      AND a.metadata->>'stage'='action' AND a.quality='browser_candidate' AND a.created_at >= c.created_at))::int AS journeys_with_recorded_action,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM durable d WHERE d.entity_id=c.entity_id AND d.prior_matching_action))::int AS journeys_with_linked_durable_outcome
  FROM candidate_entries c GROUP BY c.source_group
)
SELECT jsonb_build_object(
  'recorded_events',(SELECT count(*) FROM events),
  'recorded_landing_events',(SELECT count(*) FROM events WHERE event_type='discovery_landing'),
  'classified_events',(SELECT count(*) FROM events WHERE quality <> 'legacy_unclassified'),
  'quality_available',EXISTS(SELECT 1 FROM events WHERE quality <> 'legacy_unclassified'),
  'first_classified_event',(SELECT min(created_at) FROM events WHERE quality <> 'legacy_unclassified'),
  'last_recorded_event',(SELECT max(created_at) FROM events),
  'quality_totals',coalesce((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.quality) FROM quality_totals q),'[]'::jsonb),
  'browser_candidate_journeys',CASE WHEN EXISTS(SELECT 1 FROM events WHERE quality <> 'legacy_unclassified') THEN (SELECT count(*) FROM candidate_entries) ELSE NULL END,
  'candidate_sources',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.source_group) FROM candidate_sources s),'[]'::jsonb),
  'linked_durable_outcomes',(SELECT count(*) FROM durable WHERE prior_matching_action),
  'unlinked_durable_outcomes',(SELECT count(*) FROM durable WHERE NOT prior_matching_action),
  'verified_unique_people',NULL,
  'search_console_impressions',NULL,
  'search_console_clicks',NULL
) AS report;
`;

export function validateAcquisitionWindow(start, end) {
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  if (!iso.test(start || '') || !iso.test(end || '')) throw new Error('Use explicit UTC ISO --start and --end; end is exclusive.');
  const first = new Date(start), last = new Date(end);
  const duration = last.getTime() - first.getTime();
  if (!Number.isFinite(duration) || duration <= 0 || duration > 90 * 86400000) throw new Error('Report window must be positive and at most 90 days.');
  if (first.toISOString().slice(0,10) !== start.slice(0,10) || last.toISOString().slice(0,10) !== end.slice(0,10)) throw new Error('Invalid calendar date.');
  return [first.toISOString(), last.toISOString()];
}

export async function queryAcquisitionQuality(client, start, end) {
  const window = validateAcquisitionWindow(start, end);
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='8s'");
    const result = await client.query(ACQUISITION_QUALITY_SQL, window);
    await client.query('COMMIT');
    return {
      schemaVersion: 1, product: 'sway', start: window[0], endExclusive: window[1], capturedAt: new Date().toISOString(),
      ...result.rows[0].report,
      limitations: 'Request signals are spoofable. Browser candidates are not verified people. Source labels are not verified organic referrals. Linked outcomes require a prior matching candidate action and existing server-confirmed completion, not a click. Missing/legacy classification is not backfilled. No audience estimate is inferred from an empty result. Outcome links are bounded to this window; later returns and cross-device paths are not inferred. Candidate exclusion checks all retained shell-friction events for the same journey, including signals before or after the selected window and other event types. Later retained signals may revise historical candidate counts; expired or deleted history is unavailable, not proof of a clean lifetime.'
    };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--(start|end)=(.+)$/.exec(arg);
    if (!match) throw new Error('Usage: node scripts/report-acquisition-quality.mjs --start=<UTC ISO> --end=<UTC ISO>');
    return [match[1],match[2]];
  }));
  validateAcquisitionWindow(args.start,args.end);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must identify the authorized Sway audit database.');
  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  try { await client.connect(); console.log(JSON.stringify(await queryAcquisitionQuality(client,args.start,args.end),null,2)); }
  finally { await client.end(); }
}
// Bundled server modules share the entry URL; only the named standalone report may run its CLI.
if (process.argv[1] && /(?:^|[\\/])report-acquisition-quality\.mjs$/.test(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Acquisition report unavailable: validate the UTC window, database access and query timeout. No partial totals reported.'); process.exitCode=1; });
}
