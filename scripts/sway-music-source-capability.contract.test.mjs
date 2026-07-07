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
  'accessControl.requireTalentAccess(req)',
  'getMusicSourceCapabilityCatalog({',
  'spotifyCatalogConfigured: isCatalogSearchConfigured(process.env)'
]) {
  if (!server.includes(term)) failures.push(`Server missing music source capability route behavior: ${term}`);
}

for (const forbidden of [
  "accessToken: text('access_token')",
  "refreshToken: text('refresh_token')",
  "providerToken: text('provider_token')",
  'playInSway: true'
]) {
  if (schema.includes(forbidden) || migration.includes(forbidden) || capabilities.includes(forbidden)) {
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
