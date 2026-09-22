export const QUALITY_CLASSES = ['browser_candidate', 'automation_signal', 'qa_signal', 'unclassified', 'legacy_unclassified'] as const;
export const SOURCE_GROUPS = ['search_labeled', 'ai_labeled', 'social_or_referral_labeled', 'direct_or_unknown', 'other_labeled'] as const;
export type QualityClass = typeof QUALITY_CLASSES[number];
export type SourceGroup = typeof SOURCE_GROUPS[number];
export type AcquisitionQualityReport = {
  schemaVersion: 1; product: 'sway'; start: string; endExclusive: string; capturedAt: string;
  recorded_events: number; recorded_landing_events: number; classified_events: number;
  quality_available: boolean; first_classified_event: string | null; last_recorded_event: string | null;
  quality_totals: Array<{ quality: QualityClass; recorded_events: number; landing_events: number }>;
  browser_candidate_journeys: number | null;
  candidate_sources: Array<{ source_group: SourceGroup; browser_candidate_journeys: number; journeys_with_recorded_action: number; journeys_with_linked_durable_outcome: number }>;
  linked_durable_outcomes: number; unlinked_durable_outcomes: number;
  verified_unique_people: null; search_console_impressions: null; search_console_clicks: null;
};
const DAY = 86400000;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Report unavailable.');
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Report unavailable.');
  return value;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Report unavailable.');
  return new Date(value).toISOString();
}
export function completeUtcWindow(start: unknown, end: unknown, now = new Date()) {
  for (const value of [start, end]) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00.000Z')) || new Date(value + 'T00:00:00.000Z').toISOString().slice(0, 10) !== value) {
      throw new Error('Use valid YYYY-MM-DD dates.');
    }
  }
  const first = String(start) + 'T00:00:00.000Z';
  const last = String(end) + 'T00:00:00.000Z';
  const days = (Date.parse(last) - Date.parse(first)) / DAY;
  const today = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
  if (days < 1 || days > 90 || Date.parse(last) > today) throw new Error('Choose 1–90 complete UTC days; the end date is excluded.');
  return { start: first, endExclusive: last };
}
export function defaultAcquisitionDates(now = new Date()) {
  const end = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
  return { start: new Date(end.getTime() - 28 * DAY).toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
/** Validate and project on both sides. Unknown/extra database fields never reach the operator. */
export function parseAcquisitionQualityReport(raw: unknown, expected: { start: string; endExclusive: string }): AcquisitionQualityReport {
  const r = object(raw);
  if (r.schemaVersion !== 1 || r.product !== 'sway' || r.start !== expected.start || r.endExclusive !== expected.endExclusive || typeof r.quality_available !== 'boolean') throw new Error('Report unavailable.');
  for (const key of ['verified_unique_people', 'search_console_impressions', 'search_console_clicks']) if (r[key] !== null) throw new Error('Unsupported acquisition claim.');
  if (!Array.isArray(r.quality_totals) || r.quality_totals.length > QUALITY_CLASSES.length || !Array.isArray(r.candidate_sources) || r.candidate_sources.length > SOURCE_GROUPS.length) throw new Error('Report unavailable.');
  const quality = r.quality_totals.map(value => {
    const q = object(value);
    if (!QUALITY_CLASSES.includes(q.quality as QualityClass)) throw new Error('Report unavailable.');
    const row = { quality: q.quality as QualityClass, recorded_events: count(q.recorded_events), landing_events: count(q.landing_events) };
    if (row.landing_events > row.recorded_events) throw new Error('Report unavailable.');
    return row;
  });
  const sources = r.candidate_sources.map(value => {
    const s = object(value);
    if (!SOURCE_GROUPS.includes(s.source_group as SourceGroup)) throw new Error('Report unavailable.');
    const row = { source_group: s.source_group as SourceGroup, browser_candidate_journeys: count(s.browser_candidate_journeys), journeys_with_recorded_action: count(s.journeys_with_recorded_action), journeys_with_linked_durable_outcome: count(s.journeys_with_linked_durable_outcome) };
    if (row.journeys_with_recorded_action > row.browser_candidate_journeys || row.journeys_with_linked_durable_outcome > row.journeys_with_recorded_action) throw new Error('Report unavailable.');
    return row;
  });
  if (new Set(quality.map(q => q.quality)).size !== quality.length || new Set(sources.map(s => s.source_group)).size !== sources.length) throw new Error('Report unavailable.');
  const recorded = count(r.recorded_events), landing = count(r.recorded_landing_events), classified = count(r.classified_events);
  if (quality.reduce((n, q) => n + q.recorded_events, 0) !== recorded || quality.reduce((n, q) => n + q.landing_events, 0) !== landing || quality.filter(q => q.quality !== 'legacy_unclassified').reduce((n, q) => n + q.recorded_events, 0) !== classified || r.quality_available !== (classified > 0)) throw new Error('Report unavailable.');
  const candidates = r.quality_available ? count(r.browser_candidate_journeys) : null;
  if (!r.quality_available && r.browser_candidate_journeys !== null) throw new Error('Missing classification is not zero visitors.');
  if (sources.reduce((n, s) => n + s.browser_candidate_journeys, 0) !== (candidates ?? 0)) throw new Error('Report unavailable.');
  const first = r.first_classified_event === null ? null : timestamp(r.first_classified_event);
  const last = r.last_recorded_event === null ? null : timestamp(r.last_recorded_event);
  if ((classified > 0) !== (first !== null) || (recorded > 0) !== (last !== null)) throw new Error('Report unavailable.');
  for (const at of [first, last]) if (at && (at < expected.start || at >= expected.endExclusive)) throw new Error('Report unavailable.');
  if (first && last && first > last) throw new Error('Report unavailable.');
  return {
    schemaVersion: 1, product: 'sway', ...expected, capturedAt: timestamp(r.capturedAt),
    recorded_events: recorded, recorded_landing_events: landing, classified_events: classified,
    quality_available: r.quality_available, first_classified_event: first, last_recorded_event: last,
    quality_totals: quality, browser_candidate_journeys: candidates, candidate_sources: sources,
    linked_durable_outcomes: count(r.linked_durable_outcomes), unlinked_durable_outcomes: count(r.unlinked_durable_outcomes),
    verified_unique_people: null, search_console_impressions: null, search_console_clicks: null
  };
}
