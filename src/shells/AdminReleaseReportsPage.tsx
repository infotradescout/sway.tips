import { CheckCircle2, ExternalLink, Flag, Loader2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

type ReportStatus = 'pending' | 'dismissed' | 'escalated' | 'resolved';

type ReleaseReport = {
  id: string;
  releaseId: string;
  releaseTitle: string;
  primaryArtistName: string;
  releasePath: string;
  reason: string;
  details: string;
  status: ReportStatus;
  reporterDisplayName: string | null;
  reporterEmail: string | null;
  createdAt: string;
  updatedAt: string;
  events: Array<{
    eventType: string;
    note: string;
    createdAt: string;
  }>;
};

const FILTERS: Array<{ value: ReportStatus; label: string }> = [
  { value: 'pending', label: 'Pending' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' }
];

function readableReason(value: string) {
  return value.replaceAll('_', ' ');
}

export default function AdminReleaseReportsPage() {
  const [filter, setFilter] = useState<ReportStatus>('pending');
  const [reports, setReports] = useState<ReleaseReport[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'loading' | 'ready' | 'locked' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const loadReports = useCallback(async () => {
    setStatus('loading');
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/release-reports?status=${filter}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        setStatus('locked');
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Could not load release reports.');
      setReports(Array.isArray(data.reports) ? data.reports : []);
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not load release reports.');
    }
  }, [filter]);

  useEffect(() => {
    document.title = 'Release reports · Sway admin';
    void loadReports();
  }, [loadReports]);

  const review = async (report: ReleaseReport, outcome: 'dismissed' | 'escalated' | 'resolved') => {
    const note = notes[report.id]?.trim() || '';
    if (note.length < 20) {
      setMessage('Write at least 20 characters explaining the evidence-based decision.');
      return;
    }
    setSavingId(report.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/release-reports/${report.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome, note })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not save this review.');
      setNotes((current) => ({ ...current, [report.id]: '' }));
      await loadReports();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save this review.');
    } finally {
      setSavingId(null);
    }
  };

  if (status === 'locked') {
    return <main className="grid min-h-screen place-items-center bg-slate-950 px-4 text-center text-white"><div><ShieldAlert className="mx-auto h-9 w-9 text-amber-300" /><h1 className="mt-4 text-2xl font-black">Administrator access required</h1><p className="mt-2 text-sm text-slate-400">Sign in with an authorized Sway administrator account.</p><a href="/admin/login" className="mt-5 inline-flex rounded-xl bg-fuchsia-600 px-4 py-3 text-sm font-black">Admin sign in</a></div></main>;
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <a href="/admin" className="text-xs font-bold text-cyan-300 hover:text-white">← Operator app</a>
            <p className="mt-5 text-[10px] font-black uppercase tracking-[0.26em] text-fuchsia-300">Evidence-based community moderation</p>
            <h1 className="mt-2 text-3xl font-black text-white">Release reports</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">Community reports never change release status or discovery rank automatically. Record a reasoned outcome after reviewing the submitted evidence.</p>
          </div>
          <button type="button" onClick={() => void loadReports()} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-xs font-black text-slate-200"><RefreshCw className="h-4 w-4" />Refresh</button>
        </header>

        <nav className="mt-7 flex flex-wrap gap-2" aria-label="Report status filters">
          {FILTERS.map((option) => <button key={option.value} type="button" onClick={() => setFilter(option.value)} aria-pressed={filter === option.value} className={`min-h-10 rounded-full border px-4 text-xs font-black ${filter === option.value ? 'border-fuchsia-300/40 bg-fuchsia-500/15 text-fuchsia-100' : 'border-white/10 bg-white/[0.03] text-slate-400'}`}>{option.label}</button>)}
        </nav>

        {message ? <div className="mt-5 rounded-xl border border-amber-300/20 bg-amber-400/10 p-4 text-sm text-amber-100">{message}</div> : null}

        {status === 'loading' ? <div className="mt-8 grid min-h-48 place-items-center rounded-2xl border border-white/10 bg-slate-900/60"><Loader2 className="h-7 w-7 animate-spin text-fuchsia-200" aria-label="Loading reports" /></div> : null}
        {status === 'error' ? <div className="mt-8 rounded-2xl border border-rose-300/20 bg-rose-400/10 p-6"><h2 className="font-black text-white">Reports unavailable</h2><p className="mt-2 text-sm text-rose-100/80">{message}</p><button type="button" onClick={() => void loadReports()} className="mt-4 rounded-xl bg-white px-4 py-2 text-sm font-black text-slate-950">Try again</button></div> : null}
        {status === 'ready' && reports.length === 0 ? <div className="mt-8 rounded-2xl border border-dashed border-white/10 bg-slate-900/50 p-10 text-center"><Flag className="mx-auto h-8 w-8 text-slate-600" /><h2 className="mt-4 font-black text-white">No {filter} release reports</h2><p className="mt-2 text-sm text-slate-500">The queue reflects durable community submissions only.</p></div> : null}

        {status === 'ready' && reports.length ? <div className="mt-6 space-y-5">{reports.map((report) => <article key={report.id} className="rounded-2xl border border-white/10 bg-slate-900/75 p-5 shadow-xl">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-[10px] font-black uppercase tracking-[0.22em] text-amber-300">{readableReason(report.reason)}</p><h2 className="mt-1 text-xl font-black text-white">{report.releaseTitle}</h2><p className="mt-1 text-sm text-slate-400">{report.primaryArtistName}</p></div>
            <a href={report.releasePath} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-xs font-black text-cyan-200">Open public release <ExternalLink className="h-3.5 w-3.5" /></a>
          </div>
          <div className="mt-4 rounded-xl border border-white/10 bg-slate-950/70 p-4"><p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Submitted evidence</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">{report.details}</p></div>
          <p className="mt-3 text-xs text-slate-500">Reported by {report.reporterDisplayName || report.reporterEmail || 'Sway account'} · {new Date(report.createdAt).toLocaleString()}</p>

          {report.events.length ? <details className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3"><summary className="cursor-pointer text-xs font-black text-slate-300">Review history ({report.events.length})</summary><div className="mt-3 space-y-2">{report.events.map((event, index) => <div key={`${event.eventType}:${event.createdAt}:${index}`} className="border-l border-white/10 pl-3 text-xs leading-5 text-slate-400"><p className="font-black text-slate-300">{readableReason(event.eventType)} · {new Date(event.createdAt).toLocaleString()}</p><p>{event.note}</p></div>)}</div></details> : null}

          {report.status === 'pending' || report.status === 'escalated' ? <div className="mt-4 border-t border-white/10 pt-4">
            <label className="block text-xs font-bold text-slate-300">Reasoned review note
              <textarea value={notes[report.id] || ''} onChange={(event) => setNotes((current) => ({ ...current, [report.id]: event.target.value }))} minLength={20} maxLength={2000} rows={3} placeholder="Explain what the evidence establishes and the next review state (at least 20 characters)." className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 p-3 text-sm leading-6 text-white outline-none focus:border-fuchsia-300/40" />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={savingId === report.id} onClick={() => void review(report, 'dismissed')} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-slate-300/20 bg-white/[0.04] px-4 text-xs font-black text-slate-200 disabled:opacity-50"><XCircle className="h-4 w-4" />Dismiss</button>
              {report.status === 'pending' ? <button type="button" disabled={savingId === report.id} onClick={() => void review(report, 'escalated')} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-amber-300/30 bg-amber-400/10 px-4 text-xs font-black text-amber-100 disabled:opacity-50"><ShieldAlert className="h-4 w-4" />Escalate</button> : null}
              <button type="button" disabled={savingId === report.id} onClick={() => void review(report, 'resolved')} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-emerald-300/30 bg-emerald-400/10 px-4 text-xs font-black text-emerald-100 disabled:opacity-50">{savingId === report.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Resolve</button>
            </div>
          </div> : <p className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-xs font-bold text-slate-400">Final outcome: {report.status}</p>}
        </article>)}</div> : null}
      </div>
    </main>
  );
}
