import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { createStripeConnectOnboardingStore } from '../src/server/stripe-connect-onboarding-store';

const root = process.cwd();
const migrationDirectory = join(root, 'drizzle');
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

async function applyAllMigrations(database: PGlite) {
  for (const migrationFile of migrationFiles) {
    const statements = readFileSync(join(migrationDirectory, migrationFile), 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await database.exec(statement);
  }
}

const ids = {
  owner: '10000000-0000-4000-8000-000000000001',
  performer: '20000000-0000-4000-8000-000000000001',
  unverifiedOwner: '10000000-0000-4000-8000-000000000002',
  unverifiedPerformer: '20000000-0000-4000-8000-000000000002',
  outsider: '10000000-0000-4000-8000-000000000003'
} as const;

const database = new PGlite();
await applyAllMigrations(database);
const db = drizzle(database, { schema }) as unknown as SwayDb;

await db.insert(schema.users).values([
  {
    id: ids.owner,
    email: 'verified-owner@example.test',
    displayName: 'Verified Owner',
    emailVerifiedAt: new Date('2026-08-11T00:00:00Z'),
    termsAcceptedAt: new Date('2026-08-11T00:00:00Z'),
    proModeStatus: 'active'
  },
  {
    id: ids.unverifiedOwner,
    email: 'unverified-owner@example.test',
    displayName: 'Unverified Owner',
    emailVerifiedAt: null,
    termsAcceptedAt: new Date('2026-08-11T00:00:00Z'),
    proModeStatus: 'active'
  },
  {
    id: ids.outsider,
    email: 'outsider@example.test',
    displayName: 'Outsider',
    emailVerifiedAt: new Date('2026-08-11T00:00:00Z'),
    termsAcceptedAt: new Date('2026-08-11T00:00:00Z')
  }
]);

await db.insert(schema.performers).values([
  {
    id: ids.performer,
    ownerUserId: ids.owner,
    displayName: 'Verified Performer',
    handle: 'verified-performer',
    isActive: true,
    onboardingStatus: 'gig_ready'
  },
  {
    id: ids.unverifiedPerformer,
    ownerUserId: ids.unverifiedOwner,
    displayName: 'Unverified Performer',
    handle: 'unverified-performer',
    isActive: true,
    onboardingStatus: 'gig_ready'
  }
]);

let clock = new Date('2026-08-11T12:00:00Z');
const store = createStripeConnectOnboardingStore(db, () => new Date(clock));

const reservation = await store.reserve({ performerId: ids.performer, ownerUserId: ids.owner });
assert.equal(reservation.kind, 'reserved');
if (reservation.kind !== 'reserved') throw new Error('expected reservation');

const concurrent = await store.reserve({ performerId: ids.performer, ownerUserId: ids.owner });
assert.deepEqual(concurrent, { kind: 'busy' });

clock = new Date(clock.getTime() + 2 * 60 * 1000 + 1);
const reclaimed = await store.reserve({ performerId: ids.performer, ownerUserId: ids.owner });
assert.equal(reclaimed.kind, 'reserved');
if (reclaimed.kind !== 'reserved') throw new Error('expected reclaimed reservation');
assert.notEqual(reclaimed.leaseToken, reservation.leaseToken);
assert.equal(reclaimed.operationKey, reservation.operationKey);

await store.complete({
  performerId: ids.performer,
  ownerUserId: ids.owner,
  leaseToken: reclaimed.leaseToken,
  operationKey: reclaimed.operationKey,
  accountId: 'acct_durable_connect_test'
});

const replay = await store.reserve({ performerId: ids.performer, ownerUserId: ids.owner });
assert.deepEqual(replay, { kind: 'bound', accountId: 'acct_durable_connect_test' });

const [operation] = await db.select().from(schema.stripeConnectOnboardingOperations)
  .where(eq(schema.stripeConnectOnboardingOperations.performerId, ids.performer));
assert.equal(operation.status, 'bound');
assert.equal(operation.stripeAccountId, 'acct_durable_connect_test');
assert.equal(operation.attemptCount, 2);
assert.equal(operation.leaseToken, null);
assert.equal(operation.leaseExpiresAt, null);

const [performer] = await db.select({ accountId: schema.performers.stripeConnectedAccountId })
  .from(schema.performers)
  .where(eq(schema.performers.id, ids.performer));
assert.equal(performer.accountId, 'acct_durable_connect_test');

const auditRows = await db.select().from(schema.auditEvents)
  .where(eq(schema.auditEvents.eventType, 'stripe_connect.account_bound'));
assert.equal(auditRows.length, 1);

const unverified = await store.reserve({
  performerId: ids.unverifiedPerformer,
  ownerUserId: ids.unverifiedOwner
});
assert.deepEqual(unverified, { kind: 'unverified' });

const crossOwner = await store.reserve({ performerId: ids.performer, ownerUserId: ids.outsider });
assert.deepEqual(crossOwner, { kind: 'not_found' });

await database.close();
console.log(`Stripe Connect onboarding store integration test passed (${migrationFiles.length} migrations).`);
