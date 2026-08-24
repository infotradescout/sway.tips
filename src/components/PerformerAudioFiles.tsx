import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, Upload } from 'lucide-react';
import {
  AUDIO_UPLOAD_PART_SIZE_BYTES,
  chunkFileForUpload,
  sha256FileHex
} from '../audio-upload-client';
import CollaboratorInbox, {
  type CollaborationCapabilities,
  type FileConnection
} from './CollaboratorInbox';

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

type StorageUsage = {
  workspaceLimitBytes: number;
  workingBytes: number;
  sealedWorkingBytes: number;
  reservedBytes: number;
  releaseProtectedBytes: number;
  availableWorkspaceBytes: number;
  workingObjectCount: number;
  workingObjectLimit: number;
  releaseCountLimit: null;
};

type CandidateGrantResponse = {
  grant?: {
    id?: string;
    maxCandidateBytes?: number;
  };
  reused?: boolean;
  error?: string;
};

const MIN_CANDIDATE_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_CANDIDATE_REQUEST_BYTES = 512 * 1024 * 1024;

function candidateRequestByteLimit(sourceByteSize: number) {
  if (!Number.isSafeInteger(sourceByteSize) || sourceByteSize <= 0) {
    return MIN_CANDIDATE_REQUEST_BYTES;
  }
  if (sourceByteSize >= MAX_CANDIDATE_REQUEST_BYTES / 2) {
    return MAX_CANDIDATE_REQUEST_BYTES;
  }
  return Math.max(MIN_CANDIDATE_REQUEST_BYTES, sourceByteSize * 2);
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: unitIndex === 0 ? 0 : 1 })} ${units[unitIndex]}`;
}

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
  const [connections, setConnections] = useState<FileConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [collaborationRefreshKey, setCollaborationRefreshKey] = useState(0);
  const [candidateUploadsEnabled, setCandidateUploadsEnabled] = useState(false);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const assetRefreshSequence = useRef(0);
  const selectedProjectIdRef = useRef('');

  const refreshProjects = async () => {
    const response = await fetch('/api/talent/audio/projects', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Could not load projects.');
    const nextProjects: Project[] = data.projects || [];
    const currentProjectId = selectedProjectIdRef.current;
    const nextSelectedProjectId = nextProjects.some((project) => project.id === currentProjectId)
      ? currentProjectId
      : nextProjects[0]?.id || '';
    setProjects(nextProjects);
    selectedProjectIdRef.current = nextSelectedProjectId;
    setSelectedProjectId(nextSelectedProjectId);
    return nextSelectedProjectId;
  };

  const refreshAssets = async (projectId: string) => {
    const refreshId = ++assetRefreshSequence.current;
    const response = await fetch(`/api/talent/audio/projects/${projectId}/assets`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (refreshId !== assetRefreshSequence.current) return;
      throw new Error(data?.error || 'Could not load assets.');
    }
    if (refreshId !== assetRefreshSequence.current
      || projectId !== selectedProjectIdRef.current) return;
    setAssets(data.assets || []);
    setVersions(data.versions || []);
  };

  const refreshStorageUsage = async () => {
    const response = await fetch('/api/talent/audio/storage-usage', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Could not load release workspace usage.');
    const nextUsage = data.storageUsage as StorageUsage;
    setStorageUsage(nextUsage);
    return nextUsage;
  };

  const handleConnectionsLoaded = useCallback((
    nextConnections: FileConnection[],
    capabilities: CollaborationCapabilities
  ) => {
    setConnections(nextConnections);
    setCandidateUploadsEnabled(capabilities.candidateUploads);
    setSelectedConnectionId((current) => nextConnections.some((connection) => connection.connectionId === current)
      ? current
      : nextConnections[0]?.connectionId || '');
  }, []);

  const openPanel = async () => {
    setOpen(true);
    setStatus(null);
    setBusy(true);
    try {
      const projectId = await refreshProjects();
      await refreshStorageUsage();
      if (projectId && selectedProjectIdRef.current === projectId) await refreshAssets(projectId);
      else {
        assetRefreshSequence.current += 1;
        setAssets([]);
        setVersions([]);
      }
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
      selectedProjectIdRef.current = data.project.id;
      setSelectedProjectId(data.project.id);
      assetRefreshSequence.current += 1;
      setAssets([]);
      setVersions([]);
      setStatus('Project created.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not create project.');
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async (file: File | null) => {
    if (!file) return;
    if (storageUsage && file.size > storageUsage.availableWorkspaceBytes) {
      setStatus(`This file needs ${formatBytes(file.size)}, but ${formatBytes(storageUsage.availableWorkspaceBytes)} remains in your release workspace.`);
      return;
    }
    if (storageUsage && storageUsage.workingObjectCount >= storageUsage.workingObjectLimit) {
      setStatus('Your working-file safeguard is full. Ready releases are not limited; finish a release or contact support for retained-file review.');
      return;
    }
    setBusy(true);
    setStatus(`Hashing ${file.name}…`);
    setShareToken(null);
    try {
      let projectId = selectedProjectIdRef.current;
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
        selectedProjectIdRef.current = projectId;
        setSelectedProjectId(projectId);
      }
      const expectedSha256 = await sha256FileHex(file);
      const partSize = AUDIO_UPLOAD_PART_SIZE_BYTES;
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

      const parts = chunkFileForUpload(file, partSize);
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
      await Promise.all([refreshAssets(projectId), refreshStorageUsage()]);
      setStatus(`Sealed v${completeData.version.versionNumber} · ${completeData.version.sha256.slice(0, 12)}…`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Upload failed.');
      void refreshStorageUsage().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const setRequestable = async (assetId: string, requestable: boolean) => {
    const projectId = selectedProjectIdRef.current;
    if (!projectId) return;
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
      await refreshAssets(projectId);
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
        body: JSON.stringify({ maxUses: 1 })
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
      setCollaborationRefreshKey((current) => current + 1);
      setStatus(data.reused ? 'This version is already shared with that connection.' : 'Selected version shared for download, review, and approval.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not share selected file.');
    } finally {
      setBusy(false);
    }
  };

  const requestCandidateRevision = async (version: Version) => {
    if (!selectedConnectionId) {
      setStatus('Pair with another account before requesting a private candidate.');
      return;
    }
    if (!candidateUploadsEnabled) return;
    const maxCandidateBytes = candidateRequestByteLimit(version.byteSize);
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(
        `/api/talent/audio/pairing/connections/${selectedConnectionId}/candidate-revision-grants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            versionId: version.id,
            maxCandidateBytes,
            expiresInHours: 168,
            idempotencyKey: `candidate-grant:${version.id}:${crypto.randomUUID()}`
          })
        }
      );
      const data = await response.json().catch(() => ({})) as CandidateGrantResponse;
      if (!response.ok) throw new Error(data?.error || 'Could not request a private candidate.');
      if (data.grant?.maxCandidateBytes !== maxCandidateBytes) {
        throw new Error('The server did not confirm the creator-approved candidate request ceiling.');
      }
      setCollaborationRefreshKey((current) => current + 1);
      setStatus(data.reused
        ? `That connection already has this ${formatBytes(maxCandidateBytes)} private-candidate request for the source.`
        : `Private-candidate upload requested for seven days with a ${formatBytes(maxCandidateBytes)} ceiling. It cannot replace the source or enter a release.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not request a private candidate.');
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

      {storageUsage ? (
        <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-black text-cyan-100">Release workspace</span>
            <span className="font-bold text-slate-300">
              {formatBytes(storageUsage.workingBytes)} of {formatBytes(storageUsage.workspaceLimitBytes)} working storage
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
            <div
              className="h-full rounded-full bg-cyan-400 transition-[width]"
              style={{ width: `${Math.min(100, (storageUsage.workingBytes / storageUsage.workspaceLimitBytes) * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            Release count is unlimited. Draft files and active uploads use this working pool. Only the exact file versions in an immutable, validated release-package manifest leave the pool; changing a release or delivery status is not enough. Sway preserves sealed originals and does not silently delete them to make room.
          </p>
          <p className="mt-1 text-[10px] text-slate-500">
            {storageUsage.workingObjectCount.toLocaleString()} of {storageUsage.workingObjectLimit.toLocaleString()} working-file records. This safeguard limits storage abuse, not releases.
          </p>
          {storageUsage.releaseProtectedBytes > 0 ? (
            <p className="mt-1 text-[10px] font-bold text-emerald-300">
              {formatBytes(storageUsage.releaseProtectedBytes)} preserved in validated release-package manifests outside the working pool.
            </p>
          ) : null}
        </div>
      ) : null}

      <label className="relative mt-4 inline-flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white focus-within:ring-2 focus-within:ring-fuchsia-300 disabled:opacity-50">
          <Upload className="h-4 w-4" aria-hidden="true" />
          Add Catalog file
          <input
            type="file"
            accept="audio/*,image/*,application/pdf,text/plain"
            aria-label="Add audio to Catalog"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            disabled={busy
              || storageUsage?.availableWorkspaceBytes === 0
              || (storageUsage != null && storageUsage.workingObjectCount >= storageUsage.workingObjectLimit)}
            onChange={(event) => uploadFile(event.target.files?.[0] ?? null)}
          />
      </label>

      <details className="mt-3 rounded-xl border border-white/10 bg-slate-900 p-3">
        <summary className="cursor-pointer list-none text-xs font-bold text-slate-400">Organize projects</summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="sway-audio-project" className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
              Catalog project
            </label>
            <select
              id="sway-audio-project"
              value={selectedProjectId}
              onChange={async (event) => {
                const projectId = event.target.value;
                selectedProjectIdRef.current = projectId;
                setSelectedProjectId(projectId);
                assetRefreshSequence.current += 1;
                setAssets([]);
                setVersions([]);
                if (projectId) {
                  setStatus(null);
                  try {
                    await refreshAssets(projectId);
                  } catch (error) {
                    setStatus(error instanceof Error ? error.message : 'Could not load assets.');
                  }
                }
              }}
              className="mt-2 min-h-11 w-full rounded-xl border border-white/10 bg-slate-950 px-3 text-sm font-bold text-white"
            >
              <option value="">My Catalog</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <label htmlFor="sway-new-project-title" className="sr-only">New project title</label>
            <input id="sway-new-project-title" value={title} onChange={(event) => setTitle(event.target.value)} className="min-h-11 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm font-bold text-white" placeholder="Project title" />
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
          const maxCandidateBytes = candidateRequestByteLimit(version.byteSize);
          return <div key={version.id} className="rounded-xl border border-white/10 bg-slate-900 px-3 py-3">
            <p className="truncate text-sm font-bold text-white">{version.originalFilename} · v{version.versionNumber}</p>
            {version.mimeType.startsWith('audio/') ? <audio controls preload="metadata" src={`/api/talent/audio/versions/${version.id}/content`} className="mt-3 w-full" aria-label={`Play ${version.originalFilename}`} /> : null}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${requestable ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-white/10 text-slate-400'}`}>{requestable ? 'In Library' : 'Private'}</span>
              {version.mimeType.startsWith('audio/') ? <button type="button" onClick={() => setRequestable(version.assetId, !requestable)} disabled={busy} className="rounded-lg border border-fuchsia-500/30 px-3 py-2 text-xs font-black text-fuchsia-100 disabled:opacity-50">{requestable ? 'Remove from requests' : 'Allow requests'}</button> : null}
            </div>
            <details className="mt-2"><summary className="cursor-pointer text-[10px] text-slate-500">File details and sharing</summary><p className="mt-2 break-all font-mono text-[10px] text-slate-500">{version.sha256}</p>
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
            {candidateUploadsEnabled && version.mimeType.startsWith('audio/') ? (
              <>
                <button
                  type="button"
                  onClick={() => requestCandidateRevision(version)}
                  disabled={busy || !selectedConnectionId}
                  className="ml-2 mt-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-[11px] font-black text-violet-100 disabled:opacity-50"
                >
                  Request private candidate
                </button>
                <p className="mt-2 text-[10px] leading-relaxed text-violet-200">
                  Request ceiling: {formatBytes(maxCandidateBytes)} (twice the source size with a 16 MiB minimum and 512 MiB maximum). Allows one private candidate for your review; it does not replace this file, become requestable, or enter a release.
                </p>
              </>
            ) : null}
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

      <CollaboratorInbox
        embedded
        refreshKey={collaborationRefreshKey}
        onConnectionsLoaded={handleConnectionsLoaded}
        onCollaborationStateChange={setCandidateUploadsEnabled}
      />

      {shareToken ? (
        <p className="mt-3 break-all rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 font-mono text-[11px] text-amber-100">
          {shareToken}
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="mt-3 min-h-4 text-xs text-slate-300">
        {status || ''}
      </p>
    </section>
  );
}
