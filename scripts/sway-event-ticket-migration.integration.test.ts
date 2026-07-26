import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = process.cwd();
const migrationDirectory = join(root, 'drizzle');
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const ticketMigrationIndex = migrationFiles.findIndex((name) => name.startsWith('0027_'));

assert.notEqual(ticketMigrationIndex, -1, 'The native-ticket migration must be present.');

const ids = {
  ownerUser: '00000000-0000-4000-8000-000000000101',
  buyerOne: '00000000-0000-4000-8000-000000000102',
  buyerTwo: '00000000-0000-4000-8000-000000000103',
  performer: '00000000-0000-4000-8000-000000000201',
  legacyEvent: '00000000-0000-4000-8000-000000000301',
  nativeEvent: '00000000-0000-4000-8000-000000000302',
  auxiliaryEvent: '00000000-0000-4000-8000-000000000303',
  nativeOffer: '00000000-0000-4000-8000-000000000401',
  auxiliaryOffer: '00000000-0000-4000-8000-000000000402',
  raceOrderOne: '00000000-0000-4000-8000-000000000501',
  raceOrderTwo: '00000000-0000-4000-8000-000000000502',
  auxiliaryOrder: '00000000-0000-4000-8000-000000000503',
  ticket: '00000000-0000-4000-8000-000000000601',
  admission: '00000000-0000-4000-8000-000000000701',
  checkoutOperation: '00000000-0000-4000-8000-000000000801',
  expiryOperation: '00000000-0000-4000-8000-000000000802',
  ledgerEntry: '00000000-0000-4000-8000-000000000901',
  processorEvent: '00000000-0000-4000-8000-000000001001'
} as const;

const sellerTermsHash = 'a'.repeat(64);
const buyerTermsHash = 'b'.repeat(64);
const credentialHash = 'c'.repeat(64);
const admissionEvidenceHash = 'd'.repeat(64);
const requestFingerprintOne = 'e'.repeat(64);
const requestFingerprintTwo = 'f'.repeat(64);
const payloadHash = '1'.repeat(64);

async function applyMigrations(database: PGlite, files: string[]) {
  for (const migrationFile of files) {
    const migrationSql = readFileSync(join(migrationDirectory, migrationFile), 'utf8');
    const statements = migrationSql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const [statementIndex, statement] of statements.entries()) {
      try {
        await database.exec(statement);
      } catch (error) {
        throw new Error(
          `Migration failed: ${migrationFile}, statement ${statementIndex + 1}`,
          { cause: error }
        );
      }
    }
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function expectDatabaseRejection(
  action: () => Promise<unknown>,
  expected: RegExp,
  label: string
) {
  await assert.rejects(action, (error: unknown) => {
    assert.match(errorText(error), expected, label);
    return true;
  });
}

async function insertOffer(
  database: PGlite,
  input: {
    id: string;
    eventId: string;
    capacity: number;
    payoutReady?: boolean;
  }
) {
  const payoutReady = input.payoutReady ?? true;
  return database.query(
    `insert into event_ticket_offers (
       id,
       event_id,
       performer_id,
       status,
       capacity,
       face_value_cents,
       mandatory_fee_bps,
       mandatory_fee_fixed_cents,
       mandatory_fee_cents,
       advertised_total_cents,
       seller_transfer_amount_cents,
       currency,
       tax_mode,
       stripe_tax_code,
       settlement_policy,
       checkout_reservation_minutes,
       refund_grace_minutes,
       sales_open_at,
       sales_close_at,
       seller_stripe_account_id_snapshot,
       seller_payment_account_status_snapshot,
       seller_kyc_status_snapshot,
       seller_charges_enabled_snapshot,
       seller_payouts_enabled_snapshot,
       payout_readiness_checked_at,
       seller_terms_version,
       seller_terms_hash,
       seller_terms_text,
       seller_terms_snapshot,
       seller_terms_accepted_by_user_id,
       seller_terms_accepted_at,
       created_by_actor_user_id,
       last_mutation_actor_user_id,
       activated_at
     ) values (
       $1, $2, $3, 'on_sale', $4,
       1000, 1000, 50, 150, 1150, 1000, 'USD',
       'stripe_automatic', 'txcd_99999999', 'refund_only',
       31, 1440, now() - interval '1 hour', now() + interval '1 day',
       'acct_ticket_seller', 'payouts_enabled', 'not_required', true, $5, now(),
       '2026-07-26.native-ga.v1', $6, 'Seller terms',
       '{"settlementPolicy":"refund_only"}'::jsonb,
       $7, now(), $7, $7, now()
     )`,
    [
      input.id,
      input.eventId,
      ids.performer,
      input.capacity,
      payoutReady,
      sellerTermsHash,
      ids.ownerUser
    ]
  );
}

async function insertOrder(
  database: PGlite,
  input: {
    id: string;
    offerId: string;
    eventId: string;
    buyerUserId: string;
    clientRequestId: string;
    requestFingerprint: string;
    quantity?: number;
    advertisedTotalCents?: number;
  }
) {
  return database.query(
    `insert into ticket_orders (
       id,
       offer_id,
       event_id,
       performer_id,
       buyer_user_id,
       client_request_id,
       request_fingerprint,
       quantity,
       face_value_cents,
       mandatory_fee_cents,
       advertised_total_cents,
       seller_transfer_amount_cents,
       currency,
       tax_mode_snapshot,
       stripe_tax_code_snapshot,
       buyer_terms_version,
       buyer_terms_hash,
       buyer_terms_text,
       buyer_terms_snapshot,
       buyer_terms_accepted_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8,
       1000, 150, $9, 1000, 'USD',
       'stripe_automatic', 'txcd_99999999',
       '2026-07-26.native-ga.v1', $10, 'Buyer terms',
       '{"settlementPolicy":"refund_only","advertisedTotalCents":1150}'::jsonb,
       now()
     )`,
    [
      input.id,
      input.offerId,
      input.eventId,
      ids.performer,
      input.buyerUserId,
      input.clientRequestId,
      input.requestFingerprint,
      input.quantity ?? 1,
      input.advertisedTotalCents ?? 1150,
      buyerTermsHash
    ]
  );
}

async function runMigrationProof(database: PGlite) {
  await applyMigrations(database, migrationFiles.slice(0, ticketMigrationIndex));

  // Seed a real pre-0027 event, then prove the migration preserves the
  // external handoff and supplies the backward-compatible mode.
  await database.exec(`
    insert into users (id, email, role) values
      ('${ids.ownerUser}', 'ticket-owner@example.test', 'performer'),
      ('${ids.buyerOne}', 'ticket-buyer-one@example.test', 'patron'),
      ('${ids.buyerTwo}', 'ticket-buyer-two@example.test', 'patron');

    insert into performers (
      id,
      owner_user_id,
      display_name,
      handle,
      is_active,
      onboarding_status,
      payment_account_status,
      kyc_status,
      charges_enabled,
      payouts_enabled,
      stripe_connected_account_id
    ) values (
      '${ids.performer}',
      '${ids.ownerUser}',
      'Ticket Seller',
      'ticket-seller',
      true,
      'gig_ready',
      'payouts_enabled',
      'not_required',
      true,
      true,
      'acct_ticket_seller'
    );

    insert into performer_events (
      id,
      performer_id,
      client_request_id,
      created_by_actor_user_id,
      last_mutation_actor_user_id,
      title,
      starts_at,
      ends_at,
      time_zone,
      external_ticket_url,
      external_ticket_label,
      visibility,
      status,
      published_at
    ) values (
      '${ids.legacyEvent}',
      '${ids.performer}',
      '00000000-0000-4000-8000-000000000311',
      '${ids.ownerUser}',
      '${ids.ownerUser}',
      'Legacy external event',
      now() + interval '10 days',
      now() + interval '10 days 3 hours',
      'America/Chicago',
      'https://tickets.example.test/legacy',
      'Get tickets',
      'public',
      'published',
      now()
    );
  `);

  await applyMigrations(database, migrationFiles.slice(ticketMigrationIndex));

  const legacy = await database.query<{
    ticketing_mode: string;
    external_ticket_url: string | null;
  }>(
    `select ticketing_mode::text, external_ticket_url
       from performer_events
      where id = $1`,
    [ids.legacyEvent]
  );
  assert.deepEqual(legacy.rows[0], {
    ticketing_mode: 'external',
    external_ticket_url: 'https://tickets.example.test/legacy'
  });

  await expectDatabaseRejection(
    () => database.exec(`
      insert into performer_events (
        id, performer_id, client_request_id, created_by_actor_user_id,
        last_mutation_actor_user_id, title, starts_at, ends_at, time_zone,
        ticketing_mode
      ) values (
        '00000000-0000-4000-8000-000000000304',
        '${ids.performer}',
        '00000000-0000-4000-8000-000000000314',
        '${ids.ownerUser}',
        '${ids.ownerUser}',
        'Missing door native event',
        now() + interval '4 days',
        now() + interval '4 days 3 hours',
        'America/Chicago',
        'native_ga'
      )
    `),
    /performer_events_native_door_required/i,
    'Every native event must persist an explicit door-opening time.'
  );
  await expectDatabaseRejection(
    () => database.exec(`
      insert into performer_events (
        id, performer_id, client_request_id, created_by_actor_user_id,
        last_mutation_actor_user_id, title, starts_at, door_opens_at,
        ends_at, time_zone, ticketing_mode
      ) values (
        '00000000-0000-4000-8000-000000000305',
        '${ids.performer}',
        '00000000-0000-4000-8000-000000000315',
        '${ids.ownerUser}',
        '${ids.ownerUser}',
        'Late door native event',
        now() + interval '5 days',
        now() + interval '5 days 1 hour',
        now() + interval '5 days 3 hours',
        'America/Chicago',
        'native_ga'
      )
    `),
    /performer_events_door_not_after_start/i,
    'A native door-opening time must not be after the event starts.'
  );

  await database.exec(`
    insert into performer_events (
      id,
      performer_id,
      client_request_id,
      created_by_actor_user_id,
      last_mutation_actor_user_id,
      title,
      starts_at,
      door_opens_at,
      ends_at,
      time_zone,
      ticketing_mode,
      visibility,
      status,
      published_at
    ) values
      (
        '${ids.nativeEvent}',
        '${ids.performer}',
        '00000000-0000-4000-8000-000000000312',
        '${ids.ownerUser}',
        '${ids.ownerUser}',
        'Native GA event',
        now() + interval '2 days',
        now() + interval '2 days' - interval '1 hour',
        now() + interval '2 days 3 hours',
        'America/Chicago',
        'native_ga',
        'public',
        'published',
        now()
      ),
      (
        '${ids.auxiliaryEvent}',
        '${ids.performer}',
        '00000000-0000-4000-8000-000000000313',
        '${ids.ownerUser}',
        '${ids.ownerUser}',
        'Auxiliary native GA event',
        now() + interval '3 days',
        now() + interval '3 days' - interval '1 hour',
        now() + interval '3 days 3 hours',
        'America/Chicago',
        'native_ga',
        'public',
        'published',
        now()
      );
  `);

  await expectDatabaseRejection(
    () => database.query(
      `update performer_events
          set ticketing_mode = 'external'
        where id = $1`,
      [ids.nativeEvent]
    ),
    /ticketing mode is immutable/i,
    'Event ticketing mode must not be rewritten.'
  );
  await expectDatabaseRejection(
    () => database.query(
      `update performer_events
          set door_opens_at = door_opens_at - interval '15 minutes'
        where id = $1`,
      [ids.nativeEvent]
    ),
    /fulfillment terms are sealed/i,
    'The published native door-opening time must be immutable.'
  );

  await insertOffer(database, {
    id: ids.nativeOffer,
    eventId: ids.nativeEvent,
    capacity: 1
  });

  await expectDatabaseRejection(
    () => insertOffer(database, {
      id: ids.auxiliaryOffer,
      eventId: ids.auxiliaryEvent,
      capacity: 5,
      payoutReady: false
    }),
    /event_ticket_offers_payout_ready/i,
    'An offer must snapshot an actually payout-ready seller.'
  );
  await insertOffer(database, {
    id: ids.auxiliaryOffer,
    eventId: ids.auxiliaryEvent,
    capacity: 5
  });

  await expectDatabaseRejection(
    () => insertOrder(database, {
      id: '00000000-0000-4000-8000-000000000510',
      offerId: ids.auxiliaryOffer,
      eventId: ids.auxiliaryEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: '00000000-0000-4000-8000-000000000520',
      requestFingerprint: requestFingerprintOne,
      quantity: 2
    }),
    /ticket_orders_one_ticket_only/i,
    'Every order must reserve exactly one ticket.'
  );

  await expectDatabaseRejection(
    () => insertOrder(database, {
      id: '00000000-0000-4000-8000-000000000511',
      offerId: ids.auxiliaryOffer,
      eventId: ids.auxiliaryEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: '00000000-0000-4000-8000-000000000521',
      requestFingerprint: requestFingerprintOne,
      advertisedTotalCents: 1149
    }),
    /ticket_orders_price_valid/i,
    'Advertised all-in price must equal face value plus mandatory fee.'
  );

  await insertOrder(database, {
    id: ids.auxiliaryOrder,
    offerId: ids.auxiliaryOffer,
    eventId: ids.auxiliaryEvent,
    buyerUserId: ids.buyerOne,
    clientRequestId: '00000000-0000-4000-8000-000000000522',
    requestFingerprint: requestFingerprintOne
  });
  await expectDatabaseRejection(
    () => insertOrder(database, {
      id: '00000000-0000-4000-8000-000000000512',
      offerId: ids.auxiliaryOffer,
      eventId: ids.auxiliaryEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: '00000000-0000-4000-8000-000000000525',
      requestFingerprint: requestFingerprintTwo
    }),
    /ticket_orders_offer_buyer_active_idx/i,
    'One verified buyer account may hold only one active or paid order per event.'
  );

  await expectDatabaseRejection(
    () => database.query(
      `update ticket_orders
          set status = 'paid',
              tax_total_cents = 50,
              charged_total_cents = 1199,
              processor_checkout_session_id = 'cs_ticket_bad_total',
              processor_payment_intent_id = 'pi_ticket_bad_total',
              processor_charge_id = 'ch_ticket_bad_total',
              processor_balance_transaction_id = 'txn_ticket_bad_total',
              processor_fee_cents = 40,
              processor_net_cents = 1159,
              charged_at = now()
        where id = $1`,
      [ids.auxiliaryOrder]
    ),
    /ticket_orders_(?:final_charge|charged_state)_coherent/i,
    'Provider charge total must equal advertised total plus final tax.'
  );
  await expectDatabaseRejection(
    () => database.query(
      `update ticket_orders
          set status = 'paid',
              tax_total_cents = 50,
              charged_total_cents = 1200,
              processor_checkout_session_id = 'cs_ticket_missing_fee',
              processor_payment_intent_id = 'pi_ticket_missing_fee',
              processor_charge_id = 'ch_ticket_missing_fee',
              charged_at = now()
        where id = $1`,
      [ids.auxiliaryOrder]
    ),
    /ticket_orders_(?:final_charge|charged_state)_coherent/i,
    'A captured ticket cannot become paid without exact balance-transaction fee and net evidence.'
  );
  await database.query(
    `update ticket_orders
        set status = 'expired',
            expired_at = now()
      where id = $1`,
    [ids.auxiliaryOrder]
  );
  await expectDatabaseRejection(
    () => database.query(
      `update ticket_orders
          set status = 'voided',
              voided_at = now()
        where id = $1`,
      [ids.auxiliaryOrder]
    ),
    /illegal ticket order status transition/i,
    'An expired order must not move to an unrelated terminal state.'
  );
  await database.query(
    `update ticket_orders
        set status = 'refund_pending',
            tax_total_cents = 50,
            charged_total_cents = 1200,
            processor_checkout_session_id = 'cs_ticket_late_success',
            processor_payment_intent_id = 'pi_ticket_late_success',
            processor_charge_id = 'ch_ticket_late_success',
            processor_balance_transaction_id = 'txn_ticket_late_success',
            processor_fee_cents = 40,
            processor_net_cents = 1160,
            charged_at = now(),
            refund_pending_at = now()
      where id = $1`,
    [ids.auxiliaryOrder]
  );
  const lateSuccess = await database.query<{
    status: string;
    processor_charge_id: string | null;
    refund_pending_at: Date | null;
  }>(
    `select status::text, processor_charge_id, refund_pending_at
       from ticket_orders
      where id = $1`,
    [ids.auxiliaryOrder]
  );
  assert.equal(lateSuccess.rows[0]?.status, 'refund_pending');
  assert.equal(lateSuccess.rows[0]?.processor_charge_id, 'ch_ticket_late_success');
  assert(lateSuccess.rows[0]?.refund_pending_at);

  const reservationAttempts = await Promise.allSettled([
    insertOrder(database, {
      id: ids.raceOrderOne,
      offerId: ids.nativeOffer,
      eventId: ids.nativeEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: '00000000-0000-4000-8000-000000000523',
      requestFingerprint: requestFingerprintOne
    }),
    insertOrder(database, {
      id: ids.raceOrderTwo,
      offerId: ids.nativeOffer,
      eventId: ids.nativeEvent,
      buyerUserId: ids.buyerTwo,
      clientRequestId: '00000000-0000-4000-8000-000000000524',
      requestFingerprint: requestFingerprintTwo
    })
  ]);
  assert.equal(
    reservationAttempts.filter((result) => result.status === 'fulfilled').length,
    1,
    'Exactly one concurrent reservation may claim capacity one.'
  );
  assert.equal(
    reservationAttempts.filter((result) => result.status === 'rejected').length,
    1,
    'The second concurrent reservation must fail closed.'
  );

  const winningOrderResult = await database.query<{ id: string }>(
    `select id
       from ticket_orders
      where offer_id = $1`,
    [ids.nativeOffer]
  );
  assert.equal(winningOrderResult.rows.length, 1);
  const winningOrderId = winningOrderResult.rows[0]!.id;

  await expectDatabaseRejection(
    () => database.query(
      `update event_ticket_offers
          set seller_terms_text = 'Rewritten seller terms'
        where id = $1`,
      [ids.nativeOffer]
    ),
    /commercial terms are sealed/i,
    'On-sale offer terms must be sealed.'
  );
  await expectDatabaseRejection(
    () => database.query(
      `update ticket_orders
          set buyer_terms_text = 'Rewritten buyer terms'
        where id = $1`,
      [winningOrderId]
    ),
    /identity, price, and terms are immutable/i,
    'Buyer terms snapshots must be immutable.'
  );
  await expectDatabaseRejection(
    () => database.query(
      `update ticket_orders
          set advertised_total_cents = 1200
        where id = $1`,
      [winningOrderId]
    ),
    /identity, price, and terms are immutable/i,
    'Order price snapshots must be immutable.'
  );

  await database.query(
    `update ticket_orders
        set status = 'paid',
            tax_total_cents = 50,
            charged_total_cents = 1200,
            processor_checkout_session_id = 'cs_ticket_winner',
            processor_payment_intent_id = 'pi_ticket_winner',
            processor_charge_id = 'ch_ticket_winner',
            processor_balance_transaction_id = 'txn_ticket_winner',
            processor_fee_cents = 40,
            processor_net_cents = 1160,
            charged_at = now()
      where id = $1`,
    [winningOrderId]
  );
  await expectDatabaseRejection(
    () => database.query(
      `update ticket_orders
          set status = 'checkout_open',
              checkout_expires_at = now() + interval '30 minutes'
        where id = $1`,
      [winningOrderId]
    ),
    /illegal ticket order status transition/i,
    'A paid order must not regress to checkout.'
  );

  await expectDatabaseRejection(
    () => database.query(
      `insert into event_tickets (
         id, order_id, offer_id, event_id, performer_id, buyer_user_id,
         status, admission_credential_version, admission_credential_hash,
         release_pending_at
       ) values (
         '00000000-0000-4000-8000-000000000610',
         $1, $2, $3, $4, $5,
         'release_pending', 1, $6, now()
       )`,
      [
        winningOrderId,
        ids.nativeOffer,
        ids.nativeEvent,
        ids.performer,
        winningOrderId === ids.raceOrderOne ? ids.buyerOne : ids.buyerTwo,
        credentialHash
      ]
    ),
    /event_tickets_state_evidence/i,
    'Release pending requires accepted-admission evidence.'
  );

  const winningBuyerId = winningOrderId === ids.raceOrderOne
    ? ids.buyerOne
    : ids.buyerTwo;
  await database.query(
    `insert into event_tickets (
       id, order_id, offer_id, event_id, performer_id, buyer_user_id,
       status, admission_credential_version, admission_credential_hash
     ) values ($1, $2, $3, $4, $5, $6, 'held', 1, $7)`,
    [
      ids.ticket,
      winningOrderId,
      ids.nativeOffer,
      ids.nativeEvent,
      ids.performer,
      winningBuyerId,
      credentialHash
    ]
  );

  await expectDatabaseRejection(
    () => database.query(
      `insert into event_tickets (
         order_id, offer_id, event_id, performer_id, buyer_user_id,
         status, admission_credential_version, admission_credential_hash
       ) values ($1, $2, $3, $4, $5, 'held', 1, $6)`,
      [
        winningOrderId,
        ids.nativeOffer,
        ids.nativeEvent,
        ids.performer,
        winningBuyerId,
        credentialHash
      ]
    ),
    /event_tickets_order_idx/i,
    'An order may issue only one ticket.'
  );

  await expectDatabaseRejection(
    () => database.query(
      `update event_tickets
          set status = 'release_pending',
              release_pending_at = now()
        where id = $1`,
      [ids.ticket]
    ),
    /event_tickets_state_evidence/i,
    'Ticket state cannot claim admission without complete evidence.'
  );

  await database.query(
    `insert into ticket_admission_events (
       id,
       ticket_id,
       order_id,
       offer_id,
       event_id,
       performer_id,
       accepted_by_user_id,
       client_request_id,
       idempotency_key,
       admission_credential_version,
       presented_credential_hash,
       evidence,
       accepted_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7,
       '00000000-0000-4000-8000-000000000711',
       'admission:ticket:one',
       1,
       $8,
       '{"accepted":true,"scanner":"performer"}'::jsonb,
       now()
     )`,
    [
      ids.admission,
      ids.ticket,
      winningOrderId,
      ids.nativeOffer,
      ids.nativeEvent,
      ids.performer,
      ids.ownerUser,
      credentialHash
    ]
  );
  await database.query(
    `update event_tickets
        set status = 'release_pending',
            admission_accepted_at = now(),
            admission_accepted_by_user_id = $2,
            admission_idempotency_key = 'admission:ticket:one',
            admission_evidence_hash = $3,
            release_pending_at = now()
      where id = $1`,
    [ids.ticket, ids.ownerUser, admissionEvidenceHash]
  );
  await database.query(
    `update event_tickets
        set status = 'released',
            released_at = now()
      where id = $1`,
    [ids.ticket]
  );
  await expectDatabaseRejection(
    () => database.query(
      `update event_tickets
          set status = 'held'
        where id = $1`,
      [ids.ticket]
    ),
    /illegal event ticket status transition/i,
    'Released tickets must not return to held.'
  );

  await expectDatabaseRejection(
    () => database.query(
      `update ticket_admission_events
          set evidence = '{"accepted":false}'::jsonb
        where id = $1`,
      [ids.admission]
    ),
    /append-only/i,
    'Admission evidence must be append-only.'
  );
  await expectDatabaseRejection(
    () => database.query(
      `delete from ticket_admission_events where id = $1`,
      [ids.admission]
    ),
    /append-only/i,
    'Admission evidence must not be deletable.'
  );

  await database.query(
    `insert into ticket_ledger_entries (
       id,
       order_id,
       ticket_id,
       entry_type,
       account,
       direction,
       amount_cents,
       currency,
       transaction_key,
       idempotency_key,
       processor_reference,
       occurred_at
     ) values (
       $1, $2, $3, 'charge_captured', 'platform_cash', 'debit',
       1200, 'USD', 'charge:ticket:one', 'ledger:charge:ticket:one',
       'ch_ticket_winner', now()
     )`,
    [ids.ledgerEntry, winningOrderId, ids.ticket]
  );
  await expectDatabaseRejection(
    () => database.query(
      `update ticket_ledger_entries set amount_cents = 1199 where id = $1`,
      [ids.ledgerEntry]
    ),
    /append-only/i,
    'Ledger facts must be append-only.'
  );
  await expectDatabaseRejection(
    () => database.query(
      `delete from ticket_ledger_entries where id = $1`,
      [ids.ledgerEntry]
    ),
    /append-only/i,
    'Ledger facts must not be deletable.'
  );

  await database.query(
    `insert into ticket_processor_events (
       id,
       processor,
       processor_event_id,
       event_type,
       payload_sha256,
       payload,
       livemode,
       order_id
     ) values (
       $1, 'stripe', 'evt_ticket_one', 'checkout.session.completed',
       $2, '{"id":"evt_ticket_one"}'::jsonb, false, $3
     )`,
    [ids.processorEvent, payloadHash, winningOrderId]
  );
  await expectDatabaseRejection(
    () => database.query(
      `insert into ticket_processor_events (
         processor, processor_event_id, event_type, payload_sha256, payload, livemode
       ) values (
         'stripe', 'evt_ticket_one', 'checkout.session.completed',
         $1, '{"id":"evt_ticket_one"}'::jsonb, false
       )`,
      [payloadHash]
    ),
    /ticket_processor_events_event_idx/i,
    'Stripe event IDs must deduplicate durably.'
  );

  await database.query(
    `insert into ticket_payment_operations (
       id,
       order_id,
       operation_type,
       idempotency_key,
       amount_cents,
       request_payload
     ) values (
       $1, $2, 'create_checkout', 'ticket-op:create-checkout',
       1150, '{"order":"winner"}'::jsonb
     )`,
    [ids.checkoutOperation, winningOrderId]
  );
  await expectDatabaseRejection(
    () => database.query(
      `insert into ticket_payment_operations (
         order_id,
         operation_type,
         idempotency_key,
         amount_cents,
         request_payload
       ) values (
         $1, 'create_checkout', 'ticket-op:create-checkout',
         1150, '{"order":"other"}'::jsonb
       )`,
      [ids.auxiliaryOrder]
    ),
    /ticket_payment_operations_idempotency_idx/i,
    'Outbox idempotency keys must be globally unique.'
  );
  await expectDatabaseRejection(
    () => database.query(
      `insert into ticket_payment_operations (
         order_id,
         operation_type,
         status,
         idempotency_key,
         request_payload
       ) values (
         $1, 'expire_checkout', 'leased',
         'ticket-op:bad-lease', '{"order":"winner"}'::jsonb
       )`,
      [winningOrderId]
    ),
    /ticket_payment_operations_lease_coherent/i,
    'A leased outbox job requires complete lease ownership.'
  );
  await database.query(
    `insert into ticket_payment_operations (
       id,
       order_id,
       operation_type,
       status,
       idempotency_key,
       request_payload,
       lease_owner,
       lease_expires_at
     ) values (
       $1, $2, 'expire_checkout', 'leased',
       'ticket-op:expire-checkout', '{"order":"winner"}'::jsonb,
       'ticket-worker-1', now() + interval '1 minute'
     )`,
    [ids.expiryOperation, winningOrderId]
  );

  await database.query(
    `update event_ticket_offers
        set status = 'sales_closed',
            sales_closed_at = now()
      where id = $1`,
    [ids.nativeOffer]
  );
  await expectDatabaseRejection(
    () => database.query(
      `update event_ticket_offers
          set status = 'draft'
        where id = $1`,
      [ids.nativeOffer]
    ),
    /illegal event ticket offer status transition/i,
    'Closed offers must not reopen through an illegal transition.'
  );

  await expectDatabaseRejection(
    () => database.query(`delete from ticket_orders where id = $1`, [winningOrderId]),
    /ticket orders cannot be deleted/i,
    'Financial orders must be retained.'
  );
  await expectDatabaseRejection(
    () => database.query(`delete from event_tickets where id = $1`, [ids.ticket]),
    /event tickets cannot be deleted/i,
    'Issued tickets must be retained.'
  );
  await expectDatabaseRejection(
    () => database.query(`delete from event_ticket_offers where id = $1`, [ids.nativeOffer]),
    /event ticket offers cannot be deleted/i,
    'Commercial offer snapshots must be retained.'
  );
  await expectDatabaseRejection(
    () => database.query(`delete from performer_events where id = $1`, [ids.nativeEvent]),
    /foreign key|violates/i,
    'An event with native financial evidence must not be cascade-deleted.'
  );

  const finalCounts = await database.query<{
    orders: number;
    tickets: number;
    admissions: number;
    ledger_entries: number;
  }>(
    `select
       (select count(*)::int from ticket_orders) as orders,
       (select count(*)::int from event_tickets) as tickets,
       (select count(*)::int from ticket_admission_events) as admissions,
       (select count(*)::int from ticket_ledger_entries) as ledger_entries`
  );
  assert.equal(finalCounts.rows[0]?.orders, 2);
  assert.equal(finalCounts.rows[0]?.tickets, 1);
  assert.equal(finalCounts.rows[0]?.admissions, 1);
  assert.equal(finalCounts.rows[0]?.ledger_entries, 1);
}

const database = new PGlite();

try {
  await runMigrationProof(database);
  console.log(
    `Native event ticket migration integration test passed (${migrationFiles.length} migrations).`
  );
} finally {
  await database.close();
}
