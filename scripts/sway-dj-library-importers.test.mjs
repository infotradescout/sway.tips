import assert from 'node:assert/strict';
import {
  parseLibraryCsv,
  parseM3u,
  parseRekordboxXml,
  parseTraktorNml,
  parseVirtualDjXml
} from './lib/dj-library-importers.mjs';
import { parseDjLibraryText } from '../src/dj-library-file-parser.ts';

const rekordbox = parseRekordboxXml(`
  <DJ_PLAYLISTS Version="1.0.0">
    <COLLECTION Entries="1">
      <TRACK TrackID="42" Name="One &amp; Two" Artist="DJ Test" Album="Room" Genre="House"
        AverageBpm="124.5" Tonality="8A" TotalTime="201" Location="file://localhost/C:/Music/One%20Two.mp3" />
    </COLLECTION>
  </DJ_PLAYLISTS>
`);
assert.equal(rekordbox.length, 1);
assert.equal(rekordbox[0].title, 'One & Two');
assert.equal(rekordbox[0].metadata.path, 'C:/Music/One Two.mp3');
assert.equal(rekordbox[0].metadata.bpm, 124.5);

const traktor = parseTraktorNml(`
  <NML VERSION="20">
    <COLLECTION ENTRIES="1">
      <ENTRY TITLE="Night Drive" ARTIST="Test Artist" AUDIO_ID="abc">
        <LOCATION DIR="/:Music/:Sets/:" FILE="night-drive.flac" VOLUME="Macintosh HD" />
        <ALBUM TITLE="Late Set" />
        <INFO GENRE="Techno" KEY="Fm" BITRATE="1411" />
        <TEMPO BPM="128" />
      </ENTRY>
    </COLLECTION>
  </NML>
`);
assert.equal(traktor.length, 1);
assert.equal(traktor[0].album, 'Late Set');
assert.equal(traktor[0].metadata.path, '/Music/Sets/night-drive.flac');

const virtualDj = parseVirtualDjXml(`
  <VirtualDJ_Database Version="8.5">
    <Song FilePath="D:\\Music\\Open Up.mp3" FileSize="1234">
      <Tags Author="Booth DJ" Title="Open Up" Album="Peak" Genre="Dance" />
      <Infos SongLength="180.5" />
      <Scan Bpm="0.5" Key="Gm" />
    </Song>
  </VirtualDJ_Database>
`);
assert.equal(virtualDj.length, 1);
assert.equal(virtualDj[0].metadata.path, 'D:\\Music\\Open Up.mp3');
assert.equal(virtualDj[0].metadata.bpm, 120);

const m3u = parseM3u('#EXTM3U\n#EXTINF:245,Artist A - Track A\nMusic/track-a.mp3\n', {
  baseDirectory: '/Users/dj'
});
assert.equal(m3u.length, 1);
assert.equal(m3u[0].title, 'Track A');
assert.equal(m3u[0].metadata.path, '/Users/dj/Music/track-a.mp3');

const csv = parseLibraryCsv('Title,Artist,Album,File Path,BPM\n"Track, Live",Artist B,Set,/music/live.wav,126\n');
assert.equal(csv.length, 1);
assert.equal(csv[0].title, 'Track, Live');
assert.equal(csv[0].metadata.bpm, 126);

const browserImport = parseDjLibraryText('rekordbox.xml', `
  <DJ_PLAYLISTS><COLLECTION><TRACK TrackID="7" Name="Browser Track" Artist="Browser DJ" Location="file://localhost/C:/private.mp3" /></COLLECTION></DJ_PLAYLISTS>
`);
assert.equal(browserImport.format, 'rekordbox_xml');
assert.equal(browserImport.tracks.length, 1);
assert.equal(browserImport.tracks[0].metadata?.localLocationPresent, true);
assert.equal('path' in (browserImport.tracks[0].metadata || {}), false);

console.log('Sway DJ library importer tests passed.');
