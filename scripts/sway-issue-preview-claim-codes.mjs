import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import dotenv from 'dotenv';

/**
 * For active curated previews with no linked performer yet: create the
 * minimal users + performers rows (no email, no password -- the performer
 * sets both themselves when they redeem the code at /talent/signup), link
 * the preview, and issue a claim code via the same challenge store
 * sway-bulk-claim-links.mjs uses. Prints one code per preview; nothing
 * else to do after sending it.
 *
 * Previews that already have a linked-but-unclaimed performer are handled
 * by sway-bulk-claim-links.mjs instead, not this script.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/sway-issue-preview-claim-codes.mjs
 */

dotenv.config({ path: '.env.local', override: false, quiet: true });
dotenv.config({ override: false, quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

async function loadModules() {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const dbClientOut = join(tempDir, 'issue-preview-codes-db-client.bundle.cjs');
  const loginOut = join(tempDir, 'issue-preview-codes-performer-login.bundle.cjs');

  await build({ entryPoints: ['src/db/client.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: dbClientOut, sourcemap: false, packages: 'external' });
  await build({ entryPoints: ['src/server/performer-login.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: loginOut, sourcemap: false, packages: 'external' });

  const require = createRequire(import.meta.url);
  return {
    createSwayDb: require(dbClientOut).createSwayDb,
    ...require(loginOut)
  };
}

async function main() {
  const {
    createSwayDb,
    createPerformerLoginChallengeStore,
    hashPerformerLoginRequesterIp,
    PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
    PERFORMER_CLAIM_CODE_TTL_MS
  } = await loadModules();

  const db = createSwayDb(databaseUrl);
  const store = createPerformerLoginChallengeStore({ dbOverride: db });
  const ipHash = hashPerformerLoginRequesterIp('issue-preview-claim-codes-script');

  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();

  try {
    const previews = await pg.query(`
      SELECT id, handle, display_name
      FROM performer_profile_previews
      WHERE is_active = true AND claimed_performer_id IS NULL
      ORDER BY handle ASC
    `);

    if (!previews.rows.length) {
      console.log('No previews are waiting on a performer slot.');
      return;
    }

    console.log(`Creating performer slots and claim codes for ${previews.rows.length} preview(s).\n`);

    for (const preview of previews.rows) {
      const handle = preview.handle;
      const displayName = preview.display_name || handle;

      const createdUser = await pg.query(`
        INSERT INTO users (email, display_name, password_hash, role, email_verified_at, terms_accepted_at)
        VALUES (NULL, $1, NULL, 'performer', NULL, NULL)
        RETURNING id
      `, [displayName]);
      const userId = createdUser.rows[0].id;

      const createdPerformer = await pg.query(`
        INSERT INTO performers (owner_user_id, handle, display_name, is_active, onboarding_status)
        VALUES ($1, $2, $3, false, 'created')
        RETURNING id
      `, [userId, handle, displayName]);
      const performerId = createdPerformer.rows[0].id;

      await pg.query(`
        UPDATE performer_profile_previews
        SET claimed_performer_id = $1, updated_at = NOW()
        WHERE id = $2
      `, [performerId, preview.id]);

      await pg.query(`
        INSERT INTO audit_events (
          actor_type, actor_id, entity_type, entity_id, event_type, previous_status, next_status, metadata, created_at
        ) VALUES (
          'admin', $1, 'user', $2, 'admin_account.onboard',
          NULL, 'created', $3::jsonb, NOW()
        )
      `, [
        userId,
        userId,
        JSON.stringify({
          targetHandle: handle,
          performerId,
          passwordSetByAdmin: false,
          termsAcceptedByAdmin: false,
          source: 'issue_preview_claim_codes_script'
        })
      ]);

      const issued = await store.issueChallenge({
        actorUserId: userId,
        targetEmail: '',
        challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
        challengeMetadata: { performerId },
        requesterIpHash: ipHash,
        ttlMs: PERFORMER_CLAIM_CODE_TTL_MS
      });

      console.log(`${displayName}  @${handle}`);
      console.log(`  ${issued.token}\n`);
    }
  } finally {
    await pg.end();
  }
}

main().catch((error) => {
  console.error('Preview claim code issuance failed:', error);
  process.exit(1);
});
