import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { reconcileStripeConnectPerformerStatus } from '../src/server/stripe-connect-status';
import { handleStripeConnectAccountStatusWebhook } from '../src/server/stripe-connect-webhook';

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
  owner: '10000000-0000-4000-8000-000000000011',
  performer: '20000000-0000-4000-8000-000000000011',
  outsider: '10000000-0000-4000-8000-000000000012',
  duplicateOwner: '10000000-0000-4000-8000-000000000013',
  duplicatePerformer: '20000000-0000-4000-8000-000000000013'
} as const;

const database = new PGlite();
await applyAllMigrations(database);
const db = drizzle(database, { schema }) as unknown as SwayDb;

await db.insert(schema.users).values([
  { id: ids.owner, email: 'status-owner@example.test', displayName: 'Status Owner' },
  { id: ids.outsider, email: 'status-outsider@example.test', displayName: 'Status Outsider' },
  { id: ids.duplicateOwner, email: 'status-duplicate@example.test', displayName: 'Status Duplicate' }
]);
await db.insert(schema.performers).values({
  id: ids.performer,
  ownerUserId: ids.owner,
  displayName: 'Status Performer',
  handle: 'status-performer',
  isActive: true,
  onboardingStatus: 'gig_ready',
  stripeConnectedAccountId: 'acct_status_original',
  updatedAt: new Date('2026-08-11T10:00:00Z')
});

const readyStatus = { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true };
const firstCheck = new Date('2026-08-11T11:00:00Z');
const first = await reconcileStripeConnectPerformerStatus({
  db,
  accountId: 'acct_status_original',
  status: readyStatus,
  source: 'return',
  actorId: ids.owner,
  expectedPerformerId: ids.performer,
  expectedOwnerUserId: ids.owner,
  now: firstCheck
});
assert.deepEqual(first, { kind: 'updated', performerId: ids.performer });

let [performer] = await db.select().from(schema.performers).where(eq(schema.performers.id, ids.performer));
assert.equal(performer.paymentAccountStatus, 'payouts_enabled');
assert.equal(performer.chargesEnabled, true);
assert.equal(performer.payoutsEnabled, true);
assert.equal(performer.updatedAt.toISOString(), firstCheck.toISOString());
assert.equal(performer.stripeConnectStatusCheckedAt?.toISOString(), firstCheck.toISOString());

let audits = await db.select().from(schema.auditEvents)
  .where(eq(schema.auditEvents.eventType, 'stripe_connect.readiness_changed'));
assert.equal(audits.length, 1);
assert.equal(audits[0].actorId, ids.owner);
assert.equal(audits[0].previousStatus, 'not_started');
assert.equal(audits[0].nextStatus, 'payouts_enabled');
assert.equal((audits[0].metadata as Record<string, unknown>).source, 'return');

const replayCheck = new Date('2026-08-11T11:05:00Z');
let replayHttpStatus = 200;
let replayHttpBody: unknown = null;
const replayResponse = {
  status(statusCode: number) {
    replayHttpStatus = statusCode;
    return replayResponse;
  },
  json(body: unknown) {
    replayHttpBody = body;
    return replayResponse;
  }
};
await handleStripeConnectAccountStatusWebhook({
  res: replayResponse,
  accountEvent: {
    accountId: 'acct_status_original',
    status: readyStatus,
    providerEventId: 'evt_status_replay',
    eventType: 'v2.core.account.updated'
  },
  applyStatus: (event) => reconcileStripeConnectPerformerStatus({
    db,
    accountId: event.accountId,
    status: event.status,
    source: 'webhook_v2',
    providerEventId: event.providerEventId,
    actorId: null,
    now: replayCheck
  })
});
assert.equal(replayHttpStatus, 200);
assert.deepEqual(replayHttpBody, { received: true, result: { type: 'account.updated' } });
audits = await db.select().from(schema.auditEvents)
  .where(eq(schema.auditEvents.eventType, 'stripe_connect.readiness_changed'));
assert.equal(audits.length, 1, 'callback replay must not duplicate transition audit rows');
[performer] = await db.select().from(schema.performers).where(eq(schema.performers.id, ids.performer));
assert.equal(performer.updatedAt.toISOString(), replayCheck.toISOString(), 'replay still records provider-check freshness');
assert.equal(
  performer.stripeConnectStatusCheckedAt?.toISOString(),
  replayCheck.toISOString(),
  'Stripe freshness must use its dedicated timestamp'
);

const wrongOwner = await reconcileStripeConnectPerformerStatus({
  db,
  accountId: 'acct_status_original',
  status: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false },
  source: 'return',
  actorId: ids.outsider,
  expectedPerformerId: ids.performer,
  expectedOwnerUserId: ids.outsider
});
assert.deepEqual(wrongOwner, { kind: 'not_found' });

await db.update(schema.performers)
  .set({ stripeConnectedAccountId: 'acct_status_rebound' })
  .where(eq(schema.performers.id, ids.performer));
const staleAccount = await reconcileStripeConnectPerformerStatus({
  db,
  accountId: 'acct_status_original',
  status: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false },
  source: 'return',
  actorId: ids.owner,
  expectedPerformerId: ids.performer,
  expectedOwnerUserId: ids.owner
});
assert.deepEqual(staleAccount, { kind: 'not_found' });
[performer] = await db.select().from(schema.performers).where(eq(schema.performers.id, ids.performer));
assert.equal(performer.paymentAccountStatus, 'payouts_enabled', 'stale account callback must not mutate readiness');

const disabledCheck = new Date('2026-08-11T11:10:00Z');
const disabled = await reconcileStripeConnectPerformerStatus({
  db,
  accountId: 'acct_status_rebound',
  status: { chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: true },
  source: 'webhook_v1',
  providerEventId: 'evt_current_status',
  actorId: null,
  now: disabledCheck
});
assert.deepEqual(disabled, { kind: 'updated', performerId: ids.performer });
[performer] = await db.select().from(schema.performers).where(eq(schema.performers.id, ids.performer));
assert.equal(performer.paymentAccountStatus, 'created');
assert.equal(performer.chargesEnabled, false);
assert.equal(performer.payoutsEnabled, false);
audits = await db.select().from(schema.auditEvents)
  .where(eq(schema.auditEvents.eventType, 'stripe_connect.readiness_changed'));
assert.equal(audits.length, 2);
assert.equal((audits[1].metadata as Record<string, unknown>).providerEventId, 'evt_current_status');

await assert.rejects(
  db.insert(schema.performers).values({
    id: ids.duplicatePerformer,
    ownerUserId: ids.duplicateOwner,
    displayName: 'Duplicate Destination',
    handle: 'duplicate-destination',
    stripeConnectedAccountId: 'acct_status_rebound'
  }),
  /unique|duplicate/i
);

await database.close();
console.log(`Stripe Connect status integration test passed (${migrationFiles.length} migrations).`);
