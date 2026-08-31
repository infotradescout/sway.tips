import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import {
  canConfigurePayoutDestination,
  normalizePayoutDestinationKind,
  payoutDestinationLabel,
  PAYOUT_DESTINATIONS,
  resolvePayoutDestinationSetupRequest,
  resolvePayoutSetupReturnStatus
} from '../src/payout-destination';
import { createPayoutDestinationStore } from '../src/server/payout-destination-store';

assert.deepEqual(PAYOUT_DESTINATIONS.map((destination) => destination.id), [
  'bank_account',
  'debit_card',
  'cash_app_direct_deposit',
  'venmo_direct_deposit'
]);
assert.equal(normalizePayoutDestinationKind('bank'), 'bank_account');
assert.equal(normalizePayoutDestinationKind('Debit Card'), 'debit_card');
assert.equal(normalizePayoutDestinationKind('cashapp'), 'cash_app_direct_deposit');
assert.equal(normalizePayoutDestinationKind('Venmo'), 'venmo_direct_deposit');
assert.equal(normalizePayoutDestinationKind('$cashtag'), null);
assert.equal(payoutDestinationLabel('cash_app'), 'Cash App direct deposit');
const allCapabilities = Object.fromEntries(PAYOUT_DESTINATIONS.map((destination) => [destination.id, true]));
assert.equal(canConfigurePayoutDestination('bank_account', 'test', allCapabilities), true);
assert.equal(canConfigurePayoutDestination('debit_card', 'test', allCapabilities), true);
assert.equal(canConfigurePayoutDestination('cash_app_direct_deposit', 'test', allCapabilities), false);
assert.equal(canConfigurePayoutDestination('venmo_direct_deposit', 'test', allCapabilities), false);
assert.equal(canConfigurePayoutDestination('cash_app_direct_deposit', 'live', allCapabilities), true);
assert.equal(canConfigurePayoutDestination('bank_account', 'unavailable', allCapabilities), false);
assert.equal(canConfigurePayoutDestination('bank_account', 'loading', allCapabilities), false);
assert.equal(canConfigurePayoutDestination('bank_account', 'unknown', allCapabilities), false);
assert.equal(canConfigurePayoutDestination('bank_account', 'test', {}), false);

let providerProvisionCalls = 0;
function attemptPayoutSetup(destinationKind: unknown, runtimeAvailable: boolean, capabilities: unknown) {
  const result = resolvePayoutDestinationSetupRequest({
    destinationKind,
    paymentMode: 'live',
    capabilities,
    runtimeAvailable
  });
  if (result.ok) providerProvisionCalls += 1;
  return result;
}
assert.deepEqual(attemptPayoutSetup(undefined, true, allCapabilities), {
  ok: false,
  status: 422,
  error: 'Choose a supported payout destination.'
});
assert.deepEqual(attemptPayoutSetup('cash_tag', true, allCapabilities), {
  ok: false,
  status: 422,
  error: 'Choose a supported payout destination.'
});
assert.deepEqual(attemptPayoutSetup('bank_account', true, {}), {
  ok: false,
  status: 422,
  error: 'That payout destination is not available yet. Choose an enabled option.'
});
assert.deepEqual(attemptPayoutSetup('bank_account', false, allCapabilities), {
  ok: false,
  status: 503,
  error: 'Secure payout setup is temporarily unavailable. Try again later.'
});
assert.equal(providerProvisionCalls, 0, 'omitted, invalid, disabled, and unavailable requests must make zero provider provisioning calls');
assert.deepEqual(attemptPayoutSetup('bank_account', true, allCapabilities), {
  ok: true,
  destinationKind: 'bank_account'
});
assert.equal(providerProvisionCalls, 1, 'only an explicit valid and enabled destination may proceed to provider provisioning');
assert.equal(resolvePayoutSetupReturnStatus('?connect=return'), 'return');
assert.equal(resolvePayoutSetupReturnStatus('?connect=pending'), 'pending');
assert.equal(resolvePayoutSetupReturnStatus('?connect=bogus'), null);
assert.equal(resolvePayoutSetupReturnStatus('?connect=return&connect=pending'), null);

const root = process.cwd();
const migrationFiles = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const database = new PGlite();
for (const migrationFile of migrationFiles) {
  const statements = readFileSync(join(root, 'drizzle', migrationFile), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
  await database.exec('BEGIN');
  try {
    for (const statement of statements) await database.exec(statement);
    await database.exec('COMMIT');
  } catch (error) {
    await database.exec('ROLLBACK');
    throw error;
  }
}

const db = drizzle(database, { schema }) as unknown as SwayDb;
const ownerId = '10000000-0000-4000-8000-000000000041';
const outsiderId = '10000000-0000-4000-8000-000000000042';
const performerId = '20000000-0000-4000-8000-000000000041';
await db.insert(schema.users).values([
  { id: ownerId, email: 'payout-owner@example.test', displayName: 'Payout Owner' },
  { id: outsiderId, email: 'payout-outsider@example.test', displayName: 'Payout Outsider' }
]);
await db.insert(schema.performers).values({
  id: performerId,
  ownerUserId: ownerId,
  displayName: 'Payout Performer',
  handle: 'payout-performer'
});

let clock = new Date('2026-08-30T10:00:00.000Z');
const store = createPayoutDestinationStore(db, () => clock);
assert.deepEqual(await store.selectForOwner({
  performerId,
  ownerUserId: outsiderId,
  destinationKind: 'bank_account'
}), { kind: 'not_found' });

assert.deepEqual(await store.selectForOwner({
  performerId,
  ownerUserId: ownerId,
  destinationKind: 'bank_account'
}), { kind: 'updated', destinationKind: 'bank_account' });

let [preference] = await db.select().from(schema.performerPayoutPreferences)
  .where(eq(schema.performerPayoutPreferences.performerId, performerId));
assert.equal(preference.destinationKind, 'bank_account');
let audits = await db.select().from(schema.auditEvents)
  .where(eq(schema.auditEvents.eventType, 'performer_payout_preference.select'));
assert.equal(audits.length, 1);
assert.equal(audits[0].actorId, ownerId);
assert.equal(audits[0].previousStatus, 'not_selected');
assert.equal(audits[0].nextStatus, 'bank_account');
assert.equal((audits[0].metadata as Record<string, unknown>).storesSensitiveAccountData, false);

clock = new Date('2026-08-30T10:05:00.000Z');
assert.deepEqual(await store.selectForOwner({
  performerId,
  ownerUserId: ownerId,
  destinationKind: 'bank_account'
}), { kind: 'unchanged', destinationKind: 'bank_account' });
audits = await db.select().from(schema.auditEvents)
  .where(eq(schema.auditEvents.eventType, 'performer_payout_preference.select'));
assert.equal(audits.length, 1, 'reselecting the same destination must not duplicate the audit transition');

clock = new Date('2026-08-30T10:10:00.000Z');
assert.deepEqual(await store.selectForOwner({
  performerId,
  ownerUserId: ownerId,
  destinationKind: 'cash_app_direct_deposit'
}), { kind: 'updated', destinationKind: 'cash_app_direct_deposit' });
[preference] = await db.select().from(schema.performerPayoutPreferences)
  .where(eq(schema.performerPayoutPreferences.performerId, performerId));
assert.equal(preference.destinationKind, 'cash_app_direct_deposit');
assert.equal(preference.updatedAt.toISOString(), clock.toISOString());
audits = await db.select().from(schema.auditEvents)
  .where(eq(schema.auditEvents.eventType, 'performer_payout_preference.select'));
assert.equal(audits.length, 2);
assert.equal(audits[1].previousStatus, 'bank_account');
assert.equal(audits[1].nextStatus, 'cash_app_direct_deposit');

await assert.rejects(
  db.update(schema.performerPayoutPreferences)
    .set({ destinationKind: 'cash_tag' })
    .where(eq(schema.performerPayoutPreferences.performerId, performerId)),
  (error: any) => error?.cause?.code === '23514'
);

await database.close();
console.log(`Payout destination behavior test passed (${migrationFiles.length} migrations).`);
