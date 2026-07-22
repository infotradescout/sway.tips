import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, FolderOpen, Loader2, MessageSquare, Upload, UserRound } from 'lucide-react';

async function sha256Hex(file: File) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function chunkFile(file: File, partSize: number) {
  const parts: Blob[] = [];
  for (let offset = 0; offset < file.size; offset += partSize) {
    parts.push(file.slice(offset, Math.min(offset + partSize, file.size)));
  }
  return parts;
}

function inferAssetKind(file: File) {
  if (file.type.startsWith('image/')) return 'artwork';
  if (file.type === 'application/pdf' || file.type.startsWith('text/')) return 'document';
  if (file.type.startsWith('video/')) return 'video';
  return 'master_audio';
}

type Project = { id: string; title: string };
type Asset = { id: string; title: string; metadata?: { requestable?: boolean } | null };
type Version = {
  id: string;
  assetId: string;
  versionNumber: number;
  originalFilename: string;
  byteSize: number;
  sha256: string;
  mimeType: string;
};
type Connection = {
  connectionId: string;
  counterparty: { displayName: string; handle: string | null } | null;
};
type SharedFile = {
  grantId: string;
  connectionId: string;
  projectTitle: string;
  versionId: string;
  originalFilename: string;
  byteSize: number;
  sha256: string;
  canDownloadOriginal: boolean;
  canComment: boolean;
  canApprove: boolean;
};
type ReviewEvent = {
  id: string;
  eventType: string;
  body: string | null;
  timecodeMs: number | null;
  createdAt: string;
};

export default function PerformerAudioFiles() {
  const [open, setOpen] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [title, setTitle] = useState('Masters');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [sharedWithMe, setSharedWithMe] = useState<SharedFile[]>([]);
  const [sharedByMe, setSharedByMe] = useState<SharedFile[]>([]);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});
  const [reviewsByGrant, setReviewsByGrant] = useState<Record<string, ReviewEvent[]>>({});

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const refreshProjects = async () => {
    const response = await fetch('/api/talent/audio/projects', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Could not load projects.');
    const nextProjects: Project[] = data.projects || [];
    const nextSelectedProjectId = nextProjects.some((project) => project.id === selectedProjectId)
      ? selectedProjectId
      : nextProjects[0]?.id || '';
    setProjects(nextProjects);
    setSelectedProjectId(nextSelectedProjectId);
    return nextSelectedProjectId;
  };

  const refreshAssets = async (projectId: string) => {
    const response = await fetch(`/api/talent/audio/projects/${projectId}/assets`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Could not load assets.');
    setAssets(data.assets || []);
    setVersions(data.versions || []);
  };

  const refreshCollaboration = async () => {
    const [connectionsResponse, incomingResponse, outgoingResponse] = await Promise.all([
      fetch('/api/talent/audio/pairing/connections', { cache: 'no-store' }),
      fetch('/api/talent/audio/files/shared-with-me', { cache: 'no-store' }),
      fetch('/api/talent/audio/files/shared-by-me', { cache: 'no-store' })
    ]);
    const [connectionsData, incomingData, outgoingData] = await Promise.all([
      connectionsResponse.json().catch(() => ({})),
      incomingResponse.json().catch(() => ({})),
      outgoingResponse.json().catch(() => ({}))
    ]);
    if (!connectionsResponse.ok) throw new Error(connectionsData?.error || 'Could not load file connections.');
    if (!incomingResponse.ok) throw new Error(incomingData?.error || 'Could not load files shared with you.');
    if (!outgoingResponse.ok) throw new Error(outgoingData?.error || 'Could not load files you shared.');
    const nextConnections: Connection[] = connectionsData.connections || [];
    setConnections(nextConnections);
    setSelectedConnectionId((current) => nextConnections.some((connection) => connection.connectionId === current)
      ? current
      : nextConnections[0]?.connectionId || '');
    setSharedWithMe(incomingData.files || []);
    setSharedByMe(outgoingData.files || []);
  };

  const openPanel = async () => {
    setOpen(true);
    setStatus(null);
    setBusy(true);
    try {
      const projectId = await refreshProjects();
      await refreshCollaboration();
      if (projectId) await refreshAssets(projectId);
      else setVersions([]);
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Audio files unavailable.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void openPanel();
  }, []);

  const createProject = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch('/api/talent/audio/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not create project.');
      await refreshProjects();
      setSelectedProjectId(data.project.id);
      setStatus('Project created.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not create project.');
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setStatus(`Hashing ${file.name}…`);
    setShareToken(null);
    try {
      let projectId = selectedProjectId;
      if (!projectId) {
        setStatus('Preparing your Catalog…');
        const projectResponse = await fetch('/api/talent/audio/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'My Catalog' })
        });
        const projectData = await projectResponse.json().catch(() => ({}));
        if (!projectResponse.ok) throw new Error(projectData?.error || 'Could not prepare your Catalog.');
        projectId = projectData.project.id;
        await refreshProjects();
        setSelectedProjectId(projectId);
      }
      const expectedSha256 = await sha256Hex(file);
      const partSize = 5 * 1024 * 1024;
      const start = await fetch(`/api/talent/audio/projects/${projectId}/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: file.name,
          assetKind: inferAssetKind(file),
          originalFilename: file.name,
          mimeType: file.type || 'application/octet-stream',
          expectedByteSize: file.size,
          expectedSha256,
          idempotencyKey: `upload:${projectId}:${expectedSha256}:${file.size}`,
          partSizeBytes: partSize
        })
      });
      const startData = await start.json().catch(() => ({}));
      if (!start.ok) throw new Error(startData?.error || 'Could not start upload.');

      const parts = chunkFile(file, partSize);
      for (let index = 0; index < parts.length; index += 1) {
        setStatus(`Uploading part ${index + 1}/${parts.length}…`);
        const partResponse = await fetch(
          `/api/talent/audio/uploads/${startData.uploadSession.id}/parts/${index + 1}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: parts[index]
          }
        );
        const partData = await partResponse.json().catch(() => ({}));
        if (!partResponse.ok) throw new Error(partData?.error || `Part ${index + 1} failed.`);
      }

      setStatus('Sealing immutable source file…');
      const complete = await fetch(`/api/talent/audio/uploads/${startData.uploadSession.id}/complete`, {
        method: 'POST'
      });
      const completeData = await complete.json().catch(() => ({}));
      if (!complete.ok) throw new Error(completeData?.error || 'Could not seal upload.');
      await refreshAssets(projectId);
      setStatus(`Sealed v${completeData.version.versionNumber} · ${completeData.version.sha256.slice(0, 12)}…`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setBusy(false);
    }
  };

  const setRequestable = async (assetId: string, requestable: boolean) => {
    if (!selectedProjectId) return;
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/talent/audio/assets/${assetId}/requestable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestable })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not update request availability.');
      await refreshAssets(selectedProjectId);
      setStatus(requestable ? 'This track is now available in Library.' : 'This track is private to Catalog.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not update request availability.');
    } finally {
      setBusy(false);
    }
  };

  const createShare = async (versionId: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/talent/audio/versions/${versionId}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxUses: 5 })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not create share.');
      setShareToken(data.shareToken);
      setStatus('Share token created. Copy it now — it is shown once.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Share failed.');
    } finally {
      setBusy(false);
    }
  };

  const shareWithConnection = async (versionId: string) => {
    if (!selectedConnectionId) {
      setStatus('Pair with another account before sharing a selected file.');
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/talent/audio/pairing/connections/${selectedConnectionId}/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          versionId,
          canDownloadOriginal: true,
          canComment: true,
          canApprove: true
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not share selected file.');
      await refreshCollaboration();
      setStatus(data.reused ? 'This version is already shared with that connection.' : 'Selected version shared for download, review, and approval.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not share selected file.');
    } finally {
      setBusy(false);
    }
  };

  const loadReviews = async (grantId: string) => {
    const response = await fetch(`/api/talent/audio/file-grants/${grantId}/reviews`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Could not load review activity.');
    setReviewsByGrant((current) => ({ ...current, [grantId]: data.events || [] }));
  };

  const sendReview = async (grantId: string, eventType: 'comment' | 'approved' | 'changes_requested') => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/talent/audio/file-grants/${grantId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType, body: reviewDrafts[grantId] || undefined })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not record review.');
      setReviewDrafts((current) => ({ ...current, [grantId]: '' }));
      await loadReviews(grantId);
      setStatus(eventType === 'approved' ? 'Approval recorded.' : 'Review note recorded.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not record review.');
    } finally {
      setBusy(false);
    }
  };

  const revokeGrant = async (grantId: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(`/api/talent/audio/file-grants/${grantId}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Removed from Files & projects.' })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Could not revoke file access.');
      await refreshCollaboration();
      setStatus('Selected-file access revoked. Download and review replay are now denied.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not revoke file access.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPanel}
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-black text-cyan-100 transition hover:border-cyan-300 hover:text-white"
      >
        <FolderOpen className="h-4 w-4" aria-hidden="true" />
        Files &amp; projects
      </button>
    );
  }

  return (
    <section className="rounded-2xl border border-cyan-500/20 bg-slate-950 p-4 sm:col-span-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Your Catalog</p>
          <p className="mt-1 text-xs text-slate-400">Keep masters, artwork, and rights documents together. Files stay private unless you explicitly share them or allow an audio master for requests.</p>
        </div>
        {busy ? <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> : null}
      </div>

      <label className="relative mt-4 inline-flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white focus-within:ring-2 focus-within:ring-fuchsia-300 disabled:opacity-50">
          <Upload className="h-4 w-4" aria-hidden="true" />
          Add Catalog file
          <input
            type="file"
            accept="audio/*,image/*,application/pdf,text/plain"
            aria-label="Add audio to Catalog"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            disabled={busy}
            onChange={(event) => uploadFile(event.target.files?.[0] ?? null)}
          />
      </label>

      <details className="mt-3 rounded-xl border border-white/10 bg-slate-900 p-3">
        <summary className="cursor-pointer list-none text-xs font-bold text-slate-400">Organize projects</summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <select value={selectedProjectId} onChange={async (event) => { setSelectedProjectId(event.target.value); if (event.target.value) await refreshAssets(event.target.value); }} className="min-h-11 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm font-bold text-white">
            <option value="">My Catalog</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input value={title} onChange={(event) => setTitle(event.target.value)} className="min-h-11 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm font-bold text-white" placeholder="Project title" />
            <button type="button" onClick={createProject} disabled={busy} className="rounded-xl border border-fuchsia-500/30 px-3 text-xs font-black text-fuchsia-100 disabled:opacity-50">Create</button>
          </div>
        </div>
      </details>

      <div className="mt-4 space-y-2">
        {versions.length === 0 ? (
          <p className="text-xs text-slate-500">No sealed versions yet.</p>
        ) : versions.map((version) => {
          const asset = assets.find((candidate) => candidate.id === version.assetId);
          const requestable = asset?.metadata?.requestable === true;
          return <div key={version.id} className="rounded-xl border border-white/10 bg-slate-900 px-3 py-3">
            <p className="truncate text-sm font-bold text-white">{version.originalFilename} · v{version.versionNumber}</p>
            {version.mimeType.startsWith('audio/') ? <audio controls preload="metadata" src={`/api/talent/audio/versions/${version.id}/content`} className="mt-3 w-full" aria-label={`Play ${version.originalFilename}`} /> : null}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${requestable ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-white/10 text-slate-400'}`}>{requestable ? 'In Library' : 'Private'}</span>
              {version.mimeType.startsWith('audio/') ? <button type="button" onClick={() => setRequestable(version.assetId, !requestable)} disabled={busy} className="rounded-lg border border-fuchsia-500/30 px-3 py-2 text-xs font-black text-fuchsia-100 disabled:opacity-50">{requestable ? 'Remove from requests' : 'Allow requests'}</button> : null}
            </div>
            <details className="mt-2"><summary className="cursor-pointer text-[10px] text-slate-500">File details and sharing</summary><p className="mt-2 font-mono text-[10px] text-slate-500">{version.sha256}</p>
            <button
              type="button"
              onClick={() => createShare(version.id)}
              disabled={busy}
              className="mt-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-black text-cyan-100"
            >
              Create one-time link
            </button>
            <button
              type="button"
              onClick={() => shareWithConnection(version.id)}
              disabled={busy || !selectedConnectionId}
              className="ml-2 mt-2 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1.5 text-[11px] font-black text-fuchsia-100 disabled:opacity-50"
            >
              Share with connection
            </button>
            </details>
          </div>;
        })}
      </div>

      <div className="mt-5 rounded-xl border border-white/10 bg-slate-900 p-3">
        <label className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400" htmlFor="sway-file-connection">
          Selected connection
        </label>
        <select
          id="sway-file-connection"
          value={selectedConnectionId}
          onChange={(event) => setSelectedConnectionId(event.target.value)}
          className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 text-sm font-bold text-white"
        >
          <option value="">Pair an account first</option>
          {connections.map((connection) => (
            <option key={connection.connectionId} value={connection.connectionId}>
              {connection.counterparty?.displayName || 'Connected account'}
              {connection.counterparty?.handle ? ` @${connection.counterparty.handle}` : ''}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-5 space-y-3">
        <div className="flex items-center gap-2 text-cyan-200">
          <UserRound className="h-4 w-4" aria-hidden="true" />
          <p className="text-[10px] font-black uppercase tracking-[0.24em]">Shared with me</p>
        </div>
        {sharedWithMe.length === 0 ? <p className="text-xs text-slate-500">No selected files shared with you.</p> : sharedWithMe.map((file) => (
          <div key={file.grantId} className="rounded-xl border border-cyan-500/20 bg-slate-900 p-3">
            <p className="text-sm font-bold text-white">{file.originalFilename}</p>
            <p className="mt-1 text-[11px] text-slate-400">{file.projectTitle} · {file.byteSize.toLocaleString()} bytes</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {file.canDownloadOriginal ? (
                <a
                  href={`/api/talent/audio/file-grants/${file.grantId}/download`}
                  className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-cyan-500 px-3 text-xs font-black text-slate-950"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  Download source file
                </a>
              ) : null}
              <button type="button" onClick={() => loadReviews(file.grantId)} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-bold text-white">
                Review history
              </button>
              <button type="button" onClick={() => revokeGrant(file.grantId)} className="min-h-10 rounded-lg border border-rose-500/30 px-3 text-xs font-bold text-rose-200">
                Remove access
              </button>
            </div>
            {file.canComment ? (
              <textarea
                value={reviewDrafts[file.grantId] || ''}
                onChange={(event) => setReviewDrafts((current) => ({ ...current, [file.grantId]: event.target.value }))}
                placeholder="Leave a review note"
                className="mt-3 min-h-20 w-full rounded-xl border border-white/10 bg-slate-950 p-3 text-sm text-white"
              />
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2">
              {file.canComment ? (
                <button type="button" onClick={() => sendReview(file.grantId, 'comment')} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-cyan-500/30 px-3 text-xs font-bold text-cyan-100">
                  <MessageSquare className="h-4 w-4" aria-hidden="true" />
                  Add note
                </button>
              ) : null}
              {file.canComment ? (
                <button type="button" onClick={() => sendReview(file.grantId, 'changes_requested')} className="min-h-10 rounded-lg border border-amber-500/30 px-3 text-xs font-bold text-amber-100">
                  Request changes
                </button>
              ) : null}
              {file.canApprove ? (
                <button type="button" onClick={() => sendReview(file.grantId, 'approved')} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-emerald-500 px-3 text-xs font-black text-slate-950">
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  Approve
                </button>
              ) : null}
            </div>
            {reviewsByGrant[file.grantId]?.length ? (
              <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
                {reviewsByGrant[file.grantId].map((event) => (
                  <p key={event.id} className="text-xs text-slate-300">
                    <span className="font-bold text-white">{event.eventType.replace('_', ' ')}</span>
                    {event.body ? ` · ${event.body}` : ''}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">Shared by me</p>
        {sharedByMe.length === 0 ? <p className="text-xs text-slate-500">No active selected-file shares.</p> : sharedByMe.map((file) => (
          <div key={file.grantId} className="rounded-xl border border-white/10 bg-slate-900 p-3">
            <p className="text-sm font-bold text-white">{file.originalFilename}</p>
            <p className="mt-1 text-[11px] text-slate-400">Download, review, and approval access is active.</p>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => loadReviews(file.grantId)} className="min-h-10 rounded-lg border border-white/10 px-3 text-xs font-bold text-white">Review history</button>
              <button type="button" onClick={() => revokeGrant(file.grantId)} className="min-h-10 rounded-lg border border-rose-500/30 px-3 text-xs font-bold text-rose-200">Revoke</button>
            </div>
            {reviewsByGrant[file.grantId]?.length ? (
              <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
                {reviewsByGrant[file.grantId].map((event) => (
                  <p key={event.id} className="text-xs text-slate-300">
                    <span className="font-bold text-white">{event.eventType.replace('_', ' ')}</span>
                    {event.body ? ` · ${event.body}` : ''}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {shareToken ? (
        <p className="mt-3 break-all rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 font-mono text-[11px] text-amber-100">
          {shareToken}
        </p>
      ) : null}
      {status ? <p className="mt-3 text-xs text-slate-300">{status}</p> : null}
    </section>
  );
}
