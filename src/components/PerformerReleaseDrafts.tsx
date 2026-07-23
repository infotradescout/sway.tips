import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, Disc3, FileCheck2, Loader2, Plus, Save, ShieldCheck } from 'lucide-react';
import PerformerReleaseTrackBuilder from './PerformerReleaseTrackBuilder';

export type ReleaseMaster = {
  versionId: string;
  projectId: string;
  projectTitle: string;
  title: string;
  originalFilename: string;
  versionNumber: number;
};

export type ReleaseAsset = ReleaseMaster & { mimeType: string; assetKind: string; sha256: string };

export type ReleaseCredit = { id?: string; displayName: string; role: string; sequence?: number };
type FileConnection = { connectionId: string; counterparty: { displayName: string; handle: string | null } | null };

export type ReleaseRecording = {
  recordingId: string;
  masterAssetVersionId: string | null;
  title: string;
  versionTitle: string | null;
  primaryArtistName: string;
  isrc: string | null;
  isExplicit: boolean;
  languageCode: string | null;
  originalReleaseDate: string | null;
  rightsStatus: string;
  discNumber: number;
  trackNumber: number;
  credits: ReleaseCredit[];
};

export type ReleaseDraft = {
  id: string;
  projectId: string;
  title: string;
  primaryArtistName: string;
  releaseType: string;
  distributionMode: string;
  status: string;
  artworkAssetVersionId: string | null;
  upc: string | null;
  labelName: string | null;
  pLine: string | null;
  cLine: string | null;
  originalReleaseDate: string | null;
  scheduledReleaseAt: string | null;
  territories: string[] | null;
  updatedAt: string;
  recordings: ReleaseRecording[];
  declarations: Array<{ id: string; recordingId: string | null; declarationType: string; outcome: string; termsVersion: string }>;
  readiness: {
    ready: boolean;
    issues: string[];
    metadataIssues: string[];
    rightsIssues: string[];
    verifiedRights: string[];
    requiredRights: string[];
  };
};

function freshReleaseId() {
  return crypto.randomUUID();
}

const RIGHTS_TYPES = [
  ['master_control', 'Master control'], ['composition_control', 'Composition control'],
  ['sample_clearance', 'Sample clearance'], ['cover_license', 'Cover license'],
  ['beat_license', 'Beat license'], ['artwork_control', 'Artwork control'],
  ['performer_consent', 'Performer consent'], ['ai_disclosure', 'AI disclosure'],
  ['distribution_authorization', 'Distribution authorization']
];

const RECORDING_SCOPED_RIGHTS = new Set([
  'master_control', 'composition_control', 'sample_clearance', 'cover_license',
  'beat_license', 'performer_consent', 'ai_disclosure'
]);

function localDateTimeValue(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function ReleaseEditor({
  release,
  masters,
  artworks,
  rightsDocuments,
  connections,
  onSaved
}: {
  release: ReleaseDraft;
  masters: ReleaseMaster[];
  artworks: ReleaseAsset[];
  rightsDocuments: ReleaseAsset[];
  connections: FileConnection[];
  onSaved: () => Promise<void>;
}) {
  const leadRecording = [...release.recordings]
    .sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber)
    .at(0);
  const [form, setForm] = useState({
    title: release.title,
    primaryArtistName: release.primaryArtistName,
    releaseType: release.releaseType,
    distributionMode: release.distributionMode,
    artworkAssetVersionId: release.artworkAssetVersionId || '',
    upc: release.upc || '',
    labelName: release.labelName || '',
    pLine: release.pLine || '',
    cLine: release.cLine || '',
    originalReleaseDate: release.originalReleaseDate || '',
    scheduledReleaseAt: localDateTimeValue(release.scheduledReleaseAt),
    territories: (release.territories || ['US']).join(', ')
  });
  const [rights, setRights] = useState({
    declarationType: 'master_control',
    recordingId: leadRecording?.recordingId || '',
    termsDocumentAssetVersionId: '',
    termsVersion: '1',
    declarationText: '',
    evidenceNote: ''
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewerConnectionId, setReviewerConnectionId] = useState('');

  useEffect(() => {
    if (!release.recordings.some((recording) => recording.recordingId === rights.recordingId)) {
      setRights((current) => ({ ...current, recordingId: leadRecording?.recordingId || '' }));
    }
  }, [leadRecording?.recordingId, release.recordings, rights.recordingId]);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/talent/audio/releases/${release.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          trackTitle: leadRecording?.title || release.title,
          versionTitle: leadRecording?.versionTitle || null,
          isrc: leadRecording?.isrc || null,
          isExplicit: leadRecording?.isExplicit === true,
          languageCode: leadRecording?.languageCode || null,
          credits: leadRecording?.credits.length
            ? leadRecording.credits
            : [{ displayName: leadRecording?.primaryArtistName || release.primaryArtistName, role: 'primary_artist' }],
          expectedUpdatedAt: release.updatedAt,
          artworkAssetVersionId: form.artworkAssetVersionId || null,
          scheduledReleaseAt: form.scheduledReleaseAt ? new Date(form.scheduledReleaseAt).toISOString() : null,
          territories: form.territories.split(',').map((value) => value.trim()).filter(Boolean)
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not save release details.');
      setNotice('Release metadata, artwork, and schedule saved as a new audited draft revision.');
      await onSaved();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save release details.');
    } finally {
      setBusy(false);
    }
  };

  const declareRights = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/talent/audio/releases/${release.id}/rights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...rights,
          recordingId: RECORDING_SCOPED_RIGHTS.has(rights.declarationType) ? rights.recordingId : null
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not record rights declaration.');
      setNotice('Immutable rights declaration recorded. A different release manager must verify or reject it.');
      setRights((current) => ({ ...current, declarationText: '', evidenceNote: '' }));
      await onSaved();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not record rights declaration.');
    } finally {
      setBusy(false);
    }
  };

  const addReviewer = async () => {
    if (!reviewerConnectionId) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/talent/audio/projects/${release.projectId}/release-reviewers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: reviewerConnectionId })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not add release reviewer.');
      setNotice(`Release-review permission granted. Send them ${window.location.origin}/talent/releases/review.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not add release reviewer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mt-3 rounded-xl border border-white/10 bg-slate-950/70 p-3">
      <summary className="cursor-pointer list-none text-xs font-black text-violet-200">Edit release, tracks, artwork, and rights</summary>
      {notice ? <p className="mt-3 rounded-lg border border-white/10 bg-slate-900 p-3 text-xs text-slate-200">{notice}</p> : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-400">Release title<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">Primary artist<input value={form.primaryArtistName} onChange={(event) => setForm({ ...form, primaryArtistName: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">Release type<select value={form.releaseType} onChange={(event) => setForm({ ...form, releaseType: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white"><option value="single">Single</option><option value="ep">EP</option><option value="album">Album</option><option value="comedy_special">Comedy special</option><option value="spoken_word">Spoken word</option><option value="other">Other</option></select></label>
        <label className="text-xs text-slate-400">Release mode<select value={form.distributionMode} onChange={(event) => setForm({ ...form, distributionMode: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white"><option value="private">Private</option><option value="sway_only">Sway only</option><option value="sway_first">Sway first</option><option value="everywhere">Everywhere</option></select></label>
        <label className="text-xs text-slate-400">Verified artwork<select value={form.artworkAssetVersionId} onChange={(event) => setForm({ ...form, artworkAssetVersionId: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white"><option value="">Select artwork</option>{artworks.filter((asset) => asset.projectId === release.projectId).map((asset) => <option key={asset.versionId} value={asset.versionId}>{asset.title || asset.originalFilename} · v{asset.versionNumber}</option>)}</select></label>
        <label className="text-xs text-slate-400">Scheduled release<input type="datetime-local" value={form.scheduledReleaseAt} onChange={(event) => setForm({ ...form, scheduledReleaseAt: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">UPC<input value={form.upc} onChange={(event) => setForm({ ...form, upc: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">Label<input value={form.labelName} onChange={(event) => setForm({ ...form, labelName: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">Territories<input value={form.territories} onChange={(event) => setForm({ ...form, territories: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">℗ line<input value={form.pLine} onChange={(event) => setForm({ ...form, pLine: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">© line<input value={form.cLine} onChange={(event) => setForm({ ...form, cLine: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
        <label className="text-xs text-slate-400">Original release date<input type="date" value={form.originalReleaseDate} onChange={(event) => setForm({ ...form, originalReleaseDate: event.target.value })} className="mt-1 min-h-10 w-full rounded-lg border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
      </div>

      <button type="button" onClick={save} disabled={busy || release.status !== 'draft'} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 text-xs font-black text-white disabled:opacity-40"><Save className="h-4 w-4" />Save audited draft revision</button>

      <PerformerReleaseTrackBuilder release={release} masters={masters} onSaved={onSaved} />

      <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
        <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-amber-200" /><p className="text-xs font-black text-white">Immutable rights evidence</p></div>
        {rightsDocuments.some((asset) => asset.projectId === release.projectId) ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <select value={rights.declarationType} onChange={(event) => setRights({ ...rights, declarationType: event.target.value })} className="min-h-10 rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white">{RIGHTS_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            {RECORDING_SCOPED_RIGHTS.has(rights.declarationType) ? (
              <select value={rights.recordingId} onChange={(event) => setRights({ ...rights, recordingId: event.target.value })} className="min-h-10 rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white">
                <option value="">Choose the recording this evidence covers</option>
                {[...release.recordings].sort((a, b) => a.trackNumber - b.trackNumber).map((recording) => <option key={recording.recordingId} value={recording.recordingId}>Track {recording.trackNumber} · {recording.title}</option>)}
              </select>
            ) : <div className="grid min-h-10 place-items-center rounded-lg border border-white/10 bg-slate-950 px-3 text-[11px] text-slate-400">Applies to the whole release</div>}
            <select value={rights.termsDocumentAssetVersionId} onChange={(event) => setRights({ ...rights, termsDocumentAssetVersionId: event.target.value })} className="min-h-10 rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white"><option value="">Select rights document</option>{rightsDocuments.filter((asset) => asset.projectId === release.projectId).map((asset) => <option key={asset.versionId} value={asset.versionId}>{asset.title || asset.originalFilename} · {asset.sha256.slice(0, 10)}…</option>)}</select>
            <input value={rights.termsVersion} onChange={(event) => setRights({ ...rights, termsVersion: event.target.value })} placeholder="Document version" className="min-h-10 rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white" />
            <input value={rights.evidenceNote} onChange={(event) => setRights({ ...rights, evidenceNote: event.target.value })} placeholder="Where the authority or license came from" className="min-h-10 rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white sm:col-span-2" />
            <textarea value={rights.declarationText} onChange={(event) => setRights({ ...rights, declarationText: event.target.value })} placeholder="State exactly what rights you control or are authorized to distribute." className="min-h-24 rounded-lg border border-white/10 bg-slate-950 p-3 text-xs text-white sm:col-span-2" />
          </div>
        ) : <p className="mt-2 text-xs text-amber-100">Upload a PDF or text rights document to this Catalog project before declaring rights.</p>}
        <button type="button" onClick={declareRights} disabled={busy || !rights.termsDocumentAssetVersionId || !rights.declarationText || !rights.evidenceNote || (RECORDING_SCOPED_RIGHTS.has(rights.declarationType) && !rights.recordingId)} className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 text-xs font-black text-amber-100 disabled:opacity-40"><FileCheck2 className="h-4 w-4" />Record immutable declaration</button>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <select value={reviewerConnectionId} onChange={(event) => setReviewerConnectionId(event.target.value)} className="min-h-10 rounded-lg border border-white/10 bg-slate-950 px-3 text-xs text-white"><option value="">Choose a connected independent reviewer</option>{connections.map((connection) => <option key={connection.connectionId} value={connection.connectionId}>{connection.counterparty?.displayName || 'Connected account'}{connection.counterparty?.handle ? ` @${connection.counterparty.handle}` : ''}</option>)}</select>
          <button type="button" onClick={addReviewer} disabled={busy || !reviewerConnectionId} className="min-h-10 rounded-lg border border-cyan-500/30 px-3 text-xs font-black text-cyan-100 disabled:opacity-40">Grant review access</button>
        </div>
        <a href="/talent/releases/review" className="mt-3 inline-flex text-[11px] font-bold text-cyan-200 underline decoration-cyan-500/40 underline-offset-4">Open my rights review queue</a>
      </div>

      <div className={`mt-4 rounded-xl border p-3 ${release.readiness.ready ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-white/10 bg-slate-900/70'}`}>
        <div className="flex items-center gap-2">{release.readiness.ready ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <ShieldCheck className="h-4 w-4 text-slate-400" />}<p className="text-xs font-black text-white">{release.readiness.ready ? 'Release is delivery-ready' : `${release.readiness.issues.length} readiness item${release.readiness.issues.length === 1 ? '' : 's'} remaining`}</p></div>
        {!release.readiness.ready ? <ul className="mt-2 list-disc pl-5 text-[11px] leading-5 text-slate-400">{release.readiness.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : null}
        {release.declarations.length ? <div className="mt-3 flex flex-wrap gap-2">{release.declarations.map((declaration) => {
          const recording = release.recordings.find((candidate) => candidate.recordingId === declaration.recordingId);
          return <span key={declaration.id} className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-slate-300">{recording ? `Track ${recording.trackNumber} · ` : 'Release · '}{declaration.declarationType.replaceAll('_', ' ')} · {declaration.outcome}</span>;
        })}</div> : null}
      </div>
    </details>
  );
}

export default function PerformerReleaseDrafts() {
  const [masters, setMasters] = useState<ReleaseMaster[]>([]);
  const [artworks, setArtworks] = useState<ReleaseAsset[]>([]);
  const [rightsDocuments, setRightsDocuments] = useState<ReleaseAsset[]>([]);
  const [connections, setConnections] = useState<FileConnection[]>([]);
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
      const [response, connectionsResponse] = await Promise.all([
        fetch('/api/talent/audio/releases', { cache: 'no-store' }),
        fetch('/api/talent/audio/pairing/connections', { cache: 'no-store' })
      ]);
      const [data, connectionData] = await Promise.all([
        response.json().catch(() => ({})),
        connectionsResponse.json().catch(() => ({}))
      ]);
      if (!response.ok) throw new Error(data?.error || 'Could not load release drafts.');
      if (!connectionsResponse.ok) throw new Error(connectionData?.error || 'Could not load connected reviewers.');
      const nextMasters: ReleaseMaster[] = Array.isArray(data.masters) ? data.masters : [];
      setMasters(nextMasters);
      setArtworks(Array.isArray(data.artworks) ? data.artworks : []);
      setRightsDocuments(Array.isArray(data.rightsDocuments) ? data.rightsDocuments : []);
      setConnections(Array.isArray(connectionData.connections) ? connectionData.connections : []);
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
            Assemble sealed masters into an ordered release. Drafts stay private and are not sent to stores.
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
              {[...release.recordings]
                .sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber)
                .map((recording) => <p key={recording.recordingId} className="mt-2 text-xs text-slate-300">Track {recording.trackNumber} · {recording.title}{recording.versionTitle ? ` (${recording.versionTitle})` : ''}</p>)}
              <p className="mt-2 text-[10px] text-slate-500">Not delivered to stores. Rights review and provider-confirmed delivery remain separate required steps.</p>
              <ReleaseEditor release={release} masters={masters} artworks={artworks} rightsDocuments={rightsDocuments} connections={connections} onSaved={refresh} />
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
