import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import dotenv from 'dotenv';

/**
 * Bulk-generates claim links for every performer whose owner has never
 * completed a real claim/accept flow (users.terms_accepted_at IS NULL).
 *
 * That's a precise, safe definition of "accounts you made that the real
 * artist hasn't taken control of yet": every existing invite-accept and
 * claim-accept flow sets terms_accepted_at, so anyone who already
 * legitimately claimed their account is automatically excluded -- this
 * will never hand out a code that could overwrite a real, already-owned
 * account.
 *
 * Curated public profile previews (dj3x, coreymack, etc.) do NOT get codes
 * from this script until an admin creates a real performer slot for that
 * handle (Admin → Manually onboard, leave email blank, or claim-link with
 * matching handle). Previews are not accounts.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/sway-bulk-claim-links.mjs [--base-url https://app.sway.tips]
 */

dotenv.config({ path: '.env.local', override: false, quiet: true });
dotenv.config({ override: false, quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

function readFlag(flagName) {
  const index = process.argv.indexOf(flagName);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

const baseUrl = (readFlag('--base-url')?.trim()
  || process.env.SWAY_APP_BASE_URL?.trim()
  || (process.env.NODE_ENV === 'production' ? 'https://app.sway.tips' : 'http://localhost:3000')
).replace(/\/+$/, '');

async function loadModules() {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const dbClientOut = join(tempDir, 'bulk-claim-db-client.bundle.cjs');
  const loginOut = join(tempDir, 'bulk-claim-performer-login.bundle.cjs');

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
    PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE
  } = await loadModules();

  const db = createSwayDb(databaseUrl);
  const store = createPerformerLoginChallengeStore({ dbOverride: db });

  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  let rows;
  let previewRows;
  try {
    const result = await pg.query(`
      SELECT performers.id AS performer_id, users.id AS user_id, performers.handle, performers.display_name
      FROM performers
      JOIN users ON users.id = performers.owner_user_id
      WHERE users.terms_accepted_at IS NULL
      ORDER BY performers.created_at ASC
    `);
    rows = result.rows;

    const previews = await pg.query(`
      SELECT handle, display_name, claimed_performer_id
      FROM performer_profile_previews
      WHERE is_active = true
      ORDER BY handle ASC
    `);
    previewRows = previews.rows;
  } finally {
    await pg.end();
  }

  if (previewRows?.length) {
    console.log('Curated profile previews (no claim code until a real performer slot exists):\n');
    for (const preview of previewRows) {
      const state = preview.claimed_performer_id ? 'pending (performer slot linked)' : 'unclaimed preview only';
      console.log(`  @${preview.handle}  ${preview.display_name}  — ${state}`);
    }
    console.log('');
  }

  if (!rows.length) {
    console.log('No performers need a claim link -- every account has already been claimed by its real owner.');
    console.log('To create a code for a preview handle: Admin → Manually onboard with that handle and leave email blank.');
    return;
  }

  console.log(`Generating claim links for ${rows.length} performer(s) that have never been claimed:\n`);

  const ipHash = hashPerformerLoginRequesterIp('bulk-claim-script');
  for (const row of rows) {
    await pgReconnectRevokeAndIssue({
      databaseUrl,
      store,
      userId: row.user_id,
      performerId: row.performer_id,
      displayName: row.display_name,
      handle: row.handle,
      ipHash,
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
      baseUrl
    });
  }
}

async function pgReconnectRevokeAndIssue(input) {
  const pg = new Client({ connectionString: input.databaseUrl });
  await pg.connect();
  try {
    await pg.query(`
      UPDATE performer_login_challenges
      SET revoked_at = NOW()
      WHERE actor_user_id = $1
        AND challenge_type = $2
        AND consumed_at IS NULL
        AND revoked_at IS NULL
    `, [input.userId, input.challengeType]);

    const issued = await input.store.issueChallenge({
      actorUserId: input.userId,
      targetEmail: '',
      challengeType: input.challengeType,
      challengeMetadata: { performerId: input.performerId },
      requesterIpHash: input.ipHash
    });

    await pg.query(`
      INSERT INTO audit_events (
        actor_type, actor_id, entity_type, entity_id, event_type, previous_status, next_status, metadata, created_at
      ) VALUES (
        'admin', $1, 'performer_login_challenge', $2, 'admin_performer.claim_link_issue',
        NULL, 'pending', $3::jsonb, NOW()
      )
    `, [
      input.userId,
      issued.challengeId,
      JSON.stringify({
        source: 'bulk_claim_links_script',
        userId: input.userId,
        performerId: input.performerId,
        handle: input.handle,
        wasNewPerformer: false
      })
    ]);

    const link = `${input.baseUrl}/talent/signup?code=${encodeURIComponent(issued.token)}`;
    console.log(`${input.displayName ?? '(no display name)'}  @${input.handle ?? '(no handle)'}`);
    console.log(`  ${link}\n`);
  } finally {
    await pg.end();
  }
}

main().catch((error) => {
  console.error('Bulk claim link generation failed:', error);
  process.exit(1);
});
