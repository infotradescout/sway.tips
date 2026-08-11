import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { transferPerformerOwnership } from '../src/server/account-claim';
import { provisionStripeConnectRecipient } from '../src/server/stripe-connect-onboarding';
import { createStripeConnectOnboardingStore } from '../src/server/stripe-connect-onboarding-store';
import type { StripeConnectService } from '../src/server/stripe-connect';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

const ids = {
  providerOwner: '10000000-0000-4000-8000-000000000011',
  providerRecipient: '10000000-0000-4000-8000-000000000012',
  providerPerformer: '20000000-0000-4000-8000-000000000011',
  raceOwner: '10000000-0000-4000-8000-000000000021',
  raceRecipient: '10000000-0000-4000-8000-000000000022',
  racePerformer: '20000000-0000-4000-8000-000000000021',
  staleOwner: '10000000-0000-4000-8000-000000000031',
  stalePerformer: '20000000-0000-4000-8000-000000000031',
  boundOwner: '10000000-0000-4000-8000-000000000041',
  boundRecipient: '10000000-0000-4000-8000-000000000042',
  boundPerformer: '20000000-0000-4000-8000-000000000041'
} as const;

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      throw new Error(`${label} exceeded ${timeoutMs}ms; possible lock-order deadlock.`);
    })
  ]);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const proof = await startEmbeddedPostgresProof('stripe_connect_ownership_concurrency');
if (process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF === 'true') {
  assert.equal(proof.kind, 'real-postgres', 'Strict ownership concurrency proof requires standalone PostgreSQL.');
}

const dbA = createSwayDb(proof.databaseUrl);
const dbB = createSwayDb(proof.databaseUrl);

try {
  await dbA.insert(schema.users).values([
    { id: ids.providerOwner, email: 'provider-owner@example.test', displayName: 'Provider Owner', emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), proModeStatus: 'active' },
    { id: ids.providerRecipient, email: 'provider-recipient@example.test', displayName: 'Provider Recipient', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() },
    { id: ids.raceOwner, email: 'race-owner@example.test', displayName: 'Race Owner', emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), proModeStatus: 'active' },
    { id: ids.raceRecipient, email: 'race-recipient@example.test', displayName: 'Race Recipient', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() },
    { id: ids.staleOwner, email: 'stale-owner@example.test', displayName: 'Stale Owner', emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), proModeStatus: 'active' },
    { id: ids.boundOwner, email: 'bound-owner@example.test', displayName: 'Bound Owner', emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), proModeStatus: 'active' },
    { id: ids.boundRecipient, email: 'bound-recipient@example.test', displayName: 'Bound Recipient', emailVerifiedAt: new Date(), termsAcceptedAt: new Date() }
  ]);

  await dbA.insert(schema.performers).values([
    { id: ids.providerPerformer, ownerUserId: ids.providerOwner, displayName: 'Provider Gap Performer', handle: 'provider-gap-performer', onboardingStatus: 'created' },
    { id: ids.racePerformer, ownerUserId: ids.raceOwner, displayName: 'Completion Race Performer', handle: 'completion-race-performer', onboardingStatus: 'created' },
    { id: ids.stalePerformer, ownerUserId: ids.staleOwner, displayName: 'Stale Lease Performer', handle: 'stale-lease-performer', onboardingStatus: 'created' },
    { id: ids.boundPerformer, ownerUserId: ids.boundOwner, displayName: 'Already Bound Performer', handle: 'already-bound-performer', onboardingStatus: 'created', stripeConnectedAccountId: 'acct_already_bound' }
  ]);

  // Reproduce the external-provider gap: the Stripe account exists, but the
  // provider call has not returned and Sway has not bound it yet. The durable
  // operation row must fence transfer throughout that gap.
  const providerCreated = deferred();
  const allowProviderReturn = deferred();
  const providerStripe = {
    async createRecipientAccount() {
      providerCreated.resolve();
      await allowProviderReturn.promise;
      return { accountId: 'acct_provider_gap' };
    }
  } as unknown as StripeConnectService;
  const providerStore = createStripeConnectOnboardingStore(dbA);
  const providerProvisioning = provisionStripeConnectRecipient({
    performerId: ids.providerPerformer,
    ownerUserId: ids.providerOwner,
    store: providerStore,
    stripe: providerStripe
  });

  await within(providerCreated.promise, 'provider creation checkpoint');
  const providerGapTransfer = await within(dbB.transaction((tx) => transferPerformerOwnership(tx, {
    performerId: ids.providerPerformer,
    fromUserId: ids.providerOwner,
    toUserId: ids.providerRecipient
  })), 'provider-gap ownership transfer');
  assert.deepEqual(providerGapTransfer, { ok: false, code: 'stripe_connect_provisioning_in_progress' });
  allowProviderReturn.resolve();
  const providerBound = await within(providerProvisioning, 'provider-gap completion');
  assert.deepEqual(providerBound, { kind: 'bound', accountId: 'acct_provider_gap' });

  // Race completion and ownership transfer from independent database handles.
  // Both paths lock performer -> operation; completion must stay bounded and
  // transfer must lose without changing the owner or account identity.
  const raceStore = createStripeConnectOnboardingStore(dbA);
  const raceReservation = await raceStore.reserve({ performerId: ids.racePerformer, ownerUserId: ids.raceOwner });
  assert.equal(raceReservation.kind, 'reserved');
  if (raceReservation.kind !== 'reserved') throw new Error('Expected race reservation.');

  const [raceCompletion, raceTransfer] = await within(Promise.all([
    raceStore.complete({
      performerId: ids.racePerformer,
      ownerUserId: ids.raceOwner,
      leaseToken: raceReservation.leaseToken,
      operationKey: raceReservation.operationKey,
      accountId: 'acct_completion_race'
    }),
    dbB.transaction((tx) => transferPerformerOwnership(tx, {
      performerId: ids.racePerformer,
      fromUserId: ids.raceOwner,
      toUserId: ids.raceRecipient
    }))
  ]), 'concurrent completion and ownership transfer');
  assert.deepEqual(raceCompletion, { accountId: 'acct_completion_race' });
  assert.equal(raceTransfer.ok, false);
  if (raceTransfer.ok) throw new Error('Concurrent transfer unexpectedly succeeded.');
  assert.ok(
    ['stripe_connect_provisioning_in_progress', 'payment_account_configured'].includes(raceTransfer.code),
    `Unexpected concurrent transfer result: ${raceTransfer.code}`
  );

  // An expired lease can be reclaimed, but the stale completion must never
  // bind its account after the new owner-bound lease takes over.
  let clock = new Date('2026-08-11T00:00:00.000Z');
  const staleStore = createStripeConnectOnboardingStore(dbA, () => new Date(clock));
  const staleReservation = await staleStore.reserve({ performerId: ids.stalePerformer, ownerUserId: ids.staleOwner });
  assert.equal(staleReservation.kind, 'reserved');
  if (staleReservation.kind !== 'reserved') throw new Error('Expected initial stale-lease reservation.');
  clock = new Date(clock.getTime() + 2 * 60 * 1000 + 1);
  const replacementReservation = await staleStore.reserve({ performerId: ids.stalePerformer, ownerUserId: ids.staleOwner });
  assert.equal(replacementReservation.kind, 'reserved');
  if (replacementReservation.kind !== 'reserved') throw new Error('Expected replacement stale-lease reservation.');
  await assert.rejects(staleStore.complete({
    performerId: ids.stalePerformer,
    ownerUserId: ids.staleOwner,
    leaseToken: staleReservation.leaseToken,
    operationKey: staleReservation.operationKey,
    accountId: 'acct_stale_completion'
  }), /stripe_connect_operation_lease_conflict/);
  await staleStore.complete({
    performerId: ids.stalePerformer,
    ownerUserId: ids.staleOwner,
    leaseToken: replacementReservation.leaseToken,
    operationKey: replacementReservation.operationKey,
    accountId: 'acct_replacement_completion'
  });

  // A legacy/already-bound performer is fenced even if no provisioning row
  // exists, so transfer cannot detach identity from its payout account.
  const boundTransfer = await dbB.transaction((tx) => transferPerformerOwnership(tx, {
    performerId: ids.boundPerformer,
    fromUserId: ids.boundOwner,
    toUserId: ids.boundRecipient
  }));
  assert.deepEqual(boundTransfer, { ok: false, code: 'payment_account_configured' });

  const finalPerformers = await dbA.select({
    id: schema.performers.id,
    ownerUserId: schema.performers.ownerUserId,
    accountId: schema.performers.stripeConnectedAccountId
  }).from(schema.performers);
  const finalById = new Map(finalPerformers.map((performer) => [performer.id, performer]));
  assert.deepEqual(finalById.get(ids.providerPerformer), {
    id: ids.providerPerformer,
    ownerUserId: ids.providerOwner,
    accountId: 'acct_provider_gap'
  });
  assert.deepEqual(finalById.get(ids.racePerformer), {
    id: ids.racePerformer,
    ownerUserId: ids.raceOwner,
    accountId: 'acct_completion_race'
  });
  assert.deepEqual(finalById.get(ids.stalePerformer), {
    id: ids.stalePerformer,
    ownerUserId: ids.staleOwner,
    accountId: 'acct_replacement_completion'
  });
  assert.deepEqual(finalById.get(ids.boundPerformer), {
    id: ids.boundPerformer,
    ownerUserId: ids.boundOwner,
    accountId: 'acct_already_bound'
  });

  const [staleOperation] = await dbA.select().from(schema.stripeConnectOnboardingOperations)
    .where(eq(schema.stripeConnectOnboardingOperations.performerId, ids.stalePerformer));
  assert.equal(staleOperation.status, 'bound');
  assert.equal(staleOperation.stripeAccountId, 'acct_replacement_completion');
  const staleAuditEvents = await dbA.select({ eventId: schema.auditEvents.eventId }).from(schema.auditEvents)
    .where(eq(schema.auditEvents.actorId, ids.staleOwner));
  assert.equal(staleAuditEvents.length, 1, 'A stale completion must not append a binding audit event.');

  console.log(`Stripe Connect ownership concurrency integration test passed (${proof.kind}).`);
} finally {
  await proof.close();
}
