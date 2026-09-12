import { parseDjLibraryFile, type DjLibraryImportResult } from './dj-library-file-parser';

export type MusicFileImportStatus = 'idle' | 'submitting' | 'success' | 'error';
type Source = { sourceKey: string; sourceLabel: string; trackCount?: number; syncKeyPreview?: string };
export type MusicFileImportOptions = {
  input: HTMLInputElement;
  previewMode: boolean;
  performerId?: string;
  isCurrent?: () => boolean;
  onStatus: (status: MusicFileImportStatus) => void;
  onMessage: (message: string | null) => void;
  onSaved: () => Promise<void>;
  fetcher?: typeof fetch;
  confirm?: (message: string) => boolean;
};

/** File identity is per named export, not per format. Two CSVs must not replace one another. */
export async function identifyMusicFileImport(fileName: string, parsed: DjLibraryImportResult, chosenSource = '') {
  const name = fileName.split(/[\\/]/).pop()?.trim() || 'Song list';
  const source = chosenSource.trim() || parsed.sourceLabel;
  const identity = `${source.normalize('NFKC').toLowerCase()}\n${name.normalize('NFKC').toLowerCase()}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const seen = new Set<string>();
  const tracks = parsed.tracks.filter(track => {
    const id = track.externalTrackId || JSON.stringify([track.title, track.artist, track.album ?? '']);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    ...parsed,
    sourceKey: `file-${hash.slice(0, 48)}`,
    sourceLabel: `${source} · ${name.replace(/\.[^.]+$/, '')}`.slice(0, 80),
    tracks,
    duplicatesRemoved: parsed.tracks.length - tracks.length
  };
}

function confirmedSources(value: unknown): Source[] {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { sources?: unknown }).sources)) {
    throw new Error('Sway could not check your saved sources. Nothing was imported. Try again.');
  }
  const sources = (value as { sources: Source[] }).sources;
  if (!sources.every(source => source && typeof source.sourceKey === 'string' && typeof source.sourceLabel === 'string')) {
    throw new Error('Sway could not check your saved sources. Nothing was imported. Try again.');
  }
  return sources;
}

export async function importMusicFile(options: MusicFileImportOptions): Promise<void> {
  const { input, previewMode, onStatus, onMessage, onSaved } = options;
  const file = input.files?.[0];
  const current = options.isCurrent ?? (() => true);
  if (!file || previewMode || !current()) return;
  const fetcher = options.fetcher ?? fetch;
  const confirm = options.confirm ?? (message => window.confirm(message));
  const selectedSource = input.dataset?.swaySourceLabel || '';
  const status = (value: MusicFileImportStatus) => { if (current()) onStatus(value); };
  const message = (value: string | null) => { if (current()) onMessage(value); };
  status('submitting'); message(null);
  try {
    const parsed = await identifyMusicFileImport(file.name, await parseDjLibraryFile(file), selectedSource);
    if (!current()) return;
    if (!parsed.tracks.length) throw new Error('No valid songs were found. Nothing was imported.');
    // Read the actual current source list before offering replacement. Never
    // rely on a stale page's empty state to decide whether a write is destructive.
    const existingResponse = await fetcher('/api/talent/library/sources', { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const existingBody = await existingResponse.json().catch(() => null);
    if (!existingResponse.ok) throw new Error('Sway could not check your saved sources. Nothing was imported. Try again.');
    const existing = confirmedSources(existingBody).find(source => source.sourceKey === parsed.sourceKey);
    if (!current()) return;
    if (existing && existing.syncKeyPreview !== 'file-import') {
      throw new Error('This name belongs to a synced source. Rename this export before importing; the existing source was not changed.');
    }
    const action = existing
      ? `Replace the tracks in “${existing.sourceLabel}” with ${parsed.tracks.length} imported tracks? Other sources will not change.`
      : `Add ${parsed.tracks.length} tracks from “${parsed.sourceLabel}”? Your existing sources will not change.`;
    const preview = parsed.tracks.slice(0, 3).map(track => `${track.artist} — ${track.title}`).join('\n');
    const limit = parsed.truncated ? '\n\nThis file exceeds the import limit. Only the first 1,000 parsed tracks will be imported. Export smaller lists to include the rest.' : '';
    const duplicates = parsed.duplicatesRemoved ? `\n${parsed.duplicatesRemoved} duplicate rows were removed.` : '';
    if (!confirm(`${action}\n\n${preview}${duplicates}${limit}`)) {
      status('idle'); message('Import canceled. Your saved sources were not changed.'); return;
    }
    if (!current()) return;
    const response = await fetcher('/api/talent/library/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ sourceKey: parsed.sourceKey, sourceLabel: parsed.sourceLabel, tracks: parsed.tracks })
    });
    const data = await response.json().catch(() => null);
    if (!current()) return;
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Song-list import failed. Your other sources were not changed.');
    if (data?.success !== true || data?.sourceKey !== parsed.sourceKey
      || !Number.isInteger(data?.importedCount) || data.importedCount !== parsed.tracks.length
      || (options.performerId && data?.performerId !== options.performerId)) {
      throw new Error('Sway could not confirm the saved import. Refresh Sources before retrying; do not assume the tracks were saved.');
    }
    status('success');
    message(`${existing ? 'Updated' : 'Saved'} ${data.importedCount} tracks from ${parsed.sourceLabel}.${parsed.truncated ? ' Only the first 1,000 parsed tracks were imported.' : ''} Audio stays in your music app.`);
    try { await onSaved(); }
    catch { message(`Saved ${data.importedCount} tracks, but the page could not refresh. Reload Sources to check them.`); }
  } catch (error) {
    status('error');
    message(error instanceof Error && !['TimeoutError', 'AbortError'].includes(error.name)
      ? error.message
      : 'The import could not be confirmed. Refresh Sources, then retry this same export if needed.');
  } finally { input.value = ''; }
}
