import { readFileSync } from 'node:fs';

const failures = [];
const read = (path) => readFileSync(path, 'utf8');
const requireIncludes = (source, expected, message) => {
  if (!source.includes(expected)) failures.push(message);
};

const schema = read('src/db/schema.ts');
const migration = read('drizzle/0037_brief_komodo.sql');
const service = read('src/server/audio-publishing-service.ts');
const server = read('server.ts');
const disclosure = read('src/components/RecordingCreationDisclosureFields.tsx');
const releaseDrafts = read('src/components/PerformerReleaseDrafts.tsx');
const releasePage = read('src/components/PublicReleasePage.tsx');
const discoverPage = read('src/components/PublicDiscoverPage.tsx');
const profilePage = read('src/components/PerformerPublicProfilePage.tsx');
const adminPage = read('src/shells/AdminReleaseReportsPage.tsx');
const adminEntry = read('src/entries/admin.tsx');
const policy = read('docs/SONGWRITER_FIRST_SYNTHETIC_MUSIC_POLICY_V1.md');
const packageJson = JSON.parse(read('package.json'));

for (const field of [
  "lyricsAuthorship: text('lyrics_authorship')",
  "compositionAuthorship: text('composition_authorship')",
  "vocalPerformance: text('vocal_performance')",
  "productionMethod: text('production_method')",
  "lyricsExcerpt: text('lyrics_excerpt')"
]) {
  requireIncludes(schema, field, `Recording schema is missing independent creation fact: ${field}`);
}
requireIncludes(schema, 'export const musicReleaseReports', 'Schema must persist community release reports.');
requireIncludes(schema, 'export const musicReleaseReportEvents', 'Schema must persist append-only report review history.');
requireIncludes(migration, 'music_release_reports_active_identity_idx', 'Migration must reject duplicate active reports.');
requireIncludes(migration, 'Music release report origin and evidence are immutable.', 'Migration must make submitted report evidence immutable.');
requireIncludes(migration, 'music_release_report_events_append_only', 'Migration must make report events append-only.');

for (const label of ['Human-written lyrics', 'Original virtual artist', 'Rights checked']) {
  requireIncludes(service, label, `Public creation policy is missing label: ${label}`);
  requireIncludes(releasePage, label, `Public release UI is missing label: ${label}`);
}
requireIncludes(service, "recording.lyricsAuthorship === 'generated'", 'Fully-generated classification must evaluate lyric authorship.');
requireIncludes(service, "recording.compositionAuthorship === 'generated'", 'Fully-generated classification must evaluate composition authorship.');
requireIncludes(service, "recording.productionMethod === 'generated'", 'Fully-generated classification must evaluate production method.');
requireIncludes(service, 'human-written lyrics require a songwriter credit', 'Human-authored lyrics must require a songwriter credit.');
requireIncludes(service, "recording.vocalPerformance === 'licensed_replica'", 'A real-performer replica must trigger the additional consent check.');
requireIncludes(service, '`${recording.recordingId}:performer_consent`', 'Replica consent must be scoped to the exact recording.');
requireIncludes(service, 'AI use by itself is not reportable', 'AI use alone must not be a community report reason.');
requireIncludes(service, 'automaticReleaseAction: false', 'Community reports must explicitly record that no automatic release action occurred.');

for (const copy of [
  'Who wrote the lyrics?',
  'Original virtual persona',
  'Public songwriter credit',
  'This does not change who wrote the lyrics.'
]) {
  requireIncludes(disclosure, copy, `Creator disclosure form is missing required copy: ${copy}`);
}
requireIncludes(disclosure, 'Your private account identity is not substituted', 'The disclosure form must preserve public pen-name privacy.');
for (const field of ['lyricsAuthorship', 'compositionAuthorship', 'vocalPerformance', 'productionMethod', 'lyricsExcerpt']) {
  requireIncludes(releaseDrafts, `${field}: leadRecording?.${field}`, `Release metadata edits must preserve lead-recording creation fact: ${field}`);
}

requireIncludes(releasePage, 'Track list · songs and writers', 'Public release must center songs and writers.');
requireIncludes(releasePage, 'Written by', 'Public release must present a prominent songwriter credit.');
requireIncludes(releasePage, 'How this recording was made', 'Synthetic production detail must be available without collapsing authorship.');
requireIncludes(releasePage, 'A report never removes or downranks a release automatically.', 'Public report copy must explain the non-automatic moderation boundary.');
requireIncludes(discoverPage, 'Human-written lyrics', 'Discovery must offer a human-written lyrics filter.');
requireIncludes(discoverPage, 'Original virtual artists', 'Discovery must offer an original virtual artist filter.');
requireIncludes(discoverPage, 'recording.lyricsExcerpt', 'Discovery search must include creator-supplied lyric excerpts.');
requireIncludes(discoverPage, "credit.role === 'songwriter'", 'Discovery search must include songwriter credits.');
requireIncludes(profilePage, 'release.creationTags.map', 'Performer release cards must show creation labels.');

for (const route of [
  "app.post('/api/public/releases/:releaseId/reports'",
  "app.get('/api/admin/release-reports'",
  "app.patch('/api/admin/release-reports/:reportId'"
]) {
  requireIncludes(server, route, `Server is missing moderation route: ${route}`);
}
requireIncludes(server, 'requireAuthenticatedAccountAccess(req)', 'Public reports must require an authenticated account.');
requireIncludes(server, 'requireAdminAccess(req)', 'Report review must require administrator access.');
requireIncludes(adminEntry, "'/admin/release-reports'", 'Admin entry point must route to the release report queue.');
requireIncludes(adminPage, 'Evidence-based community moderation', 'Admin queue must state its evidence standard.');
requireIncludes(adminPage, 'never change release status or discovery rank automatically', 'Admin queue must preserve the no-automatic-action boundary.');

for (const truth of [
  'A songwriter does not stop being a songwriter',
  'must not be collapsed into one stigmatizing “AI song” label',
  'Sway does not downrank a release',
  '“Uses AI,” “uses a virtual artist,”',
  'does not change payouts, publishing splits, DSP delivery, pricing'
]) {
  requireIncludes(policy, truth, `Policy is missing governing truth: ${truth}`);
}

if (!(packageJson.scripts?.['test:contracts'] || '').includes('sway-songwriter-first-synthetic-music.contract.test.mjs')) {
  failures.push('The hard contract gate must include the songwriter-first synthetic music contract.');
}

if (failures.length) {
  console.error('Songwriter-first synthetic music contract failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Songwriter-first synthetic music contract passed.');
