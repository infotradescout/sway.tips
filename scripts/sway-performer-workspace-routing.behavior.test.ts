import assert from 'node:assert/strict';
import {
  INACTIVE_PERFORMER_WORKSPACE_PATHS,
  LEGACY_SHOWS_WORKSPACE_HASH,
  resolveInactivePerformerWorkspace,
  resolvePerformerLoginWorkspaceRedirect
} from '../src/performer-workspace-routing';

const canonicalWorkspaces = {
  home: '/talent',
  room: '/talent/gigs',
  shows: '/talent/shows',
  library: '/talent/music',
  catalog: '/talent/files',
  profile: '/talent/profile',
  account: '/talent/account'
} as const;

assert.deepEqual(
  INACTIVE_PERFORMER_WORKSPACE_PATHS,
  canonicalWorkspaces,
  'Every performer workspace must keep a stable canonical path.'
);

for (const [workspace, pathname] of Object.entries(canonicalWorkspaces)) {
  assert.equal(
    resolveInactivePerformerWorkspace(pathname),
    workspace,
    `${pathname} must open the ${workspace} workspace.`
  );
  assert.equal(
    resolveInactivePerformerWorkspace(`${pathname}/`),
    workspace,
    `${pathname}/ must tolerate a trailing slash.`
  );
}

assert.equal(
  resolveInactivePerformerWorkspace('/talent/shows/upcoming'),
  'home',
  'Unknown nested show paths must fail back to Home instead of impersonating a supported deep link.'
);
assert.equal(
  resolveInactivePerformerWorkspace('/talent/unknown'),
  'home',
  'Unknown performer paths must fall back to Home.'
);
assert.equal(resolveInactivePerformerWorkspace('/talent/showcase'), 'home');
assert.equal(resolveInactivePerformerWorkspace('/talent/profiled'), 'home');
assert.equal(
  resolveInactivePerformerWorkspace('/talent', LEGACY_SHOWS_WORKSPACE_HASH),
  'shows',
  'Legacy Shows bookmarks on the performer root must open Shows.'
);
assert.equal(
  resolveInactivePerformerWorkspace('/talent/profile', LEGACY_SHOWS_WORKSPACE_HASH),
  'shows',
  'Legacy Shows bookmarks inside Profile must open Shows.'
);
assert.equal(
  resolvePerformerLoginWorkspaceRedirect('/talent', LEGACY_SHOWS_WORKSPACE_HASH),
  '/talent/shows',
  'The login bridge must retain a signed-out legacy Shows bookmark.'
);
assert.equal(
  resolvePerformerLoginWorkspaceRedirect('/talent/profile', ''),
  '/talent/profile',
  'Ordinary login continuations must remain unchanged.'
);

console.log('Performer workspace routing behavior passed.');
