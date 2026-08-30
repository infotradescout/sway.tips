import assert from 'node:assert/strict';
import { preparePayoutSetup } from '../src/server/payout-setup';

const accountId = 'acct_payout_setup_test';

function harness(overrides: Partial<Parameters<typeof preparePayoutSetup>[0]> = {}) {
  const calls: string[] = [];
  const input: Parameters<typeof preparePayoutSetup>[0] = {
    useManagementPortal: false,
    provision: async () => {
      calls.push('provision');
      return { kind: 'bound', accountId };
    },
    createOnboardingLink: async (requestedAccountId) => {
      assert.equal(requestedAccountId, accountId);
      calls.push('create_onboarding_link');
      return { url: 'https://provider.test/onboard' };
    },
    createManagementLink: async (requestedAccountId) => {
      assert.equal(requestedAccountId, accountId);
      calls.push('create_management_link');
      return { url: 'https://provider.test/manage' };
    },
    persistDestination: async () => {
      calls.push('persist_destination');
      return { kind: 'updated' };
    },
    ...overrides
  };
  return { calls, input };
}

for (const kind of ['busy', 'unverified', 'not_found'] as const) {
  const { calls, input } = harness({
    provision: async () => {
      calls.push('provision');
      return { kind };
    }
  });
  assert.deepEqual(await preparePayoutSetup(input), { kind });
  assert.deepEqual(calls, ['provision'], `${kind} must not create a link or persist a preference`);
}

{
  const { calls, input } = harness({
    createOnboardingLink: async () => {
      calls.push('create_onboarding_link');
      throw new Error('provider link unavailable');
    }
  });
  await assert.rejects(preparePayoutSetup(input), /provider link unavailable/);
  assert.deepEqual(calls, ['provision', 'create_onboarding_link']);
}

{
  const { calls, input } = harness({
    persistDestination: async () => {
      calls.push('persist_destination');
      throw new Error('preference store unavailable');
    }
  });
  await assert.rejects(preparePayoutSetup(input), /preference store unavailable/);
  assert.deepEqual(calls, ['provision', 'create_onboarding_link', 'persist_destination']);
}

{
  const { calls, input } = harness({
    persistDestination: async () => {
      calls.push('persist_destination');
      return { kind: 'not_found' };
    }
  });
  assert.deepEqual(await preparePayoutSetup(input), { kind: 'not_found' });
  assert.deepEqual(calls, ['provision', 'create_onboarding_link', 'persist_destination']);
}

{
  const { calls, input } = harness();
  assert.deepEqual(await preparePayoutSetup(input), {
    kind: 'ready',
    url: 'https://provider.test/onboard',
    accountId,
    setupSurface: 'onboarding'
  });
  assert.deepEqual(calls, ['provision', 'create_onboarding_link', 'persist_destination']);
}

{
  const { calls, input } = harness({ persistDestination: undefined });
  assert.deepEqual(await preparePayoutSetup(input), {
    kind: 'ready',
    url: 'https://provider.test/onboard',
    accountId,
    setupSurface: 'onboarding'
  });
  assert.deepEqual(calls, ['provision', 'create_onboarding_link'], 'legacy omitted destination must not invent or persist a preference');
}

{
  const { calls, input } = harness({ useManagementPortal: true });
  assert.deepEqual(await preparePayoutSetup(input), {
    kind: 'ready',
    url: 'https://provider.test/manage',
    accountId,
    setupSurface: 'management'
  });
  assert.deepEqual(calls, ['provision', 'create_management_link', 'persist_destination']);
}

console.log('Payout setup ordering behavior test passed.');
