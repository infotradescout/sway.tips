import { useId, type ChangeEvent, type FormEvent } from 'react';
import { Upload, Music2 } from 'lucide-react';

type ImportStatus = 'idle' | 'submitting' | 'success' | 'error';
export type PerformerSourceImportChoicesProps = {
  spotifyPlaylistUrl: string;
  spotifyImportStatus: ImportStatus;
  spotifyImportMessage: string | null;
  djLibraryImportStatus: ImportStatus;
  djLibraryImportMessage: string | null;
  previewMode: boolean;
  onSpotifyPlaylistUrlChange: (value: string) => void;
  onSpotifyPlaylistImport: (event: FormEvent) => void;
  onDjLibraryFileImport: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenCatalog: () => void;
};

export const MUSIC_FILE_SOURCES = [
  { name: 'Apple Music / iTunes', accept: '.xml,.txt,.tsv', detail: 'Library or playlist XML; exported song information as text.', help: 'In Music on Mac: File → Library → Export Playlist or Export Library. Choose XML, or export playlist information as Text.' },
  { name: 'Serato', accept: '.csv,.txt,.m3u,.m3u8', detail: 'History exports: CSV, text, or M3U.', help: 'In Serato, open History, select a session, choose CSV, Text, or M3U, and export. Native .crate files are not imported here.' },
  { name: 'rekordbox', accept: '.xml,.m3u,.m3u8,.txt,.tsv', detail: 'rekordbox XML or an exported playlist.', help: 'Choose a rekordbox XML export or a song list in M3U or tab-separated text. This does not read a device database.' },
  { name: 'Traktor', accept: '.nml,.xml', detail: 'Traktor collection or playlist NML.', help: 'Export your collection or playlist as NML and choose that file.' },
  { name: 'VirtualDJ', accept: '.xml,.csv,.m3u,.m3u8', detail: 'Database XML, CSV, or M3U playlist.', help: 'Choose a VirtualDJ database XML or a playlist export. Local audio and file locations remain on your device.' },
  { name: 'Mixxx', accept: '.csv,.txt,.m3u,.m3u8,.pls', detail: 'Playlist or crate exported as CSV, text, M3U, or PLS.', help: 'Right-click a playlist or crate and choose Export. Select a supported list format, not Export Track Files.' },
  { name: 'Local / USB playlists', accept: '.m3u,.m3u8,.pls,.xspf', detail: 'M3U, M3U8, PLS, and XSPF.', help: 'Choose a playlist file from your computer or USB drive. Song information is imported; audio files are not uploaded or fetched.' },
  { name: 'Song list / setlist', accept: '.csv,.tsv,.txt', detail: 'Spreadsheets, original songs, covers, and performance setlists.', help: 'Use a Title or Name column plus Artist in CSV/TSV. Plain text accepts one title per line, or Artist - Title. No DJ software is required.' }
] as const;

export default function PerformerSourceImportChoices(props: PerformerSourceImportChoicesProps) {
  const helpId = useId();
  const fileBusy = props.previewMode || props.djLibraryImportStatus === 'submitting';
  return (
    <section data-sway-source-import-choices="true" className="rounded-2xl border border-cyan-500/20 bg-slate-950 p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.22em] text-cyan-300">Add music</p>
      <h3 className="mt-1 text-base font-black text-white">Choose where your music is now</h3>
      <p id={helpId} className="mt-2 text-xs leading-5 text-slate-300">Import song information for requests, or open your Sway uploads. File imports do not connect a streaming account, copy audio, or give playback permission. Up to 1,000 songs per import; larger lists are explicitly reported.</p>

      <details className="group mt-4 rounded-xl border border-white/10 bg-slate-900 p-3">
        <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm font-black text-white">
          Spotify playlist <span className="text-xs font-semibold text-cyan-200">Playlist link</span>
        </summary>
        <form className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]" onSubmit={props.onSpotifyPlaylistImport}>
          <input aria-label="Spotify playlist link" type="text" value={props.spotifyPlaylistUrl} onChange={event => props.onSpotifyPlaylistUrlChange(event.target.value)} placeholder="Paste a Spotify playlist link" disabled={props.previewMode || props.spotifyImportStatus === 'submitting'} className="min-h-12 min-w-0 rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-white disabled:opacity-50" />
          <button type="submit" disabled={props.previewMode || props.spotifyImportStatus === 'submitting' || !props.spotifyPlaylistUrl.trim()} className="min-h-12 rounded-xl bg-emerald-400 px-4 text-sm font-black text-slate-950 disabled:opacity-50">{props.spotifyImportStatus === 'submitting' ? 'Adding…' : 'Add playlist'}</button>
        </form>
        <p className="mt-2 text-xs leading-5 text-slate-400">Uses the existing Spotify playlist importer when available. This adds request metadata, not Spotify audio or in-app playback.</p>
        {props.spotifyImportMessage ? <p role={props.spotifyImportStatus === 'error' ? 'alert' : 'status'} className={`mt-2 text-xs ${props.spotifyImportStatus === 'error' ? 'text-rose-200' : 'text-emerald-200'}`}>{props.spotifyImportMessage}</p> : null}
      </details>

      <h4 className="mt-5 text-sm font-black text-white">Libraries, playlists, and setlists</h4>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {MUSIC_FILE_SOURCES.map(source => (
          <div key={source.name} className="min-w-0 rounded-xl border border-white/10 bg-slate-900 p-3">
            <label className={`flex min-h-12 cursor-pointer items-start justify-between gap-3 rounded-lg focus-within:ring-2 focus-within:ring-fuchsia-400 ${fileBusy ? 'opacity-50' : ''}`}>
              <span className="min-w-0"><span className="block text-sm font-black text-white">{source.name}</span><span className="mt-1 block text-xs leading-5 text-slate-400">{source.detail}</span><span className="mt-2 block text-xs font-bold text-cyan-200">Import file</span></span>
              <Upload className="mt-1 h-4 w-4 shrink-0 text-cyan-200" aria-hidden="true" />
              <input aria-label={`Import ${source.name} file`} aria-describedby={helpId} type="file" accept={source.accept} disabled={fileBusy} onChange={props.onDjLibraryFileImport} className="sr-only" />
            </label>
            <details className="mt-2 text-xs leading-5 text-slate-400"><summary className="min-h-8 cursor-pointer py-1 font-semibold text-slate-300">How to export</summary><p className="mt-1">{source.help}</p></details>
          </div>
        ))}
      </div>
      {props.djLibraryImportStatus === 'submitting' ? <p role="status" className="mt-3 text-sm text-cyan-200">Adding your song list…</p> : null}
      {props.djLibraryImportMessage ? <p role={props.djLibraryImportStatus === 'error' ? 'alert' : 'status'} className={`mt-3 text-xs leading-5 ${props.djLibraryImportStatus === 'error' ? 'text-rose-200' : 'text-emerald-200'}`}>{props.djLibraryImportMessage}</p> : null}

      <details className="mt-4 rounded-xl border border-white/10 bg-slate-900 p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-black text-white">Other music services and DJ apps</summary>
        <p className="mt-2 text-xs leading-5 text-slate-300">TIDAL, SoundCloud, YouTube Music, Amazon Music, Deezer, Bandcamp, Engine DJ, djay, or another source: use a CSV, TSV, or text song list exported by your service or a library-transfer tool.</p>
        <p className="mt-2 text-xs leading-5 text-amber-200">This is file import only. These services are not directly connected here. A web link, login, native database, or protected audio file cannot be imported as a song list.</p>
        <label className={`mt-3 flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-xl border border-cyan-400/30 px-3 text-sm font-bold text-cyan-200 focus-within:ring-2 focus-within:ring-fuchsia-400 ${fileBusy ? 'opacity-50' : ''}`}>
          Import exported song list <Upload className="h-4 w-4" aria-hidden="true" />
          <input aria-label="Import song list from another service" aria-describedby={helpId} type="file" accept=".csv,.tsv,.txt" disabled={fileBusy} onChange={props.onDjLibraryFileImport} className="sr-only" />
        </label>
      </details>

      <button type="button" onClick={props.onOpenCatalog} className="mt-4 flex min-h-14 w-full items-center gap-3 rounded-xl bg-fuchsia-600 px-4 py-3 text-left text-sm font-black text-white hover:bg-fuchsia-500">
        <Music2 className="h-5 w-5 shrink-0" aria-hidden="true" /><span>Music uploaded to Sway<span className="mt-1 block text-xs font-normal text-white/85">Open your audio files and choose which tracks people may request.</span></span>
      </button>
    </section>
  );
}
