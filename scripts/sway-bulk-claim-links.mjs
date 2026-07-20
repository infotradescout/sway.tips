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
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/sway-bulk-claim-links.mjs [--base-url https://app.sway.tips]
 *
 * Run this with YOUR real database credentials, in an environment where
 * DATABASE_URL is actually reachable -- it is not something to run from
 * inside an unrelated sandbox.
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

  // Raw pg for the selection query -- simplest way to express the
  // terms_accepted_at IS NULL filter without pulling in the full schema module.
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();
  let rows;
  try {
    const result = await pg.query(`
      SELECT performers.id AS performer_id, users.id AS user_id, performers.handle, performers.display_name
      FROM performers
      JOIN users ON users.id = performers.owner_user_id
      WHERE users.terms_accepted_at IS NULL
      ORDER BY performers.created_at ASC
    `);
    rows = result.rows;
  } finally {
    await pg.end();
  }

  if (!rows.length) {
    console.log('No performers need a claim link -- every account has already been claimed by its real owner.');
    return;
  }

  console.log(`Generating claim links for ${rows.length} performer(s) that have never been claimed:\n`);

  const ipHash = hashPerformerLoginRequesterIp('bulk-claim-script');
  for (const row of rows) {
    const issued = await store.issueChallenge({
      actorUserId: row.user_id,
      targetEmail: '',
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
      challengeMetadata: { performerId: row.performer_id },
      requesterIpHash: ipHash
    });
    const link = `${baseUrl}/talent/claim?code=${encodeURIComponent(issued.token)}`;
    console.log(`${row.display_name ?? '(no display name)'}  @${row.handle ?? '(no handle)'}`);
    console.log(`  ${link}\n`);
  }
}

main().catch((error) => {
  console.error('Bulk claim link generation failed:', error);
  process.exit(1);
});
