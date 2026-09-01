import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { createPerformerWithdrawalService } from '../src/server/performer-withdrawal-service';

const root = process.cwd();
const database = new PGlite();
const migrationFiles = readdirSync(join(root, 'drizzle')).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
for (const migrationFile of migrationFiles) {
  const statements = readFileSync(join(root, 'drizzle', migrationFile), 'utf8')
    .split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean);
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
const ownerUserId = '11000000-0000-4000-8000-000000000046';
const performerId = '21000000-0000-4000-8000-000000000046';
const gigId = '31000000-0000-4000-8000-000000000046';
await db.insert(schema.users).values({ id: ownerUserId, email: 'withdrawal-owner@example.test', displayName: 'Withdrawal Owner' });
await db.insert(schema.performers).values({ id: performerId, ownerUserId, displayName: 'Withdrawal Performer', handle: 'withdrawal-performer' });
await db.insert(schema.gigSessions).values({
  id: gigId,
  performerId,
  status: 'closed',
  title: 'withdrawal-test',
  venueName: 'test',
  autoCloseoutAt: new Date('2026-09-01T12:00:00.000Z')
});
await db.insert(schema.payments).values([
  { gigId, performerId, paymentMode: 'test', paymentStatus: 'captured', processor: 'stripe', amountSubtotal: 500, platformFee: 100, amountTotal: 600 },
  { gigId, performerId, paymentMode: 'test', paymentStatus: 'captured', processor: 'stripe', amountSubtotal: 500, platformFee: 100, amountTotal: 600 },
  { gigId, performerId, paymentMode: 'test', paymentStatus: 'captured', processor: 'stripe', amountSubtotal: 500, platformFee: 100, amountTotal: 600 },
  { gigId, performerId, paymentMode: 'test', paymentStatus: 'authorized', processor: 'stripe', amountSubtotal: 400, platformFee: 100, amountTotal: 500 }
]);

const service = createPerformerWithdrawalService(db);
const before = await service.getOwnerBalance({ ownerUserId, paymentMode: 'test' });
assert.equal(before.kind, 'ok');
if (before.kind !== 'ok') throw new Error('missing owner balance');
assert.equal(before.availableCents, 1_500, 'captured performer subtotals must accumulate without subtracting Sway fees');
assert.equal(before.pendingCents, 400);

const first = await service.requestTestWithdrawal({
  ownerUserId,
  paymentMode: 'test',
  idempotencyKey: 'withdrawal:test:0001',
  destinationKind: 'bank_account',
  deliverySpeed: 'standard',
  grossAmountCents: 1_000
});
assert.equal(first.kind, 'created');
if (first.kind !== 'created') throw new Error('withdrawal was not created');
assert.equal(first.withdrawal.providerFeeCents, 50);
assert.equal(first.withdrawal.netAmountCents, 950);

const after = await service.getOwnerBalance({ ownerUserId, paymentMode: 'test' });
assert.equal(after.kind, 'ok');
if (after.kind !== 'ok') throw new Error('missing owner balance');
assert.equal(after.availableCents, 500, 'one gross withdrawal must reserve the accumulated balance once');
assert.equal(after.reservedCents, 1_000);

const replay = await service.requestTestWithdrawal({
  ownerUserId,
  paymentMode: 'test',
  idempotencyKey: 'withdrawal:test:0001',
  destinationKind: 'bank_account',
  deliverySpeed: 'standard',
  grossAmountCents: 1_000
});
assert.equal(replay.kind, 'replay');

const conflict = await service.requestTestWithdrawal({
  ownerUserId,
  paymentMode: 'test',
  idempotencyKey: 'withdrawal:test:0001',
  destinationKind: 'bank_account',
  deliverySpeed: 'instant',
  grossAmountCents: 1_000
});
assert.equal(conflict.kind, 'idempotency_conflict');

const tooLarge = await service.requestTestWithdrawal({
  ownerUserId,
  paymentMode: 'test',
  idempotencyKey: 'withdrawal:test:0002',
  destinationKind: 'bank_account',
  deliverySpeed: 'standard',
  grossAmountCents: 1_000
});
assert.equal(tooLarge.kind, 'insufficient_balance');

const liveBlocked = await service.requestTestWithdrawal({
  ownerUserId,
  paymentMode: 'live',
  idempotencyKey: 'withdrawal:live:0001',
  destinationKind: 'bank_account',
  deliverySpeed: 'instant',
  grossAmountCents: 1_000
});
assert.equal(liveBlocked.kind, 'live_provider_required');

await database.close();
console.log(`Performer withdrawal behavior test passed (${migrationFiles.length} migrations).`);
