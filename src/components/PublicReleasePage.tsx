import { type FormEvent, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  Disc3,
  Flag,
  Loader2,
  Quote,
  Share2,
  ShieldCheck,
  Sparkles
} from 'lucide-react';
import {
  captureDiscoveryAttribution,
  getEffectiveDiscoveryChannel
} from '../shells/discoveryAttribution';
import { sendAcquisitionEvent, sendDiscoveryEvent } from '../shells/frictionClient';
import DiscoveryFindUsPrompt from './DiscoveryFindUsPrompt';

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
  creationTags: string[];
  humanWrittenLyrics: boolean;
  originalVirtualArtist: boolean;
  fullyGenerated: boolean;
  recordings: Array<{
    recordingId: string;
    title: string;
    versionTitle: string | null;
    isExplicit: boolean;
    discNumber: number;
    trackNumber: number;
    lyricsAuthorship: string;
    compositionAuthorship: string;
    vocalPerformance: string;
    productionMethod: string;
    lyricsExcerpt: string | null;
    creation: {
      publicTags: string[];
      howMade: string[];
      fullyGenerated: boolean;
    };
    credits: Array<{ displayName: string; role: string }>;
  }>;
  destinations: Array<{ destinationKey: string; deliveryStatus: string; liveAt: string | null }>;
};

const REPORT_REASONS = [
  ['copied_lyrics', 'Copied lyrics'],
  ['unauthorized_voice', 'Unauthorized voice replication'],
  ['unlicensed_sample', 'Unlicensed sample'],
  ['missing_commercial_rights', 'Missing commercial rights'],
  ['incorrect_creation_credit', 'Incorrect creation credits'],
  ['spam_or_duplicate', 'Spam or duplicate'],
  ['fake_engagement', 'Fake engagement'],
  ['impersonation', 'Impersonation']
] as const;

function tagClass(tag: string) {
  if (tag === 'Human-written lyrics') return 'border-emerald-300/30 bg-emerald-400/10 text-emerald-100';
  if (tag === 'Original virtual artist') return 'border-cyan-300/30 bg-cyan-400/10 text-cyan-100';
  if (tag === 'Rights checked') return 'border-violet-300/30 bg-violet-400/10 text-violet-100';
  return 'border-white/10 bg-white/[0.05] text-slate-200';
}

function readableRole(role: string) {
  return role.replaceAll('_', ' ');
}

export default function PublicReleasePage({ releaseId }: { releaseId: string }) {
  const [release, setRelease] = useState<PublicRelease | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState('incorrect_creation_credit');
  const [reportDetails, setReportDetails] = useState('');
  const [reportStatus, setReportStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [reportMessage, setReportMessage] = useState<string | null>(null);

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
        captureDiscoveryAttribution();
        sendDiscoveryEvent('discovery_landing', {
          shell: 'patron', surface: 'public-release', route_family: 'public-release',
          has_route_context: true, has_session_context: false, build_commit: 'unknown',
          attribution_channel: getEffectiveDiscoveryChannel(), entity_kind: 'release', entity_key: releaseId,
          visibility_eligibility: 'eligible'
        });
        sendDiscoveryEvent('discovery_entity_view', {
          shell: 'patron', surface: 'public-release', route_family: 'public-release',
          has_route_context: true, has_session_context: false, build_commit: 'unknown',
          attribution_channel: getEffectiveDiscoveryChannel(), entity_kind: 'release', entity_key: releaseId,
          visibility_eligibility: 'eligible'
        });
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
      sendAcquisitionEvent('public_release_shared', {
        shell: 'patron', surface: 'public-release', route_family: 'public-release',
        has_route_context: true, has_session_context: false, build_commit: 'unknown'
      });
      sendDiscoveryEvent('discovery_primary_action', {
        shell: 'patron', surface: 'public-release', route_family: 'public-release',
        has_route_context: true, has_session_context: false, build_commit: 'unknown',
        attribution_channel: getEffectiveDiscoveryChannel(), entity_kind: 'release', entity_key: release.id,
        action_kind: 'share', visibility_eligibility: 'eligible'
      });
      setMessage(navigator.share ? 'Share opened.' : 'Release link copied.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setMessage('Could not share this release link.');
    }
  };

  const submitReport = async (event: FormEvent) => {
    event.preventDefault();
    if (!release || reportStatus === 'sending') return;
    setReportStatus('sending');
    setReportMessage(null);
    try {
      const response = await fetch(`/api/public/releases/${release.id}/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reportReason, details: reportDetails })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        setReportStatus('idle');
        setReportMessage('Sign in to submit an evidence-backed report.');
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Could not submit this report.');
      setReportStatus('sent');
      setReportDetails('');
      setReportMessage('Report received for human review. The release was not automatically removed or downranked.');
    } catch (error) {
      setReportStatus('idle');
      setReportMessage(error instanceof Error ? error.message : 'Could not submit this report.');
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
            <div className="self-end">
              <p className="text-[10px] font-black uppercase tracking-[0.28em] text-violet-300">{release.releaseType.replaceAll('_', ' ')}</p>
              <h1 className="mt-2 font-display text-4xl font-black leading-none text-white sm:text-5xl">{release.title}</h1>
              <p className="mt-3 text-lg font-bold text-slate-300">{release.primaryArtistName}</p>
              <div className="mt-4 flex flex-wrap gap-2">{release.creationTags.map((tag) => <span key={tag} className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-wider ${tagClass(tag)}`}>{tag}</span>)}</div>
              <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-slate-950 px-3 py-2 text-xs font-bold text-slate-300">{release.status === 'published' ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <CalendarDays className="h-4 w-4 text-violet-300" />}{release.status === 'published' ? 'Provider-confirmed release' : release.scheduledReleaseAt ? `Planned for ${new Date(release.scheduledReleaseAt).toLocaleString()}` : 'Release ready; delivery not yet confirmed'}</div>
              <button type="button" onClick={share} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-black text-white hover:bg-violet-500"><Share2 className="h-4 w-4" />Share release</button>
              {message ? <p className="mt-2 text-center text-xs text-slate-400">{message}</p> : null}
            </div>
          </div>
          <div className="border-t border-white/10 p-5 sm:p-7">
            <h2 className="text-xs font-black uppercase tracking-[0.24em] text-slate-400">Track list · songs and writers</h2>
            <div className="mt-3 space-y-3">{release.recordings.map((recording) => {
              const allCredits = recording.credits.map((credit) => credit);
              const songwriters = allCredits.filter((credit) => credit.role === 'songwriter' || credit.role === 'composer');
              const otherCredits = allCredits.filter((credit) => credit.role !== 'songwriter' && credit.role !== 'composer');
              return <article key={recording.recordingId} className="rounded-xl border border-white/10 bg-slate-950/70 p-4">
                <div className="flex items-start gap-3">
                  <span className="font-mono text-sm font-black text-violet-300">{recording.trackNumber}</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="font-black text-white">{recording.title}{recording.versionTitle ? ` (${recording.versionTitle})` : ''}{recording.isExplicit ? <span className="ml-2 rounded bg-slate-700 px-1 py-0.5 text-[9px]">E</span> : null}</h3>
                    {songwriters.length ? <p className="mt-2 text-sm font-bold text-emerald-100">Written by {songwriters.map((credit) => credit.displayName).join(', ')}</p> : null}
                    {recording.lyricsExcerpt ? <blockquote className="mt-3 flex gap-2 rounded-lg border border-emerald-300/15 bg-emerald-400/[0.06] p-3 text-sm italic leading-6 text-slate-200"><Quote className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />{recording.lyricsExcerpt}</blockquote> : null}
                    {otherCredits.length ? <p className="mt-3 text-xs leading-5 text-slate-400">{otherCredits.map((credit) => `${credit.displayName} · ${readableRole(credit.role)}`).join('  •  ')}</p> : null}
                    <details className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                      <summary className="cursor-pointer text-xs font-black text-cyan-100">How this recording was made</summary>
                      <div className="mt-3 flex flex-wrap gap-2">{recording.creation.publicTags.map((tag) => <span key={tag} className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${tagClass(tag)}`}>{tag}</span>)}</div>
                      <ul className="mt-3 space-y-1 text-xs leading-5 text-slate-400">{recording.creation.howMade.map((detail) => <li key={detail}>{detail}</li>)}</ul>
                      <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-violet-100"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />Sway checked the release&apos;s required rights declarations. Creation method does not reduce the songwriter&apos;s credit.</p>
                    </details>
                  </div>
                </div>
              </article>;
            })}</div>

            <h2 className="mt-6 text-xs font-black uppercase tracking-[0.24em] text-slate-400">Availability</h2>
            {liveDestinations.length ? <div className="mt-3 flex flex-wrap gap-2">{liveDestinations.map((destination) => <span key={destination.destinationKey} className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-bold text-emerald-100">{destination.destinationKey} · live</span>)}</div> : <p className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-amber-100">No destination has reported this release live yet. Sway does not turn a planned or submitted delivery into a false store link.</p>}
            {(release.pLine || release.cLine || release.labelName) ? <div className="mt-6 space-y-1 text-[11px] text-slate-500">{release.labelName ? <p>Label: {release.labelName}</p> : null}{release.pLine ? <p>{release.pLine}</p> : null}{release.cLine ? <p>{release.cLine}</p> : null}</div> : null}
          </div>
        </section>

        <details className="mt-5 rounded-2xl border border-white/10 bg-slate-900/70 p-4">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-black text-slate-200"><Flag className="h-4 w-4 text-amber-300" />Report a rights, credit, or identity concern</summary>
          <div className="mt-4 border-t border-white/10 pt-4">
            <p className="text-xs leading-5 text-slate-400">Using a virtual artist or generative production is not, by itself, a violation. A report never removes or downranks a release automatically.</p>
            {reportStatus === 'sent' ? <div className="mt-4 rounded-xl border border-emerald-300/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">{reportMessage}</div> : <form onSubmit={submitReport} className="mt-4 space-y-3">
              <label className="block text-xs font-bold text-slate-300">Concern
                <select value={reportReason} onChange={(event) => setReportReason(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-white">
                  {REPORT_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="block text-xs font-bold text-slate-300">Evidence or investigable details
                <textarea value={reportDetails} onChange={(event) => setReportDetails(event.target.value)} minLength={40} maxLength={2000} required rows={5} placeholder="Give specific details, sources, or links that a reviewer can investigate (at least 40 characters)." className="mt-1 w-full rounded-xl border border-white/10 bg-slate-950 p-3 text-sm leading-6 text-white outline-none focus:border-amber-300/40" />
              </label>
              <button disabled={reportStatus === 'sending' || reportDetails.trim().length < 40} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-amber-300/30 bg-amber-400/10 px-4 text-sm font-black text-amber-100 disabled:cursor-not-allowed disabled:opacity-40">{reportStatus === 'sending' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flag className="h-4 w-4" />}Submit for human review</button>
            </form>}
            {reportMessage && reportStatus !== 'sent' ? <p className="mt-3 text-xs leading-5 text-amber-100">{reportMessage} <a href={`/account/login?next=${encodeURIComponent(`/r/${release.id}`)}`} className="font-black underline">Sign in</a></p> : null}
          </div>
        </details>

        <div className="mt-5 rounded-2xl border border-cyan-300/15 bg-cyan-400/[0.05] p-4 text-xs leading-5 text-cyan-50/80"><Sparkles className="mr-2 inline h-4 w-4 text-cyan-300" />Sway credits the human contribution that exists. A virtual performance does not erase human-written lyrics.</div>
        <DiscoveryFindUsPrompt routeFamily="public-release" surface="public-release" entityKey={release.id} />
      </div>
    </main>
  );
}
