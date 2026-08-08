import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const server = read('server.ts');
const control = read('src/server/performer-visibility-control.ts');
const component = read('src/components/PerformerVisibilityControl.tsx');
const editor = read('src/components/PerformerPublicProfileEditor.tsx');
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

const routeStart = server.indexOf("app.post('/api/talent/profile/visibility'");
const routeEnd = server.indexOf("app.post('/api/talent/partner/terms/accept'", routeStart);
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

const profileStart = server.indexOf("app.post('/api/talent/profile/public'");
const libraryStart = server.indexOf("app.post('/api/talent/library/import'", profileStart);
const profileRoute = server.slice(profileStart, libraryStart);
requireIncludes(profileRoute, "operation: 'profile_save'", 'Profile saves identify their operation');
requireIncludes(profileRoute, 'previousStatus: performerOwner.visibilityState', 'Profile saves retain prior visibility in audit');
requireIncludes(profileRoute, 'nextStatus: performerOwner.visibilityState', 'Profile saves do not publish visibility');
requireExcludes(profileRoute, 'visibilityState: req.body', 'Profile content saves must not accept visibility from the profile payload');

requireIncludes(packageJson.scripts?.['test:contracts'] ?? '', 'node scripts/sway-performer-visibility-control.contract.test.mjs', 'Contract gate wiring');
requireIncludes(packageJson.scripts?.['test:integration:performer-visibility-control'] ?? '', 'sway-performer-visibility-control.integration.test.ts', 'Integration gate wiring');

if (failures.length) {
  console.error('Sway performer visibility control contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway performer visibility control contract passed.');
