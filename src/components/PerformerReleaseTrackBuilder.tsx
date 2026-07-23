import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import type { ReleaseCredit, ReleaseDraft, ReleaseMaster, ReleaseRecording } from './PerformerReleaseDrafts';

const CREDIT_ROLES = [
  ['primary_artist', 'Primary artist'], ['featured_artist', 'Featured artist'], ['songwriter', 'Songwriter'],
  ['composer', 'Composer'], ['producer', 'Producer'], ['co_producer', 'Co-producer'],
  ['engineer', 'Engineer'], ['mix_engineer', 'Mix engineer'], ['mastering_engineer', 'Mastering engineer'],
  ['performer', 'Performer'], ['publisher', 'Publisher'], ['other', 'Other']
] as const;

type TrackValues = {
  title: string;
  versionTitle: string;
  primaryArtistName: string;
  isrc: string;
  languageCode: string;
  originalReleaseDate: string;
  isExplicit: boolean;
};

function initialCredits(primaryArtistName: string): ReleaseCredit[] {
  return [
    { displayName: primaryArtistName, role: 'primary_artist' },
    { displayName: '', role: 'songwriter' }
  ];
}

function TrackFields({
  values,
  credits,
  onValues,
  onCredits
}: {
  values: TrackValues;
  credits: ReleaseCredit[];
  onValues: (values: TrackValues) => void;
  onCredits: (credits: ReleaseCredit[]) => void;
}) {
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-slate-400">Track title<input value={values.title} onChange={(event) => onValues({ ...values, title: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white" /></label>
        <label className="text-[11px] text-slate-400">Version title<input value={values.versionTitle} onChange={(event) => onValues({ ...values, versionTitle: event.target.value })} placeholder="Remix, live, radio edit…" className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white" /></label>
        <label className="text-[11px] text-slate-400">Primary artist<input value={values.primaryArtistName} onChange={(event) => onValues({ ...values, primaryArtistName: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white" /></label>
        <label className="text-[11px] text-slate-400">ISRC<input value={values.isrc} onChange={(event) => onValues({ ...values, isrc: event.target.value.toUpperCase() })} maxLength={12} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-xs uppercase text-white" /></label>
        <label className="text-[11px] text-slate-400">Language<input value={values.languageCode} onChange={(event) => onValues({ ...values, languageCode: event.target.value.toLowerCase() })} maxLength={3} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white" /></label>
        <label className="text-[11px] text-slate-400">Original release date<input type="date" value={values.originalReleaseDate} onChange={(event) => onValues({ ...values, originalReleaseDate: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white" /></label>
        <label className="flex min-h-10 items-center gap-2 rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-slate-300 sm:col-span-2"><input type="checkbox" checked={values.isExplicit} onChange={(event) => onValues({ ...values, isExplicit: event.target.checked })} /> Explicit content</label>
      </div>
      <div className="mt-3 rounded-lg border border-white/10 bg-slate-950/60 p-2">
        <div className="flex items-center justify-between gap-2"><p className="text-[11px] font-black text-white">Track credits</p><button type="button" onClick={() => onCredits([...credits, { displayName: '', role: 'other' }])} className="rounded border border-violet-500/30 px-2 py-1 text-[10px] font-bold text-violet-100">Add credit</button></div>
        <div className="mt-2 space-y-2">{credits.map((credit, index) => (
          <div key={`${index}:${credit.role}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_36px] gap-2">
            <input aria-label={`Track credit ${index + 1} name`} value={credit.displayName} onChange={(event) => onCredits(credits.map((item, itemIndex) => itemIndex === index ? { ...item, displayName: event.target.value } : item))} placeholder="Name" className="min-h-9 rounded border border-white/10 bg-slate-950 px-2 text-[11px] text-white" />
            <select aria-label={`Track credit ${index + 1} role`} value={credit.role} onChange={(event) => onCredits(credits.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value } : item))} className="min-h-9 rounded border border-white/10 bg-slate-950 px-2 text-[11px] text-white">{CREDIT_ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <button type="button" aria-label={`Remove track credit ${index + 1}`} onClick={() => onCredits(credits.filter((_, itemIndex) => itemIndex !== index))} className="grid min-h-9 place-items-center rounded border border-rose-500/20 text-rose-200"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ))}</div>
      </div>
    </>
  );
}

function TrackEditor({
  release,
  recording,
  index,
  count,
  onMove,
  onRemove,
  onSaved
}: {
  release: ReleaseDraft;
  recording: ReleaseRecording;
  index: number;
  count: number;
  onMove: (recordingId: string, direction: -1 | 1) => Promise<void>;
  onRemove: (recordingId: string) => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  const [values, setValues] = useState({
    title: recording.title,
    versionTitle: recording.versionTitle || '',
    primaryArtistName: recording.primaryArtistName,
    isrc: recording.isrc || '',
    languageCode: recording.languageCode || 'en',
    originalReleaseDate: recording.originalReleaseDate || release.originalReleaseDate || '',
    isExplicit: recording.isExplicit === true
  });
  const [credits, setCredits] = useState<ReleaseCredit[]>(recording.credits.length ? recording.credits : initialCredits(recording.primaryArtistName));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const editable = release.status === 'draft';

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/talent/audio/releases/${release.id}/recordings/${recording.recordingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, credits, expectedUpdatedAt: release.updatedAt })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not save this track.');
      setNotice('Track metadata and credits saved.');
      await onSaved();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save this track.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="rounded-xl border border-white/10 bg-slate-900/80 p-3" open={count === 1}>
      <summary className="cursor-pointer list-none">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0"><p className="truncate text-sm font-black text-white">{index + 1}. {recording.title}</p><p className="mt-1 truncate text-[10px] text-slate-500">{recording.primaryArtistName} · {recording.isrc || 'ISRC not set'} · {recording.rightsStatus}</p></div>
          {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-300" /> : null}
        </div>
      </summary>
      {notice ? <p className="mt-3 rounded-lg border border-white/10 p-2 text-[11px] text-slate-300">{notice}</p> : null}
      {editable ? (
        <div className="mt-3">
          <TrackFields values={values} credits={credits} onValues={setValues} onCredits={setCredits} />
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button type="button" onClick={() => onMove(recording.recordingId, -1)} disabled={busy || index === 0} className="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border border-white/10 text-[11px] font-bold text-white disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" />Move up</button>
            <button type="button" onClick={() => onMove(recording.recordingId, 1)} disabled={busy || index === count - 1} className="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border border-white/10 text-[11px] font-bold text-white disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" />Move down</button>
            <button type="button" onClick={save} disabled={busy} className="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg bg-violet-600 text-[11px] font-black text-white disabled:opacity-40"><Save className="h-3.5 w-3.5" />Save track</button>
            <button type="button" onClick={() => onRemove(recording.recordingId)} disabled={busy || count === 1} className="inline-flex min-h-10 items-center justify-center gap-1 rounded-lg border border-rose-500/30 text-[11px] font-bold text-rose-200 disabled:opacity-30"><Trash2 className="h-3.5 w-3.5" />Remove</button>
          </div>
        </div>
      ) : <p className="mt-3 text-[11px] text-amber-100">Track order and metadata are sealed because rights review has started.</p>}
    </details>
  );
}

export default function PerformerReleaseTrackBuilder({
  release,
  masters,
  onSaved
}: {
  release: ReleaseDraft;
  masters: ReleaseMaster[];
  onSaved: () => Promise<void>;
}) {
  const recordings = useMemo(() => [...release.recordings].sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber), [release.recordings]);
  const availableMasters = useMemo(() => {
    const used = new Set(recordings.map((recording) => recording.masterAssetVersionId));
    return masters.filter((master) => master.projectId === release.projectId && !used.has(master.versionId));
  }, [masters, recordings, release.projectId]);
  const [masterAssetVersionId, setMasterAssetVersionId] = useState('');
  const [values, setValues] = useState({
    title: '', versionTitle: '', primaryArtistName: release.primaryArtistName, isrc: '',
    languageCode: 'en', originalReleaseDate: release.originalReleaseDate || '', isExplicit: false
  });
  const [credits, setCredits] = useState<ReleaseCredit[]>(initialCredits(release.primaryArtistName));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const editable = release.status === 'draft';

  useEffect(() => {
    if (!availableMasters.some((master) => master.versionId === masterAssetVersionId)) {
      setMasterAssetVersionId(availableMasters[0]?.versionId || '');
    }
  }, [availableMasters, masterAssetVersionId]);

  const addTrack = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/talent/audio/releases/${release.id}/recordings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          credits,
          masterAssetVersionId,
          clientRecordingId: crypto.randomUUID(),
          expectedUpdatedAt: release.updatedAt
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not add this track.');
      setNotice(`Track ${data.trackNumber} added from the verified master.`);
      setValues({ title: '', versionTitle: '', primaryArtistName: release.primaryArtistName, isrc: '', languageCode: 'en', originalReleaseDate: release.originalReleaseDate || '', isExplicit: false });
      setCredits(initialCredits(release.primaryArtistName));
      await onSaved();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not add this track.');
    } finally {
      setBusy(false);
    }
  };

  const moveTrack = async (recordingId: string, direction: -1 | 1) => {
    const from = recordings.findIndex((recording) => recording.recordingId === recordingId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= recordings.length) return;
    const recordingIds = recordings.map((recording) => recording.recordingId);
    [recordingIds[from], recordingIds[to]] = [recordingIds[to], recordingIds[from]];
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/talent/audio/releases/${release.id}/recordings/order`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordingIds, expectedUpdatedAt: release.updatedAt })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not reorder tracks.');
      setNotice('Track order saved.');
      await onSaved();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not reorder tracks.');
    } finally {
      setBusy(false);
    }
  };

  const removeTrack = async (recordingId: string) => {
    const recording = recordings.find((candidate) => candidate.recordingId === recordingId);
    if (!window.confirm(`Remove “${recording?.title || 'this track'}” from this release? The sealed master stays in Catalog.`)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/talent/audio/releases/${release.id}/recordings/${recordingId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: release.updatedAt })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not remove this track.');
      setNotice('Track removed and the remaining order was closed up.');
      await onSaved();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not remove this track.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-sway-release-track-builder="true" className="mt-4 rounded-xl border border-violet-500/20 bg-violet-500/5 p-3">
      <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-black text-white">Release track list</p><p className="mt-1 text-[11px] text-slate-400">{recordings.length} track{recordings.length === 1 ? '' : 's'} · order saved with the release</p></div>{busy ? <Loader2 className="h-4 w-4 animate-spin text-violet-300" /> : null}</div>
      {notice ? <p className="mt-3 rounded-lg border border-white/10 bg-slate-950 p-2 text-[11px] text-slate-300">{notice}</p> : null}
      <div className="mt-3 space-y-2">{recordings.map((recording, index) => (
        <div key={`${recording.recordingId}:${release.updatedAt}`}>
          <TrackEditor release={release} recording={recording} index={index} count={recordings.length} onMove={moveTrack} onRemove={removeTrack} onSaved={onSaved} />
        </div>
      ))}</div>

      {editable && release.releaseType === 'single' ? (
        <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-amber-100">Change the release type to EP, Album, Comedy special, Spoken word, or Other before adding another track.</p>
      ) : null}
      {editable && release.releaseType !== 'single' ? (
        <details className="mt-3 rounded-xl border border-dashed border-violet-500/30 bg-slate-950/70 p-3">
          <summary className="cursor-pointer list-none text-xs font-black text-violet-100">Add another verified master</summary>
          {availableMasters.length ? (
            <div className="mt-3">
              <label className="text-[11px] text-slate-400">Verified master<select value={masterAssetVersionId} onChange={(event) => setMasterAssetVersionId(event.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white">{availableMasters.map((master) => <option key={master.versionId} value={master.versionId}>{master.title || master.originalFilename} · v{master.versionNumber}</option>)}</select></label>
              <div className="mt-3"><TrackFields values={values} credits={credits} onValues={setValues} onCredits={setCredits} /></div>
              <button type="button" onClick={addTrack} disabled={busy || !masterAssetVersionId || !values.title} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 text-xs font-black text-white disabled:opacity-40"><Plus className="h-4 w-4" />Add track to release</button>
            </div>
          ) : <p className="mt-3 text-[11px] text-slate-400">Upload another verified audio master to this Catalog project before adding a track.</p>}
        </details>
      ) : null}
    </section>
  );
}
