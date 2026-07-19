import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import dotenv from 'dotenv';

/**
 * Proves, against a real Postgres database, that the Sway-promoted commission
 * computed by resolveProposedPlatformFee is correctly clamped by
 * resolveSwayPlatformFeePolicyForGig when the performer holds an effective
 * (accepted, active) Brand Partner entitlement -- and left untouched for a
 * performer with no entitlement. This is the one interaction the two features
 * (promotion campaigns + Brand Partner fee cap) actually depend on each other
 * for; static/text contract checks can't prove it, only a real DB round-trip can.
 *
 * Skips cleanly when DATABASE_URL is not provisioned, so the contract gate is
 * never blocked by a missing database. No Stripe secrets required -- this never
 * touches the payment provider, only the fee-resolution DB queries.
 */

dotenv.config({ path: '.env.local', override: false, quiet: true });
dotenv.config({ override: false, quiet: true });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.log('Fee policy Brand Partner cap integration test SKIPPED: set DATABASE_URL to run.');
  process.exit(0);
}

function splitStatements(sql) {
  return sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter(Boolean);
}

async function resetDatabase(client) {
  await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
  await client.query('CREATE SCHEMA public;');
}

async function applyMigrations(client) {
  const migrationDir = join(process.cwd(), 'drizzle');
  const migrationFiles = readdirSync(migrationDir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  for (const filename of migrationFiles) {
    const sql = readFileSync(join(migrationDir, filename), 'utf8');
    for (const statement of splitStatements(sql)) {
      await client.query(statement);
    }
  }
}

async function loadModules() {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const dbClientOut = join(tempDir, 'db-client.bundle.cjs');
  const partnerStoreOut = join(tempDir, 'partner-entitlement-store.bundle.cjs');
  const partnerTermsOut = join(tempDir, 'partner-entitlement.bundle.cjs');
  const feePolicyOut = join(tempDir, 'fee-policy.bundle.cjs');

  await build({ entryPoints: ['src/db/client.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: dbClientOut, sourcemap: false, packages: 'external' });
  await build({ entryPoints: ['src/server/partner-entitlement-store.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: partnerStoreOut, sourcemap: false, packages: 'external' });
  await build({ entryPoints: ['src/server/partner-entitlement.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: partnerTermsOut, sourcemap: false, packages: 'external' });
  await build({ entryPoints: ['src/server/fee-policy.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: feePolicyOut, sourcemap: false });

  const require = createRequire(import.meta.url);
  return {
    createSwayDb: require(dbClientOut).createSwayDb,
    resolveSwayPlatformFeePolicyForGig: require(partnerStoreOut).resolveSwayPlatformFeePolicyForGig,
    partnerTerms: require(partnerTermsOut),
    resolveProposedPlatformFee: require(feePolicyOut).resolveProposedPlatformFee
  };
}

const OWNER_USER_ID = '21111111-1111-4111-8111-111111111111';
const GRANTER_USER_ID = '22222222-2222-4222-8222-222222222222';
const PERFORMER_ID = '25555555-5555-4555-8555-555555555555';
const GIG_ID = '2aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNCAPPED_OWNER_USER_ID = '23111111-1111-4111-8111-111111111111';
const UNCAPPED_PERFORMER_ID = '26666666-6666-4666-8666-666666666666';
const UNCAPPED_GIG_ID = '2bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CAMPAIGN_ID = '27777777-7777-4777-8777-777777777777';
const ENTITLEMENT_ID = '28888888-8888-4888-8888-888888888888';

async function main() {
  const adminClient = new Client({ connectionString: databaseUrl });
  await adminClient.connect();
  try {
    await resetDatabase(adminClient);
    await applyMigrations(adminClient);

    const { createSwayDb, resolveSwayPlatformFeePolicyForGig, partnerTerms, resolveProposedPlatformFee } = await loadModules();
    const db = createSwayDb(databaseUrl);

    // Performer WITH an effective (accepted, active) Brand Partner entitlement.
    await adminClient.query(
      `INSERT INTO users (id, email, display_name, role) VALUES ($1, 'brand-owner@sway.local', 'Brand Owner', 'performer'), ($2, 'granter@sway.local', 'Granter', 'admin')`,
      [OWNER_USER_ID, GRANTER_USER_ID]
    );
    await adminClient.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name) VALUES ($1, $2, 'branded', 'Branded Performer')`,
      [PERFORMER_ID, OWNER_USER_ID]
    );
    await adminClient.query(
      `INSERT INTO gig_sessions (id, performer_id, status, title, venue_name, auto_closeout_at)
       VALUES ($1, $2, 'active', 'branded_session', 'venue', now() + interval '4 hours')`,
      [GIG_ID, PERFORMER_ID]
    );
    await adminClient.query(
      `INSERT INTO performer_partner_entitlements (id, performer_id, granted_by_user_id, partner_kind, terms_version, terms_hash, terms_text, terms_snapshot)
       VALUES ($1, $2, $3, 'brand', $4, $5, $6, $7)`,
      [
        ENTITLEMENT_ID,
        PERFORMER_ID,
        GRANTER_USER_ID,
        partnerTerms.SWAY_PARTNER_TERMS_VERSION,
        partnerTerms.SWAY_PARTNER_TERMS_HASH,
        partnerTerms.SWAY_PARTNER_TERMS_TEXT,
        JSON.stringify(partnerTerms.buildSwayPartnerTermsSnapshot())
      ]
    );
    await adminClient.query(
      `INSERT INTO performer_partner_entitlement_status_events (entitlement_id, performer_id, status, actor_user_id)
       VALUES ($1, $2, 'active', $3)`,
      [ENTITLEMENT_ID, PERFORMER_ID, GRANTER_USER_ID]
    );
    await adminClient.query(
      `INSERT INTO performer_partner_terms_acceptances (entitlement_id, performer_id, account_user_id, terms_version, terms_hash, terms_text, terms_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ENTITLEMENT_ID,
        PERFORMER_ID,
        OWNER_USER_ID,
        partnerTerms.SWAY_PARTNER_TERMS_VERSION,
        partnerTerms.SWAY_PARTNER_TERMS_HASH,
        partnerTerms.SWAY_PARTNER_TERMS_TEXT,
        JSON.stringify(partnerTerms.buildSwayPartnerTermsSnapshot())
      ]
    );
    await adminClient.query(
      `INSERT INTO promotion_campaigns (id, performer_id, campaign_code, label, commission_bps, status)
       VALUES ($1, $2, 'brand-launch', 'Brand launch push', 3500, 'active')`,
      [CAMPAIGN_ID, PERFORMER_ID]
    );

    // Performer with NO entitlement at all (control).
    await adminClient.query(
      `INSERT INTO users (id, email, display_name, role) VALUES ($1, 'uncapped-owner@sway.local', 'Uncapped Owner', 'performer')`,
      [UNCAPPED_OWNER_USER_ID]
    );
    await adminClient.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name) VALUES ($1, $2, 'uncapped', 'Uncapped Performer')`,
      [UNCAPPED_PERFORMER_ID, UNCAPPED_OWNER_USER_ID]
    );
    await adminClient.query(
      `INSERT INTO gig_sessions (id, performer_id, status, title, venue_name, auto_closeout_at)
       VALUES ($1, $2, 'active', 'uncapped_session', 'venue', now() + interval '4 hours')`,
      [UNCAPPED_GIG_ID, UNCAPPED_PERFORMER_ID]
    );

    // 1. A $10 sway_promoted sale at a 35% negotiated rate proposes $3.50.
    const proposed = resolveProposedPlatformFee({
      subtotalCents: 1000,
      attribution: { kind: 'sway_promoted', campaignId: CAMPAIGN_ID, commissionBps: 3500 }
    });
    assert.equal(proposed.proposedPlatformFeeCents, 350, 'a 35% campaign rate on $10 must propose $3.50');

    // 2. For the Brand Partner performer, the $1/interaction guarantee must clamp
    //    the proposed $3.50 down to $1.00 -- the whole point of composing the two features.
    const cappedPolicy = await resolveSwayPlatformFeePolicyForGig({
      db,
      gigId: GIG_ID,
      proposedPlatformFeeCents: proposed.proposedPlatformFeeCents
    });
    assert.equal(cappedPolicy.platformFeeCents, 100, 'an effective Brand Partner entitlement must cap the promoted fee at $1.00, regardless of the negotiated campaign rate');
    assert.equal(cappedPolicy.platformFeeCapCents, 100, 'the resolved cap must reflect the $1.00 guarantee');
    assert.equal(cappedPolicy.partnerTermsVersion, partnerTerms.SWAY_PARTNER_TERMS_VERSION, 'the applied cap must record which terms version was in effect');
    assert.equal(cappedPolicy.partnerTermsHash, partnerTerms.SWAY_PARTNER_TERMS_HASH, 'the applied cap must record the exact accepted terms hash');

    // 3. For a performer with no entitlement, the same proposed fee passes through untouched.
    const uncappedPolicy = await resolveSwayPlatformFeePolicyForGig({
      db,
      gigId: UNCAPPED_GIG_ID,
      proposedPlatformFeeCents: proposed.proposedPlatformFeeCents
    });
    assert.equal(uncappedPolicy.platformFeeCents, 350, 'a performer with no Brand Partner entitlement must receive the full proposed promoted fee');
    assert.equal(uncappedPolicy.platformFeeCapCents, null, 'no cap must be reported when no entitlement is effective');

    console.log('Fee policy Brand Partner cap integration test passed.');
  } finally {
    await adminClient.end();
  }
}

main().catch((error) => {
  console.error('Fee policy Brand Partner cap integration test failed:');
  console.error(error);
  process.exit(1);
});
