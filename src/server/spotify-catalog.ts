import { searchCatalog as readSpotifyCatalog } from './spotify-catalog-provider';
import type { CatalogTrack } from './spotify-catalog-provider';

export {
  importSpotifyPlaylist,
  isCatalogSearchConfigured,
  resolveSpotifyPlaylistId,
  searchCatalog as searchSpotifyCatalog
} from './spotify-catalog-provider';
export type {
  CatalogTrack,
  SpotifyPlaylistImportTrack,
  SpotifyCatalogStatus,
  SpotifyCatalogOutcome,
  SpotifyPlaylistImportResult,
  SpotifyCatalogSearchResult
} from './spotify-catalog-provider';

/**
 * Compatibility boundary for the existing server.ts search caller. That caller
 * uses `configured` as an availability/fallback switch and does not yet handle
 * a typed provider failure. Do not turn a failed provider request into a 200
 * empty open-catalog result. Keep the library fallback until the HTTP caller
 * adopts searchSpotifyCatalog's explicit status and retry information.
 *
 * Actual credential configuration remains isCatalogSearchConfigured(env), and
 * the typed provider reader always preserves that separate configuration truth.
 */
export async function searchCatalog(input: Parameters<typeof readSpotifyCatalog>[0]): Promise<{
  configured: boolean;
  results: CatalogTrack[];
}> {
  const result = await readSpotifyCatalog(input);
  return {
    configured: result.configured && result.status === 'ready',
    results: result.status === 'ready' ? result.results : []
  };
}
