import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';

const AUDIO_EXTENSIONS = new Set([
  '.aac', '.aif', '.aiff', '.alac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.wma'
]);
const MAX_TRACKS = 1_000;

function xmlDecode(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function readXmlAttributes(fragment = '') {
  const attributes = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of fragment.matchAll(pattern)) {
    attributes[match[1]] = xmlDecode(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function cleanText(value, fallback = null) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numeric(value) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function stableTrackId(parts) {
  return createHash('sha256').update(parts.filter(Boolean).join('|'), 'utf8').digest('hex');
}

export function decodeLibraryLocation(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  if (!/^file:/i.test(raw)) return raw;
  try {
    const url = new URL(raw);
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[a-z]:\//i.test(pathname)) pathname = pathname.slice(1);
    return url.hostname && url.hostname !== 'localhost'
      ? `//${url.hostname}${pathname}`
      : pathname;
  } catch {
    return decodeURIComponent(raw.replace(/^file:\/\/(?:localhost)?/i, ''));
  }
}

function normalizeTrack(input, sourceFormat) {
  const title = cleanText(input.title);
  if (!title) return null;
  const artist = cleanText(input.artist, 'Unknown artist');
  const filePath = cleanText(input.path);
  const externalTrackId = cleanText(input.externalTrackId)
    || stableTrackId([sourceFormat, filePath, title, artist, input.album]);
  return {
    title,
    artist,
    album: cleanText(input.album) || undefined,
    externalTrackId,
    metadata: {
      sourceFormat,
      ...(filePath ? { path: filePath } : {}),
      ...(cleanText(input.genre) ? { genre: cleanText(input.genre) } : {}),
      ...(cleanText(input.key) ? { key: cleanText(input.key) } : {}),
      ...(numeric(input.bpm) !== null ? { bpm: numeric(input.bpm) } : {}),
      ...(numeric(input.durationSeconds) !== null ? { durationSeconds: numeric(input.durationSeconds) } : {}),
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {})
    }
  };
}

export function parseRekordboxXml(content) {
  const tracks = [];
  const pattern = /<TRACK\b([^>]*)\/?>(?:[\s\S]*?<\/TRACK>)?/gi;
  for (const match of content.matchAll(pattern)) {
    const attrs = readXmlAttributes(match[1]);
    const track = normalizeTrack({
      externalTrackId: attrs.TrackID,
      title: attrs.Name,
      artist: attrs.Artist,
      album: attrs.Album,
      genre: attrs.Genre,
      key: attrs.Tonality,
      bpm: attrs.AverageBpm,
      durationSeconds: attrs.TotalTime,
      path: decodeLibraryLocation(attrs.Location),
      metadata: { dateAdded: cleanText(attrs.DateAdded) }
    }, 'rekordbox_xml');
    if (track) tracks.push(track);
    if (tracks.length >= MAX_TRACKS) break;
  }
  return tracks;
}

function decodeTraktorDirectory(value) {
  const raw = cleanText(value, '');
  return raw.replace(/\/:/g, '/').replace(/:{2,}/g, ':');
}

export function parseTraktorNml(content) {
  const tracks = [];
  const pattern = /<ENTRY\b([^>]*)>([\s\S]*?)<\/ENTRY>/gi;
  for (const match of content.matchAll(pattern)) {
    const entry = readXmlAttributes(match[1]);
    const body = match[2];
    const location = readXmlAttributes(body.match(/<LOCATION\b([^>]*)\/?\s*>/i)?.[1]);
    const album = readXmlAttributes(body.match(/<ALBUM\b([^>]*)\/?\s*>/i)?.[1]);
    const tempo = readXmlAttributes(body.match(/<TEMPO\b([^>]*)\/?\s*>/i)?.[1]);
    const info = readXmlAttributes(body.match(/<INFO\b([^>]*)\/?\s*>/i)?.[1]);
    const directory = decodeTraktorDirectory(location.DIR);
    const filePath = location.FILE ? path.join(directory || '.', location.FILE) : directory || null;
    const track = normalizeTrack({
      externalTrackId: entry.AUDIO_ID || filePath,
      title: entry.TITLE,
      artist: entry.ARTIST,
      album: album.TITLE,
      genre: info.GENRE,
      key: info.KEY,
      bpm: tempo.BPM,
      path: filePath,
      metadata: {
        traktorVolume: cleanText(location.VOLUME),
        bitrate: numeric(info.BITRATE)
      }
    }, 'traktor_nml');
    if (track) tracks.push(track);
    if (tracks.length >= MAX_TRACKS) break;
  }
  return tracks;
}

export function parseVirtualDjXml(content) {
  const tracks = [];
  const pattern = /<Song\b([^>]*)>([\s\S]*?)<\/Song>/gi;
  for (const match of content.matchAll(pattern)) {
    const song = readXmlAttributes(match[1]);
    const body = match[2];
    const tags = readXmlAttributes(body.match(/<Tags\b([^>]*)\/?\s*>/i)?.[1]);
    const infos = readXmlAttributes(body.match(/<Infos\b([^>]*)\/?\s*>/i)?.[1]);
    const scan = readXmlAttributes(body.match(/<Scan\b([^>]*)\/?\s*>/i)?.[1]);
    const track = normalizeTrack({
      externalTrackId: song.FilePath,
      title: tags.Title || path.basename(song.FilePath || '', path.extname(song.FilePath || '')),
      artist: tags.Author,
      album: tags.Album,
      genre: tags.Genre,
      key: scan.Key,
      bpm: numeric(scan.Bpm) ? 60 / numeric(scan.Bpm) : null,
      durationSeconds: infos.SongLength,
      path: song.FilePath,
      metadata: { fileSize: numeric(song.FileSize), flags: cleanText(song.Flag) }
    }, 'virtualdj_xml');
    if (track) tracks.push(track);
    if (tracks.length >= MAX_TRACKS) break;
  }
  return tracks;
}

export function parseM3u(content, { baseDirectory = '' } = {}) {
  const tracks = [];
  let pending = null;
  for (const rawLine of String(content).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const match = line.match(/^#EXTINF:([^,]*),(.*)$/i);
      const display = cleanText(match?.[2], '');
      const separator = display.indexOf(' - ');
      pending = {
        durationSeconds: numeric(match?.[1]),
        artist: separator >= 0 ? display.slice(0, separator) : null,
        title: separator >= 0 ? display.slice(separator + 3) : display
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    const decoded = decodeLibraryLocation(line);
    const filePath = decoded && !path.isAbsolute(decoded) && baseDirectory
      ? path.resolve(baseDirectory, decoded)
      : decoded;
    const filenameTitle = path.basename(filePath || line, path.extname(filePath || line));
    const track = normalizeTrack({
      externalTrackId: filePath || line,
      title: pending?.title || filenameTitle,
      artist: pending?.artist,
      durationSeconds: pending?.durationSeconds,
      path: filePath
    }, 'm3u');
    if (track) tracks.push(track);
    pending = null;
    if (tracks.length >= MAX_TRACKS) break;
  }
  return tracks;
}

function parseCsvRows(content) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const text = String(content).replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
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
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

function firstColumn(record, aliases) {
  for (const alias of aliases) {
    if (cleanText(record[alias])) return record[alias];
  }
  return null;
}

export function parseLibraryCsv(content) {
  const rows = parseCsvRows(content);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, ''));
  const tracks = [];
  for (const values of rows.slice(1)) {
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    const filePath = decodeLibraryLocation(firstColumn(record, ['filepath', 'filename', 'location', 'path', 'url']));
    const track = normalizeTrack({
      externalTrackId: firstColumn(record, ['trackid', 'id', 'persistentid']) || filePath,
      title: firstColumn(record, ['title', 'name', 'track']),
      artist: firstColumn(record, ['artist', 'author', 'albumartist']),
      album: firstColumn(record, ['album']),
      genre: firstColumn(record, ['genre']),
      key: firstColumn(record, ['key', 'tonality']),
      bpm: firstColumn(record, ['bpm', 'averagebpm', 'tempo']),
      durationSeconds: firstColumn(record, ['duration', 'length', 'totaltime']),
      path: filePath
    }, 'csv');
    if (track) tracks.push(track);
    if (tracks.length >= MAX_TRACKS) break;
  }
  return tracks;
}

export function detectLibraryFormat(filePath, content = '') {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.nml' || /<NML\b/i.test(content)) return 'traktor_nml';
  if (extension === '.m3u' || extension === '.m3u8') return 'm3u';
  if (extension === '.csv') return 'csv';
  if (/<DJ_PLAYLISTS\b/i.test(content)) return 'rekordbox_xml';
  if (/<VirtualDJ_Database\b/i.test(content) || /<Song\b[^>]*FilePath=/i.test(content)) return 'virtualdj_xml';
  return null;
}

export function parseLibraryExport({ filePath = '', content }) {
  const format = detectLibraryFormat(filePath, content);
  if (format === 'rekordbox_xml') return { format, tracks: parseRekordboxXml(content) };
  if (format === 'traktor_nml') return { format, tracks: parseTraktorNml(content) };
  if (format === 'virtualdj_xml') return { format, tracks: parseVirtualDjXml(content) };
  if (format === 'm3u') return { format, tracks: parseM3u(content, { baseDirectory: path.dirname(filePath) }) };
  if (format === 'csv') return { format, tracks: parseLibraryCsv(content) };
  throw new Error('Unsupported library file. Use rekordbox XML, Traktor NML, VirtualDJ XML, M3U/M3U8, or CSV.');
}

async function collectAudioFiles(rootPath, maximum = MAX_TRACKS) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maximum) return;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(entryPath);
    }
  }
  await visit(rootPath);
  return files;
}

async function parseAudioTrack(filePath) {
  let common = {};
  let format = {};
  try {
    const parsed = await parseFile(filePath, { duration: true, skipCovers: true });
    common = parsed.common || {};
    format = parsed.format || {};
  } catch {
    // An unreadable tag block should not hide a playable file from the DJ.
  }
  return normalizeTrack({
    externalTrackId: filePath,
    title: common.title || path.basename(filePath, path.extname(filePath)),
    artist: common.artist || common.albumartist,
    album: common.album,
    genre: Array.isArray(common.genre) ? common.genre.join(', ') : common.genre,
    key: common.key,
    bpm: common.bpm,
    durationSeconds: format.duration,
    path: filePath,
    metadata: { codec: cleanText(format.codec), container: cleanText(format.container) }
  }, 'audio_folder');
}

export async function importDjLibraryPath(inputPath) {
  const resolvedPath = path.resolve(inputPath);
  const pathStat = await stat(resolvedPath);
  if (pathStat.isDirectory()) {
    const files = await collectAudioFiles(resolvedPath);
    const tracks = [];
    for (const filePath of files) {
      const track = await parseAudioTrack(filePath);
      if (track) tracks.push(track);
    }
    return { format: 'audio_folder', inputPath: resolvedPath, tracks, truncated: files.length >= MAX_TRACKS };
  }
  if (!pathStat.isFile()) throw new Error('Library import path must be a file or directory.');
  const content = await readFile(resolvedPath, 'utf8');
  const parsed = parseLibraryExport({ filePath: resolvedPath, content });
  return { ...parsed, inputPath: resolvedPath, truncated: parsed.tracks.length >= MAX_TRACKS };
}

export const DJ_LIBRARY_IMPORT_FORMATS = [
  'rekordbox_xml',
  'traktor_nml',
  'virtualdj_xml',
  'm3u',
  'csv',
  'audio_folder'
];
