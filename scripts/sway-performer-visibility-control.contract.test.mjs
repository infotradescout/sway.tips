import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const server = read('server.ts');
const control = read('src/server/performer-visibility-control.ts');
const component = read('src/components/PerformerVisibilityControl.tsx');
const editor = read('src/components/PerformerPublicProfileEditor.tsx');
const handleLock = read('src/server/performer-handle-lock.ts');
const handleMigration = read('drizzle/0039_performer-handle-namespace.sql');
const packageJson = JSON.parse(read('package.json'));
const failures = [];

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(`${message}: missing ${term}`);
}

function requireExcludes(source, term, message) {
  if (source.includes(term)) failures.push(`${message}: forbidden ${term}`);
}

for (const state of ["'draft'", "'unlisted'", "'public'"]) {
  requireIncludes(control, state, 'Visibility parser state set');
}
requireIncludes(control, 'parsePerformerVisibilityState', 'Visibility parser export');
requireIncludes(component, '/api/talent/profile/visibility', 'Visibility UI mutation route');
for (const label of ['Draft', 'Unlisted', 'Public']) {
  requireIncludes(component, label, `Visibility UI label ${label}`);
}
requireIncludes(editor, 'PerformerVisibilityControl', 'Public profile editor visibility control');
for (const term of [
  'Performer display name',
  'Public handle',
  'displayName: form.displayName',
  'handle: form.handle',
  'Changing your handle changes your public URL.',
  'href={`/p/${encodeURIComponent(savedHandle)}`}',
  "new CustomEvent('sway:performer-profile-updated'",
  "new Event('re-fetch-state')"
]) {
  requireIncludes(editor, term, 'Owner public identity editor');
}

const routeStart = server.indexOf("app.post('/api/talent/profile/visibility'");
const routeEnd = server.indexOf("app.get('/api/talent/partner/terms'", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart, 'Visibility route must be locatable.');
const visibilityRoute = server.slice(routeStart, routeEnd);
for (const term of [
  'requireTalentAccess',
  'parsePerformerVisibilityState',
  'performers.ownerUserId',
  ".for('update')",
  'performers.visibilityState',
  "eventType: 'performer_visibility.update'",
  'previousStatus: performer.visibilityState',
  'nextStatus: nextVisibilityState',
  'writeAuditEvent'
]) {
  requireIncludes(visibilityRoute, term, 'Owner visibility route');
}
requireExcludes(visibilityRoute, 'req.body?.performerId', 'Owner visibility route must not trust a caller performer id');
requireIncludes(server, 'visibilityState: performerOwner.visibilityState', 'Profile responses expose persisted visibility');

for (const term of [
  "PERFORMER_HANDLE_LOCK_PREFIX = 'sway:performer-handle:v1:'",
  'canonicalPerformerHandle',
  'lockPerformerHandleNamespace',
  'pg_advisory_xact_lock',
  'hashtextextended'
]) {
  requireIncludes(handleLock, term, 'Shared performer handle namespace lock');
}

for (const term of [
  'performers_handle_not_reserved',
  'performers_handle_canonical',
  'performer_profile_previews_handle_not_reserved',
  'performer_profile_previews_handle_canonical',
  "'tickets'",
  'sway_global_performer_handle_unique',
  'sway_enforce_performer_handle_namespace',
  'sway_enforce_preview_handle_namespace',
  'pg_advisory_xact_lock',
  'performers_global_handle_namespace',
  'performer_profile_previews_global_handle_namespace'
]) {
  requireIncludes(handleMigration, term, 'Database-wide performer handle namespace invariant');
}
requireIncludes(server, 'import { lockPerformerHandleNamespace }', 'Server imports shared performer handle lock');
requireIncludes(server, 'function isPerformerHandleUniqueViolation(error: unknown)', 'Server defines performer handle race mapper');
requireIncludes(server, "'sway_global_performer_handle_unique'", 'Performer handle race mapper recognizes the global namespace constraint');

const profileStart = server.indexOf("app.post('/api/talent/profile/public'");
const libraryStart = server.indexOf("app.post('/api/talent/library/import'", profileStart);
const profileRoute = server.slice(profileStart, libraryStart);
requireIncludes(profileRoute, "operation: 'profile_save'", 'Profile saves identify their operation');
requireIncludes(profileRoute, 'previousStatus: ownedPerformer.visibilityState', 'Profile saves retain locked prior visibility in audit');
requireIncludes(profileRoute, 'nextStatus: ownedPerformer.visibilityState', 'Profile saves do not publish visibility');
requireExcludes(profileRoute, 'visibilityState: req.body', 'Profile content saves must not accept visibility from the profile payload');
for (const term of [
  'normalizePerformerDisplayName(req.body?.displayName)',
  'normalizePerformerHandle(req.body?.handle)',
  'eq(performers.ownerUserId, talentAccess.actor.actorId)',
  ".for('update')",
  'ne(performers.id, ownedPerformer.performerId)',
  'eq(performerProfilePreviews.isActive, true)',
  'activePreview.claimedPerformerId !== ownedPerformer.performerId',
  'await lockPerformerHandleNamespace(tx, normalizedHandle)',
  '...(handleProvided ? { handle: nextHandle } : {})',
  'isPerformerHandleUniqueViolation(error)',
  "return { kind: 'handle_conflict' as const }",
  "return res.status(409).json({ error: 'This handle is already taken.' })",
  'changedIdentityFields:',
  'previousHandle:',
  'nextHandle,',
  'claimedPreviewReservationUsed',
  'handle: savedLinks.handle',
  'displayName: savedLinks.displayName'
]) {
  requireIncludes(profileRoute, term, 'Owner public identity save');
}
requireExcludes(profileRoute, 'req.body?.performerId', 'Owner public identity save must not trust a caller performer id');
requireExcludes(
  profileRoute,
  "isUniqueConstraintViolation(error, 'idx_performers_handle_lower')",
  'Owner public identity save must use the centralized handle race mapper'
);

requireIncludes(packageJson.scripts?.['test:contracts'] ?? '', 'node scripts/sway-performer-visibility-control.contract.test.mjs', 'Contract gate wiring');
requireIncludes(packageJson.scripts?.['test:integration:performer-visibility-control'] ?? '', 'sway-performer-visibility-control.integration.test.ts', 'Integration gate wiring');

if (failures.length) {
  console.error('Sway performer visibility control contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway performer visibility control contract passed.');
