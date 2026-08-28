import assert from 'node:assert/strict';
import {
  INACTIVE_PERFORMER_WORKSPACE_PATHS,
  LEGACY_SHOWS_WORKSPACE_HASH,
  resolveInactivePerformerWorkspace,
  resolvePerformerLoginWorkspaceRedirect,
  shouldRenderPerformerLiveRoom
} from '../src/performer-workspace-routing.ts';

assert.equal(resolveInactivePerformerWorkspace('/talent'), 'home');
assert.equal(resolveInactivePerformerWorkspace('/talent/gigs'), 'room');
assert.equal(resolveInactivePerformerWorkspace('/talent/shows'), 'shows');
assert.equal(resolveInactivePerformerWorkspace('/talent/music'), 'library');
assert.equal(resolveInactivePerformerWorkspace('/talent/files'), 'catalog');
assert.equal(resolveInactivePerformerWorkspace('/talent/profile'), 'profile');
assert.equal(resolveInactivePerformerWorkspace('/talent/account'), 'account');
assert.equal(resolveInactivePerformerWorkspace('/talent/profile', LEGACY_SHOWS_WORKSPACE_HASH), 'shows');
assert.equal(resolvePerformerLoginWorkspaceRedirect('/talent', LEGACY_SHOWS_WORKSPACE_HASH), INACTIVE_PERFORMER_WORKSPACE_PATHS.shows);
assert.equal(resolvePerformerLoginWorkspaceRedirect('/talent/profile', ''), '/talent/profile');

for (const status of ['active', 'ending', 'closed']) {
  assert.equal(shouldRenderPerformerLiveRoom(status, 'home'), true);
  assert.equal(shouldRenderPerformerLiveRoom(status, 'room'), true);
  for (const workspace of ['shows', 'library', 'catalog', 'profile', 'account']) {
    assert.equal(shouldRenderPerformerLiveRoom(status, workspace), false);
  }
}
assert.equal(shouldRenderPerformerLiveRoom('inactive', 'home'), false);
assert.equal(shouldRenderPerformerLiveRoom('inactive', 'room'), false);

console.log('Performer workspace routing contract passed.');
