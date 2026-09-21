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
  normalizePayoutDestinationCapabilities,
  normalizePayoutDestinationKind,
  normalizePayoutRecipient,
  payoutDestinationLabel,
  PAYOUT_DESTINATIONS
} from '../src/payout-destination';
import { createPayoutDestinationStore } from '../src/server/payout-destination-store';
import {
  createConfiguredPayoutRecipientCipher,
  createPayoutRecipientCipher
} from '../src/server/payout-recipient-crypto';

assert.deepEqual(PAYOUT_DESTINATIONS.map((destination) => destination.id), ['paypal', 'venmo']);
assert.equal(normalizePayoutDestinationKind('PayPal'), 'paypal');
assert.equal(normalizePayoutDestinationKind('Venmo'), 'venmo');
for (const retired of ['bank', 'bank_account', 'debit_card', 'cashapp', 'cash_app_direct_deposit', 'plaid', 'moov']) {
  assert.equal(normalizePayoutDestinationKind(retired), null, `${retired} must not survive the PayPal/Venmo cutover`);
}
assert.equal(payoutDestinationLabel('paypal'), 'PayPal');
assert.equal(payoutDestinationLabel('venmo'), 'Venmo');
assert.deepEqual(normalizePayoutDestinationCapabilities({ paypal: true, venmo: 'true' }), {
  paypal: true,
  venmo: false
});
assert.equal(canConfigurePayoutDestination('paypal', 'test', { paypal: true, venmo: true }), true);
assert.equal(canConfigurePayoutDestination('venmo', 'live', { paypal: true, venmo: true }), true);
assert.equal(canConfigurePayoutDestination('paypal', 'unavailable', { paypal: true, venmo: true }), false);
assert.equal(canConfigurePayoutDestination('paypal', 'live', {}), false);

assert.deepEqual(normalizePayoutRecipient({
  destinationKind: 'paypal',
  recipientType: 'email',
  recipientValue: ' Artist@Example.COM '
}), {
  destinationKind: 'paypal',
  recipientType: 'email',
  recipientValue: 'artist@example.com',
  recipientPreview: 'a***@example.com'
});
assert.equal(normalizePayoutRecipient({
  destinationKind: 'paypal',
  recipientType: 'phone',
  recipientValue: '555-555-1212'
}), null, 'PayPal recipient input is email-only in this release');
assert.deepEqual(normalizePayoutRecipient({
  destinationKind: 'venmo',
  recipientType: 'phone',
  recipientValue: '(415) 555-1212'
}), {
  destinationKind: 'venmo',
  recipientType: 'phone',
  recipientValue: '+14155551212',
  recipientPreview: '••• ••• 1212'
});
assert.deepEqual(normalizePayoutRecipient({
  destinationKind: 'venmo',
  recipientType: 'user handle',
  recipientValue: '@Sway.Artist'
}), {
  destinationKind: 'venmo',
  recipientType: 'user_handle',
  recipientValue: 'Sway.Artist',
  recipientPreview: '@Sw•••t'
});
assert.equal(normalizePayoutRecipient({
  destinationKind: 'venmo',
  recipientType: 'phone',
  recipientValue: '+44 20 7946 0958'
}), null, 'Venmo mobile recipients must be U.S. numbers');

const encryptionKey = Buffer.alloc(32, 7);
const cipher = createPayoutRecipientCipher(encryptionKey);
const identity = {
  performerId: '20000000-0000-4000-8000-000000000041',
  paymentMode: 'test' as const,
  destinationKind: 'paypal' as const,
  recipientType: 'email' as const,
  recipientValue: 'artist@example.com'
};
const encryptedOne = cipher.encrypt(identity);
const encryptedTwo = cipher.encrypt(identity);
assert.notEqual(encryptedOne.encryptedValue, encryptedTwo.encryptedValue, 'AES-GCM must use a fresh IV');
assert.equal(encryptedOne.fingerprint, encryptedTwo.fingerprint, 'unchanged-recipient detection must remain stable');
assert.equal(cipher.decrypt({ ...identity, encryptedValue: encryptedOne.encryptedValue }), identity.recipientValue);
assert.throws(() => cipher.decrypt({
  ...identity,
  destinationKind: 'venmo',
  encryptedValue: encryptedOne.encryptedValue
}), 'ciphertext must be bound to performer, destination, and recipient type');
assert.throws(() => cipher.decrypt({
  ...identity,
  paymentMode: 'live',
  encryptedValue: encryptedOne.encryptedValue
}), 'ciphertext must be bound to the exact test or live payout environment');
assert.equal(createConfiguredPayoutRecipientCipher({}), null);
assert.throws(() => createConfiguredPayoutRecipientCipher({
  SWAY_PAYOUT_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(31).toString('base64')
}), /encryption_key_invalid/);

const root = process.cwd();
const migrationFiles = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const database = new PGlite();
try {
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
  const performerId = identity.performerId;
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

  let clock = new Date('2026-09-02T10:00:00.000Z');
  const store = createPayoutDestinationStore(db, cipher, 'test', () => clock);
  const paypalRecipient = normalizePayoutRecipient({
    destinationKind: 'paypal',
    recipientType: 'email',
    recipientValue: identity.recipientValue
  });
  assert.ok(paypalRecipient);
  assert.deepEqual(await store.saveForOwner({
    performerId,
    ownerUserId: outsiderId,
    recipient: paypalRecipient
  }), { kind: 'not_found' });

  assert.deepEqual(await store.saveForOwner({
    performerId,
    ownerUserId: ownerId,
    recipient: paypalRecipient
  }), {
    kind: 'updated',
    destinationKind: 'paypal',
    recipientType: 'email',
    recipientPreview: 'a***@example.com'
  });
  assert.equal(store.fingerprintRecipient({
    performerId,
    recipient: paypalRecipient
  }), encryptedOne.fingerprint);

  let [preference] = await db.select().from(schema.performerPayoutPreferences)
    .where(eq(schema.performerPayoutPreferences.performerId, performerId));
  assert.equal(preference.destinationKind, 'paypal');
  assert.equal(preference.paymentMode, 'test');
  assert.equal(preference.provider, 'paypal_payouts');
  assert.equal(preference.recipientValuePreview, 'a***@example.com');
  assert.notEqual(preference.recipientValueEncrypted, identity.recipientValue);
  assert.equal(JSON.stringify(preference).includes(identity.recipientValue), false, 'ordinary DB reads must not expose the recipient');
  assert.equal((await store.loadForPerformer(performerId))?.recipientValue, identity.recipientValue);
  const liveStore = createPayoutDestinationStore(db, cipher, 'live');
  assert.equal(await liveStore.loadForPerformer(performerId), null,
    'a sandbox payout recipient must never be available to live credentials');
  assert.notEqual(liveStore.fingerprintRecipient({ performerId, recipient: paypalRecipient }), encryptedOne.fingerprint,
    'recipient fingerprints must be bound to the exact provider environment');

  let audits = await db.select().from(schema.auditEvents)
    .where(eq(schema.auditEvents.eventType, 'performer_payout_preference.save'));
  assert.equal(audits.length, 1);
  assert.equal(JSON.stringify(audits[0]).includes(identity.recipientValue), false, 'audit events must never contain the recipient');
  assert.equal((audits[0].metadata as Record<string, unknown>).encryptedAtRest, true);

  clock = new Date('2026-09-02T10:05:00.000Z');
  const unchanged = await store.saveForOwner({ performerId, ownerUserId: ownerId, recipient: paypalRecipient });
  assert.equal(unchanged.kind, 'unchanged');
  audits = await db.select().from(schema.auditEvents)
    .where(eq(schema.auditEvents.eventType, 'performer_payout_preference.save'));
  assert.equal(audits.length, 1, 'saving an unchanged recipient must not duplicate the audit transition');

  const venmoRecipient = normalizePayoutRecipient({
    destinationKind: 'venmo',
    recipientType: 'user_handle',
    recipientValue: '@sway-artist'
  });
  assert.ok(venmoRecipient);
  assert.equal((await store.saveForOwner({ performerId, ownerUserId: ownerId, recipient: venmoRecipient })).kind, 'updated');
  [preference] = await db.select().from(schema.performerPayoutPreferences)
    .where(eq(schema.performerPayoutPreferences.performerId, performerId));
  assert.equal(preference.destinationKind, 'venmo');
  assert.equal(preference.recipientType, 'user_handle');
  assert.equal(preference.updatedAt.toISOString(), clock.toISOString());

  await assert.rejects(
    db.update(schema.performerPayoutPreferences)
      .set({ destinationKind: 'bank_account' })
      .where(eq(schema.performerPayoutPreferences.performerId, performerId)),
    (error: any) => error?.cause?.code === '23514'
  );
  await assert.rejects(
    db.update(schema.performerPayoutPreferences)
      .set({ destinationKind: 'paypal', recipientType: 'phone' })
      .where(eq(schema.performerPayoutPreferences.performerId, performerId)),
    (error: any) => error?.cause?.code === '23514'
  );
} finally {
  await database.close();
}

console.log(`Payout destination behavior test passed (${migrationFiles.length} migrations).`);
