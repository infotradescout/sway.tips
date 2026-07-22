import { useEffect, useState } from 'react';
import { ArrowLeft, CalendarDays, CheckCircle2, Disc3, Loader2, Share2 } from 'lucide-react';

type PublicRelease = {
  id: string;
  title: string;
  primaryArtistName: string;
  releaseType: string;
  status: 'ready' | 'scheduled' | 'published';
  labelName: string | null;
  pLine: string | null;
  cLine: string | null;
  scheduledReleaseAt: string | null;
  publishedAt: string | null;
  artworkUrl: string | null;
  recordings: Array<{
    recordingId: string;
    title: string;
    versionTitle: string | null;
    isExplicit: boolean;
    discNumber: number;
    trackNumber: number;
    credits: Array<{ displayName: string; role: string }>;
  }>;
  destinations: Array<{ destinationKey: string; deliveryStatus: string; liveAt: string | null }>;
};

export default function PublicReleasePage({ releaseId }: { releaseId: string }) {
  const [release, setRelease] = useState<PublicRelease | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`/api/public/releases/${releaseId}`, { cache: 'no-store', signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (response.status === 404) return setStatus('missing');
        if (!response.ok || !data.release) return setStatus('error');
        setRelease(data.release);
        setStatus('ready');
        document.title = `${data.release.title} by ${data.release.primaryArtistName} on Sway`;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setStatus('error');
      }
    })();
    return () => controller.abort();
  }, [releaseId]);

  const share = async () => {
    if (!release) return;
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: release.title, text: `${release.title} by ${release.primaryArtistName}`, url });
      else await navigator.clipboard.writeText(url);
      setMessage(navigator.share ? 'Share opened.' : 'Release link copied.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setMessage('Could not share this release link.');
    }
  };

  if (status === 'loading') return <div className="grid min-h-screen place-items-center bg-slate-950 text-violet-200"><Loader2 className="h-7 w-7 animate-spin" /></div>;
  if (!release) return <div className="grid min-h-screen place-items-center bg-slate-950 px-4 text-center text-slate-100"><div><Disc3 className="mx-auto h-8 w-8 text-slate-500" /><h1 className="mt-4 text-2xl font-black">{status === 'missing' ? 'Release not public' : 'Release unavailable'}</h1><p className="mt-2 text-sm text-slate-400">This release may still be private, under review, or temporarily unavailable.</p><a href="/" className="mt-6 inline-flex text-sm font-bold text-cyan-200">Back to Sway</a></div></div>;

  const liveDestinations = release.destinations.filter((destination) => destination.deliveryStatus === 'live');
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(124,58,237,0.24),_transparent_38%),#020617] px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-3xl">
        <a href="/" className="inline-flex items-center gap-2 text-xs font-bold text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4" />Sway</a>
        <section className="mt-5 overflow-hidden rounded-[2rem] border border-white/10 bg-slate-900/90 shadow-2xl">
          <div className="grid gap-6 p-5 sm:grid-cols-[240px_minmax(0,1fr)] sm:p-7">
            {release.artworkUrl ? <img src={release.artworkUrl} alt={`${release.title} cover artwork`} className="aspect-square w-full rounded-2xl object-cover shadow-xl" /> : <div className="grid aspect-square w-full place-items-center rounded-2xl bg-violet-500/10 text-violet-200"><Disc3 className="h-16 w-16" /></div>}
            <div className="self-end"><p className="text-[10px] font-black uppercase tracking-[0.28em] text-violet-300">{release.releaseType.replaceAll('_', ' ')}</p><h1 className="mt-2 font-display text-4xl font-black leading-none text-white sm:text-5xl">{release.title}</h1><p className="mt-3 text-lg font-bold text-slate-300">{release.primaryArtistName}</p>
              <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-slate-950 px-3 py-2 text-xs font-bold text-slate-300">{release.status === 'published' ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <CalendarDays className="h-4 w-4 text-violet-300" />}{release.status === 'published' ? 'Provider-confirmed release' : release.scheduledReleaseAt ? `Planned for ${new Date(release.scheduledReleaseAt).toLocaleString()}` : 'Release ready; delivery not yet confirmed'}</div>
              <button type="button" onClick={share} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-black text-white hover:bg-violet-500"><Share2 className="h-4 w-4" />Share release</button>{message ? <p className="mt-2 text-center text-xs text-slate-400">{message}</p> : null}
            </div>
          </div>
          <div className="border-t border-white/10 p-5 sm:p-7"><h2 className="text-xs font-black uppercase tracking-[0.24em] text-slate-400">Track list</h2><div className="mt-3 space-y-2">{release.recordings.map((recording) => <article key={recording.recordingId} className="rounded-xl border border-white/10 bg-slate-950/70 p-4"><div className="flex items-start gap-3"><span className="font-mono text-sm font-black text-violet-300">{recording.trackNumber}</span><div><h3 className="font-black text-white">{recording.title}{recording.versionTitle ? ` (${recording.versionTitle})` : ''}{recording.isExplicit ? <span className="ml-2 rounded bg-slate-700 px-1 py-0.5 text-[9px]">E</span> : null}</h3><p className="mt-1 text-xs leading-5 text-slate-400">{recording.credits.map((credit) => `${credit.displayName} · ${credit.role.replaceAll('_', ' ')}`).join('  •  ')}</p></div></div></article>)}</div>
            <h2 className="mt-6 text-xs font-black uppercase tracking-[0.24em] text-slate-400">Availability</h2>{liveDestinations.length ? <div className="mt-3 flex flex-wrap gap-2">{liveDestinations.map((destination) => <span key={destination.destinationKey} className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-100">{destination.destinationKey} · live</span>)}</div> : <p className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-amber-100">No destination has reported this release live yet. Sway does not turn a planned or submitted delivery into a false store link.</p>}
            {(release.pLine || release.cLine || release.labelName) ? <div className="mt-6 space-y-1 text-[11px] text-slate-500">{release.labelName ? <p>Label: {release.labelName}</p> : null}{release.pLine ? <p>{release.pLine}</p> : null}{release.cLine ? <p>{release.cLine}</p> : null}</div> : null}
          </div>
        </section>
      </div>
    </main>
  );
}
