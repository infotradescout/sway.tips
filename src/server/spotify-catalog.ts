import { createHash } from 'node:crypto';
import { resolveSpotifyPlaylistId } from '../spotify-playlist-reference';

export { resolveSpotifyPlaylistId } from '../spotify-playlist-reference';

type CatalogEnv = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;

export type CatalogTrack = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  albumArt: string | null;
  spotifyUri: string;
  spotifyUrl: string;
};

export type SpotifyPlaylistImportTrack = CatalogTrack & { externalTrackId: string };
export type SpotifyCatalogStatus = 'ready' | 'not_configured' | 'invalid_playlist'
  | 'authentication_failed' | 'access_denied' | 'not_found' | 'rate_limited'
  | 'unavailable' | 'invalid_response' | 'too_large' | 'timeout' | 'no_importable_tracks';
export type SpotifyCatalogOutcome = {
  configured: boolean;
  status: SpotifyCatalogStatus;
  error?: string;
  retryAfterSeconds?: number;
};
export type SpotifyPlaylistImportResult = SpotifyCatalogOutcome & {
  playlistId: string | null;
  playlistName: string | null;
  tracks: SpotifyPlaylistImportTrack[];
};
export type SpotifyCatalogSearchResult = SpotifyCatalogOutcome & { results: CatalogTrack[] };

const REQUEST_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 30_000;
const MAX_PLAYLIST_ITEMS = 1000;
const MAX_PLAYLIST_PAGES = 100;
type Token = { key: string; value: string; expiresAt: number };
let cachedToken: Token | null = null;
let pendingToken: { key: string; promise: Promise<Token> } | null = null;

class CatalogFailure extends Error {
  constructor(readonly status: SpotifyCatalogStatus, message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function failure(error: unknown): CatalogFailure {
  if (error instanceof CatalogFailure) return error;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new CatalogFailure('timeout', 'Spotify took too long to respond. Please try again.');
  }
  return new CatalogFailure('unavailable', 'Spotify is temporarily unavailable. Please try again.');
}

function failureOutcome(error: unknown, configured: boolean): SpotifyCatalogOutcome {
  const result = failure(error);
  return { configured, status: result.status, error: result.message,
    ...(result.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: result.retryAfterSeconds }) };
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(1, Math.min(86_400, Math.ceil(seconds))) : undefined;
}

function responseFailure(response: Response, tokenRequest: boolean): CatalogFailure {
  if (response.status === 429) return new CatalogFailure('rate_limited', 'Spotify is busy. Please try again shortly.', retryAfter(response));
  if (response.status === 401 || (tokenRequest && response.status === 400)) {
    return new CatalogFailure('authentication_failed', 'Spotify credentials were rejected. Ask the Sway operator to reconnect the catalog.');
  }
  if (response.status === 403) return new CatalogFailure('access_denied', 'Spotify did not allow access. Check this app’s Spotify access and playlist permissions.');
  if (response.status === 404) return new CatalogFailure('not_found', 'Spotify could not find this playlist or make it available to this app.');
  return new CatalogFailure('unavailable', 'Spotify is temporarily unavailable. Please try again.');
}

async function fetchJson(url: string, init: RequestInit, deadline: number, tokenRequest = false): Promise<JsonObject> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CatalogFailure('timeout', 'Spotify took too long to respond. Please try again.');
  try {
    // Keep the deadline active while reading the body, and never forward credentials through redirects.
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)) });
    if (!response.ok) throw responseFailure(response, tokenRequest);
    let payload: unknown;
    try { payload = await response.json(); }
    catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw error;
      throw new CatalogFailure('invalid_response', 'Spotify returned an unreadable response. Please try again.');
    }
    const data = object(payload);
    if (!data) throw new CatalogFailure('invalid_response', 'Spotify returned an incomplete response. Please try again.');
    return data;
  } catch (error) { throw failure(error); }
}

async function fetchAppToken(env: CatalogEnv, deadline: number): Promise<Token> {
  const clientId = env.SWAY_SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = env.SWAY_SPOTIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new CatalogFailure('not_configured', 'Spotify catalog credentials are not configured.');
  const key = createHash('sha256').update(clientId).update('\0').update(clientSecret).digest('hex');
  if (cachedToken?.key === key && cachedToken.expiresAt > Date.now()) return cachedToken;
  if (pendingToken?.key === key) return pendingToken.promise;
  const promise = (async (): Promise<Token> => {
    const data = await fetchJson('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    }, deadline, true);
    const lifetime = typeof data.expires_in === 'number' ? data.expires_in * 1000 : NaN;
    if (typeof data.access_token !== 'string' || !data.access_token.trim() || !Number.isFinite(lifetime) || lifetime <= 0) {
      throw new CatalogFailure('invalid_response', 'Spotify returned invalid authentication information. Please try again.');
    }
    const token = { key, value: data.access_token, expiresAt: Date.now() + lifetime - Math.min(30_000, lifetime / 10) };
    cachedToken = token;
    return token;
  })();
  pendingToken = { key, promise };
  try { return await promise; }
  finally { if (pendingToken?.promise === promise) pendingToken = null; }
}

async function fetchCatalogJson(url: string, env: CatalogEnv, deadline: number): Promise<JsonObject> {
  const token = await fetchAppToken(env, deadline);
  try { return await fetchJson(url, { headers: { Authorization: `Bearer ${token.value}` } }, deadline); }
  catch (error) {
    if (!(error instanceof CatalogFailure) || error.status !== 'authentication_failed') throw error;
    // A revoked/expired token gets exactly one refresh; permission and rate errors are not retried.
    if (cachedToken === token) cachedToken = null;
    const refreshed = await fetchAppToken(env, deadline);
    return fetchJson(url, { headers: { Authorization: `Bearer ${refreshed.value}` } }, deadline);
  }
}

function boundedInteger(value: number, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value))) : fallback;
}

function catalogTrack(value: unknown): CatalogTrack | null {
  const track = object(value);
  if (!track || typeof track.id !== 'string' || !/^[a-zA-Z0-9]{22}$/.test(track.id)
    || typeof track.name !== 'string' || !track.name.trim() || track.is_local === true
    || (track.type !== undefined && track.type !== 'track')) return null;
  const album = object(track.album);
  const artists = Array.isArray(track.artists) ? track.artists.map((artist) => object(artist)?.name)
    .filter((name): name is string => typeof name === 'string' && Boolean(name.trim())) : [];
  const images = Array.isArray(album?.images) ? album.images : [];
  const imageUrl = images.map((entry) => object(entry)?.url).find((url) => typeof url === 'string' && url.startsWith('https://'));
  return {
    id: `spotify-${track.id}`, title: track.name, artist: artists.join(', ') || 'Unknown artist',
    album: typeof album?.name === 'string' ? album.name : null,
    albumArt: typeof imageUrl === 'string' ? imageUrl : null,
    spotifyUri: `spotify:track:${track.id}`, spotifyUrl: `https://open.spotify.com/track/${track.id}`
  };
}

type PlaylistPage = { items: unknown[]; total: number; offset: number; next: string | null };
function playlistPage(value: unknown): PlaylistPage {
  const page = object(value);
  if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.total) || (page.total as number) < 0
    || !Number.isSafeInteger(page.offset) || (page.offset as number) < 0
    || !(page.next === null || (typeof page.next === 'string' && Boolean(page.next)))) {
    throw new CatalogFailure('invalid_response', 'Spotify returned incomplete playlist pages. Nothing was imported. Please try again.');
  }
  return page as PlaylistPage;
}

function nextPlaylistUrl(value: string, playlistId: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new CatalogFailure('invalid_response', 'Spotify returned an invalid playlist page. Nothing was imported.'); }
  if (url.origin !== 'https://api.spotify.com' || url.username || url.password || url.hash
    || ![`/v1/playlists/${playlistId}/tracks`, `/v1/playlists/${playlistId}/items`].includes(url.pathname)) {
    throw new CatalogFailure('invalid_response', 'Spotify returned an unexpected playlist page. Nothing was imported.');
  }
  return url.toString();
}

export function isCatalogSearchConfigured(env: CatalogEnv): boolean {
  return Boolean(env.SWAY_SPOTIFY_CLIENT_ID?.trim() && env.SWAY_SPOTIFY_CLIENT_SECRET?.trim());
}

export async function importSpotifyPlaylist({ playlistUrl, env, limit = 1000 }: {
  playlistUrl: string; env: CatalogEnv; limit?: number;
}): Promise<SpotifyPlaylistImportResult> {
  const configured = isCatalogSearchConfigured(env);
  const playlistId = resolveSpotifyPlaylistId(playlistUrl);
  const empty = { playlistId, playlistName: null, tracks: [] };
  if (!playlistId) return { ...empty, configured, status: 'invalid_playlist', error: 'Enter a valid Spotify playlist URL, URI, or ID.' };
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  const cappedLimit = boundedInteger(limit, MAX_PLAYLIST_ITEMS, MAX_PLAYLIST_ITEMS);
  try {
    // No legacy-only fields filter: extended-quota apps return tracks, migrated apps return items.
    const data = await fetchCatalogJson(`https://api.spotify.com/v1/playlists/${playlistId}`, env, deadline);
    if (data.id !== playlistId || typeof data.name !== 'string') {
      throw new CatalogFailure('invalid_response', 'Spotify returned incomplete playlist information. Nothing was imported.');
    }
    if (data.items == null && data.tracks == null) {
      throw new CatalogFailure('access_denied', 'Spotify returned playlist details without songs. This app needs access to the playlist contents; a metadata-only response cannot be imported.');
    }
    let page = playlistPage(data.items ?? data.tracks);
    const paginated = page.next !== null;
    const snapshot = typeof data.snapshot_id === 'string' && data.snapshot_id ? data.snapshot_id : null;
    if (paginated && !snapshot) throw new CatalogFailure('invalid_response', 'Spotify returned no playlist version. Nothing was imported. Please try again.');
    const total = page.total;
    if (total > cappedLimit) throw new CatalogFailure('too_large', `This playlist exceeds the ${cappedLimit}-item import limit. Nothing was imported. Use a smaller playlist.`);
    let processed = 0;
    let pages = 0;
    const visited = new Set<string>();
    const seenTracks = new Set<string>();
    const tracks: SpotifyPlaylistImportTrack[] = [];
    while (true) {
      if (++pages > MAX_PLAYLIST_PAGES || page.total !== total || page.offset !== processed
        || processed + page.items.length > total || (page.items.length === 0 && page.next !== null)) {
        throw new CatalogFailure('invalid_response', 'Spotify returned inconsistent or incomplete playlist pages. Nothing was imported. Please try again.');
      }
      for (const entry of page.items) {
        const wrapper = object(entry);
        // Null items are Spotify's unavailable/removed tracks. Unknown wrappers are not silently discarded.
        if (!wrapper || (!('item' in wrapper) && !('track' in wrapper))) {
          throw new CatalogFailure('invalid_response', 'Spotify returned unreadable playlist items. Nothing was imported.');
        }
        if (wrapper.is_local === true) continue;
        const raw = wrapper.item !== undefined ? wrapper.item : wrapper.track;
        if (raw === null) continue;
        const track = object(raw);
        if (track?.is_local === true || track?.type === 'episode') continue;
        const mapped = catalogTrack(track);
        if (!mapped || !track) throw new CatalogFailure('invalid_response', 'Spotify returned unreadable track information. Nothing was imported.');
        if (!seenTracks.has(mapped.id)) {
          seenTracks.add(mapped.id);
          tracks.push({ ...mapped, externalTrackId: `spotify:${track.id}` });
        }
      }
      processed += page.items.length;
      if (page.next === null) {
        if (processed !== total) throw new CatalogFailure('invalid_response', 'Spotify stopped before the complete playlist was received. Nothing was imported. Please try again.');
        break;
      }
      if (processed >= total) throw new CatalogFailure('invalid_response', 'Spotify returned inconsistent playlist pagination. Nothing was imported.');
      if (pages >= MAX_PLAYLIST_PAGES) throw new CatalogFailure('invalid_response', 'Spotify returned too many playlist pages. Nothing was imported. Please try again.');
      const next = nextPlaylistUrl(page.next, playlistId);
      if (visited.has(next)) throw new CatalogFailure('invalid_response', 'Spotify repeated a playlist page. Nothing was imported.');
      visited.add(next);
      page = playlistPage(await fetchCatalogJson(next, env, deadline));
    }
    if (paginated) {
      const current = await fetchCatalogJson(`https://api.spotify.com/v1/playlists/${playlistId}?fields=snapshot_id`, env, deadline);
      if (current.snapshot_id !== snapshot) {
        throw new CatalogFailure('invalid_response', 'The Spotify playlist changed while it was being imported. Nothing was imported. Please try again.');
      }
    }
    if (total > 0 && tracks.length === 0) {
      throw new CatalogFailure('no_importable_tracks', 'This playlist contains no available Spotify music tracks to import. Removed, local, and episode entries cannot be imported.');
    }
    return { configured, status: 'ready', playlistId, playlistName: data.name || 'Spotify playlist', tracks };
  } catch (error) { return { ...empty, ...failureOutcome(error, configured) }; }
}

export async function searchCatalog({ query, env, limit = 10 }: {
  query: string; env: CatalogEnv; limit?: number;
}): Promise<SpotifyCatalogSearchResult> {
  const configured = isCatalogSearchConfigured(env);
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return { configured, status: configured ? 'ready' : 'not_configured', results: [] };
  try {
    // Ten also works for extended quota, and stays compatible with migrated development apps.
    const cappedLimit = boundedInteger(limit, 10, 10);
    const url = `https://api.spotify.com/v1/search?${new URLSearchParams({ q: trimmedQuery, type: 'track', limit: String(cappedLimit) })}`;
    const data = await fetchCatalogJson(url, env, Date.now() + OPERATION_TIMEOUT_MS);
    const tracks = object(data.tracks);
    if (!Array.isArray(tracks?.items)) throw new CatalogFailure('invalid_response', 'Spotify returned incomplete search results. Please try again.');
    const parsed = tracks.items.map(catalogTrack);
    if (parsed.some((track) => track === null)) {
      throw new CatalogFailure('invalid_response', 'Spotify returned unreadable search results. Please try again.');
    }
    const results = (parsed as CatalogTrack[]).slice(0, cappedLimit);
    return { configured, status: 'ready', results };
  } catch (error) { return { ...failureOutcome(error, configured), results: [] }; }
}
