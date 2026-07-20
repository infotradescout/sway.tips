import assert from 'node:assert/strict';
import { resolveProModeTransition } from '../src/server/pro-mode';

// Performer signup: disabled -> onboarding is the only allowed path.
assert.deepEqual(
  resolveProModeTransition({ currentStatus: 'disabled', action: 'performer_signup' }),
  { allowed: true, nextStatus: 'onboarding', changed: true }
);

for (const currentStatus of ['onboarding', 'active', 'suspended', 'revoked'] as const) {
  const result = resolveProModeTransition({ currentStatus, action: 'performer_signup' });
  assert.equal(result.allowed, false, `performer_signup must be rejected from ${currentStatus}`);
}

// Patron/listener self-activation goes straight to 'active' -- both from the
// universal 'disabled' starting point and from a performer account still
// mid-onboarding.
assert.deepEqual(
  resolveProModeTransition({ currentStatus: 'disabled', action: 'self_activate' }),
  { allowed: true, nextStatus: 'active', changed: true }
);
assert.deepEqual(
  resolveProModeTransition({ currentStatus: 'onboarding', action: 'self_activate' }),
  { allowed: true, nextStatus: 'active', changed: true }
);

// Idempotent: activating again while already active is a no-op success, not
// an error and not a duplicate transition.
assert.deepEqual(
  resolveProModeTransition({ currentStatus: 'active', action: 'self_activate' }),
  { allowed: true, nextStatus: 'active', changed: false }
);

// Suspended/revoked can never be reactivated through the self-service path --
// this is the administrative-only boundary this slice does not implement.
for (const currentStatus of ['suspended', 'revoked'] as const) {
  const result = resolveProModeTransition({ currentStatus, action: 'self_activate' });
  assert.equal(result.allowed, false, `self_activate must be rejected from ${currentStatus}`);
  if (result.allowed === false) {
    assert.match(result.reason, /contact support/i);
  }
}

console.log('Universal account Pro Mode behavior tests passed.');
