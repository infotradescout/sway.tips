import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../src/db/schema';
import {
  NATIVE_TICKET_BUYER_TERMS_HASH,
  NATIVE_TICKET_SELLER_TERMS_HASH,
  NATIVE_TICKET_SELLER_TERMS_TEXT,
  NATIVE_TICKET_TERMS_VERSION,
  type NativeTicketRuntimeConfig
} from '../src/server/event-ticket-contract';
import {
  createEventTicketService,
  EventTicketServiceError,
  type EventTicketService
} from '../src/server/event-ticket-service';
import type {
  CreateEventTicketCheckoutInput,
  EventTicketCheckoutResult,
  EventTicketPaymentIntentResult,
  EventTicketStripeProvider,
  EventTicketStripeWebhookEnvelope,
  RefundEventTicketPaymentInput,
  TransferEventTicketProceedsInput
} from '../src/server/event-ticket-stripe-provider';

const root = process.cwd();
const migrationDirectory = join(root, 'drizzle');
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

const ids = {
  owner: '10000000-0000-4000-8000-000000000001',
  buyerOne: '10000000-0000-4000-8000-000000000002',
  buyerTwo: '10000000-0000-4000-8000-000000000003',
  performer: '20000000-0000-4000-8000-000000000001',
  qrEvent: '30000000-0000-4000-8000-000000000001',
  manualEvent: '30000000-0000-4000-8000-000000000002',
  cancelEvent: '30000000-0000-4000-8000-000000000003',
  noShowEvent: '30000000-0000-4000-8000-000000000004',
  disputeEvent: '30000000-0000-4000-8000-000000000005',
  replacementEvent: '30000000-0000-4000-8000-000000000006',
  retryEvent: '30000000-0000-4000-8000-000000000007',
  qrOffer: '40000000-0000-4000-8000-000000000001',
  manualOffer: '40000000-0000-4000-8000-000000000002',
  cancelOffer: '40000000-0000-4000-8000-000000000003',
  noShowOffer: '40000000-0000-4000-8000-000000000004',
  disputeOffer: '40000000-0000-4000-8000-000000000005',
  replacementOffer: '40000000-0000-4000-8000-000000000006',
  retryOffer: '40000000-0000-4000-8000-000000000007',
  qrCheckoutRequest: '50000000-0000-4000-8000-000000000001',
  soldOutRequest: '50000000-0000-4000-8000-000000000002',
  manualCheckoutRequest: '50000000-0000-4000-8000-000000000003',
  cancelCheckoutRequest: '50000000-0000-4000-8000-000000000004',
  noShowCheckoutRequest: '50000000-0000-4000-8000-000000000005',
  buyerLimitRequest: '50000000-0000-4000-8000-000000000006',
  manualUnusedCheckoutRequest: '50000000-0000-4000-8000-000000000007',
  disputeCheckoutRequest: '50000000-0000-4000-8000-000000000008',
  selfPurchaseRequest: '50000000-0000-4000-8000-000000000009',
  replacementFirstRequest: '50000000-0000-4000-8000-000000000010',
  replacementSecondRequest: '50000000-0000-4000-8000-000000000011',
  retryCheckoutRequest: '50000000-0000-4000-8000-000000000012',
  qrCheckInRequest: '60000000-0000-4000-8000-000000000001',
  manualCheckInRequest: '60000000-0000-4000-8000-000000000002'
} as const;

const offerByEvent = new Map<string, string>([
  [ids.qrEvent, ids.qrOffer],
  [ids.manualEvent, ids.manualOffer],
  [ids.cancelEvent, ids.cancelOffer],
  [ids.noShowEvent, ids.noShowOffer],
  [ids.disputeEvent, ids.disputeOffer],
  [ids.replacementEvent, ids.replacementOffer]
]);
const eventStartsAt = new Date('2035-07-26T19:00:00.000Z');
const eventEndsAt = new Date('2035-07-26T21:00:00.000Z');
let currentNow = new Date('2035-07-25T12:00:00.000Z');

const runtimeConfig: NativeTicketRuntimeConfig = {
  salesEnabled: true,
  disabledReasons: [],
  expectedStripeLivemode: false,
  productionApprovalVersion: NATIVE_TICKET_TERMS_VERSION,
  feeBps: 1_000,
  feeFixedCents: 50,
  taxMode: 'not_required',
  stripeTaxCode: null,
  reservationMinutes: 31,
  refundGraceMinutes: 60,
  qrSecret: 'service-integration-ticket-qr-secret-that-is-long-enough',
  qrPreviousSecrets: [],
  appBaseUrl: 'https://app.sway.test',
  supportEmail: 'tickets@sway.test'
};

async function applyAllMigrations(database: PGlite) {
  for (const migrationFile of migrationFiles) {
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

function stripeId(prefix: string, orderId: string) {
  return `${prefix}_${orderId.replace(/-/g, '')}`;
}

function createFakeProvider(options: { checkoutFailures?: number } = {}) {
  const checkoutCalls: CreateEventTicketCheckoutInput[] = [];
  const transferCalls: TransferEventTicketProceedsInput[] = [];
  const refundCalls: RefundEventTicketPaymentInput[] = [];
  const sessions = new Map<string, EventTicketCheckoutResult>();
  const intents = new Map<string, EventTicketPaymentIntentResult>();
  let checkoutFailuresRemaining = Math.max(0, options.checkoutFailures ?? 0);

  const provider: EventTicketStripeProvider = {
    processor: 'stripe',
    tax: { mode: 'not_required' },

    async createCheckoutSession(input) {
      checkoutCalls.push(input);
      if (checkoutFailuresRemaining > 0) {
        checkoutFailuresRemaining -= 1;
        throw new Error('Temporary fake Checkout Session failure.');
      }
      const checkoutSessionId = stripeId('cs', input.orderId);
      const result: EventTicketCheckoutResult = {
        checkoutSessionId,
        checkoutUrl: `https://checkout.stripe.test/${checkoutSessionId}`,
        checkoutStatus: 'open',
        paymentStatus: 'unpaid',
        paymentIntentId: null,
        chargeId: null,
        amountSubtotalCents: input.amountTotalCents,
        amountTaxCents: 0,
        amountTotalCents: input.amountTotalCents,
        currency: 'usd',
        expiresAtUnixSeconds: input.expiresAtUnixSeconds,
        metadata: {
          ...input.metadata,
          sway_ticket_lane: 'native_ga',
          sway_ticket_order_id: input.orderId,
          sway_ticket_event_id: input.eventId,
          sway_ticket_offer_id: input.offerId,
          sway_ticket_buyer_account_id: input.buyerAccountId,
          sway_ticket_terms_hash: input.termsHash
        }
      };
      sessions.set(checkoutSessionId, result);
      return result;
    },

    async retrieveCheckoutSession(checkoutSessionId) {
      const result = sessions.get(checkoutSessionId);
      assert.ok(result, `Unknown fake Checkout Session ${checkoutSessionId}`);
      return result;
    },

    async retrievePaymentIntent(paymentIntentId) {
      const result = intents.get(paymentIntentId);
      assert.ok(result, `Unknown fake PaymentIntent ${paymentIntentId}`);
      return result;
    },

    async refundPayment(input) {
      refundCalls.push(input);
      return {
        refundId: stripeId('re', input.paymentIntentId),
        paymentIntentId: input.paymentIntentId,
        chargeId: null,
        amountCents: input.amountCents ?? 1_150,
        currency: 'usd',
        status: 'succeeded',
        metadata: input.metadata ?? {}
      };
    },

    async transferProceeds(input) {
      transferCalls.push(input);
      return {
        transferId: stripeId('tr', input.metadata?.sway_ticket_order_id ?? input.sourceChargeId),
        destinationAccountId: input.destinationAccountId,
        sourceChargeId: input.sourceChargeId,
        amountCents: input.amountCents,
        amountReversedCents: 0,
        currency: 'usd',
        transferGroup: input.transferGroup,
        reversed: false,
        metadata: input.metadata ?? {}
      };
    },

    async expireCheckoutSession(input) {
      const current = sessions.get(input.checkoutSessionId);
      assert.ok(current, `Unknown fake Checkout Session ${input.checkoutSessionId}`);
      const expired = { ...current, checkoutStatus: 'expired', checkoutUrl: null };
      sessions.set(input.checkoutSessionId, expired);
      return expired;
    },

    parseVerifiedWebhookEvent(input) {
      assert.equal(input.signatureHeader, 'verified-test-signature');
      const raw = typeof input.rawBody === 'string'
        ? input.rawBody
        : input.rawBody.toString('utf8');
      return JSON.parse(raw) as EventTicketStripeWebhookEnvelope;
    }
  };

  return {
    provider,
    checkoutCalls,
    transferCalls,
    refundCalls,
    sessions,
    intents
  };
}

function webhookEnvelope(
  input: Partial<EventTicketStripeWebhookEnvelope>
    & Pick<EventTicketStripeWebhookEnvelope, 'providerEventId' | 'providerType' | 'kind'>
): EventTicketStripeWebhookEnvelope {
  return {
    livemode: false,
    accountId: null,
    createdAtUnixSeconds: Math.floor(currentNow.getTime() / 1_000),
    checkoutSessionId: null,
    paymentIntentId: null,
    chargeId: null,
    refundId: null,
    disputeId: null,
    transferId: null,
    destinationAccountId: null,
    sourceChargeId: null,
    status: null,
    amountCents: null,
    amountTaxCents: null,
    currency: null,
    transferGroup: null,
    refundFailureReason: null,
    refundPendingReason: null,
    disputeReason: null,
    disputeIsChargeRefundable: null,
    metadata: {},
    ...input
  };
}

async function sendEnvelope(
  service: EventTicketService,
  envelope: EventTicketStripeWebhookEnvelope
) {
  const rawBody = JSON.stringify(envelope);
  return service.ingestVerifiedWebhook({
    rawBody,
    signatureHeader: 'verified-test-signature'
  });
}

async function expectServiceError(
  action: () => Promise<unknown>,
  expectedCode: string,
  expectedStatus: number
) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof EventTicketServiceError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.status, expectedStatus);
    return true;
  });
}

async function seedNativeOffer(
  database: PGlite,
  eventId: string,
  offerId: string,
  capacity: number
) {
  await database.query(
    `insert into event_ticket_offers (
       id, event_id, performer_id, status, capacity,
       face_value_cents, mandatory_fee_bps, mandatory_fee_fixed_cents,
       mandatory_fee_cents, advertised_total_cents, seller_transfer_amount_cents,
       currency, tax_mode, stripe_tax_code, settlement_policy,
       checkout_reservation_minutes, refund_grace_minutes,
       sales_open_at, sales_close_at,
       seller_stripe_account_id_snapshot,
       seller_payment_account_status_snapshot,
       seller_kyc_status_snapshot,
       seller_charges_enabled_snapshot,
       seller_payouts_enabled_snapshot,
       payout_readiness_checked_at,
       seller_terms_version, seller_terms_hash, seller_terms_text,
       seller_terms_snapshot, seller_terms_accepted_by_user_id,
       seller_terms_accepted_at, created_by_actor_user_id,
       last_mutation_actor_user_id, activated_at
     ) values (
       $1, $2, $3, 'on_sale', $4,
       1000, 1000, 50, 150, 1150, 1000,
       'USD', 'not_required', null, 'refund_only',
       31, 60, $5, $6,
       'acct_native_ticket_seller',
       'payouts_enabled', 'not_required', true, true, $5,
       $7, $8, $9, $10::jsonb, $11, $5, $11, $11, $5
     )`,
    [
      offerId,
      eventId,
      ids.performer,
      capacity,
      new Date('2020-01-01T00:00:00.000Z'),
      eventStartsAt,
      NATIVE_TICKET_TERMS_VERSION,
      NATIVE_TICKET_SELLER_TERMS_HASH,
      NATIVE_TICKET_SELLER_TERMS_TEXT,
      JSON.stringify({
        settlementPolicy: 'refund_only',
        feeBps: 1_000,
        feeFixedCents: 50,
        taxMode: 'not_required',
        sellerSupportEmail: 'ticket-owner@example.test',
        isSwayExclusive: false,
        exclusiveEntitlementVersion: null,
        exclusiveEntitlementHash: null
      }),
      ids.owner
    ]
  );
}

async function seedDatabase(database: PGlite) {
  await database.exec(`
    insert into users (id, email, email_verified_at, role) values
      ('${ids.owner}', 'ticket-owner@example.test', now(), 'performer'),
      ('${ids.buyerOne}', 'ticket-buyer-one@example.test', now(), 'patron'),
      ('${ids.buyerTwo}', 'ticket-buyer-two@example.test', now(), 'patron');

    insert into performers (
      id, owner_user_id, display_name, handle, bio, visibility_state, is_active, onboarding_status,
      payment_account_status, kyc_status, charges_enabled, payouts_enabled,
      stripe_connected_account_id
    ) values (
      '${ids.performer}', '${ids.owner}', 'Native Ticket Seller',
      'native-ticket-seller', 'A resolvable native ticket seller.', 'public', true, 'gig_ready', 'payouts_enabled',
      'not_required', true, true, 'acct_native_ticket_seller'
    );
  `);

  const eventRows = [
    [ids.qrEvent, 'QR Admission Show'],
    [ids.manualEvent, 'Manual Admission Show'],
    [ids.cancelEvent, 'Cancelled Show'],
    [ids.noShowEvent, 'No-show Refund Show'],
    [ids.disputeEvent, 'Dispute Ordering Show'],
    [ids.replacementEvent, 'Replacement Checkout Show'],
    [ids.retryEvent, 'Retry Eligibility Show']
  ] as const;
  for (const [eventId, title] of eventRows) {
    const clientRequestId = eventId.replace(/^3/, '7');
    await database.query(
      `insert into performer_events (
         id, performer_id, client_request_id, created_by_actor_user_id,
         last_mutation_actor_user_id, title, starts_at, door_opens_at, ends_at, time_zone,
         location_name, location_address, city, visibility, ticketing_mode,
         status, published_at
       ) values (
         $1, $2, $3, $4, $4, $5, $6, $9, $7, 'America/Chicago',
         'Test Door', '100 Test Way', 'Chicago, IL 60601', 'public', 'native_ga',
         'published', $8
       )`,
      [
        eventId,
        ids.performer,
        clientRequestId,
        ids.owner,
        title,
        eventStartsAt,
        eventEndsAt,
        currentNow,
        new Date(eventStartsAt.getTime() - 60 * 60_000)
      ]
    );
  }

  await seedNativeOffer(database, ids.qrEvent, ids.qrOffer, 1);
  await seedNativeOffer(database, ids.manualEvent, ids.manualOffer, 2);
  await seedNativeOffer(database, ids.cancelEvent, ids.cancelOffer, 1);
  await seedNativeOffer(database, ids.noShowEvent, ids.noShowOffer, 1);
  await seedNativeOffer(database, ids.disputeEvent, ids.disputeOffer, 1);
  await seedNativeOffer(database, ids.replacementEvent, ids.replacementOffer, 1);
  await seedNativeOffer(database, ids.retryEvent, ids.retryOffer, 1);
}

async function confirmPayment(
  service: EventTicketService,
  fake: ReturnType<typeof createFakeProvider>,
  input: {
    orderId: string;
    eventId: string;
    buyerUserId: string;
    sequence: number;
  }
) {
  const offerId = offerByEvent.get(input.eventId);
  assert.ok(offerId);
  const paymentIntentId = `pi_service_${input.sequence}`;
  const chargeId = `ch_service_${input.sequence}`;
  const transferGroup = `sway_ticket_${input.orderId}`;
  fake.intents.set(paymentIntentId, {
    paymentIntentId,
    chargeId,
    status: 'succeeded',
    amountCents: 1_150,
    amountReceivedCents: 1_150,
    balanceTransactionId: `txn_service_${input.sequence}`,
    processingFeeCents: 35,
    netCents: 1_115,
    currency: 'usd',
    transferGroup,
    metadata: {
      sway_ticket_lane: 'native_ga',
      sway_ticket_order_id: input.orderId
    }
  });
  const envelope = webhookEnvelope({
    providerEventId: `evt_service_payment_${input.sequence}`,
    providerType: 'payment_intent.succeeded',
    kind: 'payment_succeeded',
    paymentIntentId,
    chargeId,
    status: 'succeeded',
    amountCents: 1_150,
    amountTaxCents: 0,
    currency: 'usd',
    transferGroup,
    metadata: {
      sway_ticket_lane: 'native_ga',
      sway_ticket_order_id: input.orderId,
      sway_ticket_event_id: input.eventId,
      sway_ticket_offer_id: offerId,
      sway_ticket_buyer_account_id: input.buyerUserId,
      sway_ticket_terms_hash: NATIVE_TICKET_BUYER_TERMS_HASH
    }
  });
  const first = await sendEnvelope(service, envelope);
  assert.equal(first.status, 'processed');
  return envelope;
}

async function checkout(
  service: EventTicketService,
  input: {
    eventId: string;
    buyerUserId: string;
    clientRequestId: string;
  }
) {
  return service.createCheckoutOrder({
    ...input,
    termsAccepted: true
  });
}

async function scalarCount(database: PGlite, query: string, parameters: unknown[] = []) {
  const result = await database.query<{ count: number }>(query, parameters);
  return Number(result.rows[0]?.count ?? 0);
}

async function assertLedgerBalanced(database: PGlite, orderId: string) {
  const result = await database.query<{ entry_count: number; balance: number }>(
    `select count(*)::int as entry_count,
            coalesce(sum(
       case when direction = 'debit' then amount_cents else -amount_cents end
     ), 0)::int as balance
       from ticket_ledger_entries
      where order_id = $1`,
    [orderId]
  );
  assert.ok(
    Number(result.rows[0]?.entry_count ?? 0) > 0,
    `Expected ticket ledger entries for order ${orderId}.`
  );
  assert.equal(Number(result.rows[0]?.balance ?? 0), 0);
}

async function runServiceProof(
  database: PGlite,
  service: EventTicketService,
  fake: ReturnType<typeof createFakeProvider>
) {
  const openProjection = await service.getPublicOfferProjection({ eventId: ids.qrEvent });
  assert.equal(openProjection?.salesStatus, 'on_sale');

  await database.query(
    'update performers set payouts_enabled = false where id = $1',
    [ids.performer]
  );
  const payoutDisabledProjection = await service.getPublicOfferProjection({
    eventId: ids.qrEvent
  });
  assert.equal(
    payoutDisabledProjection?.salesStatus,
    'closed',
    'Public sale eligibility must close as soon as current seller payout readiness is lost.'
  );
  await expectServiceError(
    () => checkout(service, {
      eventId: ids.qrEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: ids.qrCheckoutRequest
    }),
    'ticket_seller_payout_not_ready',
    409
  );
  await database.query(
    'update performers set payouts_enabled = true where id = $1',
    [ids.performer]
  );
  await database.query(
    "update performers set onboarding_status = 'restricted' where id = $1",
    [ids.performer]
  );
  const restrictedProjection = await service.getPublicOfferProjection({ eventId: ids.qrEvent });
  assert.equal(
    restrictedProjection?.salesStatus,
    'closed',
    'A restricted performer cannot remain a publicly ready native ticket seller.'
  );
  await expectServiceError(
    () => service.publishNativeEvent({
      eventId: ids.qrEvent,
      performerId: ids.performer,
      actorUserId: ids.owner,
      expectedUpdatedAt: currentNow.toISOString()
    }),
    'ticket_seller_restricted',
    403
  );
  await expectServiceError(
    () => checkout(service, {
      eventId: ids.qrEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: ids.qrCheckoutRequest
    }),
    'ticket_seller_restricted',
    403
  );
  await database.query(
    "update performers set onboarding_status = 'gig_ready' where id = $1",
    [ids.performer]
  );
  await database.query(
    "update performers set visibility_state = 'draft' where id = $1",
    [ids.performer]
  );
  assert.equal(
    (await service.getPublicOfferProjection({ eventId: ids.qrEvent }))?.salesStatus,
    'closed',
    'A hidden seller profile must close a native ticket offer.'
  );
  await expectServiceError(
    () => service.publishNativeEvent({
      eventId: ids.qrEvent,
      performerId: ids.performer,
      actorUserId: ids.owner,
      expectedUpdatedAt: currentNow.toISOString()
    }),
    'ticket_seller_public_page_not_ready',
    409
  );
  await expectServiceError(
    () => checkout(service, {
      eventId: ids.qrEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: ids.qrCheckoutRequest
    }),
    'ticket_seller_public_page_not_ready',
    409
  );
  await database.query(
    "update performers set visibility_state = 'public' where id = $1",
    [ids.performer]
  );

  const stalePolicyService = createEventTicketService({
    db: drizzle(database, { schema }) as never,
    provider: fake.provider,
    runtimeConfig: {
      ...runtimeConfig,
      feeBps: runtimeConfig.feeBps! + 1
    },
    expectedStripeLivemode: false,
    now: () => new Date(currentNow)
  });
  const stalePolicyProjection = await stalePolicyService.getPublicOfferProjection({
    eventId: ids.qrEvent
  });
  assert.equal(
    stalePolicyProjection?.salesStatus,
    'closed',
    'A published offer must close publicly when the active fee policy changes.'
  );

  const retryBaselineNow = new Date(currentNow);
  const retryFake = createFakeProvider({ checkoutFailures: 1 });
  const retryService = createEventTicketService({
    db: drizzle(database, { schema }) as never,
    provider: retryFake.provider,
    runtimeConfig,
    expectedStripeLivemode: false,
    now: () => new Date(currentNow),
    workerId: 'checkout-eligibility-retry-worker'
  });
  await expectServiceError(
    () => checkout(retryService, {
      eventId: ids.retryEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: ids.retryCheckoutRequest
    }),
    'ticket_checkout_pending',
    503
  );
  assert.equal(retryFake.checkoutCalls.length, 1);

  await database.query(
    "update performers set onboarding_status = 'restricted' where id = $1",
    [ids.performer]
  );
  currentNow = new Date(currentNow.getTime() + 6_000);
  assert.deepEqual(
    await retryService.runDueOperations({ limit: 10, workerId: 'restricted-checkout-retry' }),
    { claimed: 1, succeeded: 0, failed: 1 }
  );
  assert.equal(
    retryFake.checkoutCalls.length,
    1,
    'A restricted seller must be rejected before a delayed create-checkout operation reaches Stripe.'
  );
  await expectServiceError(
    () => checkout(retryService, {
      eventId: ids.retryEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: ids.retryCheckoutRequest
    }),
    'ticket_seller_restricted',
    403
  );

  await database.query(
    "update performers set onboarding_status = 'gig_ready', visibility_state = 'draft' where id = $1",
    [ids.performer]
  );
  currentNow = new Date(currentNow.getTime() + 11_000);
  assert.deepEqual(
    await retryService.runDueOperations({ limit: 10, workerId: 'hidden-profile-checkout-retry' }),
    { claimed: 1, succeeded: 0, failed: 1 }
  );
  assert.equal(
    retryFake.checkoutCalls.length,
    1,
    'A seller whose Public Page became hidden must be rejected before a delayed checkout reaches Stripe.'
  );
  await expectServiceError(
    () => checkout(retryService, {
      eventId: ids.retryEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: ids.retryCheckoutRequest
    }),
    'ticket_seller_public_page_not_ready',
    409
  );

  await database.query(
    "update performers set visibility_state = 'public' where id = $1",
    [ids.performer]
  );
  currentNow = new Date(currentNow.getTime() + 21_000);
  assert.deepEqual(
    await retryService.runDueOperations({ limit: 10, workerId: 'restored-checkout-retry' }),
    { claimed: 1, succeeded: 1, failed: 0 }
  );
  assert.equal(retryFake.checkoutCalls.length, 2);
  const restoredRetryCheckout = await checkout(retryService, {
    eventId: ids.retryEvent,
    buyerUserId: ids.buyerOne,
    clientRequestId: ids.retryCheckoutRequest
  });
  assert.match(restoredRetryCheckout.checkoutUrl ?? '', /^https:\/\/checkout\.stripe\.test\//);

  currentNow = new Date(currentNow.getTime() + 32 * 60_000);
  await retryService.runMaintenance({ limit: 10 });
  await retryService.runDueOperations({ limit: 10, workerId: 'retry-proof-cleanup-worker' });
  assert.equal(
    (await retryService.getBuyerOrder({
      orderId: restoredRetryCheckout.orderId,
      buyerUserId: ids.buyerOne
    })).status,
    'checkout_expired'
  );
  currentNow = retryBaselineNow;

  const baselineNow = new Date(currentNow);
  const replacementFake = createFakeProvider();
  const replacementService = createEventTicketService({
    db: drizzle(database, { schema }) as never,
    provider: replacementFake.provider,
    runtimeConfig,
    expectedStripeLivemode: false,
    now: () => new Date(currentNow),
    workerId: 'replacement-order-worker'
  });
  const replacementFirst = await checkout(replacementService, {
    eventId: ids.replacementEvent,
    buyerUserId: ids.buyerOne,
    clientRequestId: ids.replacementFirstRequest
  });
  currentNow = new Date(currentNow.getTime() + 32 * 60_000);
  await replacementService.runMaintenance({ limit: 20 });
  await replacementService.runDueOperations({
    limit: 20,
    workerId: 'replacement-expiry-worker'
  });
  assert.equal(
    (await replacementService.getBuyerOrder({
      orderId: replacementFirst.orderId,
      buyerUserId: ids.buyerOne
    })).status,
    'checkout_expired'
  );
  const replacementSecond = await checkout(replacementService, {
    eventId: ids.replacementEvent,
    buyerUserId: ids.buyerOne,
    clientRequestId: ids.replacementSecondRequest
  });
  await confirmPayment(replacementService, replacementFake, {
    orderId: replacementFirst.orderId,
    eventId: ids.replacementEvent,
    buyerUserId: ids.buyerOne,
    sequence: 7
  });
  assert.equal(
    (await replacementService.getBuyerOrder({
      orderId: replacementFirst.orderId,
      buyerUserId: ids.buyerOne
    })).status,
    'refund_pending',
    'A late capture must persist for refund even when the buyer has a replacement checkout.'
  );
  assert.equal(
    (await replacementService.getBuyerOrder({
      orderId: replacementSecond.orderId,
      buyerUserId: ids.buyerOne
    })).status,
    'checkout_open'
  );
  await replacementService.runDueOperations({
    limit: 20,
    workerId: 'replacement-refund-worker'
  });
  assert.equal(
    (await replacementService.getBuyerOrder({
      orderId: replacementFirst.orderId,
      buyerUserId: ids.buyerOne
    })).status,
    'refunded'
  );
  await assertLedgerBalanced(database, replacementFirst.orderId);
  currentNow = new Date(currentNow.getTime() + 32 * 60_000);
  await replacementService.runMaintenance({ limit: 20 });
  await replacementService.runDueOperations({
    limit: 20,
    workerId: 'replacement-cleanup-worker'
  });
  assert.equal(
    (await replacementService.getBuyerOrder({
      orderId: replacementSecond.orderId,
      buyerUserId: ids.buyerOne
    })).status,
    'checkout_expired'
  );
  currentNow = baselineNow;

  await expectServiceError(
    () => checkout(service, {
      eventId: ids.qrEvent,
      buyerUserId: ids.owner,
      clientRequestId: ids.selfPurchaseRequest
    }),
    'ticket_seller_self_purchase_forbidden',
    403
  );
  assert.equal(fake.checkoutCalls.length, 0);

  const qrCheckout = await checkout(service, {
    eventId: ids.qrEvent,
    buyerUserId: ids.buyerOne,
    clientRequestId: ids.qrCheckoutRequest
  });
  assert.match(qrCheckout.checkoutUrl ?? '', /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(qrCheckout.ticketId, null);
  assert.equal(fake.checkoutCalls.length, 1);
  assert.deepEqual(fake.checkoutCalls[0].performanceLocation, {
    line1: '100 Test Way',
    city: 'Chicago',
    state: 'IL',
    postalCode: '60601',
    country: 'US',
    description: 'Test Door — QR Admission Show'
  });

  const idempotentCheckout = await checkout(service, {
    eventId: ids.qrEvent,
    buyerUserId: ids.buyerOne,
    clientRequestId: ids.qrCheckoutRequest
  });
  assert.equal(idempotentCheckout.orderId, qrCheckout.orderId);
  assert.equal(idempotentCheckout.checkoutUrl, qrCheckout.checkoutUrl);
  assert.equal(fake.checkoutCalls.length, 1);

  await database.query(
    "update performers set onboarding_status = 'restricted' where id = $1",
    [ids.performer]
  );
  await expectServiceError(
    () => checkout(service, {
      eventId: ids.qrEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: ids.qrCheckoutRequest
    }),
    'ticket_seller_restricted',
    403
  );
  assert.equal(
    fake.checkoutCalls.length,
    1,
    'A restricted seller must not expose an existing unpaid checkout URL.'
  );
  await database.query(
    "update performers set onboarding_status = 'gig_ready', visibility_state = 'draft' where id = $1",
    [ids.performer]
  );
  await expectServiceError(
    () => checkout(service, {
      eventId: ids.qrEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: ids.qrCheckoutRequest
    }),
    'ticket_seller_public_page_not_ready',
    409
  );
  assert.equal(fake.checkoutCalls.length, 1, 'A hidden seller must not expose an existing unpaid checkout URL.');
  await expectServiceError(
    () => checkout(service, {
      eventId: ids.qrEvent,
      buyerUserId: ids.buyerTwo,
      clientRequestId: ids.soldOutRequest
    }),
    'ticket_seller_public_page_not_ready',
    409
  );
  await database.query(
    "update performers set visibility_state = 'public' where id = $1",
    [ids.performer]
  );

  await expectServiceError(
    () => checkout(service, {
      eventId: ids.qrEvent,
      buyerUserId: ids.buyerOne,
      clientRequestId: ids.buyerLimitRequest
    }),
    'ticket_buyer_offer_limit',
    409
  );
  assert.equal(
    fake.checkoutCalls.length,
    1,
    'A second request id from the same buyer must not create another provider checkout.'
  );
  assert.equal(
    await scalarCount(
      database,
      'select count(*)::int as count from ticket_orders where event_id = $1 and buyer_user_id = $2',
      [ids.qrEvent, ids.buyerOne]
    ),
    1,
    'A buyer/offer cap denial must not reserve another ticket.'
  );

  // A hosted-checkout return is not proof of payment and cannot issue a ticket.
  const forgedReturnRead = await service.getBuyerOrder({
    orderId: qrCheckout.orderId,
    buyerUserId: ids.buyerOne
  });
  assert.deepEqual(forgedReturnRead.ticketIds, []);
  assert.equal(forgedReturnRead.status, 'checkout_open');

  await expectServiceError(
    () => checkout(service, {
      eventId: ids.qrEvent,
      buyerUserId: ids.buyerTwo,
      clientRequestId: ids.soldOutRequest
    }),
    'ticket_offer_sold_out',
    409
  );

  const qrPaymentEnvelope = await confirmPayment(service, fake, {
    orderId: qrCheckout.orderId,
    eventId: ids.qrEvent,
    buyerUserId: ids.buyerOne,
    sequence: 1
  });
  const issuedQrOrder = await service.getBuyerOrder({
    orderId: qrCheckout.orderId,
    buyerUserId: ids.buyerOne
  });
  assert.equal(issuedQrOrder.status, 'paid');
  assert.equal(issuedQrOrder.ticketIds.length, 1);
  const scheduledQrPass = await service.getBuyerTicketPass({
    ticketId: issuedQrOrder.ticketIds[0]!,
    buyerUserId: ids.buyerOne
  });
  assert.equal(scheduledQrPass.admissionStatus, 'scheduled');
  assert.equal(
    scheduledQrPass.admissionOpensAt,
    new Date(eventStartsAt.getTime() - 60 * 60_000).toISOString()
  );
  assert.equal(scheduledQrPass.qrToken, null);
  assert.equal(
    await scalarCount(
      database,
      'select count(*)::int as count from event_tickets where order_id = $1',
      [qrCheckout.orderId]
    ),
    1
  );
  await database.query(
    "update performers set onboarding_status = 'restricted', visibility_state = 'draft' where id = $1",
    [ids.performer]
  );
  const paidRecoveryReplay = await checkout(service, {
    eventId: ids.qrEvent,
    buyerUserId: ids.buyerOne,
    clientRequestId: ids.qrCheckoutRequest
  });
  assert.equal(paidRecoveryReplay.orderId, qrCheckout.orderId);
  assert.equal(
    paidRecoveryReplay.ticketId,
    issuedQrOrder.ticketIds[0],
    'Seller eligibility loss must not hide a ticket that was already paid and issued.'
  );
  await database.query(
    "update performers set onboarding_status = 'gig_ready', visibility_state = 'public' where id = $1",
    [ids.performer]
  );
  const captureLedger = await database.query<{
    account: string;
    direction: string;
    amount_cents: number;
    transaction_key: string;
  }>(
    `select account::text, direction::text, amount_cents, transaction_key
       from ticket_ledger_entries
      where order_id = $1
      order by account`,
    [qrCheckout.orderId]
  );
  const platformCashCapture = captureLedger.rows.find(
    (entry) => entry.account === 'platform_cash' && entry.direction === 'debit'
  );
  const processingFee = captureLedger.rows.find(
    (entry) => entry.account === 'processor_fee_expense'
  );
  assert.equal(platformCashCapture?.amount_cents, 1_115);
  assert.equal(processingFee?.amount_cents, 35);
  assert.equal(
    processingFee?.transaction_key,
    platformCashCapture?.transaction_key,
    'Gross capture liabilities and exact Stripe fee/net entries must share one balanced transaction.'
  );
  await assertLedgerBalanced(database, qrCheckout.orderId);

  const duplicatePayment = await sendEnvelope(service, qrPaymentEnvelope);
  assert.equal(duplicatePayment.status, 'duplicate');
  assert.equal(
    await scalarCount(
      database,
      `select count(*)::int as count
         from ticket_processor_events
        where processor_event_id = $1`,
      [qrPaymentEnvelope.providerEventId]
    ),
    1
  );

  const manualCheckout = await checkout(service, {
    eventId: ids.manualEvent,
    buyerUserId: ids.buyerTwo,
    clientRequestId: ids.manualCheckoutRequest
  });
  await confirmPayment(service, fake, {
    orderId: manualCheckout.orderId,
    eventId: ids.manualEvent,
    buyerUserId: ids.buyerTwo,
    sequence: 2
  });
  const manualUnusedCheckout = await checkout(service, {
    eventId: ids.manualEvent,
    buyerUserId: ids.buyerOne,
    clientRequestId: ids.manualUnusedCheckoutRequest
  });
  await confirmPayment(service, fake, {
    orderId: manualUnusedCheckout.orderId,
    eventId: ids.manualEvent,
    buyerUserId: ids.buyerOne,
    sequence: 5
  });

  const cancelCheckout = await checkout(service, {
    eventId: ids.cancelEvent,
    buyerUserId: ids.buyerOne,
    clientRequestId: ids.cancelCheckoutRequest
  });
  await confirmPayment(service, fake, {
    orderId: cancelCheckout.orderId,
    eventId: ids.cancelEvent,
    buyerUserId: ids.buyerOne,
    sequence: 3
  });

  const noShowCheckout = await checkout(service, {
    eventId: ids.noShowEvent,
    buyerUserId: ids.buyerTwo,
    clientRequestId: ids.noShowCheckoutRequest
  });
  await confirmPayment(service, fake, {
    orderId: noShowCheckout.orderId,
    eventId: ids.noShowEvent,
    buyerUserId: ids.buyerTwo,
    sequence: 4
  });

  const disputeCheckout = await checkout(service, {
    eventId: ids.disputeEvent,
    buyerUserId: ids.buyerTwo,
    clientRequestId: ids.disputeCheckoutRequest
  });
  const disputeEnvelope = webhookEnvelope({
    providerEventId: 'evt_service_dispute_before_capture',
    providerType: 'charge.dispute.created',
    kind: 'charge_disputed',
    paymentIntentId: 'pi_service_6',
    chargeId: 'ch_service_6',
    disputeId: 'dp_service_6',
    status: 'needs_response',
    amountCents: 1_150,
    currency: 'usd',
    disputeReason: 'fraudulent',
    metadata: {
      sway_ticket_lane: 'native_ga',
      sway_ticket_order_id: disputeCheckout.orderId
    }
  });
  const earlyDispute = await sendEnvelope(service, disputeEnvelope);
  assert.equal(
    earlyDispute.status,
    'retryable_failed',
    'A dispute delivered before capture and ticket issuance must remain retryable.'
  );
  await confirmPayment(service, fake, {
    orderId: disputeCheckout.orderId,
    eventId: ids.disputeEvent,
    buyerUserId: ids.buyerTwo,
    sequence: 6
  });
  const retriedDispute = await sendEnvelope(service, disputeEnvelope);
  assert.equal(retriedDispute.status, 'processed');
  const disputedOrder = await service.getBuyerOrder({
    orderId: disputeCheckout.orderId,
    buyerUserId: ids.buyerTwo
  });
  assert.equal(disputedOrder.status, 'disputed');
  assert.equal(
    await scalarCount(
      database,
      `select count(*)::int as count
         from ticket_ledger_entries
        where order_id = $1 and entry_type = 'dispute_opened'`,
      [disputeCheckout.orderId]
    ),
    2,
    'Retrying the dispute after capture must write the balanced dispute evidence.'
  );
  await assertLedgerBalanced(database, disputeCheckout.orderId);
  const disputeEventVersion = await database.query<{ updated_at: Date }>(
    'select updated_at from performer_events where id = $1',
    [ids.disputeEvent]
  );
  const disputeCancellation = await service.cancelNativeEvent({
    eventId: ids.disputeEvent,
    performerId: ids.performer,
    actorUserId: ids.owner,
    expectedUpdatedAt: new Date(disputeEventVersion.rows[0]!.updated_at).toISOString(),
    cancellationReason: 'The event cannot proceed while support resolves the disputed ticket.'
  });
  assert.equal(disputeCancellation.refundsQueued, 0);
  assert.equal(disputeCancellation.admittedTicketsPreserved, 0);
  assert.equal(disputeCancellation.disputedTicketsPreserved, 1);
  assert.equal(
    (await service.getBuyerOrder({
      orderId: disputeCheckout.orderId,
      buyerUserId: ids.buyerTwo
    })).status,
    'disputed',
    'Event cancellation must remain truthful while the disputed ticket stays in controlled support.'
  );
  const disputeClosed = await sendEnvelope(service, webhookEnvelope({
    providerEventId: 'evt_service_dispute_closed_6',
    providerType: 'charge.dispute.closed',
    kind: 'charge_dispute_closed',
    paymentIntentId: 'pi_service_6',
    chargeId: 'ch_service_6',
    disputeId: 'dp_service_6',
    status: 'won',
    amountCents: 1_150,
    currency: 'usd',
    disputeReason: 'fraudulent',
    metadata: {
      sway_ticket_lane: 'native_ga',
      sway_ticket_order_id: disputeCheckout.orderId
    }
  }));
  if (disputeClosed.status !== 'processed') {
    const stored = await database.query<{ status: string; last_error: string | null }>(
      `select status::text, last_error
         from ticket_processor_events
        where processor_event_id = 'evt_service_dispute_closed_6'`
    );
    console.error('Unexpected dispute-close webhook result', disputeClosed, stored.rows[0]);
  }
  assert.equal(disputeClosed.status, 'processed');
  assert.equal(
    (await service.getBuyerOrder({
      orderId: disputeCheckout.orderId,
      buyerUserId: ids.buyerTwo
    })).status,
    'refund_pending',
    'A won dispute on an unused ticket for a cancelled event must queue the buyer refund.'
  );

  const cancelEventVersion = await database.query<{ updated_at: Date }>(
    'select updated_at from performer_events where id = $1',
    [ids.cancelEvent]
  );
  const cancelled = await service.cancelNativeEvent({
    eventId: ids.cancelEvent,
    performerId: ids.performer,
    actorUserId: ids.owner,
    expectedUpdatedAt: new Date(cancelEventVersion.rows[0]!.updated_at).toISOString(),
    cancellationReason: 'Performer cannot appear.'
  });
  assert.equal(cancelled.refundsQueued, 1);
  assert.equal(
    await scalarCount(
      database,
      `select count(*)::int as count
         from ticket_payment_operations
        where order_id = $1 and operation_type = 'create_buyer_refund'
          and status = 'pending'`,
      [cancelCheckout.orderId]
    ),
    1
  );
  await service.runDueOperations({ limit: 10, workerId: 'service-refund-worker' });
  const cancelledOrder = await service.getBuyerOrder({
    orderId: cancelCheckout.orderId,
    buyerUserId: ids.buyerOne
  });
  assert.equal(cancelledOrder.status, 'refunded');
  assert.equal(fake.refundCalls.length, 2);
  assert.equal(
    (await service.getBuyerOrder({
      orderId: disputeCheckout.orderId,
      buyerUserId: ids.buyerTwo
    })).status,
    'refunded'
  );
  await assertLedgerBalanced(database, disputeCheckout.orderId);
  await assertLedgerBalanced(database, cancelCheckout.orderId);

  currentNow = new Date(eventStartsAt.getTime() + 10 * 60_000);
  const qrPass = await service.getBuyerTicketPass({
    ticketId: issuedQrOrder.ticketIds[0]!,
    buyerUserId: ids.buyerOne
  });
  assert.ok(qrPass.qrToken);
  const qrAdmission = await service.checkIn({
    eventId: ids.qrEvent,
    performerId: ids.performer,
    actorUserId: ids.owner,
    clientRequestId: ids.qrCheckInRequest,
    qrToken: qrPass.qrToken!
  });
  assert.equal(qrAdmission.result, 'accepted');
  const repeatedQrAdmission = await service.checkIn({
    eventId: ids.qrEvent,
    performerId: ids.performer,
    actorUserId: ids.owner,
    clientRequestId: ids.qrCheckInRequest,
    qrToken: qrPass.qrToken!
  });
  assert.equal(repeatedQrAdmission.result, 'already_accepted');

  const manualOrder = await service.getBuyerOrder({
    orderId: manualCheckout.orderId,
    buyerUserId: ids.buyerTwo
  });
  const manualPass = await service.getBuyerTicketPass({
    ticketId: manualOrder.ticketIds[0]!,
    buyerUserId: ids.buyerTwo
  });
  assert.ok(manualPass.manualCode);
  const rotatedService = createEventTicketService({
    db: drizzle(database, { schema }) as never,
    provider: fake.provider,
    runtimeConfig: {
      ...runtimeConfig,
      qrSecret: 'rotated-service-integration-ticket-secret-that-is-long-enough',
      qrPreviousSecrets: [runtimeConfig.qrSecret!]
    },
    expectedStripeLivemode: false,
    now: () => new Date(currentNow)
  });
  const rotatedManualPass = await rotatedService.getBuyerTicketPass({
    ticketId: manualOrder.ticketIds[0]!,
    buyerUserId: ids.buyerTwo
  });
  assert.equal(
    rotatedManualPass.manualCode,
    manualPass.manualCode,
    'Manual admission must remain usable during a configured QR-secret rotation.'
  );
  const manualAdmission = await rotatedService.checkIn({
    eventId: ids.manualEvent,
    performerId: ids.performer,
    actorUserId: ids.owner,
    clientRequestId: ids.manualCheckInRequest,
    manualCode: manualPass.manualCode!
  });
  assert.equal(manualAdmission.result, 'accepted');

  const manualEventVersion = await database.query<{ updated_at: Date }>(
    'select updated_at from performer_events where id = $1',
    [ids.manualEvent]
  );
  const mixedCancellation = await service.cancelNativeEvent({
    eventId: ids.manualEvent,
    performerId: ids.performer,
    actorUserId: ids.owner,
    expectedUpdatedAt: new Date(manualEventVersion.rows[0]!.updated_at).toISOString(),
    cancellationReason: 'The remainder of the event cannot continue.'
  });
  assert.equal(mixedCancellation.refundsQueued, 1);
  assert.equal(mixedCancellation.admittedTicketsPreserved, 1);
  assert.equal(mixedCancellation.disputedTicketsPreserved, 0);
  assert.equal(
    await scalarCount(
      database,
      `select count(*)::int as count
         from event_tickets
        where order_id = $1 and status = 'release_pending'`,
      [manualCheckout.orderId]
    ),
    1,
    'Cancellation must preserve the admitted ticket for settlement without clawback.'
  );
  assert.equal(
    await scalarCount(
      database,
      `select count(*)::int as count
         from event_tickets
        where order_id = $1 and status = 'refund_pending'`,
      [manualUnusedCheckout.orderId]
    ),
    1,
    'Cancellation must queue every unused paid ticket for a buyer refund.'
  );

  for (const orderId of [qrCheckout.orderId, manualCheckout.orderId]) {
    assert.equal(
      await scalarCount(
        database,
        `select count(*)::int as count
           from ticket_payment_operations
          where order_id = $1 and operation_type = 'create_seller_transfer'`,
        [orderId]
      ),
      1
    );
  }
  await service.runDueOperations({ limit: 10, workerId: 'service-transfer-worker' });
  assert.equal(fake.transferCalls.length, 2);
  assert.equal(fake.refundCalls.length, 3);
  assert.equal(
    await scalarCount(
      database,
      `select count(*)::int as count
         from event_tickets
        where order_id in ($1, $2) and status = 'released'`,
      [qrCheckout.orderId, manualCheckout.orderId]
    ),
    2
  );
  await assertLedgerBalanced(database, qrCheckout.orderId);
  await assertLedgerBalanced(database, manualCheckout.orderId);
  await assertLedgerBalanced(database, manualUnusedCheckout.orderId);

  currentNow = new Date(eventEndsAt.getTime() + 61 * 60_000);
  const maintenance = await service.runMaintenance({ limit: 20 });
  assert.equal(maintenance.noShowRefundsQueued, 1);
  await service.runDueOperations({ limit: 10, workerId: 'service-no-show-worker' });
  const noShowOrder = await service.getBuyerOrder({
    orderId: noShowCheckout.orderId,
    buyerUserId: ids.buyerTwo
  });
  assert.equal(noShowOrder.status, 'refunded');
  assert.equal(fake.refundCalls.length, 4);
  const unusedManualOrder = await service.getBuyerOrder({
    orderId: manualUnusedCheckout.orderId,
    buyerUserId: ids.buyerOne
  });
  assert.equal(unusedManualOrder.status, 'refunded');
  await expectServiceError(
    () => checkout(service, {
      eventId: ids.noShowEvent,
      buyerUserId: ids.buyerTwo,
      clientRequestId: ids.noShowCheckoutRequest
    }),
    'ticket_order_request_consumed',
    409
  );
  await assertLedgerBalanced(database, noShowCheckout.orderId);

  const processorEventCountBefore = await scalarCount(
    database,
    'select count(*)::int as count from ticket_processor_events'
  );
  const connectedAccountEvent = await sendEnvelope(service, webhookEnvelope({
    providerEventId: 'evt_connected_account_native_marker',
    providerType: 'payment_intent.succeeded',
    kind: 'payment_succeeded',
    accountId: 'acct_connected_performer',
    paymentIntentId: 'pi_connected_account',
    chargeId: 'ch_connected_account',
    amountCents: 500,
    currency: 'usd',
    metadata: { sway_ticket_lane: 'native_ga' }
  }));
  assert.equal(
    connectedAccountEvent.status,
    'not_ticket',
    'A signed connected-account event must never enter the platform ticket lane.'
  );
  const unrelated = await sendEnvelope(service, webhookEnvelope({
    providerEventId: 'evt_unrelated_live_room_payment',
    providerType: 'payment_intent.succeeded',
    kind: 'payment_succeeded',
    paymentIntentId: 'pi_unrelated_live_room_payment',
    chargeId: 'ch_unrelated_live_room_payment',
    amountCents: 500,
    currency: 'usd',
    transferGroup: 'legacy_live_room',
    metadata: {}
  }));
  assert.equal(unrelated.status, 'not_ticket');
  assert.equal(
    await scalarCount(
      database,
      'select count(*)::int as count from ticket_processor_events'
    ),
    processorEventCountBefore
  );

  await expectServiceError(
    () => service.ingestVerifiedWebhook({
      rawBody: '{}',
      signatureHeader: 'invalid-signature'
    }),
    'ticket_webhook_signature_invalid',
    400
  );
}

const database = new PGlite();

try {
  await applyAllMigrations(database);
  await seedDatabase(database);
  const fake = createFakeProvider();
  const db = drizzle(database, { schema });
  const service = createEventTicketService({
    db: db as never,
    provider: fake.provider,
    runtimeConfig,
    expectedStripeLivemode: false,
    now: () => new Date(currentNow),
    workerId: 'service-integration-worker'
  });
  assert.equal(
    service.canVerifyWebhook(),
    true,
    'The ticket lane must advertise webhook verification only when its provider exists.'
  );
  const providerlessService = createEventTicketService({
    db: db as never,
    provider: null,
    runtimeConfig,
    expectedStripeLivemode: false,
    now: () => new Date(currentNow),
    workerId: 'providerless-service-integration-worker'
  });
  assert.equal(
    providerlessService.canVerifyWebhook(),
    false,
    'A providerless ticket lane must not claim shared-webhook events.'
  );
  await expectServiceError(
    () => providerlessService.ingestVerifiedWebhook({
      rawBody: '{}',
      signatureHeader: 'verified-test-signature'
    }),
    'ticket_webhook_provider_unavailable',
    503
  );
  await runServiceProof(database, service, fake);
  console.log(
    `Native ticket service integration test passed (${migrationFiles.length} migrations).`
  );
} finally {
  await database.close();
}
