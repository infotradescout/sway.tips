import assert from 'node:assert/strict';
import type { StripeConnectService } from '../src/server/stripe-connect';
import type { StripeConnectOnboardingStore } from '../src/server/stripe-connect-onboarding-store';
import { provisionStripeConnectRecipient } from '../src/server/stripe-connect-onboarding';

const performerId = '10000000-0000-4000-8000-000000000001';
const ownerUserId = '20000000-0000-4000-8000-000000000002';

function createInMemoryStore(options: { verified?: boolean; failCompleteOnce?: boolean } = {}) {
  let leaseToken: string | null = null;
  let boundAccountId: string | null = null;
  let failCompleteOnce = options.failCompleteOnce ?? false;
  const operationKey = `sway-connect-recipient:${performerId}:owner:${ownerUserId}:v1`;

  const store = {
    async reserve() {
      if (options.verified === false) return { kind: 'unverified' as const };
      if (boundAccountId) return { kind: 'bound' as const, accountId: boundAccountId };
      if (leaseToken) return { kind: 'busy' as const };
      leaseToken = crypto.randomUUID();
      return {
        kind: 'reserved' as const,
        leaseToken,
        operationKey,
        displayName: 'Pilot Performer',
        contactEmail: 'verified@example.test'
      };
    },
    async complete(input: { leaseToken: string; accountId: string }) {
      if (failCompleteOnce) {
        failCompleteOnce = false;
        throw new Error('injected_database_write_failure');
      }
      assert.equal(input.leaseToken, leaseToken);
      boundAccountId = input.accountId;
      leaseToken = null;
      return { accountId: input.accountId };
    },
    async fail(input: { leaseToken: string }) {
      if (input.leaseToken === leaseToken) leaseToken = null;
    }
  } as unknown as StripeConnectOnboardingStore;

  return {
    store,
    getBoundAccountId: () => boundAccountId,
    operationKey
  };
}

function createIdempotentStripe() {
  const accountByOperation = new Map<string, string>();
  let createInvocations = 0;
  let distinctAccountsCreated = 0;

  const stripe = {
    async createRecipientAccount(input: { operationKey: string }) {
      createInvocations += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      let accountId = accountByOperation.get(input.operationKey);
      if (!accountId) {
        distinctAccountsCreated += 1;
        accountId = `acct_test_${distinctAccountsCreated}`;
        accountByOperation.set(input.operationKey, accountId);
      }
      return { accountId };
    },
    async createOnboardingLink() {
      return { url: 'https://connect.stripe.test/onboarding' };
    },
    async createManagementLink() {
      return { url: 'https://connect.stripe.test/management' };
    },
    async getAccountStatus() {
      return { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
    },
    async parseAccountUpdatedEvent() {
      return null;
    }
  } as StripeConnectService;

  return {
    stripe,
    getCreateInvocations: () => createInvocations,
    getDistinctAccountsCreated: () => distinctAccountsCreated
  };
}

{
  const memory = createInMemoryStore();
  const provider = createIdempotentStripe();
  const [first, concurrent] = await Promise.all([
    provisionStripeConnectRecipient({ performerId, ownerUserId, store: memory.store, stripe: provider.stripe }),
    provisionStripeConnectRecipient({ performerId, ownerUserId, store: memory.store, stripe: provider.stripe })
  ]);

  assert.equal(first.kind, 'bound');
  assert.equal(concurrent.kind, 'busy');
  assert.equal(provider.getCreateInvocations(), 1);
  assert.equal(provider.getDistinctAccountsCreated(), 1);
  assert.equal(memory.getBoundAccountId(), 'acct_test_1');

  const replay = await provisionStripeConnectRecipient({
    performerId,
    ownerUserId,
    store: memory.store,
    stripe: provider.stripe
  });
  assert.deepEqual(replay, { kind: 'bound', accountId: 'acct_test_1' });
  assert.equal(provider.getCreateInvocations(), 1, 'A durable binding must skip Stripe on replay.');
}

{
  const memory = createInMemoryStore({ failCompleteOnce: true });
  const provider = createIdempotentStripe();

  await assert.rejects(
    provisionStripeConnectRecipient({ performerId, ownerUserId, store: memory.store, stripe: provider.stripe }),
    /injected_database_write_failure/
  );
  assert.equal(memory.getBoundAccountId(), null);

  const retry = await provisionStripeConnectRecipient({
    performerId,
    ownerUserId,
    store: memory.store,
    stripe: provider.stripe
  });
  assert.deepEqual(retry, { kind: 'bound', accountId: 'acct_test_1' });
  assert.equal(provider.getCreateInvocations(), 2, 'The retry must reconcile through the same durable operation key.');
  assert.equal(provider.getDistinctAccountsCreated(), 1, 'A DB failure followed by retry must not create a second Stripe account.');
  assert.equal(memory.getBoundAccountId(), 'acct_test_1');
}

{
  const memory = createInMemoryStore({ verified: false });
  const provider = createIdempotentStripe();
  const result = await provisionStripeConnectRecipient({
    performerId,
    ownerUserId,
    store: memory.store,
    stripe: provider.stripe
  });
  assert.deepEqual(result, { kind: 'unverified' });
  assert.equal(provider.getCreateInvocations(), 0, 'An unverified owner must not reach Stripe.');
}

console.log('Stripe Connect durable provisioning behavior test passed.');
