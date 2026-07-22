import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from 'lucide-react';

type RightsReview = {
  id: string;
  releaseId: string;
  releaseTitle: string;
  primaryArtistName: string;
  declarationType: string;
  declarationText: string;
  declarationSha256: string;
  termsVersion: string;
  termsHash: string;
  evidence: { note?: string; sourceDocumentSha256?: string } | null;
  declaredAt: string;
};

export default function PerformerRightsReviewQueue({
  backHref = '/talent',
  backLabel = 'Back to Sway'
}: {
  backHref?: string;
  backLabel?: string;
} = {}) {
  const [items, setItems] = useState<RightsReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/talent/audio/rights/review-queue', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not load rights review work.');
      setItems(Array.isArray(data.declarations) ? data.declarations : []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load rights review work.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const review = async (item: RightsReview, outcome: 'verified' | 'rejected') => {
    const reason = reasons[item.id]?.trim();
    if (!reason) {
      setMessage('Write a specific review reason before recording an outcome.');
      return;
    }
    setBusyId(item.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/talent/audio/rights/${item.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome, reason })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not record rights review.');
      setMessage(outcome === 'verified' ? 'Evidence verified and appended to the release audit trail.' : 'Evidence rejected; the release is blocked until corrected.');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not record rights review.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <section className="mx-auto max-w-3xl rounded-3xl border border-violet-500/20 bg-slate-900 p-5 shadow-2xl sm:p-7">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-[10px] font-black uppercase tracking-[0.28em] text-violet-300">Independent release review</p><h1 className="mt-2 font-display text-2xl font-black text-white">Rights evidence queue</h1><p className="mt-2 text-sm leading-6 text-slate-400">Only projects that explicitly granted you release-review permission appear here. Your decision is append-only and bound to the exact declaration and source-document hashes.</p></div>
          {loading ? <Loader2 className="h-5 w-5 animate-spin text-violet-300" /> : <ShieldCheck className="h-6 w-6 text-violet-300" />}
        </div>
        {message ? <p className="mt-4 rounded-xl border border-white/10 bg-slate-950 p-3 text-xs text-slate-200">{message}</p> : null}
        {!loading && !items.length ? <div className="mt-6 rounded-2xl border border-dashed border-white/15 p-8 text-center"><CheckCircle2 className="mx-auto h-6 w-6 text-emerald-300" /><p className="mt-3 font-black text-white">No rights reviews waiting</p><p className="mt-1 text-xs text-slate-500">New evidence will appear after a connected project owner grants review access and records a declaration.</p></div> : null}
        <div className="mt-6 space-y-4">{items.map((item) => <article key={item.id} className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-black text-white">{item.releaseTitle}</p><p className="mt-1 text-xs text-slate-400">{item.primaryArtistName} · {item.declarationType.replaceAll('_', ' ')}</p></div><span className="rounded-full border border-amber-500/30 px-2 py-1 text-[10px] font-bold text-amber-200">Review required</span></div>
          <p className="mt-3 whitespace-pre-line rounded-xl border border-white/10 bg-slate-900 p-3 text-sm leading-6 text-slate-200">{item.declarationText}</p>
          {item.evidence?.note ? <p className="mt-2 text-xs text-slate-400"><span className="font-bold text-slate-200">Evidence note:</span> {item.evidence.note}</p> : null}
          <dl className="mt-3 grid gap-2 text-[10px] text-slate-500 sm:grid-cols-2"><div><dt>Declaration SHA-256</dt><dd className="mt-1 break-all font-mono text-slate-400">{item.declarationSha256}</dd></div><div><dt>Terms v{item.termsVersion} SHA-256</dt><dd className="mt-1 break-all font-mono text-slate-400">{item.termsHash}</dd></div></dl>
          <a href={`/api/talent/audio/rights/${item.id}/document`} target="_blank" rel="noreferrer" className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-xs font-black text-cyan-100">Open sealed evidence</a>
          <textarea value={reasons[item.id] || ''} onChange={(event) => setReasons((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Explain what you checked and why this evidence passes or fails." className="mt-4 min-h-24 w-full rounded-xl border border-white/10 bg-slate-900 p-3 text-sm text-white" />
          <div className="mt-3 grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => review(item, 'verified')} disabled={busyId === item.id} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-xs font-black text-slate-950 disabled:opacity-50"><CheckCircle2 className="h-4 w-4" />Verify evidence</button><button type="button" onClick={() => review(item, 'rejected')} disabled={busyId === item.id} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 text-xs font-black text-rose-100 disabled:opacity-50"><XCircle className="h-4 w-4" />Reject and block</button></div>
        </article>)}</div>
        <a href={backHref} className="mt-6 inline-flex text-xs font-bold text-cyan-200 underline decoration-cyan-500/40 underline-offset-4">{backLabel}</a>
      </section>
    </main>
  );
}
