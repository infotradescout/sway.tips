type CatalogEnv = Record<string, string | undefined>;

export type CatalogTrack = {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  albumArt: string | null;
  spotifyUri: string;
  spotifyUrl: string;
};

export type SpotifyPlaylistImportTrack = CatalogTrack & {
  externalTrackId: string;
};

let cachedToken: { value: string; expiresAt: number } | null = null;

function resolveSpotifyPlaylistId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const uriMatch = value.match(/^spotify:playlist:([a-zA-Z0-9]+)$/);
  if (uriMatch) return uriMatch[1];

  const urlMatch = value.match(/open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];

  if (/^[a-zA-Z0-9]{10,}$/.test(value)) return value;

  return null;
}

async function fetchAppToken(env: CatalogEnv): Promise<string | null> {
  const clientId = env.SWAY_SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = env.SWAY_SPOTIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (typeof data?.access_token !== 'string') return null;

    cachedToken = {
      value: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 30_000
    };

    return cachedToken.value;
  } catch {
    return null;
  }
}

export function isCatalogSearchConfigured(env: CatalogEnv): boolean {
  return Boolean(env.SWAY_SPOTIFY_CLIENT_ID?.trim() && env.SWAY_SPOTIFY_CLIENT_SECRET?.trim());
}

export async function importSpotifyPlaylist({
  playlistUrl,
  env,
  limit = 100
}: {
  playlistUrl: string;
  env: CatalogEnv;
  limit?: number;
}): Promise<{ configured: boolean; playlistId: string | null; playlistName: string | null; tracks: SpotifyPlaylistImportTrack[] }> {
  const playlistId = resolveSpotifyPlaylistId(playlistUrl);
  if (!playlistId) return { configured: isCatalogSearchConfigured(env), playlistId: null, playlistName: null, tracks: [] };

  const token = await fetchAppToken(env);
  if (!token) return { configured: false, playlistId, playlistName: null, tracks: [] };

  const cappedLimit = Math.min(Math.max(limit, 1), 100);

  try {
    const url = `https://api.spotify.com/v1/playlists/${playlistId}?${new URLSearchParams({
      fields: 'id,name,tracks.items(track(id,name,uri,external_urls,artists(name),album(name,images)))',
      limit: String(cappedLimit)
    })}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) return { configured: true, playlistId, playlistName: null, tracks: [] };

    const data = await response.json();
    const items = Array.isArray(data?.tracks?.items) ? data.tracks.items : [];
    const tracks: SpotifyPlaylistImportTrack[] = items
      .map((item: any) => item?.track)
      .filter((track: any) => track?.id && track?.name)
      .map((track: any) => ({
        id: `spotify-${track.id}`,
        externalTrackId: `spotify:${track.id}`,
        title: track.name,
        artist: Array.isArray(track.artists) ? track.artists.map((a: any) => a.name).join(', ') : 'Unknown artist',
        album: track.album?.name ?? null,
        albumArt: track.album?.images?.[0]?.url ?? null,
        spotifyUri: track.uri,
        spotifyUrl: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`
      }));

    return {
      configured: true,
      playlistId,
      playlistName: typeof data?.name === 'string' ? data.name : 'Spotify playlist',
      tracks
    };
  } catch {
    return { configured: true, playlistId, playlistName: null, tracks: [] };
  }
}

export async function searchCatalog({
  query,
  env,
  limit = 15
}: {
  query: string;
  env: CatalogEnv;
  limit?: number;
}): Promise<{ configured: boolean; results: CatalogTrack[] }> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return { configured: isCatalogSearchConfigured(env), results: [] };

  const token = await fetchAppToken(env);
  if (!token) return { configured: false, results: [] };

  try {
    const url = `https://api.spotify.com/v1/search?${new URLSearchParams({
      q: trimmedQuery,
      type: 'track',
      limit: String(Math.min(limit, 50))
    })}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) return { configured: true, results: [] };

    const data = await response.json();
    const items = Array.isArray(data?.tracks?.items) ? data.tracks.items : [];

    const results: CatalogTrack[] = items.map((track: any) => ({
      id: `spotify-${track.id}`,
      title: track.name,
      artist: Array.isArray(track.artists) ? track.artists.map((a: any) => a.name).join(', ') : 'Unknown artist',
      album: track.album?.name ?? null,
      albumArt: track.album?.images?.[0]?.url ?? null,
      spotifyUri: track.uri,
      spotifyUrl: track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`
    }));

    return { configured: true, results };
  } catch {
    return { configured: true, results: [] };
  }
}
