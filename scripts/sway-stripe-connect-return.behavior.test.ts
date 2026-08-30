import assert from 'node:assert/strict';
import { handleStripeConnectReturn } from '../src/server/stripe-connect-return';

const ownerId = '10000000-0000-4000-8000-000000000001';
const performerId = '20000000-0000-4000-8000-000000000001';
const accountId = 'acct_return_test';
const ready = { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };

function responseRecorder() {
  const redirects: Array<{ status: number; path: string }> = [];
  return {
    redirects,
    response: {
      redirect(status: number, path: string) {
        redirects.push({ status, path });
      }
    }
  };
}

{
  const { response, redirects } = responseRecorder();
  let touchedProvider = false;
  await handleStripeConnectReturn({
    req: {},
    res: response,
    runtimeAvailable: true,
    requireTalentAccess: async () => ({ allowed: false }),
    loadOwnedPerformer: async () => null,
    getAccountStatus: async () => {
      touchedProvider = true;
      return ready;
    },
    applyStatus: async () => ({ kind: 'not_found' })
  });
  assert.deepEqual(redirects, [{ status: 303, path: '/talent/account?connect=auth' }]);
  assert.equal(touchedProvider, false);
}

{
  const { response, redirects } = responseRecorder();
  let logged = false;
  await handleStripeConnectReturn({
    req: {},
    res: response,
    runtimeAvailable: true,
    requireTalentAccess: async () => {
      throw new Error('session database unavailable');
    },
    loadOwnedPerformer: async () => ({ performerId, stripeAccountId: accountId }),
    getAccountStatus: async () => ready,
    applyStatus: async () => ({ kind: 'updated', performerId }),
    logError: () => {
      logged = true;
    }
  });
  assert.equal(logged, true);
  assert.deepEqual(redirects, [{ status: 303, path: '/talent/account?connect=pending' }]);
}

{
  const { response, redirects } = responseRecorder();
  let loadedOwner = false;
  await handleStripeConnectReturn({
    req: {},
    res: response,
    runtimeAvailable: false,
    requireTalentAccess: async () => ({ allowed: true, actor: { actorId: ownerId } }),
    loadOwnedPerformer: async () => {
      loadedOwner = true;
      return { performerId, stripeAccountId: accountId };
    },
    getAccountStatus: async () => ready,
    applyStatus: async () => ({ kind: 'updated', performerId })
  });
  assert.equal(loadedOwner, false);
  assert.deepEqual(redirects, [{ status: 303, path: '/talent/account?connect=pending' }]);
}

{
  const { response, redirects } = responseRecorder();
  await handleStripeConnectReturn({
    req: {},
    res: response,
    runtimeAvailable: true,
    requireTalentAccess: async () => ({ allowed: true, actor: { actorId: ownerId } }),
    loadOwnedPerformer: async () => null,
    getAccountStatus: async () => ready,
    applyStatus: async () => ({ kind: 'updated', performerId })
  });
  assert.deepEqual(redirects, [{ status: 303, path: '/talent/account?connect=pending' }]);
}

{
  const { response, redirects } = responseRecorder();
  let logged = false;
  await handleStripeConnectReturn({
    req: {},
    res: response,
    runtimeAvailable: true,
    requireTalentAccess: async () => ({ allowed: true, actor: { actorId: ownerId } }),
    loadOwnedPerformer: async () => {
      throw new Error('database unavailable while loading owner');
    },
    getAccountStatus: async () => ready,
    applyStatus: async () => ({ kind: 'updated', performerId }),
    logError: () => {
      logged = true;
    }
  });
  assert.equal(logged, true);
  assert.deepEqual(redirects, [{ status: 303, path: '/talent/account?connect=pending' }]);
}

{
  const { response, redirects } = responseRecorder();
  let applied: unknown = null;
  await handleStripeConnectReturn({
    req: { query: { account: 'acct_attacker_supplied' } },
    res: response,
    runtimeAvailable: true,
    requireTalentAccess: async () => ({ allowed: true, actor: { actorId: ownerId } }),
    loadOwnedPerformer: async (requestedOwnerId) => {
      assert.equal(requestedOwnerId, ownerId);
      return { performerId, stripeAccountId: accountId };
    },
    getAccountStatus: async (requestedAccountId) => {
      assert.equal(requestedAccountId, accountId);
      return ready;
    },
    applyStatus: async (input) => {
      applied = input;
      return { kind: 'updated', performerId };
    }
  });
  assert.deepEqual(applied, { performerId, ownerUserId: ownerId, accountId, providerStatus: ready });
  assert.deepEqual(redirects, [{ status: 303, path: '/talent/account?connect=return' }]);
}

for (const failure of ['provider', 'database'] as const) {
  const { response, redirects } = responseRecorder();
  let applied = false;
  let logged = false;
  await handleStripeConnectReturn({
    req: {},
    res: response,
    runtimeAvailable: true,
    requireTalentAccess: async () => ({ allowed: true, actor: { actorId: ownerId } }),
    loadOwnedPerformer: async () => ({ performerId, stripeAccountId: accountId }),
    getAccountStatus: async () => {
      if (failure === 'provider') throw new Error('provider unavailable');
      return ready;
    },
    applyStatus: async () => {
      applied = true;
      if (failure === 'database') throw new Error('database unavailable');
      return { kind: 'updated', performerId };
    },
    logError: () => {
      logged = true;
    }
  });
  assert.equal(applied, failure === 'database');
  assert.equal(logged, true);
  assert.deepEqual(redirects, [{ status: 303, path: '/talent/account?connect=pending' }]);
}

{
  const { response, redirects } = responseRecorder();
  await handleStripeConnectReturn({
    req: {},
    res: response,
    runtimeAvailable: true,
    requireTalentAccess: async () => ({ allowed: true, actor: { actorId: ownerId } }),
    loadOwnedPerformer: async () => ({ performerId, stripeAccountId: accountId }),
    getAccountStatus: async () => ready,
    applyStatus: async () => ({ kind: 'not_found' })
  });
  assert.deepEqual(redirects, [{ status: 303, path: '/talent/account?connect=pending' }]);
}

{
  const { response, redirects } = responseRecorder();
  await handleStripeConnectReturn({
    req: {},
    res: response,
    runtimeAvailable: true,
    requireTalentAccess: async () => ({ allowed: true, actor: { actorId: ownerId } }),
    loadOwnedPerformer: async () => ({ performerId, stripeAccountId: accountId }),
    getAccountStatus: async () => ready,
    applyStatus: async () => ({ kind: 'unchanged', performerId })
  });
  assert.deepEqual(redirects, [{ status: 303, path: '/talent/account?connect=return' }]);
}

console.log('Stripe Connect return behavior test passed.');
