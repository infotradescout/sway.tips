import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

// One-use repair in the existing isolated build checkout. This is never a
// production startup hook or a validation result. It uses only the checkout's
// existing Git authentication, never reads credentials, and never force-pushes.
assert.equal(process.env.SWAY_ISOLATED_VALIDATION, 'true');
assert.equal(process.env.RENDER_SERVICE_ID, 'srv-daesln0u01pc73fso5kg');
const branch = 'refs/heads/audit/readiness-223-room-recovery';
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
const blobHash = content => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const hook = "await import('./sway-room-context-maintenance.mjs');\n";
try {
  const before = git(['rev-parse', 'HEAD']);
  assert.equal(before, process.env.RENDER_GIT_COMMIT);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(git(['ls-remote', 'origin', branch]).split(/\s+/)[0], before, 'The draft moved; preserve concurrent work.');
  // Fail before any file change when the host's existing Git access is read-only.
  git(['push', '--dry-run', '--porcelain', 'origin', `HEAD:${branch}`]);
  console.log('ROOM_CONTEXT_MAINTENANCE Existing draft-branch Git write access confirmed.');
  let server = readFileSync('server.ts', 'utf8');
  assert.equal(blobHash(server), '1a0627866a94f8d5032be020fcbd559d8f6419e6', 'Unexpected server source; do not apply blind replacements.');
  const replaceOne = (text, from, to) => {
    assert.equal(text.split(from).length, 2, 'Repair anchor must occur exactly once.');
    return text.replace(from, to);
  };
  server = replaceOne(server,
    "  inputState.activeGigId = inputState.session.status === 'active' ? (gigId ?? null) : null;",
    "  // This response field identifies the selected room, not registry membership.\n  // Ending and closed snapshots must retain it so clients can reject other rooms.\n  const hasRoomIdentity = inputState.session.status === 'active'\n    || inputState.session.status === 'ending'\n    || inputState.session.status === 'closed';\n  inputState.activeGigId = hasRoomIdentity ? (gigId ?? null) : null;"
  );
  server = replaceOne(server,
    '    state: prepareRoomState(snapshot.state, snapshot.activeGigId)\n  };\n}\n\nasync function persistBusinessStateForRoom',
    "    // Closed rows are no longer active, but this confirmed row still owns its recap.\n    state: prepareRoomState(snapshot.state, snapshot.roomStatus === 'ended' ? gigId : snapshot.activeGigId)\n  };\n}\n\nasync function persistBusinessStateForRoom"
  );
  writeFileSync('server.ts', server);
  const proof = spawnSync(process.execPath, ['scripts/sway-room-context.behavior.test.mjs'], { stdio: 'inherit', timeout: 30_000 });
  assert.equal(proof.status, 0, 'The actual repaired server functions must pass before saving.');
  const runner = readFileSync('scripts/sway-release-validation.mjs', 'utf8');
  writeFileSync('scripts/sway-release-validation.mjs', replaceOne(runner, hook, ''));
  unlinkSync('scripts/sway-room-context-maintenance.mjs');
  const changed = git(['diff', '--name-only']).split('\n').sort();
  assert.deepEqual(changed, ['scripts/sway-release-validation.mjs', 'scripts/sway-room-context-maintenance.mjs', 'server.ts']);
  git(['diff', '--check']);
  git(['add', '--', ...changed]);
  git(['-c', 'user.name=Sway maintenance', '-c', 'user.email=sway-maintenance@users.noreply.github.com', 'commit', '-m', 'fix: preserve ending-room and closed-recap identity']);
  const after = git(['rev-parse', 'HEAD']);
  assert.equal(git(['rev-parse', 'HEAD^']), before);
  git(['push', '--porcelain', 'origin', `HEAD:${branch}`]);
  assert.equal(git(['ls-remote', 'origin', branch]).split(/\s+/)[0], after);
  console.log(`ROOM_CONTEXT_MAINTENANCE_SAVED ${after}`);
} catch (error) {
  // Command failures can contain authenticated remote URLs. Do not print them.
  console.error('ROOM_CONTEXT_MAINTENANCE_NOT_SAVED', error instanceof assert.AssertionError ? error.message : 'Existing Git write access or the guarded maintenance command was unavailable.');
}
console.log('ROOM_CONTEXT_MAINTENANCE_ONLY No combined validation or production deployment was performed.');
process.exit(1);
