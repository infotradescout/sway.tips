export type DjLibraryImportTrack = {
  title: string;
  artist: string;
  album?: string;
  externalTrackId?: string;
  metadata?: Record<string, unknown>;
};

export type DjLibraryImportResult = {
  format: 'rekordbox_xml' | 'traktor_nml' | 'virtualdj_xml' | 'm3u' | 'csv';
  sourceKey: string;
  sourceLabel: string;
  tracks: DjLibraryImportTrack[];
  truncated: boolean;
};

const MAX_TRACKS = 1_000;

function xmlDecode(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function readAttributes(fragment = '') {
  const attributes: Record<string, string> = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of fragment.matchAll(pattern)) {
    attributes[match[1]] = xmlDecode(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function text(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function privateStableId(parts: unknown[]) {
  const value = parts.map((part) => String(part ?? '')).join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `browser-import-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function basename(value: string) {
  const normalized = value.replace(/\\/g, '/');
  const filename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return filename.replace(/\.[^.]+$/, '') || 'Untitled track';
}

function track(input: {
  sourceFormat: DjLibraryImportResult['format'];
  sourceIdentity?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  genre?: unknown;
  key?: unknown;
  bpm?: unknown;
  durationSeconds?: unknown;
  locationPresent?: boolean;
}): DjLibraryImportTrack | null {
  const title = text(input.title);
  if (!title) return null;
  const artist = text(input.artist, 'Unknown artist');
  const album = text(input.album);
  const bpm = numberValue(input.bpm);
  const durationSeconds = numberValue(input.durationSeconds);
  return {
    title,
    artist,
    ...(album ? { album } : {}),
    externalTrackId: privateStableId([
      input.sourceFormat,
      input.sourceIdentity,
      title,
      artist,
      album
    ]),
    metadata: {
      sourceFormat: input.sourceFormat,
      ...(text(input.genre) ? { genre: text(input.genre) } : {}),
      ...(text(input.key) ? { key: text(input.key) } : {}),
      ...(bpm !== null ? { bpm } : {}),
      ...(durationSeconds !== null ? { durationSeconds } : {}),
      ...(input.locationPresent ? { localLocationPresent: true } : {})
    }
  };
}

function parseRekordbox(content: string) {
  const tracks: DjLibraryImportTrack[] = [];
  for (const match of content.matchAll(/<TRACK\b([^>]*)\/?>(?:[\s\S]*?<\/TRACK>)?/gi)) {
    const attrs = readAttributes(match[1]);
    const parsed = track({
      sourceFormat: 'rekordbox_xml',
      sourceIdentity: attrs.TrackID || attrs.Location,
      title: attrs.Name,
      artist: attrs.Artist,
      album: attrs.Album,
      genre: attrs.Genre,
      key: attrs.Tonality,
      bpm: attrs.AverageBpm,
      durationSeconds: attrs.TotalTime,
      locationPresent: Boolean(attrs.Location)
    });
    if (parsed) tracks.push(parsed);
    if (tracks.length >= MAX_TRACKS) break;
  }
  return tracks;
}

function parseTraktor(content: string) {
  const tracks: DjLibraryImportTrack[] = [];
  for (const match of content.matchAll(/<ENTRY\b([^>]*)>([\s\S]*?)<\/ENTRY>/gi)) {
    const entry = readAttributes(match[1]);
    const body = match[2];
    const location = readAttributes(body.match(/<LOCATION\b([^>]*)\/?\s*>/i)?.[1]);
    const album = readAttributes(body.match(/<ALBUM\b([^>]*)\/?\s*>/i)?.[1]);
    const tempo = readAttributes(body.match(/<TEMPO\b([^>]*)\/?\s*>/i)?.[1]);
    const info = readAttributes(body.match(/<INFO\b([^>]*)\/?\s*>/i)?.[1]);
    const parsed = track({
      sourceFormat: 'traktor_nml',
      sourceIdentity: entry.AUDIO_ID || `${location.DIR || ''}${location.FILE || ''}`,
      title: entry.TITLE,
      artist: entry.ARTIST,
      album: album.TITLE,
      genre: info.GENRE,
      key: info.KEY,
      bpm: tempo.BPM,
      locationPresent: Boolean(location.DIR || location.FILE)
    });
    if (parsed) tracks.push(parsed);
    if (tracks.length >= MAX_TRACKS) break;
  }
  return tracks;
}

function parseVirtualDj(content: string) {
  const tracks: DjLibraryImportTrack[] = [];
  for (const match of content.matchAll(/<Song\b([^>]*)>([\s\S]*?)<\/Song>/gi)) {
    const song = readAttributes(match[1]);
    const body = match[2];
    const tags = readAttributes(body.match(/<Tags\b([^>]*)\/?\s*>/i)?.[1]);
    const infos = readAttributes(body.match(/<Infos\b([^>]*)\/?\s*>/i)?.[1]);
    const scan = readAttributes(body.match(/<Scan\b([^>]*)\/?\s*>/i)?.[1]);
    const beatSeconds = numberValue(scan.Bpm);
    const parsed = track({
      sourceFormat: 'virtualdj_xml',
      sourceIdentity: song.FilePath,
      title: tags.Title || basename(song.FilePath || ''),
      artist: tags.Author,
      album: tags.Album,
      genre: tags.Genre,
      key: scan.Key,
      bpm: beatSeconds ? 60 / beatSeconds : null,
      durationSeconds: infos.SongLength,
      locationPresent: Boolean(song.FilePath)
    });
    if (parsed) tracks.push(parsed);
    if (tracks.length >= MAX_TRACKS) break;
  }
  return tracks;
}

function parseM3u(content: string) {
  const tracks: DjLibraryImportTrack[] = [];
  let pending: { title?: string; artist?: string; durationSeconds?: number | null } | null = null;
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const match = line.match(/^#EXTINF:([^,]*),(.*)$/i);
      const display = text(match?.[2]);
      const separator = display.indexOf(' - ');
      pending = {
        durationSeconds: numberValue(match?.[1]),
        artist: separator >= 0 ? display.slice(0, separator) : undefined,
        title: separator >= 0 ? display.slice(separator + 3) : display
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    const parsed = track({
      sourceFormat: 'm3u',
      sourceIdentity: line,
      title: pending?.title || basename(line),
      artist: pending?.artist,
      durationSeconds: pending?.durationSeconds,
      locationPresent: true
    });
    if (parsed) tracks.push(parsed);
    pending = null;
    if (tracks.length >= MAX_TRACKS) break;
  }
  return tracks;
}

function csvRows(content: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const value = content.replace(/^\uFEFF/, '');
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (field || row.length) rows.push([...row, field.replace(/\r$/, '')]);
  return rows;
}

function first(record: Record<string, string>, aliases: string[]) {
  return aliases.map((alias) => text(record[alias])).find(Boolean) || '';
}

function parseCsv(content: string) {
  const rows = csvRows(content);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, ''));
  const tracks: DjLibraryImportTrack[] = [];
  for (const values of rows.slice(1)) {
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    const location = first(record, ['filepath', 'filename', 'location', 'path', 'url']);
    const parsed = track({
      sourceFormat: 'csv',
      sourceIdentity: first(record, ['trackid', 'id', 'persistentid']) || location,
      title: first(record, ['title', 'name', 'track']),
      artist: first(record, ['artist', 'author', 'albumartist']),
      album: first(record, ['album']),
      genre: first(record, ['genre']),
      key: first(record, ['key', 'tonality']),
      bpm: first(record, ['bpm', 'averagebpm', 'tempo']),
      durationSeconds: first(record, ['duration', 'length', 'totaltime']),
      locationPresent: Boolean(location)
    });
    if (parsed) tracks.push(parsed);
    if (tracks.length >= MAX_TRACKS) break;
  }
  return tracks;
}

export function parseDjLibraryText(fileName: string, content: string): DjLibraryImportResult {
  const lowerName = fileName.toLowerCase();
  let format: DjLibraryImportResult['format'];
  let sourceKey: string;
  let sourceLabel: string;
  let tracks: DjLibraryImportTrack[];

  if (lowerName.endsWith('.nml') || /<NML\b/i.test(content)) {
    format = 'traktor_nml';
    sourceKey = 'traktor-import';
    sourceLabel = 'Traktor library';
    tracks = parseTraktor(content);
  } else if (lowerName.endsWith('.m3u') || lowerName.endsWith('.m3u8')) {
    format = 'm3u';
    sourceKey = 'm3u-import';
    sourceLabel = 'M3U playlist';
    tracks = parseM3u(content);
  } else if (lowerName.endsWith('.csv')) {
    format = 'csv';
    sourceKey = 'csv-import';
    sourceLabel = 'DJ library CSV';
    tracks = parseCsv(content);
  } else if (/<DJ_PLAYLISTS\b/i.test(content)) {
    format = 'rekordbox_xml';
    sourceKey = 'rekordbox-import';
    sourceLabel = 'rekordbox library';
    tracks = parseRekordbox(content);
  } else if (/<VirtualDJ_Database\b/i.test(content) || /<Song\b[^>]*FilePath=/i.test(content)) {
    format = 'virtualdj_xml';
    sourceKey = 'virtualdj-import';
    sourceLabel = 'VirtualDJ library';
    tracks = parseVirtualDj(content);
  } else {
    throw new Error('Use a rekordbox XML, Traktor NML, VirtualDJ XML, M3U/M3U8, or CSV export.');
  }

  if (!tracks.length) throw new Error('No valid tracks were found in that library export.');
  return { format, sourceKey, sourceLabel, tracks, truncated: tracks.length >= MAX_TRACKS };
}

export async function parseDjLibraryFile(file: File) {
  if (file.size > 25_000_000) throw new Error('Library export must be 25 MB or smaller. Use the local bridge for larger libraries.');
  return parseDjLibraryText(file.name, await file.text());
}
