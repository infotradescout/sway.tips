import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { Client } from 'pg';

/**
 * Real Stripe test-mode payment execution integration test.
 *
 * Proves, against live Stripe test mode + Postgres:
 *  - provider-backed authorization is created and persisted (authorized)
 *  - capture on approval transitions to captured and writes payment_events
 *  - void releases an authorized hold
 *  - closeout totals aggregate from captured payment rows (DB-backed)
 *  - provider failure fails safe (no successful financial state)
 *
 * Skips cleanly when STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / DATABASE_URL
 * are not provisioned, so the contract gate is never blocked by missing secrets.
 */

const databaseUrl = process.env.DATABASE_URL;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!databaseUrl || !stripeSecretKey || !stripeWebhookSecret) {
  console.log('Payment execution integration test SKIPPED: set DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET to run.');
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

async function loadPaymentService() {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const serviceOut = join(tempDir, 'payment-service.bundle.cjs');
  const providerOut = join(tempDir, 'payment-provider.bundle.cjs');

  await build({
    entryPoints: ['src/server/payment-service.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: serviceOut,
    sourcemap: false
  });
  await build({
    entryPoints: ['src/server/payment-provider.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: providerOut,
    sourcemap: false
  });

  const require = createRequire(import.meta.url);
  return {
    createPaymentService: require(serviceOut).createPaymentService,
    createStripeProviderAdapter: require(providerOut).createStripeProviderAdapter
  };
}

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PERFORMER_ID = '55555555-5555-4555-8555-555555555555';
const GIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function main() {
  const adminClient = new Client({ connectionString: databaseUrl });
  await adminClient.connect();
  try {
    await resetDatabase(adminClient);
    await applyMigrations(adminClient);

    await adminClient.query(
      `INSERT INTO users (id, email, display_name, role) VALUES ($1, 'perf@sway.local', 'Perf', 'performer')`,
      [USER_ID]
    );
    await adminClient.query(
      `INSERT INTO performers (id, owner_user_id, handle, display_name) VALUES ($1, $2, 'perf', 'Perf')`,
      [PERFORMER_ID, USER_ID]
    );
    await adminClient.query(
      `INSERT INTO gig_sessions (id, performer_id, status, title, venue_name, auto_closeout_at)
       VALUES ($1, $2, 'active', 'runtime_active_session', 'runtime', now() + interval '4 hours')`,
      [GIG_ID, PERFORMER_ID]
    );

    const { createPaymentService, createStripeProviderAdapter } = await loadPaymentService();
    const provider = createStripeProviderAdapter({
      secretKey: stripeSecretKey,
      webhookSecret: stripeWebhookSecret
    });
    const service = createPaymentService({ databaseUrl, provider });

    assert.equal(service.isEnabled(), true, 'service must be enabled with provider + db');

    // 1. Authorization created (confirm a test card so funds are capturable).
    const auth = await service.authorizeAction({
      gigId: GIG_ID,
      actionType: 'request',
      amountSubtotalCents: 1500,
      platformFeeCents: 100,
      currency: 'USD',
      idempotencyKey: `it-auth-${Date.now()}`,
      paymentMethod: 'pm_card_visa',
      confirm: true
    });
    assert.equal(auth.status, 'authorized', 'confirmed test card must reach a capturable hold (requires_capture)');

    const authedRow = await adminClient.query('SELECT payment_status FROM payments WHERE id = $1', [auth.paymentId]);
    assert.equal(authedRow.rows[0].payment_status, 'authorized', 'payment row must be authorized');

    const authEvents = await adminClient.query('SELECT count(*)::int AS c FROM payment_events WHERE payment_id = $1', [auth.paymentId]);
    assert.ok(authEvents.rows[0].c >= 1, 'payment_events must be written for authorization');

    // 2. Capture on approval.
    const capture = await service.captureAuthorization(auth.paymentId);
    assert.equal(capture.status, 'captured', 'capture must succeed');
    const capturedRow = await adminClient.query('SELECT payment_status FROM payments WHERE id = $1', [auth.paymentId]);
    assert.equal(capturedRow.rows[0].payment_status, 'captured', 'payment row must be captured');
    const captureEvents = await adminClient.query(
      `SELECT count(*)::int AS c FROM payment_events WHERE payment_id = $1 AND event_type = 'charge.captured'`,
      [auth.paymentId]
    );
    assert.ok(captureEvents.rows[0].c >= 1, 'capture must write a payment_event');

    // 3. DB-backed closeout totals.
    const totals = await service.aggregateCapturedTotals(GIG_ID);
    assert.equal(totals.source, 'database_captured_payments');
    assert.equal(totals.capturedSubtotalCents, 1500, 'captured subtotal must match');
    assert.equal(totals.capturedTotalCents, 1600, 'captured total must include fee');

    // 4. Void releases an authorized hold (deny path).
    const auth2 = await service.authorizeAction({
      gigId: GIG_ID,
      actionType: 'request',
      amountSubtotalCents: 800,
      platformFeeCents: 100,
      currency: 'USD',
      idempotencyKey: `it-auth2-${Date.now()}`,
      paymentMethod: 'pm_card_visa',
      confirm: true
    });
    const reversal = await service.voidOrRefund(auth2.paymentId);
    assert.equal(reversal.status, 'voided', 'authorized hold must void on denial');
    const voidedRow = await adminClient.query('SELECT payment_status FROM payments WHERE id = $1', [auth2.paymentId]);
    assert.equal(voidedRow.rows[0].payment_status, 'voided', 'payment row must be voided');

    // Voided funds must not appear in captured totals.
    const totalsAfterVoid = await service.aggregateCapturedTotals(GIG_ID);
    assert.equal(totalsAfterVoid.capturedSubtotalCents, 1500, 'voided hold must not be counted');

    // 5. Unconfirmed authorization (no payment_method) must NOT be capturable:
    //    it must return requires_confirmation, never 'authorized'.
    const unconfirmed = await service.authorizeAction({
      gigId: GIG_ID,
      actionType: 'request',
      amountSubtotalCents: 700,
      platformFeeCents: 100,
      currency: 'USD',
      idempotencyKey: `it-unconfirmed-${Date.now()}`
    });
    assert.equal(unconfirmed.status, 'requires_confirmation', 'unconfirmed intent must not be authorized');
    assert.ok(unconfirmed.clientSecret, 'requires_confirmation must expose a client secret for confirmation');
    const unconfirmedRow = await adminClient.query('SELECT payment_status FROM payments WHERE id = $1', [unconfirmed.paymentId]);
    assert.equal(unconfirmedRow.rows[0].payment_status, 'payment_pending', 'unconfirmed payment must stay payment_pending');
    const totalsAfterUnconfirmed = await service.aggregateCapturedTotals(GIG_ID);
    assert.equal(totalsAfterUnconfirmed.capturedSubtotalCents, 1500, 'unconfirmed intent must not be captured');

    // 6. Provider failure fails safe (invalid amount => no successful state).
    const failed = await service.authorizeAction({
      gigId: GIG_ID,
      actionType: 'request',
      amountSubtotalCents: -100,
      platformFeeCents: 0,
      currency: 'USD',
      idempotencyKey: `it-fail-${Date.now()}`,
      paymentMethod: 'pm_card_visa',
      confirm: true
    });
    assert.equal(failed.status, 'failed', 'invalid authorization must fail safe');
    const failedTotals = await service.aggregateCapturedTotals(GIG_ID);
    assert.equal(failedTotals.capturedSubtotalCents, 1500, 'failed authorization must not create captured funds');

    console.log('Payment execution integration test passed.');
  } finally {
    await adminClient.end();
  }
}

main().catch((error) => {
  console.error('Payment execution integration test failed:');
  console.error(error);
  process.exit(1);
});
