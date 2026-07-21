import assert from 'node:assert/strict';
import { resolvePatronRoomRecoveryBranch } from '../src/shells/PatronApp';

// A. Initial fetch exception on a room route: must resolve to the
// non-terminal connection-error branch, never the terminal no-session branch.
assert.equal(
  resolvePatronRoomRecoveryBranch({
    roomLookup: { status: 'error' },
    hasPatronRouteContext: true,
    hasSessionContext: false
  }),
  'connection-error'
);

// B. Later polling exception after an active room had already loaded: the
// transport error must still win over any lingering session context, and
// must not be reinterpreted as a confirmed-missing room.
assert.equal(
  resolvePatronRoomRecoveryBranch({
    roomLookup: { status: 'error' },
    hasPatronRouteContext: true,
    hasSessionContext: true
  }),
  'connection-error'
);

// Precedence: an 'error' status must never fall through to 'no-session' even
// when route/session context both look empty (defends against an
// implementation that folds 'error' into the same OR-clause as 'missing').
assert.equal(
  resolvePatronRoomRecoveryBranch({
    roomLookup: { status: 'error' },
    hasPatronRouteContext: false,
    hasSessionContext: false
  }),
  'connection-error'
);

// C. Recovery after transport failure: a later successful poll reporting an
// active room must resolve to room-active with no special-casing.
assert.equal(
  resolvePatronRoomRecoveryBranch({
    roomLookup: { status: 'active' },
    hasPatronRouteContext: true,
    hasSessionContext: true
  }),
  'room-active'
);

// C (continued): a later successful poll reporting a genuinely missing room
// must resolve to no-session, not linger in connection-error.
assert.equal(
  resolvePatronRoomRecoveryBranch({
    roomLookup: { status: 'missing' },
    hasPatronRouteContext: true,
    hasSessionContext: false
  }),
  'no-session'
);

// C (continued): a later successful poll reporting an ended room must
// resolve to ended, not linger in connection-error.
assert.equal(
  resolvePatronRoomRecoveryBranch({
    roomLookup: { status: 'ended' },
    hasPatronRouteContext: true,
    hasSessionContext: true
  }),
  'ended'
);

// D. Confirmed missing room (a genuinely bad/never-existed gig id) must keep
// resolving to no-session and must not be treated as a connection problem.
assert.equal(
  resolvePatronRoomRecoveryBranch({
    roomLookup: { status: 'missing' },
    hasPatronRouteContext: false,
    hasSessionContext: false
  }),
  'no-session'
);

// E. Confirmed ended room must keep resolving to ended regardless of route or
// session context, and must never be reinterpreted as active or transient.
assert.equal(
  resolvePatronRoomRecoveryBranch({
    roomLookup: { status: 'ended' },
    hasPatronRouteContext: false,
    hasSessionContext: false
  }),
  'ended'
);

// No route context and no prior session data (patron root, no gig id in the
// URL at all) is the pre-existing no-session case and must be unaffected by
// this lane.
assert.equal(
  resolvePatronRoomRecoveryBranch({
    roomLookup: { status: 'missing' },
    hasPatronRouteContext: false,
    hasSessionContext: false
  }),
  'no-session'
);

// The global-state-hook path ('/api/state' with no gig id) is unaffected by
// this lane and must still fall through to room-active once session context
// exists.
assert.equal(
  resolvePatronRoomRecoveryBranch({
    roomLookup: { status: 'global' },
    hasPatronRouteContext: false,
    hasSessionContext: true
  }),
  'room-active'
);

console.log('Patron room lookup transient error state behavior tests passed.');
