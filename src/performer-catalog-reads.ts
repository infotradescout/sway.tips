export type CatalogProject = { id: string; title: string };
export type CatalogAsset = { id: string; title: string; metadata?: { requestable?: boolean } | null };
export type CatalogVersion = {
  id: string; assetId: string; versionNumber: number; originalFilename: string;
  byteSize: number; sha256: string; mimeType: string;
};
export type CatalogStorageUsage = {
  workspaceLimitBytes: number; workingBytes: number; sealedWorkingBytes: number;
  reservedBytes: number; releaseProtectedBytes: number; availableWorkspaceBytes: number;
  workingObjectCount: number; workingObjectLimit: number; releaseCountLimit: null;
};
type ReadState = 'idle' | 'loading' | 'ready' | 'error';
type Channel = 'projects' | 'files' | 'storage';
export type CatalogSnapshot = {
  projects: CatalogProject[]; projectId: string; assets: CatalogAsset[]; versions: CatalogVersion[];
  storageUsage: CatalogStorageUsage | null; accessDenied: boolean;
  projectsState: ReadState; filesState: ReadState; storageState: ReadState;
  projectsError: string | null; filesError: string | null; storageError: string | null;
};
const empty = (): CatalogSnapshot => ({
  projects: [], projectId: '', assets: [], versions: [], storageUsage: null, accessDenied: false,
  projectsState: 'idle', filesState: 'idle', storageState: 'idle',
  projectsError: null, filesError: null, storageError: null
});
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function invalid(): never { throw new Error('Catalog returned an incomplete response. Try refreshing.'); }
export function parseCatalogProject(value: unknown): CatalogProject {
  if (!record(value) || !text(value.id) || !text(value.title)) invalid();
  return { id: value.id, title: value.title };
}
function unique<T extends { id: string }>(rows: T[]): T[] {
  if (new Set(rows.map(row => row.id)).size !== rows.length) invalid();
  return rows;
}
export function parseCatalogProjects(value: unknown): CatalogProject[] {
  if (!record(value) || !Array.isArray(value.projects)) invalid();
  return unique(value.projects.map(parseCatalogProject));
}
export function parseCatalogFiles(value: unknown): { assets: CatalogAsset[]; versions: CatalogVersion[] } {
  if (!record(value) || !Array.isArray(value.assets) || !Array.isArray(value.versions)) invalid();
  const assets = unique(value.assets.map((asset): CatalogAsset => {
    if (!record(asset) || !text(asset.id) || !text(asset.title)) invalid();
    if (asset.metadata != null && !record(asset.metadata)) invalid();
    if (record(asset.metadata) && asset.metadata.requestable != null && typeof asset.metadata.requestable !== 'boolean') invalid();
    return asset as CatalogAsset;
  }));
  const ids = new Set(assets.map(asset => asset.id));
  const versions = unique(value.versions.map((version): CatalogVersion => {
    if (!record(version) || !text(version.id) || !text(version.assetId) || !ids.has(version.assetId)
      || !text(version.originalFilename) || !text(version.mimeType) || !text(version.sha256)
      || !/^[a-f\d]{64}$/i.test(version.sha256) || !count(version.byteSize)
      || !count(version.versionNumber) || version.versionNumber < 1) invalid();
    return version as CatalogVersion;
  }));
  return { assets, versions };
}
export function parseCatalogStorage(value: unknown): CatalogStorageUsage {
  if (!record(value) || !record(value.storageUsage)) invalid();
  const usage = value.storageUsage;
  for (const key of ['workspaceLimitBytes', 'workingBytes', 'sealedWorkingBytes', 'reservedBytes',
    'releaseProtectedBytes', 'availableWorkspaceBytes', 'workingObjectCount', 'workingObjectLimit']) {
    if (!count(usage[key])) invalid();
  }
  if (Number(usage.workspaceLimitBytes) < 1 || Number(usage.workingObjectLimit) < 1 || usage.releaseCountLimit !== null) invalid();
  return usage as CatalogStorageUsage;
}
class CatalogAccessError extends Error {}

// Read deadlines include response bodies. Cancellation also settles mocked or
// stalled transports that ignore AbortSignal. This helper never submits a write.
export async function readCatalogJson(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch, deadlineMs = 15_000): Promise<unknown> {
  if (signal.aborted) throw new Error('Catalog read cancelled.');
  const transport = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const boundary = new Promise<never>((_, reject) => {
    cancel = () => { transport.abort(); reject(new Error('Catalog read cancelled.')); };
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { transport.abort(); reject(new Error('Catalog took too long to respond. Try refreshing.')); }, deadlineMs);
  });
  try {
    return await Promise.race([boundary, (async () => {
      const response = await fetcher(url, { cache: 'no-store', signal: transport.signal });
      if (response.status === 401 || response.status === 403) throw new CatalogAccessError('Your access changed. Reload Catalog to continue.');
      if (!response.ok) throw new Error('Catalog could not refresh. Your last confirmed files have not been changed.');
      try { return await response.json(); } catch { invalid(); }
    })()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

export function createCatalogReader(fetcher: typeof fetch = fetch, deadlineMs = 15_000) {
  let snapshot = empty();
  let active = false;
  let explicitSelection = false;
  const listeners = new Set<() => void>();
  const requests: Record<Channel, AbortController | null> = { projects: null, files: null, storage: null };
  const publish = (patch: Partial<CatalogSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  };
  const cancel = (channel: Channel) => { requests[channel]?.abort(); requests[channel] = null; };
  const cancelAll = () => { cancel('projects'); cancel('files'); cancel('storage'); };
  const begin = (channel: Channel) => {
    cancel(channel);
    const controller = new AbortController();
    requests[channel] = controller;
    return controller;
  };
  const current = (channel: Channel, controller: AbortController) => active && !controller.signal.aborted && requests[channel] === controller;
  const revoke = () => {
    cancelAll();
    explicitSelection = false;
    snapshot = { ...empty(), accessDenied: true };
    listeners.forEach(listener => listener());
  };
  const fail = (channel: Channel, controller: AbortController, error: unknown) => {
    if (!current(channel, controller)) return;
    if (error instanceof CatalogAccessError) { revoke(); return; }
    publish({ [`${channel}State`]: 'error', [`${channel}Error`]: error instanceof Error ? error.message : 'Catalog could not refresh.' });
  };
  async function refreshAssets(projectId: string) {
    if (!active || snapshot.accessDenied || !projectId || snapshot.projectId !== projectId) return false;
    const controller = begin('files');
    publish({ filesState: 'loading', filesError: null });
    try {
      const files = parseCatalogFiles(await readCatalogJson(`/api/talent/audio/projects/${encodeURIComponent(projectId)}/assets`, controller.signal, fetcher, deadlineMs));
      if (!current('files', controller) || snapshot.projectId !== projectId) return false;
      publish({ ...files, filesState: 'ready', filesError: null });
      return true;
    } catch (error) { fail('files', controller, error); return false; }
  }
  function selectProject(projectId: string, explicit = true) {
    if (!active || snapshot.accessDenied) return;
    if (projectId && !snapshot.projects.some(project => project.id === projectId)) return;
    if (explicit) explicitSelection = true;
    const changed = projectId !== snapshot.projectId;
    cancel('files');
    publish({ projectId, ...(changed || !projectId ? { assets: [], versions: [] } : {}),
      filesState: projectId ? 'loading' : 'ready', filesError: null });
    if (projectId) void refreshAssets(projectId);
  }
  async function refreshProjects() {
    if (!active || snapshot.accessDenied) return false;
    const controller = begin('projects');
    publish({ projectsState: 'loading', projectsError: null });
    try {
      const projects = parseCatalogProjects(await readCatalogJson('/api/talent/audio/projects', controller.signal, fetcher, deadlineMs));
      if (!current('projects', controller)) return false;
      const projectId = projects.some(project => project.id === snapshot.projectId) ? snapshot.projectId
        : explicitSelection && !snapshot.projectId ? '' : projects[0]?.id || '';
      publish({ projects, projectsState: 'ready', projectsError: null });
      selectProject(projectId, false);
      return true;
    } catch (error) { fail('projects', controller, error); return false; }
  }
  async function refreshStorageUsage() {
    if (!active || snapshot.accessDenied) return null;
    const controller = begin('storage');
    publish({ storageState: 'loading', storageError: null });
    try {
      const storageUsage = parseCatalogStorage(await readCatalogJson('/api/talent/audio/storage-usage', controller.signal, fetcher, deadlineMs));
      if (!current('storage', controller)) return null;
      publish({ storageUsage, storageState: 'ready', storageError: null });
      return storageUsage;
    } catch (error) { fail('storage', controller, error); return null; }
  }
  async function refreshAll() {
    if (!active) return;
    if (snapshot.accessDenied) { snapshot = empty(); listeners.forEach(listener => listener()); }
    await Promise.all([refreshProjects(), refreshStorageUsage()]);
  }
  function acceptProject(value: unknown) {
    const project = parseCatalogProject(value);
    if (!active || snapshot.accessDenied) throw new Error('Catalog is no longer active.');
    // An older list must not erase a project the server just confirmed creating.
    cancel('projects');
    publish({ projects: [...snapshot.projects.filter(row => row.id !== project.id), project], projectsState: 'ready', projectsError: null });
    selectProject(project.id);
    return project.id;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: () => { active = true; void refreshAll(); },
    stop: () => { active = false; cancelAll(); },
    isActive: () => active && !snapshot.accessDenied,
    refreshAll, refreshProjects, refreshAssets, refreshStorageUsage, selectProject, acceptProject, revoke
  };
}
