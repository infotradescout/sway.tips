/** Accept only a Spotify playlist identity, never a substring of another URL. */
export function resolveSpotifyPlaylistId(input: string): string | null {
  const value = input.trim();
  const idPattern = /^[A-Za-z0-9]{22}$/;
  if (idPattern.test(value)) return value;
  const uri = /^spotify:playlist:([A-Za-z0-9]{22})$/.exec(value);
  if (uri) return uri[1];
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com'
      || url.port || url.username || url.password) return null;
    const path = /^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
    return path?.[1] ?? null;
  } catch { return null; }
}
