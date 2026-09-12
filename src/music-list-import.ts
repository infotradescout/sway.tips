import type { DjLibraryImportResult, DjLibraryImportTrack } from './dj-library-file-parser';

const LIMIT = 1_000;
const MAX_BYTES = 25_000_000;
const clean = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const key = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

function decode(value: string) {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, raw: string) => {
    const point = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : parseInt(raw, 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : '\uFFFD';
  }).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function stableId(parts: unknown[]) {
  const value = parts.map(part => String(part ?? '')).join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return `browser-import-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function duration(value: string) {
  if (!value) return null;
  if (/^\d+:\d{2}(?::\d{2})?$/.test(value)) return value.split(':').reduce((n, part) => n * 60 + Number(part), 0);
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function item(format: DjLibraryImportResult['format'], title: string, artist = '', album = '', identity = '', seconds: number | null = null): DjLibraryImportTrack | null {
  title = clean(title); artist = clean(artist) || 'Unknown artist'; album = clean(album);
  if (!title) return null;
  if (title.length > 1_000 || artist.length > 1_000 || album.length > 1_000) throw new Error('A song field is too long. Use a song list, not a webpage export.');
  return { title, artist, ...(album ? { album } : {}), externalTrackId: stableId([format, identity, title, artist, album]),
    metadata: { sourceFormat: format, ...(seconds !== null ? { durationSeconds: seconds } : {}) } };
}

function result(format: DjLibraryImportResult['format'], sourceKey: string, sourceLabel: string, tracks: DjLibraryImportTrack[]): DjLibraryImportResult {
  if (!tracks.length) throw new Error('No song titles were found. Include a Title or Name column, or one song per line.');
  return { format, sourceKey, sourceLabel, tracks: tracks.slice(0, LIMIT), truncated: tracks.length > LIMIT };
}

function delimitedRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quoted) {
      if (c === '"' && content[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && !field) quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && content[i + 1] === '\n') i++;
      row.push(field); if (row.some(cell => cell.trim())) rows.push(row);
      row = []; field = '';
    } else field += c;
  }
  if (quoted) throw new Error('The exported list contains an unclosed quoted field. Export the file again.');
  if (field || row.length) { row.push(field); if (row.some(cell => cell.trim())) rows.push(row); }
  return rows;
}

function parseTable(content: string, delimiter: string, format: 'csv' | 'tsv') {
  const rows = delimitedRows(content, delimiter);
  const headers = (rows[0] ?? []).map(key);
  const titleAliases = ['title', 'name', 'track', 'tracktitle', 'trackname', 'song', 'songtitle', 'songname'];
  if (!headers.some(header => titleAliases.includes(header))) throw new Error('Include a Title, Track Name, Song, or Name column in your exported list.');
  const tracks: DjLibraryImportTrack[] = [];
  for (const values of rows.slice(1)) {
    const read = (...aliases: string[]) => clean(values[headers.findIndex(header => aliases.includes(header))]);
    const ms = read('durationms', 'durationmilliseconds');
    const parsed = item(format, read(...titleAliases), read('artist', 'artists', 'artistname', 'artistnames', 'trackartist', 'author', 'albumartist'),
      read('album', 'albumname'), read('trackid', 'id', 'persistentid', 'trackuri', 'uri', 'filepath', 'location', 'path', 'url'),
      ms && duration(ms) !== null ? duration(ms)! / 1_000 : duration(read('duration', 'length', 'time', 'durationseconds')));
    if (parsed) {
      const metadata = parsed.metadata!;
      for (const name of ['genre', 'key']) { const value = read(name); if (value) metadata[name] = value; }
      const bpm = Number(read('bpm', 'averagebpm', 'tempo')); if (bpm > 0 && Number.isFinite(bpm)) metadata.bpm = bpm;
      tracks.push(parsed);
    }
    if (tracks.length > LIMIT) break;
  }
  return result(format, `${format}-import`, format === 'csv' ? 'Song list CSV' : 'Song list TSV', tracks);
}

function parseApple(content: string) {
  const start = /<key>\s*Tracks\s*<\/key>\s*<dict\s*>/i.exec(content);
  if (!start) throw new Error('Choose an Apple Music or iTunes library/playlist XML export with a Tracks dictionary.');
  const begin = start.index + start[0].length;
  let depth = 1, end = -1;
  const dictionaries = /<\/?dict\s*>/gi; dictionaries.lastIndex = begin;
  for (let match = dictionaries.exec(content); match; match = dictionaries.exec(content)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) { end = match.index; break; }
    if (depth > 32) throw new Error('The music XML is nested too deeply.');
  }
  if (end < 0) throw new Error('The Apple Music XML is incomplete. Export it again.');
  const tracks: DjLibraryImportTrack[] = [];
  for (const entry of content.slice(begin, end).matchAll(/<key>\s*\d+\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/gi)) {
    const fields = new Map<string, string>();
    for (const match of entry[1].matchAll(/<key>([^<]*)<\/key>\s*<(string|integer|real|date)>([\s\S]*?)<\/\2>/gi)) fields.set(decode(match[1]), decode(match[3]));
    const ms = duration(fields.get('Total Time') ?? '');
    const parsed = item('apple_music_xml', fields.get('Name') ?? '', fields.get('Artist'), fields.get('Album'),
      fields.get('Persistent ID') ?? fields.get('Track ID'), ms === null ? null : ms / 1_000);
    if (parsed) tracks.push(parsed);
    if (tracks.length > LIMIT) break;
  }
  return result('apple_music_xml', 'apple-music-import', 'Apple Music / iTunes library', tracks);
}

function displayParts(value: string): [string, string] {
  const index = value.indexOf(' - ');
  return index > 0 ? [value.slice(index + 3).trim(), value.slice(0, index).trim()] : [value.trim(), ''];
}
function filename(value: string) { return value.split(/[\\/]/).pop()?.replace(/\.[a-z0-9]{1,8}$/i, '') ?? ''; }

export function parseAdditionalMusicList(fileName: string, raw: string): DjLibraryImportResult | null {
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new Error('Library export must be 25 MB or smaller.');
  const content = raw.replace(/^\uFEFF/, ''), lower = fileName.toLowerCase();
  if (/<!ENTITY\b/i.test(content)) throw new Error('XML entity declarations are not supported. Use a standard library export.');
  if (/<plist\b/i.test(content)) return parseApple(content);
  if (lower.endsWith('.csv')) {
    const header = content.split(/\r?\n/, 1)[0];
    const delimiter = header.includes('\t') ? '\t' : header.includes(';') && !header.includes(',') ? ';' : ',';
    return parseTable(content, delimiter, 'csv');
  }
  if (lower.endsWith('.tsv') || (lower.endsWith('.txt') && content.split(/\r?\n/, 1)[0].includes('\t'))) return parseTable(content, '\t', 'tsv');
  if (lower.endsWith('.txt')) {
    const tracks: DjLibraryImportTrack[] = [];
    if (/^\s*</.test(content)) throw new Error('Use a plain song list, not HTML or XML renamed as text.');
    for (const rawLine of content.split(/\r\n|\r|\n/)) {
      const line = rawLine.trim(); if (!line || line.startsWith('#')) continue;
      if (/^(https?:|file:|[a-z]:[\\/])/i.test(line)) throw new Error('Text imports need song titles. Use M3U for file paths or playlist entries.');
      const [title, artist] = displayParts(line);
      const parsed = item('text', title, artist); if (parsed) tracks.push(parsed);
      if (tracks.length > LIMIT) break;
    }
    return result('text', 'text-import', 'Song list / setlist', tracks);
  }
  if (lower.endsWith('.pls')) {
    if (!/^\s*\[playlist\]/i.test(content)) throw new Error('Choose a valid PLS playlist.');
    const records = new Map<number, Record<string, string>>();
    for (const match of content.matchAll(/^(File|Title|Length)(\d+)=(.*)$/gmi)) {
      const id = Number(match[2]); if (!records.has(id)) records.set(id, {});
      records.get(id)![match[1].toLowerCase()] = match[3].trim();
    }
    const tracks: DjLibraryImportTrack[] = [];
    for (const [, record] of [...records].sort(([a], [b]) => a - b)) {
      const [title, artist] = displayParts(record.title || filename(record.file || ''));
      const parsed = item('pls', title, artist, '', record.file, duration(record.length));
      if (parsed) tracks.push(parsed); if (tracks.length > LIMIT) break;
    }
    return result('pls', 'pls-import', 'PLS playlist', tracks);
  }
  if (lower.endsWith('.xspf')) {
    if (!/<(?:\w+:)?playlist\b/i.test(content) || !/<(?:\w+:)?trackList\b/i.test(content)) throw new Error('Choose a valid XSPF playlist.');
    const tracks: DjLibraryImportTrack[] = [];
    for (const entry of content.matchAll(/<(?:\w+:)?track\b[^>]*>([\s\S]*?)<\/(?:\w+:)?track>/gi)) {
      const read = (tag: string) => decode(entry[1].match(new RegExp(`<(?:(?:\\w+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${tag}>`, 'i'))?.[1] ?? '');
      const ms = duration(read('duration'));
      const parsed = item('xspf', read('title') || filename(read('location')), read('creator'), read('album'), read('identifier') || read('location'), ms === null ? null : ms / 1_000);
      if (parsed) tracks.push(parsed); if (tracks.length > LIMIT) break;
    }
    return result('xspf', 'xspf-import', 'XSPF playlist', tracks);
  }
  return null;
}
