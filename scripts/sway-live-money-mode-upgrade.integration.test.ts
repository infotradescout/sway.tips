import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { createStripeConnectOnboardingStore } from '../src/server/stripe-connect-onboarding-store';

const ownerReady = '10000000-0000-4000-8000-000000000061';
const performerReady = '20000000-0000-4000-8000-000000000061';
const ownerLease = '10000000-0000-4000-8000-000000000062';
const performerLease = '20000000-0000-4000-8000-000000000062';
const legacyOperationKey = `sway-connect-recipient:${performerLease}:owner:${ownerLease}:v1`;
const oldLeaseToken = '30000000-0000-4000-8000-000000000062';
const gigId = '40000000-0000-4000-8000-000000000061';
const legacyPaymentId = '50000000-0000-4000-8000-000000000061';
const rollingPaymentId = '50000000-0000-4000-8000-000000000062';
const mismatchedPaymentId = '50000000-0000-4000-8000-000000000063';
const oldLeaseExpiry = new Date('2026-08-31T12:05:00.000Z');
const now = new Date('2026-08-31T12:00:00.000Z');

function matchesDatabaseError(pattern: RegExp) {
  return (error: unknown) => {
    const wrapped = error as { message?: unknown; cause?: { message?: unknown } };
    const text = [wrapped?.message, wrapped?.cause?.message].filter(Boolean).join('\n');
    assert.match(text, pattern);
    return true;
  };
}

const database = new PGlite();
const migrationDirectory = join(process.cwd(), 'drizzle');
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

async function applyMigration(filename: string, target = database) {
  const statements = readFileSync(join(migrationDirectory, filename), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
  await target.exec('BEGIN');
  try {
    for (const statement of statements) await target.exec(statement);
    await target.exec('COMMIT');
  } catch (error) {
    await target.exec('ROLLBACK');
    throw error;
  }
}

for (const filename of migrationFiles.filter((name) => name < '0042_')) {
  await applyMigration(filename);
}

await database.exec(`
  INSERT INTO users (id, email, display_name, email_verified_at)
  VALUES
    ('${ownerReady}', 'upgrade-ready@example.test', 'Upgrade Ready', now()),
    ('${ownerLease}', 'upgrade-lease@example.test', 'Upgrade Lease', now());

  INSERT INTO performers (
    id, owner_user_id, handle, display_name, is_active, onboarding_status,
    stripe_connected_account_id, payment_account_status, charges_enabled,
    payouts_enabled, stripe_connect_status_checked_at
  ) VALUES
    (
      '${performerReady}', '${ownerReady}', 'upgrade-ready', 'Upgrade Ready',
      true, 'gig_ready', 'acct_upgrade_ready_test', 'created', false, false,
      '2026-08-31T11:00:00.000Z'
    ),
    (
      '${performerLease}', '${ownerLease}', 'upgrade-lease', 'Upgrade Lease',
      true, 'gig_ready', NULL, 'not_started', false, false, NULL
    );

  INSERT INTO stripe_connect_onboarding_operations (
    performer_id, owner_user_id, operation_key, status, attempt_count
  ) VALUES (
    '${performerLease}', '${ownerLease}', '${legacyOperationKey}', 'pending', 2
  );

  INSERT INTO gig_sessions (
    id, performer_id, status, title, started_at, last_activity_at, auto_closeout_at
  ) VALUES (
    '${gigId}', '${performerReady}', 'active', 'Upgrade Payment Room',
    now(), now(), now() + interval '4 hours'
  );

  INSERT INTO payments (
    id, gig_id, performer_id, payment_status, processor,
    amount_subtotal, platform_fee, amount_total, currency, legacy_unlinked
  ) VALUES (
    '${legacyPaymentId}', '${gigId}', '${performerReady}', 'authorized', 'stripe',
    500, 50, 550, 'USD', true
  );

  INSERT INTO live_room_payment_operations (
    payment_id, gig_id, performer_id, operation_type, processor,
    idempotency_key, destination_account_id, request_payload
  ) VALUES (
    '${legacyPaymentId}', '${gigId}', '${performerReady}', 'reverse', 'stripe',
    'upgrade:legacy:reverse', 'acct_upgrade_ready_test', '{}'::jsonb
  );
`);

const migration0042 = migrationFiles.find((name) => name.startsWith('0042_'));
assert.ok(migration0042, '0042 live-money mode migration must exist');
await applyMigration(migration0042);

const db = drizzle(database, { schema }) as unknown as SwayDb;

const [backfilledBinding] = await db.select()
  .from(schema.performerStripeConnectBindings)
  .where(and(
    eq(schema.performerStripeConnectBindings.performerId, performerReady),
    eq(schema.performerStripeConnectBindings.paymentMode, 'test')
  ));
assert.equal(backfilledBinding.stripeAccountId, 'acct_upgrade_ready_test');
assert.equal(backfilledBinding.paymentAccountStatus, 'created');

const [backfilledOperation] = await db.select()
  .from(schema.stripeConnectModeOnboardingOperations)
  .where(and(
    eq(schema.stripeConnectModeOnboardingOperations.performerId, performerLease),
    eq(schema.stripeConnectModeOnboardingOperations.paymentMode, 'test')
  ));
assert.equal(backfilledOperation.operationKey, legacyOperationKey);
assert.equal(backfilledOperation.attemptCount, 2);

const [legacyPayment] = await db.select().from(schema.payments)
  .where(eq(schema.payments.id, legacyPaymentId));
const [legacyPaymentOperation] = await db.select().from(schema.liveRoomPaymentOperations)
  .where(eq(schema.liveRoomPaymentOperations.paymentId, legacyPaymentId));
assert.equal(legacyPayment.paymentMode, 'test');
assert.equal(legacyPaymentOperation.paymentMode, 'test');

// A still-running old writer omits the additive columns. Database defaults
// keep both parent and child in test; a mismatched explicit child is rejected.
await database.exec(`
  INSERT INTO payments (
    id, gig_id, performer_id, payment_status, processor,
    amount_subtotal, platform_fee, amount_total, currency, legacy_unlinked
  ) VALUES (
    '${rollingPaymentId}', '${gigId}', '${performerReady}', 'authorized', 'stripe',
    600, 60, 660, 'USD', true
  );
  INSERT INTO live_room_payment_operations (
    payment_id, gig_id, performer_id, operation_type, processor,
    idempotency_key, destination_account_id, request_payload
  ) VALUES (
    '${rollingPaymentId}', '${gigId}', '${performerReady}', 'reverse', 'stripe',
    'upgrade:rolling:reverse', 'acct_upgrade_ready_test', '{}'::jsonb
  );
  INSERT INTO payments (
    id, gig_id, performer_id, payment_status, processor,
    amount_subtotal, platform_fee, amount_total, currency, legacy_unlinked
  ) VALUES (
    '${mismatchedPaymentId}', '${gigId}', '${performerReady}', 'authorized', 'stripe',
    700, 70, 770, 'USD', true
  );
`);
const [rollingPayment] = await db.select().from(schema.payments)
  .where(eq(schema.payments.id, rollingPaymentId));
const [rollingOperation] = await db.select().from(schema.liveRoomPaymentOperations)
  .where(eq(schema.liveRoomPaymentOperations.paymentId, rollingPaymentId));
assert.equal(rollingPayment.paymentMode, 'test');
assert.equal(rollingOperation.paymentMode, 'test');
await assert.rejects(
  database.exec(`
    INSERT INTO live_room_payment_operations (
      payment_id, gig_id, performer_id, operation_type, processor, payment_mode,
      idempotency_key, destination_account_id, request_payload
    ) VALUES (
      '${mismatchedPaymentId}', '${gigId}', '${performerReady}', 'reverse', 'stripe', 'live',
      'upgrade:mismatch:reverse', 'acct_live_wrong_mode', '{}'::jsonb
    )
  `),
  matchesDatabaseError(/payment operation mode live does not match payment mode test/)
);

// Simulate a still-running old return/webhook after 0042. The new binding
// must immediately reflect readiness without requiring a new-server callback.
const readyCheckedAt = new Date('2026-08-31T11:30:00.000Z');
await db.update(schema.performers).set({
  paymentAccountStatus: 'payouts_enabled',
  chargesEnabled: true,
  payoutsEnabled: true,
  stripeConnectStatusCheckedAt: readyCheckedAt,
  updatedAt: readyCheckedAt
}).where(eq(schema.performers.id, performerReady));
const [mirroredReadyBinding] = await db.select()
  .from(schema.performerStripeConnectBindings)
  .where(and(
    eq(schema.performerStripeConnectBindings.performerId, performerReady),
    eq(schema.performerStripeConnectBindings.paymentMode, 'test')
  ));
assert.equal(mirroredReadyBinding.paymentAccountStatus, 'payouts_enabled');
assert.equal(mirroredReadyBinding.chargesEnabled, true);
assert.equal(mirroredReadyBinding.payoutsEnabled, true);
assert.equal(mirroredReadyBinding.statusCheckedAt?.toISOString(), readyCheckedAt.toISOString());
for (const conflictingAccountId of ['acct_upgrade_ready_other', null] as const) {
  await assert.rejects(
    db.update(schema.performers).set({
      stripeConnectedAccountId: conflictingAccountId,
      updatedAt: new Date('2026-08-31T11:31:00.000Z')
    }).where(eq(schema.performers.id, performerReady)),
    matchesDatabaseError(/stripe_connect_test_binding_(?:identity|clear)_conflict/)
  );
}
await assert.rejects(
  db.update(schema.performerStripeConnectBindings).set({
    stripeAccountId: 'acct_direct_binding_rewrite'
  }).where(and(
    eq(schema.performerStripeConnectBindings.performerId, performerReady),
    eq(schema.performerStripeConnectBindings.paymentMode, 'test')
  )),
  matchesDatabaseError(/stripe_connect_binding_identity_is_immutable/)
);
const [bindingAfterConflicts] = await db.select()
  .from(schema.performerStripeConnectBindings)
  .where(and(
    eq(schema.performerStripeConnectBindings.performerId, performerReady),
    eq(schema.performerStripeConnectBindings.paymentMode, 'test')
  ));
assert.equal(bindingAfterConflicts.stripeAccountId, 'acct_upgrade_ready_test');
const [performerAfterBindingConflicts] = await db.select({
  accountId: schema.performers.stripeConnectedAccountId
}).from(schema.performers).where(eq(schema.performers.id, performerReady));
assert.equal(performerAfterBindingConflicts.accountId, 'acct_upgrade_ready_test');

// Simulate an old server taking the legacy lease only. The migration bridge
// and new store must preserve that exact lease and return busy, never launch a
// second provider workflow.
await db.update(schema.stripeConnectOnboardingOperations).set({
  status: 'provisioning',
  leaseToken: oldLeaseToken,
  leaseExpiresAt: oldLeaseExpiry,
  attemptCount: 3,
  lastError: null,
  updatedAt: now
}).where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease));
const store = createStripeConnectOnboardingStore(db, () => new Date(now));
assert.deepEqual(await store.reserve({
  performerId: performerLease,
  ownerUserId: ownerLease,
  paymentMode: 'test'
}), { kind: 'busy' });
let [legacyAfterBusy] = await db.select().from(schema.stripeConnectOnboardingOperations)
  .where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease));
let [modeAfterBusy] = await db.select().from(schema.stripeConnectModeOnboardingOperations)
  .where(and(
    eq(schema.stripeConnectModeOnboardingOperations.performerId, performerLease),
    eq(schema.stripeConnectModeOnboardingOperations.paymentMode, 'test')
  ));
assert.equal(legacyAfterBusy.leaseToken, oldLeaseToken);
assert.equal(modeAfterBusy.leaseToken, oldLeaseToken);
assert.equal(modeAfterBusy.attemptCount, 3);

await assert.rejects(
  db.update(schema.stripeConnectOnboardingOperations).set({ operationKey: 'corrupt-operation-key' })
    .where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease)),
  matchesDatabaseError(/stripe_connect_test_operation_identity_conflict/)
);
await assert.rejects(
  db.update(schema.stripeConnectOnboardingOperations).set({
    ownerUserId: ownerReady,
    operationKey: `sway-connect-recipient:${performerLease}:owner:${ownerReady}:v1`
  }).where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease)),
  matchesDatabaseError(/stripe_connect_test_operation_identity_conflict/)
);
await assert.rejects(
  db.update(schema.stripeConnectOnboardingOperations).set({
    leaseToken: '30000000-0000-4000-8000-000000000099'
  }).where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease)),
  matchesDatabaseError(/stripe_connect_test_operation_lease_conflict/)
);
const [legacyAfterRejectedIdentityWrites] = await db.select()
  .from(schema.stripeConnectOnboardingOperations)
  .where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease));
const [modeAfterRejectedIdentityWrites] = await db.select()
  .from(schema.stripeConnectModeOnboardingOperations)
  .where(and(
    eq(schema.stripeConnectModeOnboardingOperations.performerId, performerLease),
    eq(schema.stripeConnectModeOnboardingOperations.paymentMode, 'test')
  ));
assert.equal(legacyAfterRejectedIdentityWrites.ownerUserId, ownerLease);
assert.equal(legacyAfterRejectedIdentityWrites.operationKey, legacyOperationKey);
assert.equal(legacyAfterRejectedIdentityWrites.leaseToken, oldLeaseToken);
assert.equal(modeAfterRejectedIdentityWrites.ownerUserId, ownerLease);
assert.equal(modeAfterRejectedIdentityWrites.operationKey, legacyOperationKey);
assert.equal(modeAfterRejectedIdentityWrites.leaseToken, oldLeaseToken);

// Defense in depth: even if a compatibility trigger were temporarily absent,
// the application refuses divergent active leases before overwriting either.
await database.exec('ALTER TABLE stripe_connect_onboarding_operations DISABLE TRIGGER stripe_connect_legacy_operation_test_mode_mirror');
await db.update(schema.stripeConnectOnboardingOperations).set({
  leaseToken: '30000000-0000-4000-8000-000000000098'
}).where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease));
await database.exec('ALTER TABLE stripe_connect_onboarding_operations ENABLE TRIGGER stripe_connect_legacy_operation_test_mode_mirror');
await assert.rejects(
  store.reserve({ performerId: performerLease, ownerUserId: ownerLease, paymentMode: 'test' }),
  /stripe_connect_operation_lease_conflict/
);
await db.update(schema.stripeConnectOnboardingOperations).set({
  leaseToken: oldLeaseToken
}).where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease));

// Old failure and completion transitions also flow one-way into test mode.
await db.update(schema.stripeConnectOnboardingOperations).set({
  status: 'pending',
  leaseToken: null,
  leaseExpiresAt: null,
  lastError: 'old_worker_retryable_failure',
  updatedAt: new Date('2026-08-31T12:00:30.000Z')
}).where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease));
const reclaimed = await store.reserve({
  performerId: performerLease,
  ownerUserId: ownerLease,
  paymentMode: 'test'
});
assert.equal(reclaimed.kind, 'reserved');
if (reclaimed.kind !== 'reserved') throw new Error('expected reclaimed test reservation');
legacyAfterBusy = (await db.select().from(schema.stripeConnectOnboardingOperations)
  .where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease)))[0];
modeAfterBusy = (await db.select().from(schema.stripeConnectModeOnboardingOperations)
  .where(and(
    eq(schema.stripeConnectModeOnboardingOperations.performerId, performerLease),
    eq(schema.stripeConnectModeOnboardingOperations.paymentMode, 'test')
  )))[0];
assert.equal(legacyAfterBusy.leaseToken, reclaimed.leaseToken);
assert.equal(modeAfterBusy.leaseToken, reclaimed.leaseToken);

await db.update(schema.performers).set({
  stripeConnectedAccountId: 'acct_upgrade_lease_test',
  updatedAt: new Date('2026-08-31T12:01:00.000Z')
}).where(eq(schema.performers.id, performerLease));
await db.update(schema.stripeConnectOnboardingOperations).set({
  status: 'bound',
  stripeAccountId: 'acct_upgrade_lease_test',
  leaseToken: null,
  leaseExpiresAt: null,
  lastError: null,
  updatedAt: new Date('2026-08-31T12:01:00.000Z')
}).where(and(
  eq(schema.stripeConnectOnboardingOperations.performerId, performerLease),
  eq(schema.stripeConnectOnboardingOperations.leaseToken, reclaimed.leaseToken)
));
assert.deepEqual(await store.reserve({
  performerId: performerLease,
  ownerUserId: ownerLease,
  paymentMode: 'test'
}), { kind: 'bound', accountId: 'acct_upgrade_lease_test' });

await assert.rejects(
  db.update(schema.stripeConnectOnboardingOperations).set({
    stripeAccountId: 'acct_upgrade_lease_other'
  }).where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease)),
  matchesDatabaseError(/stripe_connect_test_operation_account_conflict/)
);
await assert.rejects(
  db.update(schema.stripeConnectOnboardingOperations).set({
    status: 'pending',
    stripeAccountId: null
  }).where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease)),
  matchesDatabaseError(/stripe_connect_test_operation_(?:account|bound_state)_conflict/)
);
await assert.rejects(
  db.update(schema.stripeConnectModeOnboardingOperations).set({
    operationKey: 'direct-mode-key-rewrite'
  }).where(and(
    eq(schema.stripeConnectModeOnboardingOperations.performerId, performerLease),
    eq(schema.stripeConnectModeOnboardingOperations.paymentMode, 'test')
  )),
  matchesDatabaseError(/stripe_connect_mode_operation_identity_is_immutable/)
);
await assert.rejects(
  db.update(schema.stripeConnectModeOnboardingOperations).set({
    stripeAccountId: 'acct_direct_mode_rewrite'
  }).where(and(
    eq(schema.stripeConnectModeOnboardingOperations.performerId, performerLease),
    eq(schema.stripeConnectModeOnboardingOperations.paymentMode, 'test')
  )),
  matchesDatabaseError(/stripe_connect_mode_operation_account_is_immutable/)
);
const [legacyAfterBoundConflicts] = await db.select()
  .from(schema.stripeConnectOnboardingOperations)
  .where(eq(schema.stripeConnectOnboardingOperations.performerId, performerLease));
const [modeAfterBoundConflicts] = await db.select()
  .from(schema.stripeConnectModeOnboardingOperations)
  .where(and(
    eq(schema.stripeConnectModeOnboardingOperations.performerId, performerLease),
    eq(schema.stripeConnectModeOnboardingOperations.paymentMode, 'test')
  ));
assert.equal(legacyAfterBoundConflicts.status, 'bound');
assert.equal(legacyAfterBoundConflicts.stripeAccountId, 'acct_upgrade_lease_test');
assert.equal(legacyAfterBoundConflicts.operationKey, legacyOperationKey);
assert.equal(modeAfterBoundConflicts.status, 'bound');
assert.equal(modeAfterBoundConflicts.stripeAccountId, 'acct_upgrade_lease_test');
assert.equal(modeAfterBoundConflicts.operationKey, legacyOperationKey);

const [liveBinding] = await db.select()
  .from(schema.performerStripeConnectBindings)
  .where(and(
    eq(schema.performerStripeConnectBindings.performerId, performerLease),
    eq(schema.performerStripeConnectBindings.paymentMode, 'live')
  ));
assert.equal(liveBinding, undefined, 'legacy compatibility writes must never create live state');

await database.close();

// The very first 0042 statement rejects arbitrary historic provider keys and
// wrong-owner identities before creating any new object.
const corruptDatabase = new PGlite();
for (const filename of migrationFiles.filter((name) => name < '0042_')) {
  await applyMigration(filename, corruptDatabase);
}
await corruptDatabase.exec(`
  INSERT INTO users (id, email, display_name, email_verified_at)
  VALUES
    ('10000000-0000-4000-8000-000000000071', 'canonical-owner@example.test', 'Canonical Owner', now()),
    ('10000000-0000-4000-8000-000000000072', 'wrong-owner@example.test', 'Wrong Owner', now());
  INSERT INTO performers (id, owner_user_id, handle, display_name)
  VALUES (
    '20000000-0000-4000-8000-000000000071',
    '10000000-0000-4000-8000-000000000071',
    'corrupt-upgrade',
    'Corrupt Upgrade'
  );
  INSERT INTO stripe_connect_onboarding_operations (
    performer_id, owner_user_id, operation_key, status
  ) VALUES (
    '20000000-0000-4000-8000-000000000071',
    '10000000-0000-4000-8000-000000000072',
    'arbitrary-provider-idempotency-key',
    'pending'
  );
`);
await assert.rejects(
  applyMigration(migration0042, corruptDatabase),
  matchesDatabaseError(/legacy Stripe Connect operation key is noncanonical/)
);
await corruptDatabase.exec(`
  UPDATE stripe_connect_onboarding_operations SET operation_key =
    'sway-connect-recipient:20000000-0000-4000-8000-000000000071:owner:10000000-0000-4000-8000-000000000072:v1'
`);
await assert.rejects(
  applyMigration(migration0042, corruptDatabase),
  matchesDatabaseError(/legacy Stripe Connect operation owner mismatch/)
);
await corruptDatabase.exec(`
  UPDATE performers
  SET stripe_connected_account_id = 'acct_preflight_performer'
  WHERE id = '20000000-0000-4000-8000-000000000071';
  UPDATE stripe_connect_onboarding_operations
  SET owner_user_id = '10000000-0000-4000-8000-000000000071',
      operation_key = 'sway-connect-recipient:20000000-0000-4000-8000-000000000071:owner:10000000-0000-4000-8000-000000000071:v1',
      stripe_account_id = 'acct_preflight_operation'
  WHERE performer_id = '20000000-0000-4000-8000-000000000071';
`);
await assert.rejects(
  applyMigration(migration0042, corruptDatabase),
  matchesDatabaseError(/legacy Stripe Connect account identity mismatch/)
);
await corruptDatabase.close();
console.log('Live-money 0041 -> 0042 rolling upgrade integration test passed.');
