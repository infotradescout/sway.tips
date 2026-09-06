import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, Upload } from 'lucide-react';
import CollaboratorInbox, { type FileConnection } from './CollaboratorInbox';
import { usePerformerCatalog } from '../use-performer-catalog';
import { CatalogActionUnconfirmedError, requestCatalogAction } from '../catalog-action-request';

async function sha256Hex(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
}
function chunkFile(file: File, partSize: number) {
  const parts: Blob[] = [];
  for (let offset = 0; offset < file.size; offset += partSize) parts.push(file.slice(offset, Math.min(offset + partSize, file.size)));
  return parts;
}
function inferAssetKind(file: File) {
  if (file.type.startsWith('image/')) return 'artwork';
  if (file.type === 'application/pdf' || file.type.startsWith('text/')) return 'document';
  if (file.type.startsWith('video/')) return 'video';
  return 'master_audio';
}
function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unit)).toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}
const PAGE_SIZE = 30;
type Action = { active: boolean; controller: AbortController };

export default function PerformerAudioFiles() {
  const catalog = usePerformerCatalog();
  const { reader, projects, projectId: selectedProjectId, assets, versions, storageUsage } = catalog;
  const [title, setTitle] = useState('Masters');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionRef = useRef<Action | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const refreshRequiredRef = useRef(false);
  const recoveryReadRequested = useRef(false);
  const [shareToken, setShareToken] = useState<string | null>(null);
  const [connections, setConnections] = useState<FileConnection[]>([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [collaborationRefreshKey, setCollaborationRefreshKey] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const filesHeading = useRef<HTMLHeadingElement>(null);
  const assetById = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return versions.filter(version => !query || `${version.originalFilename} ${assetById.get(version.assetId)?.title || ''}`.toLocaleLowerCase().includes(query));
  }, [versions, assetById, search]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visibleVersions = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const projectsReady = !catalog.accessDenied && !refreshRequired && catalog.projectsState === 'ready';
  const filesReady = projectsReady && catalog.filesState === 'ready';
  const uploadReady = filesReady && catalog.storageState === 'ready';
  const loading = [catalog.projectsState, catalog.filesState, catalog.storageState].includes('loading');
  const readErrors = [catalog.projectsError, catalog.filesError, catalog.storageError].filter(Boolean);

  useEffect(() => () => {
    if (actionRef.current) {
      actionRef.current.active = false;
      actionRef.current.controller.abort();
    }
  }, []);
  useEffect(() => {
    setSearch(''); setPage(0); setShareToken(null);
  }, [selectedProjectId]);
  useEffect(() => {
    if (!catalog.accessDenied) return;
    if (actionRef.current) {
      actionRef.current.active = false;
      actionRef.current.controller.abort();
    }
    actionRef.current = null;
    refreshRequiredRef.current = false; recoveryReadRequested.current = false;
    setRefreshRequired(false);
    setBusy(false); setShareToken(null); setStatus(null);
    setConnections([]); setSelectedConnectionId(''); setTitle('Masters'); setSearch(''); setPage(0);
  }, [catalog.accessDenied]);
  useEffect(() => {
    // Only an explicit read-only refresh can unlock an unconfirmed action.
    // refreshAll returns before selected-project files finish; observe all reads.
    if (!refreshRequired || !recoveryReadRequested.current || catalog.accessDenied
      || catalog.projectsState !== 'ready' || catalog.filesState !== 'ready' || catalog.storageState !== 'ready') return;
    refreshRequiredRef.current = false; recoveryReadRequested.current = false;
    setRefreshRequired(false);
    setStatus('Catalog refreshed. Check your files and projects before repeating the previous action. Nothing was repeated automatically.');
  }, [refreshRequired, catalog.accessDenied, catalog.projectsState, catalog.filesState, catalog.storageState]);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const requireRefresh = () => {
    refreshRequiredRef.current = true; recoveryReadRequested.current = false;
    setRefreshRequired(true);
  };
  const refreshCatalog = () => {
    if (actionRef.current) return;
    recoveryReadRequested.current = refreshRequiredRef.current;
    void reader.refreshAll();
  };
  const stopWaiting = () => {
    const action = actionRef.current;
    if (!action) return;
    action.active = false;
    action.controller.abort();
    actionRef.current = null;
    requireRefresh(); setBusy(false); setShareToken(null);
    setStatus('Stopped waiting. The action may already have completed. Refresh Catalog to check before trying again.');
  };
  const ensureActive = (action: Action) => {
    if (!action.active || action.controller.signal.aborted || actionRef.current !== action || !reader.isActive()) throw new Error('Catalog changed before the action finished. Reload it to check the result.');
  };
  const sendAction = async (url: string, init: RequestInit, fallback: string, action: Action) => {
    ensureActive(action);
    const data = await requestCatalogAction(url, init, action.controller.signal, fallback, {
      onAccessDenied: () => { ensureActive(action); reader.revoke(); }
    });
    ensureActive(action);
    return data;
  };
  const runAction = async (kind: 'project' | 'file' | 'upload', operation: (action: Action) => Promise<void>) => {
    const snapshot = reader.getSnapshot();
    if (actionRef.current || refreshRequiredRef.current || !reader.isActive() || snapshot.projectsState !== 'ready'
      || (kind !== 'project' && snapshot.filesState !== 'ready')
      || (kind === 'upload' && snapshot.storageState !== 'ready')) return;
    const action: Action = { active: true, controller: new AbortController() };
    actionRef.current = action;
    setBusy(true); setStatus(null); setShareToken(null);
    try { await operation(action); }
    catch (error) {
      if (action.active && reader.isActive()) {
        if (error instanceof CatalogActionUnconfirmedError) requireRefresh();
        setStatus(error instanceof Error ? error.message : 'Catalog action failed.');
      }
    } finally {
      if (actionRef.current === action) {
        actionRef.current = null;
        if (action.active) setBusy(false);
      }
      action.active = false;
      action.controller.abort();
    }
  };
  const createProject = () => runAction('project', async action => {
    const nextTitle = title.trim();
    if (!nextTitle) throw new Error('Enter a project title.');
    const data = await sendAction('/api/talent/audio/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: nextTitle })
    }, 'Could not create project.', action);
    try { reader.acceptProject(data.project); }
    catch { throw new CatalogActionUnconfirmedError(); }
    setStatus('Project created.');
  });
  const uploadFile = (file: File | null) => {
    if (!file) return;
    return runAction('upload', async action => {
      const usage = reader.getSnapshot().storageUsage;
      if (!usage) throw new Error('Refresh storage before uploading.');
      if (file.size > usage.availableWorkspaceBytes) throw new Error(`This file needs ${formatBytes(file.size)}, but ${formatBytes(usage.availableWorkspaceBytes)} remains in your release workspace.`);
      if (usage.workingObjectCount >= usage.workingObjectLimit) throw new Error('Your working-file safeguard is full. Finish a release or contact support for retained-file review.');
      if (file.size === 0) throw new Error('Choose a file that is not empty.');
      let projectId = selectedProjectId;
      if (!projectId) {
        setStatus('Preparing your Catalog…');
        const data = await sendAction('/api/talent/audio/projects', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'My Catalog' })
        }, 'Could not prepare your Catalog.', action);
        try { projectId = reader.acceptProject(data.project); }
        catch { throw new CatalogActionUnconfirmedError(); }
      }
      setStatus(`Preparing ${file.name}…`);
      const expectedSha256 = await sha256Hex(file);
      ensureActive(action);
      const partSize = 5 * 1024 * 1024;
      const startData = await sendAction(`/api/talent/audio/projects/${encodeURIComponent(projectId)}/uploads`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: file.name, assetKind: inferAssetKind(file), originalFilename: file.name,
          mimeType: file.type || 'application/octet-stream', expectedByteSize: file.size, expectedSha256,
          idempotencyKey: `upload:${projectId}:${expectedSha256}:${file.size}`, partSizeBytes: partSize })
      }, 'Could not start upload.', action);
      if (typeof startData.uploadSession?.id !== 'string' || !startData.uploadSession.id) throw new CatalogActionUnconfirmedError('Upload was not confirmed. Refresh Catalog before trying again.');
      const uploadId = encodeURIComponent(startData.uploadSession.id);
      const parts = chunkFile(file, partSize);
      for (let index = 0; index < parts.length; index += 1) {
        ensureActive(action);
        setStatus(`Uploading part ${index + 1}/${parts.length}…`);
        await sendAction(`/api/talent/audio/uploads/${uploadId}/parts/${index + 1}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: parts[index]
        }, `Part ${index + 1} failed.`, action);
      }
      ensureActive(action);
      setStatus('Saving your original file…');
      const data = await sendAction(`/api/talent/audio/uploads/${uploadId}/complete`, { method: 'POST' }, 'Could not finish upload.', action);
      if (!Number.isInteger(data.version?.versionNumber)) throw new CatalogActionUnconfirmedError('The upload result could not be confirmed. Refresh Catalog before uploading again.');
      const [filesLoaded, usageLoaded] = await Promise.all([reader.refreshAssets(projectId), reader.refreshStorageUsage()]);
      ensureActive(action);
      setStatus(`File saved · version ${data.version.versionNumber}.${filesLoaded && usageLoaded ? '' : ' The file list or storage could not refresh. Use Refresh Catalog; do not upload it again.'}`);
    });
  };
  const setRequestable = (assetId: string, requestable: boolean) => runAction('file', async action => {
    if (!reader.getSnapshot().assets.some(asset => asset.id === assetId)) return;
    const projectId = reader.getSnapshot().projectId;
    await sendAction(`/api/talent/audio/assets/${encodeURIComponent(assetId)}/requestable`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestable })
    }, 'Could not update request availability.', action);
    const refreshed = await reader.refreshAssets(projectId);
    ensureActive(action);
    setStatus(`${requestable ? 'This track is now available in Library.' : 'This track is private to Catalog.'}${refreshed ? '' : ' The list could not refresh. Use Refresh Catalog to check it.'}`);
  });
  const createShare = (versionId: string) => runAction('file', async action => {
    if (!reader.getSnapshot().versions.some(version => version.id === versionId)) return;
    const data = await sendAction(`/api/talent/audio/versions/${encodeURIComponent(versionId)}/shares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxUses: 1 })
    }, 'Could not create share.', action);
    if (typeof data.shareToken !== 'string' || !data.shareToken) throw new CatalogActionUnconfirmedError('The share result could not be confirmed. Refresh before trying again.');
    setShareToken(data.shareToken);
    setStatus('One-time share created. Copy the code below now; it is shown once.');
  });
  const shareWithConnection = (versionId: string) => runAction('file', async action => {
    if (!reader.getSnapshot().versions.some(version => version.id === versionId)) return;
    if (!connections.some(connection => connection.connectionId === selectedConnectionId)) throw new Error('Pair with another account before sharing a selected file.');
    const data = await sendAction(`/api/talent/audio/pairing/connections/${encodeURIComponent(selectedConnectionId)}/shares`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId, canDownloadOriginal: true, canComment: true, canApprove: true })
    }, 'Could not share selected file.', action);
    setCollaborationRefreshKey(current => current + 1);
    setStatus(data.reused ? 'This version is already shared with that connection.' : 'Selected version shared for download, review, and approval.');
  });
  const handleConnectionsLoaded = useCallback((next: FileConnection[]) => {
    if (!reader.isActive()) return;
    setConnections(next);
    setSelectedConnectionId(current => next.some(connection => connection.connectionId === current) ? current : next[0]?.connectionId || '');
  }, [reader]);
  const changePage = (next: number) => { setPage(next); filesHeading.current?.focus(); };

  return (
    <section className="min-w-0 rounded-2xl border border-cyan-500/20 bg-slate-950 p-4 sm:col-span-2" aria-label="Your Catalog">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Your Catalog</p>
          <p className="mt-1 text-xs text-slate-400">Keep masters, artwork, and rights documents together. Files stay private unless you explicitly share them or allow an audio master for requests.</p>
        </div>
        <button type="button" onClick={refreshCatalog} disabled={busy || loading} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 px-3 text-xs font-bold text-white disabled:opacity-50">
          <RefreshCw className="h-4 w-4" aria-hidden="true" />{catalog.accessDenied ? 'Reload Catalog' : 'Refresh Catalog'}
        </button>
        {busy ? <button type="button" onClick={stopWaiting} className="min-h-11 rounded-xl border border-amber-500/30 px-3 text-xs font-bold text-amber-100">Stop waiting</button> : null}
        {busy || loading ? <Loader2 className="h-4 w-4 animate-spin text-cyan-300" aria-label="Catalog loading" /> : null}
      </div>
      {refreshRequired && !catalog.accessDenied ? <p role="alert" className="mt-3 rounded-xl border border-amber-500/30 p-3 text-sm text-amber-100">The previous action is unconfirmed. Refresh Catalog before creating, uploading, or sharing again. Stopping the wait does not undo saved work.</p> : null}
      {catalog.accessDenied ? <p role="alert" className="mt-3 rounded-xl border border-amber-500/30 p-3 text-sm text-amber-100">Your access changed. Private Catalog files have been cleared. Reload Catalog to continue.</p> : null}
      {readErrors.length ? <div role="alert" className="mt-3 rounded-xl border border-amber-500/30 p-3 text-xs text-amber-100">
        {readErrors.map((error, index) => <p key={index}>{error}</p>)}
        <p className="mt-1">Refresh Catalog only reloads information. It does not upload, create, or share anything.</p>
      </div> : null}
      {status ? <p role="status" className="mt-3 break-words text-sm text-slate-200">{status}</p> : null}
      {shareToken ? <p className="mt-3 break-all rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 font-mono text-[11px] text-amber-100">{shareToken}</p> : null}
      {storageUsage && !catalog.accessDenied ? <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="font-black text-cyan-100">Release workspace</span><span className="font-bold text-slate-300">{formatBytes(storageUsage.workingBytes)} of {formatBytes(storageUsage.workspaceLimitBytes)} working storage</span></div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800" aria-hidden="true"><div className="h-full rounded-full bg-cyan-400 transition-[width]" style={{ width: `${Math.min(100, storageUsage.workingBytes / storageUsage.workspaceLimitBytes * 100)}%` }} /></div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">Release count is unlimited. Draft files and active uploads use this working pool. Only the exact file versions in an immutable, validated release-package manifest leave the pool; changing a release or delivery status is not enough. Sway preserves sealed originals and does not silently delete them to make room.</p>
        <p className="mt-1 text-[10px] text-slate-500">{storageUsage.workingObjectCount.toLocaleString()} of {storageUsage.workingObjectLimit.toLocaleString()} working-file records. This safeguard limits storage abuse, not releases.</p>
        {storageUsage.releaseProtectedBytes > 0 ? <p className="mt-1 text-[10px] font-bold text-emerald-300">{formatBytes(storageUsage.releaseProtectedBytes)} preserved in validated release-package manifests outside the working pool.</p> : null}
        {catalog.storageState !== 'ready' ? <p className="mt-2 text-xs text-amber-100">Storage is not confirmed. Uploads are paused until it refreshes.</p> : null}
      </div> : null}
      <label className="relative mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white focus-within:ring-2 focus-within:ring-fuchsia-300">
        <Upload className="h-4 w-4" aria-hidden="true" />Add Catalog file
        <input type="file" accept="audio/*,image/*,application/pdf,text/plain" aria-label="Add audio to Catalog" className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          disabled={busy || !uploadReady || storageUsage?.availableWorkspaceBytes === 0 || (storageUsage != null && storageUsage.workingObjectCount >= storageUsage.workingObjectLimit)}
          onChange={event => { const file = event.target.files?.[0] ?? null; event.target.value = ''; void uploadFile(file); }} />
      </label>
      {!uploadReady && !catalog.accessDenied ? <p className="mt-2 text-xs text-slate-400">Uploads become available when your projects, files, and storage are confirmed.</p> : null}
      <details className="mt-3 rounded-xl border border-white/10 bg-slate-900 p-3">
        <summary className="cursor-pointer list-none text-xs font-bold text-slate-400">Organize projects</summary>
        <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
          <label className="min-w-0 text-xs text-slate-300">Selected project
            <select aria-label="Selected project" value={selectedProjectId} disabled={busy || !projectsReady} onChange={event => { setStatus(null); reader.selectProject(event.target.value); }} className="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm font-bold text-white disabled:opacity-50">
              <option value="">My Catalog (new project)</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
            </select>
          </label>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <label className="min-w-0 text-xs text-slate-300">Project title<input aria-label="Project title" value={title} disabled={busy || !projectsReady} onChange={event => setTitle(event.target.value)} className="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm font-bold text-white" placeholder="Project title" /></label>
            <button type="button" onClick={createProject} disabled={busy || !projectsReady || !title.trim()} className="min-h-11 rounded-xl border border-fuchsia-500/30 px-3 text-xs font-black text-fuchsia-100 disabled:opacity-50">Create</button>
          </div>
        </div>
      </details>
      <div className="mt-4 min-w-0 space-y-3">
        <h2 ref={filesHeading} tabIndex={-1} className="text-sm font-bold text-white">Catalog files</h2>
        <label className="block text-xs text-slate-300">Search Catalog files<input aria-label="Search Catalog files" type="search" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} disabled={catalog.accessDenied} className="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-slate-900 px-3 text-sm text-white" /></label>
        {catalog.filesState === 'loading' ? <p role="status" className="text-xs text-slate-300">Loading selected project files…</p> : null}
        {versions.length > 0 && !filesReady ? <p className="text-xs text-amber-100">These are the last confirmed files for this project. Sharing and request changes are paused until it refreshes.</p> : null}
        {filesReady && versions.length === 0 ? <p className="text-xs text-slate-500">No saved files in this project yet.</p> : null}
        {versions.length > 0 && filtered.length === 0 ? <p className="text-xs text-slate-300">No files match your search.</p> : null}
        {filtered.length > 0 ? <p className="text-xs text-slate-400" aria-live="polite">Showing {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length} files</p> : null}
        {visibleVersions.map(version => {
          const requestable = assetById.get(version.assetId)?.metadata?.requestable === true;
          return <article key={version.id} aria-label={version.originalFilename} className="min-w-0 rounded-xl border border-white/10 bg-slate-900 px-3 py-3">
            <p className="break-words text-sm font-bold text-white" style={{ overflowWrap: 'anywhere' }}>{version.originalFilename} · v{version.versionNumber}</p>
            {version.mimeType.startsWith('audio/') ? <audio controls preload="none" src={`/api/talent/audio/versions/${encodeURIComponent(version.id)}/content`} className="mt-3 w-full min-w-0" aria-label={`Play ${version.originalFilename}`} /> : null}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${requestable ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-white/10 text-slate-400'}`}>{requestable ? 'In Library' : 'Private'}</span>
              {version.mimeType.startsWith('audio/') ? <button type="button" onClick={() => setRequestable(version.assetId, !requestable)} disabled={busy || !filesReady} className="rounded-lg border border-fuchsia-500/30 px-3 py-2 text-xs font-black text-fuchsia-100 disabled:opacity-50">{requestable ? 'Remove from requests' : 'Allow requests'}</button> : null}
            </div>
            <details className="mt-2"><summary className="cursor-pointer text-[10px] text-slate-500">File details and sharing</summary>
              <p className="mt-2 break-all font-mono text-[10px] text-slate-500">{version.sha256}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => createShare(version.id)} disabled={busy || !filesReady} className="min-h-11 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-black text-cyan-100 disabled:opacity-50">Create one-time link</button>
                <button type="button" onClick={() => shareWithConnection(version.id)} disabled={busy || !filesReady || !selectedConnectionId} className="min-h-11 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-1.5 text-[11px] font-black text-fuchsia-100 disabled:opacity-50">Share with connection</button>
              </div>
            </details>
          </article>;
        })}
        {pages > 1 ? <nav aria-label="Catalog file pages" className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)} className="min-h-11 rounded-xl border border-white/10 px-3 text-sm text-white disabled:opacity-50">Previous files</button>
          <span className="text-xs text-slate-300">Page {currentPage + 1} of {pages}</span>
          <button type="button" disabled={currentPage + 1 >= pages} onClick={() => changePage(currentPage + 1)} className="min-h-11 rounded-xl border border-white/10 px-3 text-sm text-white disabled:opacity-50">Next files</button>
        </nav> : null}
      </div>
      {!catalog.accessDenied ? <>
        <div className="mt-5 rounded-xl border border-white/10 bg-slate-900 p-3">
          <label className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400" htmlFor="sway-file-connection">Selected connection</label>
          <select id="sway-file-connection" value={selectedConnectionId} disabled={busy} onChange={event => setSelectedConnectionId(event.target.value)} className="mt-2 min-h-11 w-full min-w-0 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm font-bold text-white">
            <option value="">Pair an account first</option>{connections.map(connection => <option key={connection.connectionId} value={connection.connectionId}>{connection.counterparty?.displayName || 'Connected account'}{connection.counterparty?.handle ? ` @${connection.counterparty.handle}` : ''}</option>)}
          </select>
        </div>
        <CollaboratorInbox embedded refreshKey={collaborationRefreshKey} onConnectionsLoaded={handleConnectionsLoaded} />
      </> : null}
    </section>
  );
}
