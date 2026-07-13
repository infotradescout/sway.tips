import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

const schema = read('src/db/schema.ts');
const migrationPath = 'drizzle/0015_performer_music_source_connections.sql';
const migration = existsSync(join(root, migrationPath)) ? read(migrationPath) : '';
const server = read('server.ts');
const capabilities = read('src/server/music-source-capabilities.ts');
const talentDashboard = read('src/components/TalentDashboard.tsx');
const patronView = read('src/components/PatronView.tsx');
const spotifyCatalog = read('src/server/spotify-catalog.ts');
const types = read('src/types.ts');
const packageJson = read('package.json');

for (const term of [
  'export const performerMusicSourceConnections',
  "providerKey: text('provider_key').notNull()",
  "sourceMode: text('source_mode').notNull()",
  "connectionStatus: text('connection_status').notNull().default('not_connected')",
  "authStatus: text('auth_status').notNull().default('not_connected')",
  "capabilitySnapshot: jsonb('capability_snapshot').notNull()",
  "tokenVaultRef: text('token_vault_ref')",
  'performer_music_source_connections_provider_account_idx'
]) {
  if (!schema.includes(term)) failures.push(`Schema missing music source capability term: ${term}`);
}

for (const term of [
  'CREATE TABLE "performer_music_source_connections"',
  '"provider_key" text NOT NULL',
  '"source_mode" text NOT NULL',
  '"connection_status" text DEFAULT \'not_connected\' NOT NULL',
  '"auth_status" text DEFAULT \'not_connected\' NOT NULL',
  '"capability_snapshot" jsonb NOT NULL',
  '"token_vault_ref" text'
]) {
  if (!migration.includes(term)) failures.push(`Migration missing music source capability term: ${term}`);
}

for (const term of [
  "providerKey: 'spotify'",
  "providerKey: 'soundcloud'",
  "providerKey: 'local_library'",
  "providerKey: 'sway_upload'",
  'playInSway: false',
  'requiresTrackAvailabilityCheck: true',
  'Sway must not claim venue playback from Spotify',
  'SoundCloud access depends on OAuth'
]) {
  if (!capabilities.includes(term)) failures.push(`Capability catalog missing required term: ${term}`);
}

for (const term of [
  "app.get('/api/talent/music/source-capabilities'",
  "app.post('/api/talent/music/spotify/import-playlist'",
  'accessControl.requireTalentAccess(req)',
  'getMusicSourceCapabilityCatalog({',
  'spotifyCatalogConfigured: isCatalogSearchConfigured(process.env)',
  'importSpotifyPlaylist({',
  "playbackMode: 'open_in_spotify'",
  "sourceProvider: 'spotify'",
  'spotifyUrl: typeof (row.metadata as any)?.spotifyUrl'
]) {
  if (!server.includes(term)) failures.push(`Server missing music source capability route behavior: ${term}`);
}

for (const term of [
  'export async function importSpotifyPlaylist',
  'resolveSpotifyPlaylistId',
  "https://api.spotify.com/v1/playlists/${playlistId}",
  'SpotifyPlaylistImportTrack',
  'externalTrackId: `spotify:${track.id}`'
]) {
  if (!spotifyCatalog.includes(term)) failures.push(`Spotify catalog missing playlist import behavior: ${term}`);
}

for (const term of [
  'data-sway-music-sources-panel="true"',
  'data-sway-spotify-playlist-import="true"',
  "fetch('/api/talent/music/source-capabilities')",
  "fetch('/api/talent/music/spotify/import-playlist'",
  'Music Sources',
  'Synced tracks',
  'Spotify playlist import',
  'Open in Spotify',
  'Connect SoundCloud',
  'No Sway playback',
  'Metadata only',
  'Metadata',
  'Library sync',
  'Open source',
  '<SpotifyOpenLink request={request} />'
]) {
  if (!talentDashboard.includes(term)) failures.push(`TalentDashboard missing music sources panel term: ${term}`);
}

for (const term of [
  'sourceProvider?: string',
  'spotifyUri?: string',
  'spotifyUrl?: string',
  'sourceProvider: selectedTrack?.sourceProvider',
  'spotifyUrl: selectedTrack?.spotifyUrl'
]) {
  if (!patronView.includes(term)) failures.push(`PatronView missing provider metadata propagation term: ${term}`);
}

for (const term of [
  'sourceProvider?: string | null;',
  'spotifyUri?: string | null;',
  'spotifyUrl?: string | null;'
]) {
  if (!types.includes(term)) failures.push(`RequestItem missing provider metadata term: ${term}`);
}

for (const forbidden of [
  "accessToken: text('access_token')",
  "refreshToken: text('refresh_token')",
  "providerToken: text('provider_token')",
  'playInSway: true',
  'Spotify plays from Sway',
  'SoundCloud plays from Sway',
  'Spotify playback'
]) {
  if (schema.includes(forbidden) || migration.includes(forbidden) || capabilities.includes(forbidden) || talentDashboard.includes(forbidden) || server.includes(forbidden)) {
    failures.push(`Music source capability slice must not add raw token storage or playback enablement: ${forbidden}`);
  }
}

if (!packageJson.includes('node scripts/sway-music-source-capability.contract.test.mjs')) {
  failures.push('package.json must register the music source capability contract in test:contracts.');
}

if (failures.length) {
  console.error('Music source capability contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Music source capability contract passed.');
