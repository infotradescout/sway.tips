import { resolveSpotifyPlaylistId } from './spotify-playlist-reference';
import type { MusicFileImportStatus } from './music-file-import';

type ImportOptions = {
  playlistUrl: string;
  performerId?: string;
  previewMode: boolean;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onStatus: (status: MusicFileImportStatus) => void;
  onMessage: (message: string | null) => void;
  onSaved: () => Promise<boolean>;
  fetcher?: typeof fetch;
  confirm?: (message: string) => boolean;
};

/** One deliberate import gets one write. A missing receipt must never trigger a POST retry. */
export async function importSpotifyPlaylistFromBrowser(options: ImportOptions): Promise<boolean> {
  const current = () => options.isCurrent() && !options.signal.aborted;
  if (options.previewMode || !current()) return false;
  const status = (value: MusicFileImportStatus) => { if (current()) options.onStatus(value); };
  const message = (value: string | null) => { if (current()) options.onMessage(value); };
  const fetcher = options.fetcher ?? fetch;
  const confirm = options.confirm ?? (value => window.confirm(value));
  status('submitting'); message(null);
  let submitted = false;
  try {
    const playlistId = resolveSpotifyPlaylistId(options.playlistUrl);
    if (!playlistId) throw new Error('Enter a Spotify playlist URL, URI, or ID.');
    if (!options.performerId) throw new Error('Your performer account could not be confirmed. Refresh your account before importing.');
    const sourceKey = `spotify-${playlistId}`;
    const sourcesResponse = await fetcher('/api/talent/library/sources', {
      cache: 'no-store', signal: AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
    });
    const sourcesBody = await sourcesResponse.json().catch(() => null);
    if (!current()) return false;
    if (!sourcesResponse.ok || !Array.isArray(sourcesBody?.sources)
      || sourcesBody.performerId !== options.performerId
      || !sourcesBody.sources.every((source: any) => source && typeof source.sourceKey === 'string' && typeof source.sourceLabel === 'string')) {
      throw new Error('Sway could not check your saved sources. Nothing was imported. Try again.');
    }
    const existing = sourcesBody.sources.find((source: any) => source.sourceKey === sourceKey);
    if (existing && existing.syncKeyPreview !== 'spotify-import') {
      throw new Error('This playlist identity belongs to another source. Your saved source was not changed.');
    }
    if (existing && (typeof existing.id !== 'string' || !existing.id
      || typeof existing.updatedAt !== 'string' || !Number.isFinite(Date.parse(existing.updatedAt)))) {
      throw new Error('The saved playlist version could not be confirmed. Refresh Sources before importing.');
    }
    if (existing && !confirm(`Update “${existing.sourceLabel}” from Spotify? Its saved songs will be replaced only after Sway reads the complete playlist. Other sources will not change.`)) {
      status('idle'); message('Import canceled. Your saved sources were not changed.'); return false;
    }
    if (!current()) return false;
    submitted = true;
    const response = await fetcher('/api/talent/music/spotify/import-playlist', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]),
      body: JSON.stringify({
        playlistUrl: options.playlistUrl.trim(), performerId: options.performerId,
        expectedSource: existing ? { id: existing.id, updatedAt: existing.updatedAt } : null
      })
    });
    const data = await response.json().catch(() => null);
    if (!current()) return false;
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Spotify import could not be confirmed. Refresh Sources before retrying.');
    if (data?.success !== true || data.performerId !== options.performerId
      || data.sourceKey !== sourceKey || data.playlistId !== playlistId
      || !Number.isInteger(data.importedCount) || data.importedCount < 1 || data.importedCount > 1_000) {
      throw new Error('Sway could not confirm the saved import. Refresh Sources before retrying; do not assume the playlist was saved.');
    }
    let refreshed = false;
    try { refreshed = await options.onSaved(); } catch { /* Receipt still confirms the save. */ }
    if (!current()) return false;
    status('success');
    message(refreshed
      ? `Saved ${data.importedCount} Spotify metadata tracks. Audio stays in Spotify.`
      : `Saved ${data.importedCount} Spotify metadata tracks, but the page could not refresh. Reload Sources to check them.`);
    return true;
  } catch (error) {
    status('error');
    message(error instanceof Error && !['TimeoutError', 'AbortError'].includes(error.name)
      ? error.message
      : submitted ? 'The import could not be confirmed. Refresh Sources before retrying this playlist.'
        : 'Sway could not check your saved sources. Nothing was imported. Try again.');
    return false;
  }
}
