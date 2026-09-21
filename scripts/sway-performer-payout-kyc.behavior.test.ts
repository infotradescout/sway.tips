import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import {
  createPerformerKycReviewStore,
  PERFORMER_KYC_PROCESS_APPROVAL_VERSION
} from '../src/server/performer-kyc-review';

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
  const ownerUserId = '11000000-0000-4000-8000-000000000091';
  const reviewerUserId = '11000000-0000-4000-8000-000000000092';
  const performerId = '21000000-0000-4000-8000-000000000091';
  await db.insert(schema.users).values([
    { id: ownerUserId, email: 'kyc-owner@example.test', displayName: 'KYC Owner' },
    { id: reviewerUserId, email: 'kyc-reviewer@example.test', displayName: 'KYC Reviewer', role: 'admin' }
  ]);
  await db.insert(schema.performers).values({
    id: performerId,
    ownerUserId,
    displayName: 'KYC Performer',
    handle: 'kyc-performer'
  });

  const disabled = createPerformerKycReviewStore({ db, processApprovalVersion: 'stale-process' });
  assert.equal(disabled.configured, false);
  assert.equal((await disabled.approve({
    performerId,
    reviewerUserId,
    evidenceReference: 'case-disabled'
  })).kind, 'process_not_approved');

  const store = createPerformerKycReviewStore({
    db,
    processApprovalVersion: PERFORMER_KYC_PROCESS_APPROVAL_VERSION
  });
  assert.equal(store.configured, true);
  assert.equal((await store.approve({
    performerId,
    reviewerUserId,
    evidenceReference: 'short'
  })).kind, 'invalid_evidence_reference');
  const evidenceReference = 'paypal-case-KYC-000091';
  assert.equal((await store.approve({
    performerId,
    reviewerUserId,
    evidenceReference
  })).kind, 'approved');
  assert.ok(await store.loadCurrentApproval(performerId));
  const auditAfterApproval = JSON.stringify(await db.select().from(schema.auditEvents));
  assert.equal(auditAfterApproval.includes(evidenceReference), false, 'identity-review audit must store only the evidence fingerprint');
  assert.equal((await store.revoke({ performerId, reviewerUserId })).kind, 'revoked');
  assert.equal(await store.loadCurrentApproval(performerId), null);
} finally {
  await database.close();
}

console.log('Performer payout KYC review behavior test passed.');
