import { parseDjLibraryText as parseLegacyLibrary, type DjLibraryImportResult as LegacyResult } from './dj-library-legacy-parser';
import { parseAdditionalMusicList } from './music-list-import';
export type { DjLibraryImportTrack } from './dj-library-legacy-parser';

export type DjLibraryImportResult = Omit<LegacyResult, 'format'> & {
  format: LegacyResult['format'] | 'apple_music_xml' | 'tsv' | 'text' | 'pls' | 'xspf';
};

export function parseDjLibraryText(fileName: string, content: string): DjLibraryImportResult {
  const additional = parseAdditionalMusicList(fileName, content);
  if (additional) return additional;
  try { return parseLegacyLibrary(fileName, content); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('Use a rekordbox')) {
      throw new Error('Choose an Apple Music/iTunes XML, rekordbox XML, Traktor NML, VirtualDJ XML, M3U/M3U8, PLS, XSPF, CSV, TSV, or plain TXT song list. Audio files belong in Sway uploads.');
    }
    throw error;
  }
}

export async function parseDjLibraryFile(file: File): Promise<DjLibraryImportResult> {
  if (file.size > 25_000_000) throw new Error('Library export must be 25 MB or smaller. Use the local bridge for larger libraries.');
  // Apple and Windows exports may be UTF-16. Decode only the uploaded file;
  // neither playlist locations nor external entities are fetched or uploaded.
  if (typeof file.arrayBuffer !== 'function') return parseDjLibraryText(file.name, await file.text());
  const bytes = new Uint8Array(await file.arrayBuffer());
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return parseDjLibraryText(file.name, new TextDecoder(encoding, { fatal: true }).decode(bytes));
}
