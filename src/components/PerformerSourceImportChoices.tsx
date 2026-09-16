import { useId, type ChangeEvent, type FormEvent } from 'react';
import { Upload, Music2, Library, ListMusic, ArrowUpRight, ChevronDown } from 'lucide-react';
import PerformerSourcePlayerSetup from './PerformerSourcePlayerSetup';
import '../performer-workspace.css';

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
    <>
      <section data-sway-source-import-choices="true" className="sway-source-panel">
        <p className="sway-source-kicker">Add music</p>
        <h3>Bring your music with you.</h3>
        <p className="sway-source-description">Choose a library, playlist, or your own tracks.</p>

        <div className="sway-source-actions">
          <details data-sway-file-source-picker="true">
            <summary className="sway-source-action">
              <span className="sway-source-icon"><Library aria-hidden="true" /></span>
              <span><strong>Import library or setlist</strong><small>DJ apps, Apple Music, local files, and song lists</small></span>
              <span className="sway-source-action-label">Browse</span>
              <ChevronDown aria-hidden="true" />
            </summary>
            <div className="sway-source-picker-content">
              <p className="sway-source-description">Choose where your music is now. Import up to 1,000 songs at a time; larger lists are explicitly reported.</p>
              <div className="sway-source-file-grid">
                {MUSIC_FILE_SOURCES.map(source => (
                  <div key={source.name} className="sway-source-file-option">
                    <label className="sway-source-file-label">
                      <span><strong>{source.name}</strong><small>{source.detail}</small></span>
                      <Upload aria-hidden="true" />
                      <input aria-label={`Import ${source.name} file`} aria-describedby={helpId} data-sway-source-label={source.name} type="file" accept={source.accept} disabled={fileBusy} onChange={props.onDjLibraryFileImport} className="sway-source-file-input" />
                    </label>
                    <details className="sway-source-disclosure"><summary>How to export</summary><p>{source.help}</p></details>
                  </div>
                ))}
              </div>
              <details className="sway-source-disclosure">
                <summary>Other music services and DJ apps</summary>
                <p>TIDAL, SoundCloud, YouTube Music, Amazon Music, Deezer, Bandcamp, Engine DJ, djay, or another source: use a CSV, TSV, or text song list exported by your service or a library-transfer tool.</p>
                <p>This is file import only. These services are not directly connected here. A web link, login, native database, or protected audio file cannot be imported as a song list.</p>
                <label className="sway-source-file-label sway-source-button sway-source-button--wide">
                  Import exported song list <Upload aria-hidden="true" />
                  <input aria-label="Import song list from another service" aria-describedby={helpId} type="file" accept=".csv,.tsv,.txt" disabled={fileBusy} onChange={props.onDjLibraryFileImport} className="sway-source-file-input" />
                </label>
              </details>
            </div>
          </details>

          <details data-sway-spotify-source-picker="true">
            <summary className="sway-source-action">
              <span className="sway-source-icon"><ListMusic aria-hidden="true" /></span>
              <span><strong>Spotify playlist</strong><small>Add a song list using a playlist link</small></span>
              <span className="sway-source-action-label">Add link</span>
              <ChevronDown aria-hidden="true" />
            </summary>
            <form className="sway-source-form" onSubmit={props.onSpotifyPlaylistImport}>
              <input aria-label="Spotify playlist link" type="text" value={props.spotifyPlaylistUrl} onChange={event => props.onSpotifyPlaylistUrlChange(event.target.value)} placeholder="Paste a Spotify playlist link" disabled={props.previewMode || props.spotifyImportStatus === 'submitting'} className="sway-source-field" />
              <button type="submit" disabled={props.previewMode || props.spotifyImportStatus === 'submitting' || !props.spotifyPlaylistUrl.trim()} className="sway-source-button sway-source-button--primary">{props.spotifyImportStatus === 'submitting' ? 'Adding…' : 'Add playlist'}</button>
            </form>
            <p className="sway-source-description">Adds song information for requests, not Spotify playback. Availability depends on the existing playlist importer.</p>
          </details>

          <button type="button" onClick={props.onOpenCatalog} className="sway-source-action">
            <span className="sway-source-icon"><Music2 aria-hidden="true" /></span>
            <span><strong>Music uploaded to Sway</strong><small>Manage your audio files and request availability</small></span>
            <span className="sway-source-action-label">Open</span>
            <ArrowUpRight aria-hidden="true" />
          </button>
        </div>
        {props.djLibraryImportStatus === 'submitting' ? <p role="status" className="sway-source-feedback">Adding your song list…</p> : null}
        {props.djLibraryImportMessage ? <p role={props.djLibraryImportStatus === 'error' ? 'alert' : 'status'} className="sway-source-feedback">{props.djLibraryImportMessage}</p> : null}
        {props.spotifyImportMessage ? <p role={props.spotifyImportStatus === 'error' ? 'alert' : 'status'} className="sway-source-feedback">{props.spotifyImportMessage}</p> : null}
        <p id={helpId} className="sway-source-footnote">File imports add song information, not audio. They do not connect a streaming account or give playback permission.</p>
      </section>
      <PerformerSourcePlayerSetup />
    </>
  );
}
