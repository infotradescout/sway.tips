import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Disc3, Loader2, Plus } from 'lucide-react';

type ReleaseMaster = {
  versionId: string;
  projectId: string;
  projectTitle: string;
  title: string;
  originalFilename: string;
  versionNumber: number;
};

type ReleaseRecording = {
  recordingId: string;
  title: string;
  versionTitle: string | null;
  isrc: string | null;
  isExplicit: boolean;
  languageCode: string | null;
  rightsStatus: string;
};

type ReleaseDraft = {
  id: string;
  title: string;
  primaryArtistName: string;
  releaseType: string;
  distributionMode: string;
  status: string;
  upc: string | null;
  labelName: string | null;
  originalReleaseDate: string | null;
  territories: string[] | null;
  recordings: ReleaseRecording[];
};

function freshReleaseId() {
  return crypto.randomUUID();
}

export default function PerformerReleaseDrafts() {
  const [masters, setMasters] = useState<ReleaseMaster[]>([]);
  const [releases, setReleases] = useState<ReleaseDraft[]>([]);
  const [clientReleaseId, setClientReleaseId] = useState(freshReleaseId);
  const [masterVersionId, setMasterVersionId] = useState('');
  const [title, setTitle] = useState('');
  const [trackTitle, setTrackTitle] = useState('');
  const [versionTitle, setVersionTitle] = useState('');
  const [primaryArtistName, setPrimaryArtistName] = useState('');
  const [releaseType, setReleaseType] = useState('single');
  const [upc, setUpc] = useState('');
  const [isrc, setIsrc] = useState('');
  const [labelName, setLabelName] = useState('');
  const [pLine, setPLine] = useState('');
  const [cLine, setCLine] = useState('');
  const [originalReleaseDate, setOriginalReleaseDate] = useState('');
  const [territories, setTerritories] = useState('US');
  const [languageCode, setLanguageCode] = useState('en');
  const [isExplicit, setIsExplicit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedMaster = useMemo(
    () => masters.find((master) => master.versionId === masterVersionId) ?? null,
    [masterVersionId, masters]
  );

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/talent/audio/releases', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not load release drafts.');
      const nextMasters: ReleaseMaster[] = Array.isArray(data.masters) ? data.masters : [];
      setMasters(nextMasters);
      setReleases(Array.isArray(data.releases) ? data.releases : []);
      setMasterVersionId((current) => nextMasters.some((master) => master.versionId === current)
        ? current
        : nextMasters[0]?.versionId || '');
      setPrimaryArtistName((current) => current || data?.performer?.displayName || '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load release drafts.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const createDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedMaster) return;
    setSubmitting(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch('/api/talent/audio/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientReleaseId,
          projectId: selectedMaster.projectId,
          masterAssetVersionId: selectedMaster.versionId,
          title,
          trackTitle: trackTitle || title,
          versionTitle,
          primaryArtistName,
          releaseType,
          upc,
          isrc,
          labelName,
          pLine,
          cLine,
          originalReleaseDate,
          territories: territories.split(',').map((value) => value.trim()).filter(Boolean),
          languageCode,
          isExplicit
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not create release draft.');
      setMessage(data.created === false ? 'This release draft was already saved.' : 'Private release draft created.');
      setClientReleaseId(freshReleaseId());
      setTitle('');
      setTrackTitle('');
      setVersionTitle('');
      setUpc('');
      setIsrc('');
      await refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not create release draft.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section data-sway-release-drafts="true" className="mt-5 rounded-2xl border border-violet-500/20 bg-slate-950/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-violet-300">Release drafts</p>
          <h3 className="mt-1 text-lg font-black text-white">Prepare a release from your Catalog</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            Bind a sealed master to release metadata. Drafts stay private and are not sent to stores.
          </p>
        </div>
        {loading || submitting ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-300" aria-label="Working" /> : <Disc3 className="h-5 w-5 shrink-0 text-violet-300" aria-hidden="true" />}
      </div>

      {error ? <p className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-100">{error}</p> : null}
      {message ? <p className="mt-4 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-100">{message}</p> : null}

      {!loading && masters.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-white/15 p-5 text-center">
          <p className="text-sm font-black text-white">Add a master first</p>
          <p className="mt-1 text-xs text-slate-400">Upload and seal audio in Catalog before creating a release draft.</p>
        </div>
      ) : null}

      {masters.length > 0 ? (
        <form onSubmit={createDraft} className="mt-4 space-y-3">
          <label className="block text-xs font-bold text-slate-300">
            Sealed master
            <select value={masterVersionId} onChange={(event) => setMasterVersionId(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-sm text-white">
              {masters.map((master) => <option key={master.versionId} value={master.versionId}>{master.title || master.originalFilename} · v{master.versionNumber} · {master.projectTitle}</option>)}
            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold text-slate-300">Release title<input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
            <label className="text-xs font-bold text-slate-300">Primary artist<input required maxLength={200} value={primaryArtistName} onChange={(event) => setPrimaryArtistName(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
            <label className="text-xs font-bold text-slate-300">Track title<input required maxLength={200} value={trackTitle} onChange={(event) => setTrackTitle(event.target.value)} placeholder="Defaults to release title" className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
            <label className="text-xs font-bold text-slate-300">Release type<select value={releaseType} onChange={(event) => setReleaseType(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-sm text-white"><option value="single">Single</option><option value="ep">EP</option><option value="album">Album</option><option value="comedy_special">Comedy special</option><option value="spoken_word">Spoken word</option><option value="other">Other</option></select></label>
          </div>

          <details className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
            <summary className="cursor-pointer list-none text-xs font-bold text-slate-400">Identifiers and release details</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-slate-400">Version title<input maxLength={200} value={versionTitle} onChange={(event) => setVersionTitle(event.target.value)} placeholder="Remix, live, radio edit…" className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-white" /></label>
              <label className="text-xs text-slate-400">Original release date<input type="date" value={originalReleaseDate} onChange={(event) => setOriginalReleaseDate(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-white" /></label>
              <label className="text-xs text-slate-400">UPC<input inputMode="numeric" maxLength={14} value={upc} onChange={(event) => setUpc(event.target.value)} placeholder="Optional" className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-white" /></label>
              <label className="text-xs text-slate-400">ISRC<input maxLength={12} value={isrc} onChange={(event) => setIsrc(event.target.value)} placeholder="Optional" className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-sm uppercase text-white" /></label>
              <label className="text-xs text-slate-400">Label<input maxLength={200} value={labelName} onChange={(event) => setLabelName(event.target.value)} placeholder="Optional" className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-white" /></label>
              <label className="text-xs text-slate-400">Territories<input value={territories} onChange={(event) => setTerritories(event.target.value)} placeholder="US, CA, GB" className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-sm uppercase text-white" /></label>
              <label className="text-xs text-slate-400">Language code<input maxLength={3} value={languageCode} onChange={(event) => setLanguageCode(event.target.value)} placeholder="en" className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-white" /></label>
              <label className="flex min-h-10 items-center gap-2 self-end rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-slate-300"><input type="checkbox" checked={isExplicit} onChange={(event) => setIsExplicit(event.target.checked)} /> Explicit content</label>
              <label className="text-xs text-slate-400">P line<input maxLength={200} value={pLine} onChange={(event) => setPLine(event.target.value)} placeholder="℗ year owner" className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-white" /></label>
              <label className="text-xs text-slate-400">C line<input maxLength={200} value={cLine} onChange={(event) => setCLine(event.target.value)} placeholder="© year owner" className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-sm text-white" /></label>
            </div>
          </details>

          <button type="submit" disabled={submitting || !selectedMaster} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-black text-white transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50">
            <Plus className="h-4 w-4" aria-hidden="true" />
            {submitting ? 'Saving release draft…' : 'Create private release draft'}
          </button>
        </form>
      ) : null}

      {releases.length > 0 ? (
        <div className="mt-6 space-y-2" aria-label="Saved release drafts">
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-slate-500">Saved drafts</p>
          {releases.map((release) => (
            <article key={release.id} className="rounded-xl border border-white/10 bg-slate-900 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div><p className="font-black text-white">{release.title}</p><p className="mt-1 text-xs text-slate-400">{release.primaryArtistName} · {release.releaseType.replace('_', ' ')}</p></div>
                <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-1 text-[10px] font-bold text-violet-200">Private draft</span>
              </div>
              {release.recordings.map((recording) => <p key={recording.recordingId} className="mt-2 text-xs text-slate-300">Track 1 · {recording.title}{recording.versionTitle ? ` (${recording.versionTitle})` : ''}</p>)}
              <p className="mt-2 text-[10px] text-slate-500">Not delivered to stores. Rights review and delivery remain separate required steps.</p>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
