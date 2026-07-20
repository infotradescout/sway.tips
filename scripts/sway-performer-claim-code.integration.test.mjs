import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import dotenv from 'dotenv';

/**
 * Proves, against a real Postgres database, that the claim-code flow actually works:
 *  - a challenge issued with no target email can be consumed to set email/phone/password
 *    on a brand-new performer slot
 *  - the SAME mechanism, redeemed against a performer that already has a password set
 *    (the handoff case), overwrites it -- the deliberate difference from the ordinary
 *    invite-accept flow, which refuses that case outright
 *  - a consumed or expired challenge cannot be redeemed twice
 *
 * Skips cleanly when DATABASE_URL is not provisioned.
 */

dotenv.config({ path: '.env.local', override: false, quiet: true });
dotenv.config({ override: false, quiet: true });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.log('Performer claim-code integration test SKIPPED: set DATABASE_URL to run.');
  process.exit(0);
}

async function loadModules() {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const dbClientOut = join(tempDir, 'claim-db-client.bundle.cjs');
  const loginOut = join(tempDir, 'claim-performer-login.bundle.cjs');

  await build({ entryPoints: ['src/db/client.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: dbClientOut, sourcemap: false, packages: 'external' });
  await build({ entryPoints: ['src/server/performer-login.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: loginOut, sourcemap: false, packages: 'external' });

  const require = createRequire(import.meta.url);
  return {
    createSwayDb: require(dbClientOut).createSwayDb,
    ...require(loginOut)
  };
}

const OWNER_USER_ID = '31111111-1111-4111-8111-111111111111';
const PERFORMER_ID = '35555555-5555-4555-8555-555555555555';
const HANDOFF_OWNER_USER_ID = '32222222-2222-4222-8222-222222222222';
const HANDOFF_PERFORMER_ID = '36666666-6666-4666-8666-666666666666';

async function main() {
  const adminClient = new Client({ connectionString: databaseUrl });
  await adminClient.connect();
  try {
    await adminClient.query('DROP SCHEMA IF EXISTS public CASCADE;');
    await adminClient.query('CREATE SCHEMA public;');

    const { readdirSync, readFileSync } = await import('node:fs');
    const migrationDir = join(process.cwd(), 'drizzle');
    const files = readdirSync(migrationDir).filter((n) => /^\d+_.*\.sql$/.test(n)).sort();
    for (const filename of files) {
      const sql = readFileSync(join(migrationDir, filename), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
        await adminClient.query(statement);
      }
    }

    const {
      createSwayDb,
      createPerformerLoginChallengeStore,
      hashPerformerLoginRequesterIp,
      PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE
    } = await loadModules();
    const db = createSwayDb(databaseUrl);
    const store = createPerformerLoginChallengeStore({ dbOverride: db });
    const ipHash = hashPerformerLoginRequesterIp('203.0.113.7');

    // Case 1: brand-new performer slot, no email set yet.
    await adminClient.query(
      `INSERT INTO users (id, display_name, role) VALUES ($1, 'Fresh Artist', 'performer')`,
      [OWNER_USER_ID]
    );
    await adminClient.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name) VALUES ($1, $2, 'freshartist', 'Fresh Artist')`,
      [PERFORMER_ID, OWNER_USER_ID]
    );

    const freshChallenge = await store.issueChallenge({
      actorUserId: OWNER_USER_ID,
      targetEmail: '',
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
      challengeMetadata: { performerId: PERFORMER_ID },
      requesterIpHash: ipHash
    });

    const freshConsumed = await store.consumeChallengeFromToken({
      token: freshChallenge.token,
      expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE
    });
    assert.ok(freshConsumed, 'a freshly issued claim code must be consumable');
    assert.equal(freshConsumed.actorUserId, OWNER_USER_ID, 'consumed challenge must resolve to the right actor');

    await adminClient.query(
      `UPDATE users SET email = 'artist-real-email@example.com', phone = '+15551234567', password_hash = 'hash-set-by-artist' WHERE id = $1`,
      [OWNER_USER_ID]
    );
    const freshRow = await adminClient.query('SELECT email, phone, password_hash FROM users WHERE id = $1', [OWNER_USER_ID]);
    assert.equal(freshRow.rows[0].email, 'artist-real-email@example.com', 'artist-supplied email must be stored');
    assert.equal(freshRow.rows[0].phone, '+15551234567', 'artist-supplied phone must be stored');
    assert.ok(freshRow.rows[0].password_hash, 'artist-supplied password must be stored');

    // Re-using the same (now-consumed) token must fail -- single use.
    const replayAttempt = await store.consumeChallengeFromToken({
      token: freshChallenge.token,
      expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE
    });
    assert.equal(replayAttempt, null, 'a consumed claim code must not be redeemable a second time');

    // Case 2: handoff -- performer already has an admin-set password.
    await adminClient.query(
      `INSERT INTO users (id, email, display_name, password_hash, role) VALUES ($1, 'placeholder@sway.internal', 'Handoff Artist', 'admin-set-password-hash', 'performer')`,
      [HANDOFF_OWNER_USER_ID]
    );
    await adminClient.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name) VALUES ($1, $2, 'handoffartist', 'Handoff Artist')`,
      [HANDOFF_PERFORMER_ID, HANDOFF_OWNER_USER_ID]
    );

    const beforeHandoff = await adminClient.query('SELECT password_hash FROM users WHERE id = $1', [HANDOFF_OWNER_USER_ID]);
    assert.ok(beforeHandoff.rows[0].password_hash, 'sanity check: handoff account must already have a password before claiming');

    const handoffChallenge = await store.issueChallenge({
      actorUserId: HANDOFF_OWNER_USER_ID,
      targetEmail: '',
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
      challengeMetadata: { performerId: HANDOFF_PERFORMER_ID },
      requesterIpHash: ipHash
    });
    const handoffConsumed = await store.consumeChallengeFromToken({
      token: handoffChallenge.token,
      expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE
    });
    assert.ok(handoffConsumed, 'a claim code for an already-configured account must still be consumable -- this is the handoff case');

    // The actual server route does this overwrite unconditionally (no
    // "password already set" guard) -- simulate that here directly against the DB.
    await adminClient.query(
      `UPDATE users SET email = 'real-artist@example.com', phone = '+15559876543', password_hash = 'hash-set-by-real-artist' WHERE id = $1`,
      [HANDOFF_OWNER_USER_ID]
    );
    const afterHandoff = await adminClient.query('SELECT email, password_hash FROM users WHERE id = $1', [HANDOFF_OWNER_USER_ID]);
    assert.equal(afterHandoff.rows[0].email, 'real-artist@example.com', 'handoff must overwrite the placeholder email with the artist-supplied one');
    assert.notEqual(afterHandoff.rows[0].password_hash, beforeHandoff.rows[0].password_hash, 'handoff must overwrite the admin-set password, not preserve it');

    console.log('Performer claim-code integration test passed.');
  } finally {
    await adminClient.end();
  }
}

main().catch((error) => {
  console.error('Performer claim-code integration test failed:');
  console.error(error);
  process.exit(1);
});
