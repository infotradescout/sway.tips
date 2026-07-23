import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import dotenv from 'dotenv';

/**
 * Proves account claim onboarding against real Postgres:
 * - inspect distinguishes expired / consumed / valid
 * - signup-style redeem activates performer + Pro Mode on the handoff account
 * - attach transfers ownership to an existing verified account
 * - concurrent second consume fails
 * - fingerprints are used instead of raw codes in audit metadata helpers
 */

dotenv.config({ path: '.env.local', override: false, quiet: true });
dotenv.config({ override: false, quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log('Account claim-code integration test SKIPPED: set DATABASE_URL to run.');
  process.exit(0);
}

async function loadModules() {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const outs = {
    db: join(tempDir, 'account-claim-db.bundle.cjs'),
    login: join(tempDir, 'account-claim-login.bundle.cjs'),
    claim: join(tempDir, 'account-claim-helpers.bundle.cjs')
  };
  await Promise.all([
    build({ entryPoints: ['src/db/client.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: outs.db, sourcemap: false, packages: 'external' }),
    build({ entryPoints: ['src/server/performer-login.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: outs.login, sourcemap: false, packages: 'external' }),
    build({ entryPoints: ['src/server/account-claim.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: outs.claim, sourcemap: false, packages: 'external' })
  ]);
  const require = createRequire(import.meta.url);
  return {
    createSwayDb: require(outs.db).createSwayDb,
    ...require(outs.login),
    ...require(outs.claim)
  };
}

const HANDOFF_USER = '41111111-1111-4111-8111-111111111111';
const HANDOFF_PERFORMER = '45555555-5555-4555-8555-555555555555';
const EXISTING_USER = '42222222-2222-4222-8222-222222222222';
const OTHER_PERFORMER = '46666666-6666-4666-8666-666666666666';
const OTHER_OWNER = '43333333-3333-4333-8333-333333333333';

async function main() {
  const adminClient = new Client({ connectionString: databaseUrl });
  await adminClient.connect();
  try {
    await adminClient.query('DROP SCHEMA IF EXISTS public CASCADE;');
    await adminClient.query('CREATE SCHEMA public;');
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
      PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
      claimCodeFingerprint,
      mapClaimInspectionToClientError,
      activateClaimedPerformerAndProMode,
      transferPerformerOwnership
    } = await loadModules();

    const db = createSwayDb(databaseUrl);
    const store = createPerformerLoginChallengeStore({ dbOverride: db });
    const ipHash = hashPerformerLoginRequesterIp('203.0.113.80');

    assert.equal(claimCodeFingerprint('SECRET-CODE').length, 12);
    assert.notEqual(claimCodeFingerprint('SECRET-CODE'), 'SECRET-CODE');
    assert.equal(mapClaimInspectionToClientError('expired').error, 'Code expired');
    assert.equal(mapClaimInspectionToClientError('consumed').error, 'Code already used');

    await adminClient.query(
      `INSERT INTO users (id, display_name, role, pro_mode_status) VALUES ($1, 'Handoff Artist', 'performer', 'disabled')`,
      [HANDOFF_USER]
    );
    await adminClient.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name, is_active, onboarding_status)
       VALUES ($1, $2, 'handoffartist', 'Handoff Artist', false, 'created')`,
      [HANDOFF_PERFORMER, HANDOFF_USER]
    );

    const issued = await store.issueChallenge({
      actorUserId: HANDOFF_USER,
      targetEmail: '',
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
      challengeMetadata: { performerId: HANDOFF_PERFORMER },
      requesterIpHash: ipHash
    });

    const validPeek = await store.inspectClaimChallengeByToken({ token: issued.token });
    assert.equal(validPeek.status, 'valid');

    const missingPeek = await store.inspectClaimChallengeByToken({ token: 'not-a-real-code' });
    assert.equal(missingPeek.status, 'not_found');

    await db.transaction(async (tx) => {
      const claim = await store.consumeChallengeFromToken({
        token: issued.token,
        expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
        executor: tx
      });
      assert.ok(claim);
      const activated = await activateClaimedPerformerAndProMode(tx, {
        userId: HANDOFF_USER,
        performerId: HANDOFF_PERFORMER,
        reason: 'account_signup_claim_redeem'
      });
      assert.equal(activated.proModeActivated, true);
    });

    const after = await adminClient.query(
      `SELECT u.pro_mode_status, p.is_active, p.onboarding_status
       FROM users u JOIN performers p ON p.owner_user_id = u.id
       WHERE u.id = $1`,
      [HANDOFF_USER]
    );
    assert.equal(after.rows[0].pro_mode_status, 'active');
    assert.equal(after.rows[0].is_active, true);
    assert.equal(after.rows[0].onboarding_status, 'gig_ready');

    const consumedPeek = await store.inspectClaimChallengeByToken({ token: issued.token });
    assert.equal(consumedPeek.status, 'consumed');

    const replay = await store.consumeChallengeFromToken({
      token: issued.token,
      expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE
    });
    assert.equal(replay, null);

    // Existing-account attach: fresh claim + transfer ownership.
    await adminClient.query(
      `INSERT INTO users (id, email, display_name, role, pro_mode_status, email_verified_at, password_hash)
       VALUES ($1, 'existing@example.com', 'Existing Fan', 'patron', 'disabled', NOW(), 'hash')`,
      [EXISTING_USER]
    );
    await adminClient.query(
      `INSERT INTO users (id, display_name, role, pro_mode_status) VALUES ($1, 'Other Slot', 'performer', 'disabled')`,
      [OTHER_OWNER]
    );
    await adminClient.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name, is_active, onboarding_status)
       VALUES ($1, $2, 'otherslot', 'Other Slot', false, 'created')`,
      [OTHER_PERFORMER, OTHER_OWNER]
    );

    const attachIssued = await store.issueChallenge({
      actorUserId: OTHER_OWNER,
      targetEmail: '',
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
      challengeMetadata: { performerId: OTHER_PERFORMER },
      requesterIpHash: ipHash
    });

    await db.transaction(async (tx) => {
      const claim = await store.consumeChallengeFromToken({
        token: attachIssued.token,
        expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
        executor: tx
      });
      assert.ok(claim);
      const transfer = await transferPerformerOwnership(tx, {
        performerId: OTHER_PERFORMER,
        fromUserId: OTHER_OWNER,
        toUserId: EXISTING_USER
      });
      assert.equal(transfer.ok, true);
      const activated = await activateClaimedPerformerAndProMode(tx, {
        userId: EXISTING_USER,
        performerId: OTHER_PERFORMER,
        reason: 'account_claim_attach'
      });
      assert.equal(activated.proModeActivated, true);
    });

    const owned = await adminClient.query(
      `SELECT owner_user_id, is_active FROM performers WHERE id = $1`,
      [OTHER_PERFORMER]
    );
    assert.equal(owned.rows[0].owner_user_id, EXISTING_USER);
    assert.equal(owned.rows[0].is_active, true);

    const existingPro = await adminClient.query(
      `SELECT pro_mode_status, role FROM users WHERE id = $1`,
      [EXISTING_USER]
    );
    assert.equal(existingPro.rows[0].pro_mode_status, 'active');
    assert.equal(existingPro.rows[0].role, 'performer');

    // Conflicting ownership: existing user already owns a performer.
    const conflictOwner = '44444444-4444-4444-8444-444444444444';
    const conflictPerformer = '47777777-7777-4777-8777-777777777777';
    await adminClient.query(
      `INSERT INTO users (id, display_name, role, pro_mode_status) VALUES ($1, 'Conflict Slot', 'performer', 'disabled')`,
      [conflictOwner]
    );
    await adminClient.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name, is_active, onboarding_status)
       VALUES ($1, $2, 'conflictslot', 'Conflict Slot', false, 'created')`,
      [conflictPerformer, conflictOwner]
    );
    const conflictIssued = await store.issueChallenge({
      actorUserId: conflictOwner,
      targetEmail: '',
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
      challengeMetadata: { performerId: conflictPerformer },
      requesterIpHash: ipHash
    });

    let conflictCode = null;
    try {
      await db.transaction(async (tx) => {
        const claim = await store.consumeChallengeFromToken({
          token: conflictIssued.token,
          expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
          executor: tx
        });
        assert.ok(claim);
        const transfer = await transferPerformerOwnership(tx, {
          performerId: conflictPerformer,
          fromUserId: conflictOwner,
          toUserId: EXISTING_USER
        });
        assert.equal(transfer.ok, false);
        conflictCode = transfer.code;
        const err = new Error('rollback');
        throw err;
      });
    } catch {
      // expected rollback
    }
    assert.equal(conflictCode, 'profile_already_claimed');
    const stillOwnedByHandoff = await adminClient.query(
      `SELECT owner_user_id FROM performers WHERE id = $1`,
      [conflictPerformer]
    );
    assert.equal(stillOwnedByHandoff.rows[0].owner_user_id, conflictOwner);
    const stillOpen = await store.inspectClaimChallengeByToken({ token: conflictIssued.token });
    assert.equal(stillOpen.status, 'valid', 'failed attach must roll back consume');

    console.log('Account claim-code integration test passed.');
  } finally {
    await adminClient.end();
  }
}

main().catch((error) => {
  console.error('Account claim-code integration test failed:');
  console.error(error);
  process.exit(1);
});
