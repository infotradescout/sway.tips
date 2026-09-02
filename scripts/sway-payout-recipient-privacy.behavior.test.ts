import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { normalizePayoutRecipient } from '../src/payout-destination';
import { createPayoutDestinationStore } from '../src/server/payout-destination-store';
import { createPayoutRecipientCipher } from '../src/server/payout-recipient-crypto';
import { createPayoutRecipientPrivacyService } from '../src/server/payout-recipient-privacy';

const database = new PGlite();
try {
  const migrationFiles = readdirSync(join(process.cwd(), 'drizzle'))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migrationFile of migrationFiles) {
    const statements = readFileSync(join(process.cwd(), 'drizzle', migrationFile), 'utf8')
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
  const cipher = createPayoutRecipientCipher(Buffer.alloc(32, 19));
  const destinations = createPayoutDestinationStore(db, cipher, 'test');
  const privacy = createPayoutRecipientPrivacyService(db);
  const rows = [
    {
      ownerUserId: '11000000-0000-4000-8000-000000000081',
      performerId: '21000000-0000-4000-8000-000000000081',
      email: 'privacy-immediate@example.test'
    },
    {
      ownerUserId: '11000000-0000-4000-8000-000000000082',
      performerId: '21000000-0000-4000-8000-000000000082',
      email: 'privacy-deferred@example.test'
    }
  ];
  for (const row of rows) {
    await db.insert(schema.users).values({
      id: row.ownerUserId,
      email: row.email,
      displayName: 'Privacy Owner',
      emailVerifiedAt: new Date()
    });
    await db.insert(schema.performers).values({
      id: row.performerId,
      ownerUserId: row.ownerUserId,
      displayName: 'Privacy Performer',
      handle: `privacy-${row.performerId.slice(-2)}`,
      isActive: true
    });
    const recipient = normalizePayoutRecipient({
      destinationKind: 'paypal',
      recipientType: 'email',
      recipientValue: row.email
    });
    assert.ok(recipient);
    assert.equal((await destinations.saveForOwner({
      performerId: row.performerId,
      ownerUserId: row.ownerUserId,
      recipient
    })).kind, 'updated');
  }

  assert.equal((await privacy.requestDeletion({
    performerId: rows[0].performerId,
    actorUserId: rows[0].ownerUserId
  })).kind, 'purged');
  assert.equal((await db.select().from(schema.performerPayoutPreferences)
    .where(eq(schema.performerPayoutPreferences.performerId, rows[0].performerId))).length, 0);

  const [preference] = await db.select().from(schema.performerPayoutPreferences)
    .where(eq(schema.performerPayoutPreferences.performerId, rows[1].performerId));
  await db.insert(schema.performerWithdrawals).values({
    performerId: rows[1].performerId,
    ownerUserId: rows[1].ownerUserId,
    idempotencyKey: 'withdrawal:privacy:deferred-0001',
    destinationKind: 'paypal',
    recipientType: 'email',
    recipientFingerprint: preference.recipientValueFingerprint,
    recipientPreview: preference.recipientValuePreview,
    paymentMode: 'test',
    status: 'processing',
    grossAmountCents: 1_000,
    providerFeeCents: 25,
    netAmountCents: 975,
    providerPayoutId: 'PRIVACY-BATCH-1',
    providerSenderItemId: 'privacy-sender-1'
  });

  assert.equal((await privacy.requestDeletion({
    performerId: rows[1].performerId,
    actorUserId: rows[1].ownerUserId
  })).kind, 'deferred');
  const [deferred] = await db.select().from(schema.performerPayoutPreferences)
    .where(eq(schema.performerPayoutPreferences.performerId, rows[1].performerId));
  assert.ok(deferred.privacyDeletionRequestedAt, 'unresolved payouts must retain a durable deferred-purge marker');
  await assert.rejects(
    db.update(schema.performerPayoutPreferences)
      .set({ recipientValuePreview: 'changed' })
      .where(eq(schema.performerPayoutPreferences.performerId, rows[1].performerId)),
    (error: unknown) => {
      const cause = error && typeof error === 'object' && 'cause' in error
        ? (error as { cause?: unknown }).cause
        : null;
      return String(cause ?? error).includes('payout recipient locked while withdrawal is unresolved');
    }
  );

  const [withdrawal] = await db.select().from(schema.performerWithdrawals)
    .where(eq(schema.performerWithdrawals.performerId, rows[1].performerId));
  await db.update(schema.performerWithdrawals).set({
    status: 'paid',
    paidAt: new Date()
  }).where(eq(schema.performerWithdrawals.id, withdrawal.id));
  assert.equal((await privacy.purgeDeferred()).purged, 1);
  assert.equal((await db.select().from(schema.performerPayoutPreferences)
    .where(eq(schema.performerPayoutPreferences.performerId, rows[1].performerId))).length, 0);

  const auditJson = JSON.stringify(await db.select().from(schema.auditEvents));
  assert.equal(auditJson.includes(rows[0].email), false);
  assert.equal(auditJson.includes(rows[1].email), false);
} finally {
  await database.close();
}

console.log('Payout recipient privacy deletion behavior test passed.');
