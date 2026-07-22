import { useMemo, useState } from 'react';
import { FolderOpen, Loader2, Upload } from 'lucide-react';

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

type Project = { id: string; title: string };
type Version = {
  id: string;
  assetId: string;
  versionNumber: number;
  originalFilename: string;
  byteSize: number;
  sha256: string;
};

export default function PerformerAudioFiles() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [title, setTitle] = useState('Masters');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shareToken, setShareToken] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const refreshProjects = async () => {
    const response = await fetch('/api/talent/audio/projects', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Could not load projects.');
    setProjects(data.projects || []);
    if (!selectedProjectId && data.projects?.[0]?.id) setSelectedProjectId(data.projects[0].id);
  };

  const refreshAssets = async (projectId: string) => {
    const response = await fetch(`/api/talent/audio/projects/${projectId}/assets`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Could not load assets.');
    setVersions(data.versions || []);
  };

  const openPanel = async () => {
    setOpen(true);
    setStatus(null);
    setBusy(true);
    try {
      await refreshProjects();
      setStatus(null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Audio files unavailable.');
    } finally {
      setBusy(false);
    }
  };

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
    if (!file || !selectedProjectId) return;
    setBusy(true);
    setStatus(`Hashing ${file.name}…`);
    setShareToken(null);
    try {
      const expectedSha256 = await sha256Hex(file);
      const partSize = 5 * 1024 * 1024;
      const start = await fetch(`/api/talent/audio/projects/${selectedProjectId}/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: file.name,
          assetKind: 'master_audio',
          originalFilename: file.name,
          mimeType: file.type || 'application/octet-stream',
          expectedByteSize: file.size,
          expectedSha256,
          idempotencyKey: `upload:${selectedProjectId}:${expectedSha256}:${file.size}`,
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

      setStatus('Sealing immutable original…');
      const complete = await fetch(`/api/talent/audio/uploads/${startData.uploadSession.id}/complete`, {
        method: 'POST'
      });
      const completeData = await complete.json().catch(() => ({}));
      if (!complete.ok) throw new Error(completeData?.error || 'Could not seal upload.');
      await refreshAssets(selectedProjectId);
      setStatus(`Sealed v${completeData.version.versionNumber} · ${completeData.version.sha256.slice(0, 12)}…`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Upload failed.');
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
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Files &amp; projects</p>
          <p className="mt-1 text-xs text-slate-400">Immutable originals with SHA-256 seal. Private pairing is available; music distribution is not yet live.</p>
        </div>
        {busy ? <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> : null}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="min-h-11 rounded-xl border border-white/10 bg-slate-900 px-3 text-sm font-bold text-white"
          placeholder="Project title"
        />
        <button type="button" onClick={createProject} disabled={busy} className="min-h-11 rounded-xl bg-fuchsia-600 px-4 text-xs font-black text-white disabled:opacity-50">
          Create project
        </button>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <select
          value={selectedProjectId}
          onChange={async (event) => {
            setSelectedProjectId(event.target.value);
            if (event.target.value) {
              setBusy(true);
              try {
                await refreshAssets(event.target.value);
              } catch (error) {
                setStatus(error instanceof Error ? error.message : 'Could not load assets.');
              } finally {
                setBusy(false);
              }
            }
          }}
          className="min-h-11 rounded-xl border border-white/10 bg-slate-900 px-3 text-sm font-bold text-white"
        >
          <option value="">Select project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.title}</option>
          ))}
        </select>
        <label className={`relative inline-flex min-h-11 items-center justify-center gap-2 overflow-hidden rounded-xl border border-white/10 bg-slate-900 px-4 text-xs font-black text-white focus-within:border-cyan-300 focus-within:ring-2 focus-within:ring-cyan-400/40 ${selectedProject ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
          <Upload className="h-4 w-4" />
          Upload master
          <input
            type="file"
            aria-label="Upload master audio"
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            disabled={!selectedProject || busy}
            onChange={(event) => uploadFile(event.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      <div className="mt-4 space-y-2">
        {versions.length === 0 ? (
          <p className="text-xs text-slate-500">No sealed versions yet.</p>
        ) : versions.map((version) => (
          <div key={version.id} className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2">
            <p className="truncate text-sm font-bold text-white">{version.originalFilename} · v{version.versionNumber}</p>
            <p className="mt-1 font-mono text-[10px] text-slate-400">{version.sha256}</p>
            <button
              type="button"
              onClick={() => createShare(version.id)}
              disabled={busy}
              className="mt-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-black text-cyan-100"
            >
              Create share token
            </button>
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
