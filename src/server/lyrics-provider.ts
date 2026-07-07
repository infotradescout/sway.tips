type LyricsResult = {
  found: boolean;
  trackName?: string;
  artistName?: string;
  plainLyrics?: string;
  syncedLyrics?: string;
  instrumental?: boolean;
};

const LRCLIB_BASE_URL = 'https://lrclib.net/api';
const FETCH_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'sway.tips (contact@sway.tips)' } });
  } finally {
    clearTimeout(timer);
  }
}

export async function lookupLyrics({ title, artist }: { title: string; artist: string }): Promise<LyricsResult> {
  const trackName = title.trim();
  const artistName = artist.trim();
  if (!trackName) return { found: false };

  try {
    const getUrl = `${LRCLIB_BASE_URL}/get?${new URLSearchParams({ track_name: trackName, artist_name: artistName })}`;
    const getResponse = await fetchWithTimeout(getUrl);
    if (getResponse.ok) {
      const data = await getResponse.json();
      if (data?.instrumental || data?.plainLyrics || data?.syncedLyrics) {
        return {
          found: true,
          trackName: data.trackName ?? trackName,
          artistName: data.artistName ?? artistName,
          plainLyrics: data.plainLyrics ?? undefined,
          syncedLyrics: data.syncedLyrics ?? undefined,
          instrumental: Boolean(data.instrumental)
        };
      }
    }

    const searchUrl = `${LRCLIB_BASE_URL}/search?${new URLSearchParams({ track_name: trackName, artist_name: artistName })}`;
    const searchResponse = await fetchWithTimeout(searchUrl);
    if (!searchResponse.ok) return { found: false };
    const results = await searchResponse.json();
    const bestMatch = Array.isArray(results) ? results[0] : null;
    if (!bestMatch || (!bestMatch.plainLyrics && !bestMatch.syncedLyrics && !bestMatch.instrumental)) {
      return { found: false };
    }

    return {
      found: true,
      trackName: bestMatch.trackName ?? trackName,
      artistName: bestMatch.artistName ?? artistName,
      plainLyrics: bestMatch.plainLyrics ?? undefined,
      syncedLyrics: bestMatch.syncedLyrics ?? undefined,
      instrumental: Boolean(bestMatch.instrumental)
    };
  } catch {
    return { found: false };
  }
}
