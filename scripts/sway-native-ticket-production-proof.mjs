import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import pg from 'pg';
import Stripe from 'stripe';

const { Pool } = pg;

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function required(name, value) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function cents(value) {
  return value == null ? null : Number(value);
}

function check(name, ok, evidence) {
  return { name, status: ok ? 'pass' : 'fail', evidence };
}

const orderId = required('--order-id', arg('order-id'));
const databaseUrl = required('DATABASE_URL', process.env.DATABASE_URL);
const stripeKey = required('STRIPE_SECRET_KEY', process.env.STRIPE_SECRET_KEY);
const outputPath = resolve(arg('output') ?? `artifacts/ticket-proof-${orderId}.json`);
const expectedLivemode = arg('livemode') === 'true';
const expectedOutcome = arg('outcome') ?? 'admitted';
if (!['admitted', 'refunded'].includes(expectedOutcome)) {
  throw new Error('--outcome must be admitted or refunded.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});
const stripe = new Stripe(stripeKey);

try {
  const result = await pool.query(
    `select
       o.*,
       t.id as ticket_id,
       t.status as ticket_status,
       t.admission_accepted_at,
       t.released_at,
       t.refunded_at as ticket_refunded_at,
       e.status as event_status,
       e.starts_at,
       e.ends_at,
       e.cancelled_at,
       f.status as offer_status,
       f.advertised_total_cents as offer_advertised_total_cents,
       f.seller_transfer_amount_cents as offer_seller_transfer_amount_cents,
       coalesce((
         select json_agg(json_build_object(
           'entryType', l.entry_type,
           'account', l.account,
           'direction', l.direction,
           'amountCents', l.amount_cents,
           'processorReference', l.processor_reference
         ) order by l.created_at, l.id)
         from ticket_ledger_entries l where l.order_id = o.id
       ), '[]'::json) as ledger,
       coalesce((
         select json_agg(json_build_object(
           'operationType', p.operation_type,
           'status', p.status,
           'processorObjectId', p.processor_object_id,
           'lastError', p.last_error
         ) order by p.created_at, p.id)
         from ticket_payment_operations p where p.order_id = o.id
       ), '[]'::json) as operations
       ,coalesce((
         select json_agg(json_build_object(
           'eventType', x.event_type,
           'status', x.status,
           'attemptCount', x.attempt_count,
           'lastError', x.last_error
         ) order by x.received_at, x.id)
         from ticket_processor_events x where x.order_id = o.id
       ), '[]'::json) as processor_events
     from ticket_orders o
     join performer_events e on e.id = o.event_id
     join event_ticket_offers f on f.id = o.offer_id
     left join event_tickets t on t.order_id = o.id
     where o.id = $1`,
    [orderId]
  );
  if (result.rowCount !== 1) throw new Error(`Ticket order ${orderId} was not found.`);

  const row = result.rows[0];
  const paymentIntent = row.processor_payment_intent_id
    ? await stripe.paymentIntents.retrieve(row.processor_payment_intent_id, { expand: ['latest_charge.balance_transaction'] })
    : null;
  const charge = paymentIntent && typeof paymentIntent.latest_charge === 'object'
    ? paymentIntent.latest_charge
    : null;
  const balanceTransaction = charge && typeof charge.balance_transaction === 'object'
    ? charge.balance_transaction
    : null;

  const checks = [
    check('stripe_mode_matches', paymentIntent?.livemode === expectedLivemode, {
      expectedLivemode,
      actualLivemode: paymentIntent?.livemode ?? null
    }),
    check('payment_intent_matches_order', !paymentIntent || (
      paymentIntent.id === row.processor_payment_intent_id
      && paymentIntent.metadata?.sway_ticket_order_id === row.id
    ), { paymentIntentId: paymentIntent?.id ?? null }),
    check('captured_total_matches', !paymentIntent || paymentIntent.amount_received === cents(row.charged_total_cents), {
      databaseCents: cents(row.charged_total_cents),
      stripeCents: paymentIntent?.amount_received ?? null
    }),
    check('currency_matches', !paymentIntent || paymentIntent.currency.toUpperCase() === row.currency, {
      database: row.currency,
      stripe: paymentIntent?.currency?.toUpperCase() ?? null
    }),
    check('charge_matches_order', !charge || charge.id === row.processor_charge_id, {
      database: row.processor_charge_id,
      stripe: charge?.id ?? null
    }),
    check('balance_transaction_matches', !balanceTransaction || balanceTransaction.id === row.processor_balance_transaction_id, {
      database: row.processor_balance_transaction_id,
      stripe: balanceTransaction?.id ?? null
    }),
    check('processor_fee_matches', !balanceTransaction || balanceTransaction.fee === cents(row.processor_fee_cents), {
      databaseCents: cents(row.processor_fee_cents),
      stripeCents: balanceTransaction?.fee ?? null
    }),
    check('ticket_issued_for_paid_order', row.status !== 'paid' || Boolean(row.ticket_id), {
      orderStatus: row.status,
      ticketId: row.ticket_id
    }),
    check('admission_state_coherent', !row.admission_accepted_at || ['release_pending', 'released'].includes(row.ticket_status), {
      ticketStatus: row.ticket_status,
      admissionAcceptedAt: row.admission_accepted_at
    }),
    check('terminal_operation_not_failed', !row.operations.some((operation) =>
      operation.status === 'terminal_failed'
    ), { operations: row.operations }),
    check('processor_events_settled', !row.processor_events.some((event) =>
      !['processed', 'ignored'].includes(event.status)
    ), { processorEvents: row.processor_events }),
    check('expected_lifecycle_outcome', expectedOutcome === 'admitted'
      ? row.admission_accepted_at && row.ticket_status === 'released' && row.released_at
      : row.status === 'refunded' && row.ticket_status === 'refunded'
        && row.refunded_at && row.ticket_refunded_at, {
      expectedOutcome,
      orderStatus: row.status,
      ticketStatus: row.ticket_status,
      admissionAcceptedAt: row.admission_accepted_at,
      releasedAt: row.released_at,
      refundedAt: row.refunded_at,
      ticketRefundedAt: row.ticket_refunded_at
    }),
    check('double_entry_ledger_balances', (() => {
      const debit = row.ledger.filter((entry) => entry.direction === 'debit')
        .reduce((sum, entry) => sum + cents(entry.amountCents), 0);
      const credit = row.ledger.filter((entry) => entry.direction === 'credit')
        .reduce((sum, entry) => sum + cents(entry.amountCents), 0);
      return debit === credit && debit > 0;
    })(), { entries: row.ledger.length })
  ];

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: expectedLivemode ? 'live' : 'test',
    order: {
      id: row.id,
      eventId: row.event_id,
      performerId: row.performer_id,
      status: row.status,
      ticketId: row.ticket_id,
      ticketStatus: row.ticket_status,
      eventStatus: row.event_status,
      offerStatus: row.offer_status,
      advertisedTotalCents: cents(row.advertised_total_cents),
      chargedTotalCents: cents(row.charged_total_cents),
      processorFeeCents: cents(row.processor_fee_cents),
      processorNetCents: cents(row.processor_net_cents),
      admissionAcceptedAt: row.admission_accepted_at,
      releasedAt: row.released_at,
      refundedAt: row.refunded_at,
      ticketRefundedAt: row.ticket_refunded_at
    },
    processor: {
      paymentIntentId: paymentIntent?.id ?? null,
      paymentIntentStatus: paymentIntent?.status ?? null,
      chargeId: charge?.id ?? null,
      balanceTransactionId: balanceTransaction?.id ?? null
    },
    operations: row.operations,
    processorEvents: row.processor_events,
    ledger: row.ledger,
    checks,
    decision: checks.every((item) => item.status === 'pass') ? 'GO' : 'HOLD'
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ decision: report.decision, output: outputPath, checks }, null, 2));
  if (report.decision !== 'GO') process.exitCode = 1;
} finally {
  await pool.end();
}
