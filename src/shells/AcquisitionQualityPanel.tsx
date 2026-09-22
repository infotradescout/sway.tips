import { useEffect, useRef, useState, type FormEvent } from 'react';
import { completeUtcWindow, defaultAcquisitionDates, parseAcquisitionQualityReport, type AcquisitionQualityReport } from '../acquisition-quality-report';

const qualityLabels: Record<string, string> = { browser_candidate: 'Browser-shaped requests', automation_signal: 'Automation signals', qa_signal: 'Marked diagnostics', unclassified: 'Insufficient request evidence', legacy_unclassified: 'Historical records without classification' };
const sourceLabels: Record<string, string> = { search_labeled: 'Search-labeled', ai_labeled: 'AI-labeled', social_or_referral_labeled: 'Social / referral-labeled', direct_or_unknown: 'Direct or unknown', other_labeled: 'Other source labels' };
const number = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString();
export default function AcquisitionQualityPanel() {
  const [dates, setDates] = useState(defaultAcquisitionDates);
  const [report, setReport] = useState<AcquisitionQualityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const request = useRef<{ sequence: number; controller: AbortController | null }>({ sequence: 0, controller: null });
  async function load(selected = dates) {
    let window: ReturnType<typeof completeUtcWindow>;
    try { window = completeUtcWindow(selected.start, selected.end); }
    catch (cause) { setValidation(cause instanceof Error ? cause.message : 'Check the dates.'); return; }
    setValidation(null);
    request.current.controller?.abort();
    const sequence = ++request.current.sequence;
    const controller = new AbortController(); request.current.controller = controller;
    setLoading(true); setReport(null); setError(null);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/admin/discovery-observatory/acquisition-quality?' + new URLSearchParams({ start: selected.start, end: selected.end }), { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Administrator access is required. Sign in again.' : 'Acquisition evidence is unavailable. Retry the report.');
      const payload = await response.json();
      const parsed = parseAcquisitionQualityReport(payload?.report, window);
      if (sequence === request.current.sequence) setReport(parsed);
    } catch (cause) {
      if (sequence === request.current.sequence) setError(controller.signal.aborted ? 'The report timed out. Retry the report.' : cause instanceof Error && cause.message.includes('Administrator access') ? cause.message : 'Acquisition evidence is unavailable. No missing value was treated as zero.');
    } finally {
      clearTimeout(timer);
      if (sequence === request.current.sequence) { setLoading(false); request.current.controller = null; }
    }
  }
  useEffect(() => {
    void load(defaultAcquisitionDates());
    return () => { request.current.sequence++; request.current.controller?.abort(); };
  }, []);
  function submit(event: FormEvent) { event.preventDefault(); void load(); }
  return <main className="mx-auto max-w-7xl px-4 py-8" data-testid="acquisition-quality-panel">
    <a href="/admin" className="text-sm text-cyan-300">Back to admin</a>
    <h1 className="mt-4 text-3xl font-bold">Sway traffic quality</h1>
    <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-300">Separate recorded requests from browser-shaped journeys and linked server-confirmed outcomes. Browser candidates are not verified people. Source labels do not prove organic referrals.</p>
    <form onSubmit={submit} className="mt-6 flex flex-wrap items-end gap-3" aria-label="Acquisition date window">
      <label className="grid gap-2 text-sm">Start date (UTC)<input type="date" value={dates.start} onChange={event => setDates({ ...dates, start: event.target.value })} required className="min-h-11 rounded-lg border border-white/20 bg-slate-900 px-3" /></label>
      <label className="grid gap-2 text-sm">End date (excluded, UTC)<input type="date" value={dates.end} max={defaultAcquisitionDates().end} onChange={event => setDates({ ...dates, end: event.target.value })} required className="min-h-11 rounded-lg border border-white/20 bg-slate-900 px-3" /></label>
      <button type="submit" disabled={loading} className="min-h-11 rounded-lg bg-cyan-900 px-4 py-2 font-semibold disabled:opacity-50">Apply dates</button>
      <button type="button" onClick={() => void load()} disabled={loading} className="min-h-11 rounded-lg border border-white/20 px-4 py-2 disabled:opacity-50">Refresh</button>
    </form>
    <p className="mt-2 text-xs text-slate-400">Previous 28 complete UTC days by default. Maximum 90 days; UTC days differ from local calendar days.</p>
    {validation ? <p role="alert" className="mt-4 text-amber-200">{validation}</p> : null}
    {loading ? <p role="status" className="mt-8 text-slate-300">Loading acquisition evidence…</p> : error ? <div role="alert" className="mt-8 rounded-lg border border-amber-500/40 p-4"><p>{error}</p><button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-white/20 px-4">Retry report</button></div> : report ? <div className="mt-8 space-y-8" data-testid="acquisition-results">
      <p className="text-sm text-slate-400">Applied window: {report.start.slice(0, 10)} to {report.endExclusive.slice(0, 10)} (exclusive), UTC. Retrieved {new Date(report.capturedAt).toLocaleString()}.</p>
      {!report.quality_available ? <p className="rounded-lg border border-amber-500/30 p-4 text-amber-100">No classified request evidence is available in this window. An empty or historical-only result does not mean zero people.</p> : null}
      <section aria-label="Acquisition summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Recorded landing events', number(report.recorded_landing_events), 'Raw events, including excluded traffic and history.'],
          ['Browser-candidate journeys', number(report.browser_candidate_journeys), 'Journeys with any automation or diagnostic signal in this window are excluded.'],
          ['Journeys with a linked outcome', report.quality_available ? number(report.candidate_sources.reduce((sum, row) => sum + row.journeys_with_linked_durable_outcome, 0)) : 'Unavailable', 'Requires an earlier matching action and existing server-confirmed room or tip completion. Not revenue.'],
          ['Verified people', 'Unavailable', 'Request headers can be spoofed. No unique-person estimate is made.']
        ].map(([title, value, detail]) => <article key={title} className="min-w-0 rounded-xl border border-white/10 p-4"><h2 className="text-sm text-slate-300">{title}</h2><p className="my-3 break-words text-2xl font-semibold">{value}</p><p className="text-xs leading-5 text-slate-400">{detail}</p></article>)}
      </section>
      <section><h2 className="text-xl font-semibold">Request-quality breakdown</h2><p className="mt-2 text-sm text-slate-400">All recorded events remain visible. Diagnostics and automation are not audience growth.</p><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{report.quality_totals.map(row => <article key={row.quality} className="rounded-lg border border-white/10 p-4"><h3 className="text-sm font-semibold">{qualityLabels[row.quality]}</h3><p className="mt-2 text-sm">{number(row.recorded_events)} events · {number(row.landing_events)} landings</p></article>)}</div>{!report.quality_totals.length ? <p className="mt-3 text-sm">No matching event records were returned.</p> : null}</section>
      <section><h2 className="text-xl font-semibold">Source-labeled candidate journeys</h2><p className="mt-2 text-sm text-slate-400">These are stored labels, not Google click counts or proof of AI recommendations.</p><div className="mt-4 grid gap-3 md:grid-cols-2">{report.candidate_sources.map(row => <article key={row.source_group} className="rounded-lg border border-white/10 p-4"><h3 className="font-semibold">{sourceLabels[row.source_group]}</h3><dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><dt>Candidate journeys</dt><dd>{number(row.browser_candidate_journeys)}</dd><dt>With recorded action</dt><dd>{number(row.journeys_with_recorded_action)}</dd><dt>With linked outcome</dt><dd>{number(row.journeys_with_linked_durable_outcome)}</dd></dl></article>)}</div>{!report.candidate_sources.length ? <p className="mt-3 text-sm">No candidate source groups are available for this window.</p> : null}</section>
      <section className="rounded-xl border border-white/10 p-4 text-sm leading-6"><h2 className="font-semibold">Measurement limits</h2><p>Server-confirmed outcome records: {number(report.linked_durable_outcomes)} linked; {number(report.unlinked_durable_outcomes)} without the required candidate entry and action. Event totals are not unique jobs, customers, or payments.</p><p>Google Search Console impressions and clicks: unavailable. Historical classification is not backfilled; cross-device and later-window returns are not inferred.</p><p>First classified event: {report.first_classified_event ? new Date(report.first_classified_event).toLocaleString() : 'Unavailable'}. Last recorded event: {report.last_recorded_event ? new Date(report.last_recorded_event).toLocaleString() : 'Unavailable'}.</p></section>
    </div> : null}
  </main>;
}
