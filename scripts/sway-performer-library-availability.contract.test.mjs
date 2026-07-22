import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

const schema = read('src/db/schema.ts');
const server = read('server.ts');
const patronView = read('src/components/PatronView.tsx');
const talentDashboard = read('src/components/TalentDashboard.tsx');
const packageJson = read('package.json');
const bridgeScript = read('scripts/sway-library-bridge.mjs');
const bridgeDoc = read('docs/SWAY_LIBRARY_CONNECTOR_BRIDGE.md');
const migration = read('drizzle/0009_performer_library_tracks.sql');
const sourceMigration = read('drizzle/0010_performer_library_sources.sql');

for (const term of [
  'export const performerLibrarySources',
  'export const performerLibraryTracks',
  "syncKeyHash: text('sync_key_hash').notNull()",
  "sourceKey: text('source_key').notNull()",
  "externalTrackId: text('external_track_id').notNull()",
  "searchableText: text('searchable_text').notNull()"
]) {
  if (!schema.includes(term)) failures.push(`Schema missing performer library term: ${term}`);
}

for (const term of [
  'CREATE TABLE "performer_library_tracks"',
  '"source_key" text NOT NULL',
  '"external_track_id" text NOT NULL',
  '"searchable_text" text NOT NULL'
]) {
  if (!migration.includes(term)) failures.push(`Migration missing performer library term: ${term}`);
}

for (const term of [
  'CREATE TABLE "performer_library_sources"',
  '"sync_key_hash" text NOT NULL',
  '"sync_key_preview" text NOT NULL'
]) {
  if (!sourceMigration.includes(term)) failures.push(`Source migration missing performer library term: ${term}`);
}

for (const term of [
  "app.get('/api/talent/library/sources'",
  "app.get('/api/talent/library/tracks'",
  "app.post('/api/talent/library/sources'",
  "app.post('/api/talent/library/sources/:sourceId/rotate-key'",
  "app.post('/api/talent/library/sources/:sourceId/revoke'",
  "app.post('/api/library/sync'",
  'performerLibraryTracks',
  'performerLibrarySources',
  'replaceExisting',
  'removedCount',
  "app.post(\"/api/music/search\"",
  "integrationMode: 'performer_library'"
]) {
  if (!server.includes(term)) failures.push(`Server missing performer library behavior: ${term}`);
}

for (const term of [
  'loadRequestableCatalogTracks',
  "sourceLabel: 'Catalog'",
  "sourceProvider: 'sway_catalog'",
  "playbackBoundary: 'sway_stored_audio'",
  "playbackBoundary: 'external_source_required'",
  "sql`${audioAssets.metadata}->>'requestable' = 'true'`"
]) {
  if (!server.includes(term)) failures.push(`Catalog source is missing from the request-library path: ${term}`);
}

if (!patronView.includes('gig_id: gigId')) {
  failures.push('PatronView must send gig_id when searching performer availability.');
}

for (const forbidden of ['Mr. Brightside', 'Dancing Queen', 'Bohemian Rhapsody']) {
  if (server.includes(forbidden)) {
    failures.push(`Server must not hardcode fake music catalog result: ${forbidden}`);
  }
}

for (const term of [
  'Music people can request',
  'Catalog is connected automatically.',
  'Your owned or cleared audio stored in Sway.',
  'Potentially copyrighted music played from Spotify, DJ software, or another external source.',
  'Advanced library connections',
  'Link Any Library Program',
  'Create linked source',
  'Sync endpoint',
  'x-sway-library-key',
  'Rotate key',
  'Revoke source',
  'Tracks available:',
  'npm run library:bridge -- --sync-key'
]) {
  if (!talentDashboard.includes(term)) failures.push(`TalentDashboard missing linked-source UX term: ${term}`);
}

for (const term of [
  'Catalog audio · stored in Sway',
  'External request music',
  'The performer plays this from Spotify, DJ software, or another external source.'
]) {
  if (!patronView.includes(term)) failures.push(`Patron search must preserve the Catalog/external boundary: ${term}`);
}

for (const term of [
  '"library:bridge": "node scripts/sway-library-bridge.mjs"',
  'Sway Library Bridge',
  'POST /ingest',
  'replaceExisting',
  'x-sway-library-key'
]) {
  if (!packageJson.includes(term) && !bridgeScript.includes(term) && !bridgeDoc.includes(term)) {
    failures.push(`Bridge implementation missing term: ${term}`);
  }
}

if (failures.length) {
  console.error('Performer library availability contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Performer library availability contract passed.');
