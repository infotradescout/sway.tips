import { FormEvent, useCallback, useEffect, useState } from 'react';

type Funnel = {
  name: string;
  entries: number;
  actions: number;
  completedOutcomes: number;
  entryToActionRate: number | null;
  actionToOutcomeRate: number | null;
  actionAvailability: string;
  outcomeAvailability: string;
  outcomeAvailabilityByAction?: Record<string, string>;
  denominators: { entryToAction: string; actionToOutcome: string };
  exclusions: {
    ineligibleJourneys: number;
    unknownEligibilityJourneys: number;
    actionsLackingPriorEntry: number;
    outcomesLackingPriorAction: number;
  };
};

type Observatory = {
  generatedAt: string;
  funnels: Funnel[];
  discoverySources: Array<{ source: string; uniqueEntries: number }>;
  queries: Array<{ query: string; kind: string; evidence: string; timeSensitive: boolean; expiresAt: string | null }>;
  observedPages: Array<Record<string, string | null>>;
  repeatedOutsideSources: Array<{ source: string; count: number }>;
  repeatedCompetitors: Array<{ competitor: string; count: number }>;
  pagesWithEntriesButNoActions: Array<{ path: string; uniqueEntries: number }>;
  pagesWithImpressionsButNoActions: Record<string, unknown>;
  internalZeroResults: Array<{ query: string; evidence: string }>;
  freshnessFailures: Array<Record<string, unknown>>;
  experiments: Array<Record<string, unknown>>;
  visibility: { schema: string; eligible: number; ineligible: number; unknown: number };
  eligibilityExclusions: { events: number; rooms: number; releases: number; unknownPerformerRooms: number };
  sourceAvailability: Array<{ source: string; state: string; asOf: string | null; note: string }>;
  unclaimedEntitiesReceivingDemand: Record<string, unknown>;
  unknownOrUnavailableEvidence: Array<Record<string, unknown>>;
  quality: Record<string, unknown>;
};

function percent(value: number | null) {
  return value === null ? 'Unavailable' : `${(value * 100).toFixed(1)}%`;
}

function label(value: string) {
  return value.replaceAll('_', ' ');
}

function JsonDetail({ value }: { value: unknown }) {
  return <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-[11px] leading-5 text-slate-400">{JSON.stringify(value, null, 2)}</pre>;
}

function ExperimentDecision({ experiment, onSaved }: { experiment: Record<string, unknown>; onSaved: () => void }) {
  const [decision, setDecision] = useState('approve');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/discovery-observatory/experiments/${String(experiment.key)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, evidenceNote: note })
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || 'Decision was not saved.');
      setNote('');
      setMessage('Decision recorded; no public change was applied.');
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Decision was not saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-4 grid gap-2 border-t border-white/10 pt-4 sm:grid-cols-[9rem_1fr_auto]">
      <select value={decision} onChange={(event) => setDecision(event.target.value)} className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs">
        {['approve', 'activate', 'pause', 'complete', 'rollback', 'reject'].map((value) => <option key={value}>{value}</option>)}
      </select>
      <input value={note} onChange={(event) => setNote(event.target.value)} required maxLength={1200} placeholder="Evidence note (required)" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs" />
      <button disabled={busy} className="rounded-lg bg-fuchsia-500 px-4 py-2 text-xs font-black text-white disabled:opacity-50">Record</button>
      {message ? <p className="text-xs text-slate-300 sm:col-span-3">{message}</p> : null}
    </form>
  );
}

export default function DiscoveryObservatoryPage() {
  const [observatory, setObservatory] = useState<Observatory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [queryEvidenceState, setQueryEvidenceState] = useState('unknown');
  const [observedPrecision, setObservedPrecision] = useState<'timestamp' | 'day'>('timestamp');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/discovery-observatory?windowDays=30', { cache: 'no-store' });
      const body = await response.json().catch(() => null) as { observatory?: Observatory; error?: string } | null;
      if (!response.ok || !body?.observatory) throw new Error(body?.error || 'Observatory is unavailable.');
      setObservatory(body.observatory);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Observatory is unavailable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const recordObservation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setFormMessage(null);
    const query = String(data.get('query') || '').trim();
    const observation = {
      source: data.get('source'),
      surface: data.get('surface'),
      resultState: data.get('resultState'),
      queryEvidenceState,
      query: queryEvidenceState === 'known' ? query : null,
      observedAt: data.get('observedAt'),
      observedPrecision,
      locationContext: data.get('locationContext') || null,
      deviceContext: data.get('deviceContext') || null,
      displayedPage: data.get('displayedPage') || null,
      outsideSources: String(data.get('outsideSources') || '').split(',').map((value) => value.trim()).filter(Boolean),
      competitors: String(data.get('competitors') || '').split(',').map((value) => value.trim()).filter(Boolean),
      evidenceNote: data.get('evidenceNote'),
      linkStrength: 'unknown_unavailable'
    };
    try {
      const response = await fetch('/api/admin/discovery-observatory/observations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(observation)
      });
      const body = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error || 'Observation was not saved.');
      form.reset();
      setFormMessage('Observation recorded with its provenance and evidence boundary.');
      await load();
    } catch (saveError) {
      setFormMessage(saveError instanceof Error ? saveError.message : 'Observation was not saved.');
    }
  };

  if (loading) return <main className="min-h-screen bg-slate-950 p-8 text-slate-200">Loading Discovery Observatory…</main>;
  if (error || !observatory) return <main className="min-h-screen bg-slate-950 p-8 text-rose-200"><a href="/admin" className="text-fuchsia-300">← Admin</a><p className="mt-6">{error}</p></main>;

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div><a href="/admin" className="text-xs font-black text-fuchsia-300">← Admin</a><p className="mt-5 text-[10px] font-black uppercase tracking-[0.25em] text-cyan-300">Admin only · read model + controlled capture</p><h1 className="mt-2 text-3xl font-black">Sway Discovery Observatory</h1><p className="mt-2 text-sm text-slate-400">As of {new Date(observatory.generatedAt).toLocaleString()}. Observation, entry, action, outcome, and experiment remain separate.</p></div>
          <button onClick={() => void load()} className="rounded-xl border border-white/10 px-4 py-2 text-xs font-black">Refresh</button>
        </header>

        <section className="mt-8 grid gap-4 lg:grid-cols-3" aria-label="Separate discovery funnels">
          {observatory.funnels.map((funnel) => <article key={funnel.name} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><p className="text-xs font-black uppercase tracking-wider text-fuchsia-200">{label(funnel.name)}</p><div className="mt-5 grid grid-cols-3 gap-2 text-center"><div><strong className="text-2xl">{funnel.entries}</strong><p className="text-[10px] text-slate-500">entries</p></div><div><strong className="text-2xl">{funnel.actions}</strong><p className="text-[10px] text-slate-500">actions</p></div><div><strong className="text-2xl">{funnel.completedOutcomes}</strong><p className="text-[10px] text-slate-500">outcomes</p></div></div><p className="mt-4 text-xs text-slate-300">Entry → action: {percent(funnel.entryToActionRate)} · Action → outcome: {percent(funnel.actionToOutcomeRate)}</p><p className="mt-3 text-[11px] leading-5 text-slate-500">{funnel.denominators.entryToAction}. {funnel.denominators.actionToOutcome}. Action: {label(funnel.actionAvailability)}. Outcome: {label(funnel.outcomeAvailability)}.</p><JsonDetail value={{ ...funnel.exclusions, outcomeAvailabilityByAction: funnel.outcomeAvailabilityByAction ?? null }} /></article>)}
        </section>

        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="text-lg font-black">Record independent outside observation</h2><p className="mt-1 text-xs text-slate-400">Use only directly observed, non-private evidence. A query is known only when directly observed; URLs/contact details/long identifiers are rejected.</p><form onSubmit={recordObservation} className="mt-4 grid gap-3 md:grid-cols-3"><input name="source" required maxLength={80} placeholder="Source (for example web_search)" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs" /><input name="surface" required maxLength={120} placeholder="Surface" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs" /><select name="resultState" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs">{['observed', 'not_observed', 'unknown', 'unavailable'].map((value) => <option key={value}>{value}</option>)}</select><select value={queryEvidenceState} onChange={(event) => setQueryEvidenceState(event.target.value)} className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs">{['known', 'unknown', 'unavailable'].map((value) => <option key={value}>{value}</option>)}</select><input name="query" disabled={queryEvidenceState !== 'known'} required={queryEvidenceState === 'known'} maxLength={300} placeholder="Observed query" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs disabled:opacity-40" /><select value={observedPrecision} onChange={(event) => setObservedPrecision(event.target.value as 'timestamp' | 'day')} className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs"><option value="timestamp">timestamp precision</option><option value="day">day precision</option></select><input name="observedAt" required placeholder={observedPrecision === 'day' ? 'YYYY-MM-DD' : 'ISO timestamp'} className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs" /><input name="displayedPage" placeholder="Displayed public page (optional)" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs" /><input name="locationContext" placeholder="Location context or unknown" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs" /><input name="deviceContext" placeholder="Device context or unknown" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs" /><input name="outsideSources" placeholder="Outside sources, comma separated" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs" /><input name="competitors" placeholder="Competitors, comma separated" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs" /><textarea name="evidenceNote" required maxLength={1200} placeholder="Evidence note" className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-xs md:col-span-2" /><button className="rounded-lg bg-cyan-500 px-4 py-2 text-xs font-black text-slate-950">Record observation</button>{formMessage ? <p className="text-xs text-slate-300 md:col-span-3">{formMessage}</p> : null}</form></section>

        <section className="mt-8"><h2 className="text-xl font-black">Evidence-ranked experiment queue</h2><p className="mt-1 text-xs text-slate-400">Rank is recomputed from current stored observations, eligible supply, freshness, and matching zero-result evidence. A decision never applies a public change.</p><div className="mt-4 space-y-4">{observatory.experiments.map((experiment) => <article key={String(experiment.key)} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><div className="flex flex-wrap items-center gap-3"><span className="rounded-full bg-fuchsia-500/20 px-3 py-1 text-xs font-black text-fuchsia-100">Rank {String(experiment.rank)}</span>{experiment.timeSensitive ? <span className="rounded-full bg-amber-500/20 px-3 py-1 text-xs font-black text-amber-100">Time-sensitive</span> : null}<span className="text-xs text-slate-400">{label(String(experiment.status))} · score {String(experiment.score)}</span></div><h3 className="mt-4 text-base font-black">{String(experiment.question)}</h3><p className="mt-2 text-xs leading-5 text-slate-400">Baseline: {String(experiment.currentBaseline)}</p><p className="mt-2 text-xs leading-5 text-slate-300">One controlled change: {String(experiment.controlledChange)}</p><p className="mt-2 text-xs text-cyan-200">Cohorts: {JSON.stringify(experiment.assignments)} · change key {String(experiment.controlledChangeKey)}</p><ExperimentDecision experiment={experiment} onSaved={() => void load()} /></article>)}</div></section>

        <section className="mt-8 grid gap-4 lg:grid-cols-2"><article className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="font-black">Source availability and freshness</h2><JsonDetail value={{ sourceAvailability: observatory.sourceAvailability, freshnessFailures: observatory.freshnessFailures }} /></article><article className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="font-black">Visibility and eligibility</h2><JsonDetail value={{ visibility: observatory.visibility, exclusions: observatory.eligibilityExclusions }} /></article><article className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="font-black">Outside observations</h2><JsonDetail value={{ observations: observatory.observedPages, outsideSources: observatory.repeatedOutsideSources, competitors: observatory.repeatedCompetitors }} /></article><article className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="font-black">Unknown and unavailable</h2><JsonDetail value={{ evidence: observatory.unknownOrUnavailableEvidence, unclaimedDemand: observatory.unclaimedEntitiesReceivingDemand }} /></article><article className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="font-black">Demand and page gaps</h2><JsonDetail value={{ zeroResults: observatory.internalZeroResults, entryPagesWithNoAction: observatory.pagesWithEntriesButNoActions, impressionPagesWithNoAction: observatory.pagesWithImpressionsButNoActions, discoverySources: observatory.discoverySources }} /></article><article className="rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="font-black">Record grain and integrity</h2><JsonDetail value={observatory.quality} /></article></section>

        <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-5"><h2 className="font-black">Current real-supply query collection</h2><p className="mt-1 text-xs text-slate-400">No synthetic performer, event, room, release, or perpetual search baseline is added here.</p><JsonDetail value={observatory.queries} /></section>
      </div>
    </main>
  );
}
