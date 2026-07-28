import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
// Source-boundary checks use newline-delimited sentinels. Normalize Windows
// checkouts so CRLF cannot hide the signed Stripe webhook implementation.
const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const failures = [];

function requireTerms(source, label, terms) {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${label} is missing: ${term}`);
  }
}

function requirePatterns(source, label, patterns) {
  for (const pattern of patterns) {
    if (!pattern.test(source)) failures.push(`${label} does not match: ${pattern}`);
  }
}

function requireAnyPattern(source, label, patterns) {
  if (!patterns.some((pattern) => pattern.test(source))) {
    failures.push(`${label} does not match any accepted boundary: ${patterns.join(' or ')}`);
  }
}

function forbidPatterns(source, label, patterns) {
  for (const pattern of patterns) {
    if (pattern.test(source)) failures.push(`${label} violates the native GA boundary: ${pattern}`);
  }
}

function sliceBetween(source, startTerm, endTerm, label) {
  const start = source.indexOf(startTerm);
  const end = start >= 0 ? source.indexOf(endTerm, start + startTerm.length) : -1;
  if (start < 0 || end <= start) {
    failures.push(`${label} source boundary could not be located.`);
    return '';
  }
  return source.slice(start, end);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function routeBlock(source, method, path) {
  const routePattern = new RegExp(
    `app\\.${method}\\(\\s*(['"])${escapeRegExp(path)}\\1`
  );
  const match = routePattern.exec(source);
  if (!match) {
    failures.push(`${method.toUpperCase()} ${path} route is missing.`);
    return '';
  }

  const nextRoutePattern = /\napp\.(?:get|post|put|patch|delete)\(/g;
  nextRoutePattern.lastIndex = match.index + match[0].length;
  const nextRoute = nextRoutePattern.exec(source);
  return source.slice(match.index, nextRoute?.index ?? source.length);
}

function runGate(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8'
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(`${label} failed with status ${result.status ?? 'unknown'}.`);
    process.exit(1);
  }
}

const schema = read('src/db/schema.ts');
const eventService = read('src/server/performer-event-service.ts');
const ticketContract = read('src/server/event-ticket-contract.ts');
const ticketService = read('src/server/event-ticket-service.ts');
const stripeProvider = read('src/server/event-ticket-stripe-provider.ts');
const tokenService = read('src/server/event-ticket-token.ts');
const server = read('server.ts');
const envExample = read('.env.example');
const renderConfig = read('render.yaml');
const readiness = read('config/sway-complete-product-readiness.json');
const purchaseCard = read('src/components/EventTicketPurchaseCard.tsx');
const eventManager = read('src/components/PerformerEventsManager.tsx');
const publicEventPage = read('src/components/PublicEventPage.tsx');
const orderReturnPage = read('src/components/TicketOrderReturnPage.tsx');
const ticketPassPage = read('src/components/TicketPassPage.tsx');
const ticketWalletPage = read('src/components/TicketWalletPage.tsx');
const doorPage = read('src/components/PerformerEventDoorPage.tsx');

const migrationName = readdirSync(join(root, 'drizzle'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .find((name) => {
    const migration = read(`drizzle/${name}`);
    return migration.includes('CREATE TABLE "event_ticket_offers"')
      && migration.includes('CREATE TABLE "ticket_orders"')
      && migration.includes('CREATE TABLE "ticket_admission_events"');
  });
if (!migrationName) failures.push('Generated native event ticket migration is missing.');
const migration = migrationName ? read(`drizzle/${migrationName}`) : '';

const ticketSchema = sliceBetween(
  schema,
  '// Native paid GA tickets',
  'export const gigSessions',
  'Native ticket schema'
);
const runtimeConfig = sliceBetween(
  ticketContract,
  'export function resolveNativeTicketRuntimeConfig',
  'export function calculateNativeTicketPrice',
  'Native ticket runtime configuration'
);
const checkoutProvider = sliceBetween(
  stripeProvider,
  'async createCheckoutSession(input)',
  'async retrieveCheckoutSession',
  'Stripe ticket checkout adapter'
);
const transferProvider = sliceBetween(
  stripeProvider,
  'async transferProceeds(input)',
  'async expireCheckoutSession',
  'Stripe ticket transfer adapter'
);
const webhookProvider = sliceBetween(
  stripeProvider,
  'parseVerifiedWebhookEvent(input)',
  '\n  };\n}',
  'Stripe ticket webhook adapter'
);
const webhookIngestion = sliceBetween(
  ticketService,
  'async function ingestVerifiedWebhook',
  'async function runSpecificOperation',
  'Ticket webhook ingestion'
);

// Production sales must remain closed unless every policy and secret is valid.
requireTerms(ticketContract, 'Native ticket fail-closed configuration', [
  'SWAY_NATIVE_TICKETS_ENABLED',
  'SWAY_TICKET_FEE_BPS',
  'SWAY_TICKET_FEE_FIXED_CENTS',
  'SWAY_TICKET_TAX_MODE',
  'SWAY_TICKET_QR_SECRET',
  'SWAY_TICKET_SUPPORT_EMAIL',
  'native_ticket_sales_not_enabled',
  'ticket_fee_policy_missing',
  'ticket_tax_mode_missing',
  'ticket_qr_secret_missing',
  'ticket_app_base_url_missing',
  'ticket_support_email_missing',
  'ticket_support_email_invalid'
]);
requireTerms(envExample, 'Native ticket environment contract', [
  'SWAY_NATIVE_TICKETS_ENABLED="false"',
  'SWAY_TICKET_PRODUCTION_APPROVAL_VERSION=""',
  'SWAY_TICKET_QR_PREVIOUS_SECRETS=""',
  'SWAY_TICKET_SUPPORT_EMAIL=""'
]);
requirePatterns(renderConfig, 'Production native ticket default', [
  /key:\s*SWAY_NATIVE_TICKETS_ENABLED\s*\n\s*value:\s*["']?false["']?/
]);
requireTerms(readiness, 'Native ticket readiness HOLD', [
  '"id": "native_general_admission_tickets"',
  '"status": "implemented_unverified"',
  'Production sales remain explicitly disabled.',
  'dispute and post-transfer reversal/reserve policy'
]);
requireTerms(runtimeConfig, 'Native ticket sales enablement', [
  'salesEnabled: requested && disabledReasons.length === 0'
]);
requireTerms(ticketService, 'Native ticket runtime gate', [
  'function requireSalesConfiguration',
  'if (!config.salesEnabled)',
  "'native_ticket_sales_disabled'",
  'const config = requireSalesConfiguration(runtimeConfig)',
  'const capability = getNativeTicketSalesCapability()',
  'salesStatus: salesStatus === \'on_sale\'',
  "? 'closed'"
]);
requirePatterns(ticketService, 'Native ticket public-sale policy gate', [
  /salesStatus:\s*salesStatus === 'on_sale'[\s\S]*!capability\.salesAvailable[\s\S]*!activeOfferPolicy[\s\S]*!activeSeller[\s\S]*\?\s*'closed'/
]);
requireTerms(ticketService, 'Native ticket capability timing policy', [
  'reservationMinutes: runtimeConfig.reservationMinutes',
  'refundGraceMinutes: runtimeConfig.refundGraceMinutes',
  'supportEmail: runtimeConfig.supportEmail'
]);

// External ticket handoffs and Sway-native inventory are mutually exclusive.
requireTerms(schema, 'Event ticketing modes', [
  "pgEnum('performer_event_ticketing_mode'",
  "'external'",
  "'native_ga'",
  "'performer_events_ticketing_mode_exclusive'",
  "'performer_events_native_door_required'",
  "'performer_events_door_not_after_start'",
  "doorOpensAt: timestamp('door_opens_at'"
]);
requireTerms(eventService, 'Event mode validation', [
  "const doorOpensAt = parseOptionalDateTime(input.doorOpensAt, 'Door-open time')",
  "if (ticketingMode === 'native_ga' && !doorOpensAt)",
  "'native_ticket_door_time_required'",
  'if (doorOpensAt && doorOpensAt.getTime() > startsAt.getTime())',
  "'event_door_after_start'",
  "if (ticketingMode === 'native_ga' && !endsAt)",
  "if (ticketingMode === 'native_ga' && externalTicketUrl)",
  "'native_ticket_external_url_conflict'"
]);
requireTerms(ticketService, 'Explicit native admission window', [
  'if (!event.doorOpensAt)',
  'const opensAt = event.doorOpensAt',
  'admissionOpensAt: event.event.doorOpensAt!.toISOString()',
  '!owner.event.doorOpensAt',
  'owner.event.doorOpensAt.getTime() <= now.getTime()',
  "'event_door_not_future'",
  "'native_ticket_event_window_invalid'"
]);
const createEventRoute = routeBlock(server, 'post', '/api/talent/events');
const updateEventRoute = routeBlock(server, 'patch', '/api/talent/events/:eventId');
requireTerms(createEventRoute, 'Native event create door field', [
  'doorOpensAt: req.body?.doorOpensAt'
]);
requireTerms(updateEventRoute, 'Native event update door field', [
  "'doorOpensAt'",
  'Object.prototype.hasOwnProperty.call(req.body ?? {}, field)'
]);
requireTerms(server, 'Public event door projection', [
  'doorOpensAt: event.doorOpensAt'
]);
for (const [label, source] of [
  ['Performer event service', eventService],
  ['Native ticket service', ticketService],
  ['Server ticket routes', server]
]) {
  forbidPatterns(source, `${label} admission timing`, [
    /\bNATIVE_TICKET_ADMISSION_LEAD_MINUTES\b/,
    /\badmissionLeadMinutes\b/,
    /startsAt\.getTime\(\)\s*-\s*(?:120|2\s*\*\s*60)\s*\*\s*60_000/
  ]);
}
requireTerms(migration, 'Event mode database protection', [
  'CREATE TYPE "public"."performer_event_ticketing_mode" AS ENUM(\'external\', \'native_ga\')',
  'CONSTRAINT "performer_events_ticketing_mode_exclusive"',
  'CONSTRAINT "performer_events_native_door_required"',
  'CONSTRAINT "performer_events_door_not_after_start"',
  'ADD COLUMN "door_opens_at" timestamp with time zone',
  'CREATE FUNCTION "sway_guard_performer_event_ticketing_mode"',
  'CREATE FUNCTION "sway_guard_published_native_event_fulfillment"',
  'CREATE TRIGGER "performer_events_ticketing_mode_immutable"',
  'CREATE TRIGGER "performer_events_published_native_fulfillment_guard"',
  'NEW."door_opens_at" IS DISTINCT FROM OLD."door_opens_at"',
  '"ticketing_mode" = \'native_ga\' OR "performer_events"."external_ticket_url" IS NOT NULL'
]);
requireTerms(publicEventPage, 'Public event mode rendering', [
  'event.externalTicket && !cancelled && !started',
  'event.nativeTicket && !cancelled && !started',
  '<EventTicketPurchaseCard'
]);
forbidPatterns(ticketSchema, 'Native ticket persistence', [
  /\bvenue_id\b/i,
  /\bhost_(?:id|user_id)\b/i,
  /\b(?:resale|secondary_sale|listed_for_sale)\b/i,
  /\b(?:holder_transfer|ticket_transfer|transferee_user_id)\b/i,
  /\b(?:forfeit|forfeited|credit_settlement|store_credit)\b/i
]);

// Financial, processor, and admission evidence must be durable and constrained.
requireTerms(schema, 'Native event ticket schema', [
  "export const eventTicketOffers = pgTable('event_ticket_offers'",
  "export const ticketOrders = pgTable('ticket_orders'",
  "export const eventTickets = pgTable('event_tickets'",
  "export const ticketPaymentOperations = pgTable('ticket_payment_operations'",
  "export const ticketLedgerEntries = pgTable('ticket_ledger_entries'",
  "export const ticketProcessorEvents = pgTable('ticket_processor_events'",
  "export const ticketAdmissionEvents = pgTable('ticket_admission_events'",
  "pgEnum('ticket_settlement_policy', ['refund_only'])",
  "pgEnum('ticket_payment_processor', ['stripe'])",
  "pgEnum('ticket_charge_account', ['platform'])",
  "'ticket_tax_payable'",
  "'event_ticket_offers_price_valid'",
  "'event_ticket_offers_payout_ready'",
  "'event_ticket_offers_seller_terms_valid'",
  "'ticket_orders_one_ticket_only'",
  "'ticket_orders_offer_buyer_active_idx'",
  "'ticket_orders_balance_transaction_idx'",
  "'ticket_orders_usd_only'",
  "'ticket_orders_automatic_platform_charge'",
  "'ticket_orders_final_charge_coherent'",
  "'ticket_orders_charged_state_coherent'",
  "processorBalanceTransactionId: text('processor_balance_transaction_id')",
  "processorFeeCents: integer('processor_fee_cents')",
  "processorNetCents: integer('processor_net_cents')",
  "'processor_fee_recorded'",
  "'processor_fee_expense'",
  "'event_tickets_admission_key_idx'",
  "'ticket_payment_operations_idempotency_idx'",
  "'ticket_payment_operations_order_type_idx'",
  "'ticket_payment_operations_lease_coherent'",
  "'ticket_ledger_entries_idempotency_idx'",
  "'ticket_processor_events_event_idx'",
  "'ticket_admission_events_ticket_idx'",
  "'ticket_admission_events_idempotency_idx'"
]);
requireTerms(migration, 'Native ticket migration', [
  'CREATE TABLE "event_ticket_offers"',
  'CREATE TABLE "ticket_orders"',
  'CREATE TABLE "event_tickets"',
  'CREATE TABLE "ticket_payment_operations"',
  'CREATE TABLE "ticket_ledger_entries"',
  'CREATE TABLE "ticket_processor_events"',
  'CREATE TABLE "ticket_admission_events"',
  'CREATE UNIQUE INDEX "ticket_orders_buyer_request_idx"',
  'CREATE UNIQUE INDEX "ticket_orders_offer_buyer_active_idx"',
  'CREATE UNIQUE INDEX "ticket_orders_balance_transaction_idx"',
  '"processor_balance_transaction_id" text',
  '"processor_fee_cents" integer',
  '"processor_net_cents" integer',
  'CONSTRAINT "ticket_orders_final_charge_coherent"',
  'CONSTRAINT "ticket_orders_charged_state_coherent"',
  "'processor_fee_expense'",
  "'processor_fee_recorded'",
  'CREATE UNIQUE INDEX "ticket_payment_operations_idempotency_idx"',
  'CREATE UNIQUE INDEX "ticket_payment_operations_order_type_idx"',
  'CREATE UNIQUE INDEX "ticket_ledger_entries_idempotency_idx"',
  'CREATE UNIQUE INDEX "ticket_processor_events_event_idx"',
  'CREATE UNIQUE INDEX "ticket_admission_events_ticket_idx"',
  'CREATE UNIQUE INDEX "ticket_admission_events_idempotency_idx"',
  'CREATE FUNCTION "sway_guard_event_ticket_offer"',
  'CREATE FUNCTION "sway_reserve_event_ticket_capacity"',
  'CREATE FUNCTION "sway_guard_ticket_order"',
  'CREATE FUNCTION "sway_guard_event_ticket"',
  'CREATE FUNCTION "sway_guard_ticket_processor_event"',
  'CREATE FUNCTION "sway_reject_ticket_evidence_mutation"',
  'CREATE TRIGGER "event_ticket_offers_guard"',
  'CREATE TRIGGER "ticket_orders_capacity_reservation"',
  'CREATE TRIGGER "ticket_orders_guard"',
  'CREATE TRIGGER "event_tickets_guard"',
  'CREATE TRIGGER "ticket_processor_events_guard"',
  'CREATE TRIGGER "ticket_ledger_entries_append_only"',
  'CREATE TRIGGER "ticket_admission_events_append_only"',
  'FOR UPDATE',
  "RAISE EXCEPTION 'ticket offer capacity exhausted'",
  "RAISE EXCEPTION 'event ticket offer commercial terms are sealed'",
  "RAISE EXCEPTION 'ticket order identity, price, and terms are immutable'",
  "RAISE EXCEPTION 'event ticket identity and admission credential are immutable'"
]);
for (const line of migration.split('\n')) {
  if (
    /ALTER TABLE "(?:event_ticket_offers|ticket_orders|event_tickets|ticket_payment_operations|ticket_ledger_entries|ticket_processor_events|ticket_admission_events)"/.test(line)
    && /ON DELETE cascade/i.test(line)
  ) {
    failures.push(`Native ticket financial evidence must not cascade-delete: ${line.trim()}`);
  }
}

// Checkout is a Stripe platform charge. Seller transfer is a later, idempotent
// operation tied to the original charge.
requireTerms(checkoutProvider, 'Stripe platform checkout', [
  'stripe.checkout.sessions.create',
  "mode: 'payment'",
  "capture_method: 'automatic'",
  'transfer_group: transferGroup',
  '{ idempotencyKey }'
]);
forbidPatterns(checkoutProvider, 'Stripe platform checkout', [
  /\btransfer_data\s*:/,
  /\bdestination\s*:/,
  /\bapplication_fee_amount\s*:/
]);
requireTerms(transferProvider, 'Stripe post-admission transfer', [
  'stripe.transfers.create',
  'destination: destinationAccountId',
  'source_transaction: sourceChargeId',
  'transfer_group: transferGroup',
  '{ idempotencyKey: requireIdempotencyKey(input.idempotencyKey) }'
]);
requireTerms(ticketService, 'Durable ticket payment orchestration', [
  "chargeAccount: 'platform'",
  "captureMode: 'automatic'",
  "operationType: 'create_checkout'",
  "operationType: 'create_seller_transfer'",
  'destinationAccountId: offer.sellerStripeAccountIdSnapshot',
  'sourceChargeId: row.order.processorChargeId',
  'await runSpecificOperation(created.operationId'
]);
requireTerms(stripeProvider, 'Stripe capture balance evidence', [
  "extractCaptureBalanceEvidence",
  "{ expand: ['latest_charge.balance_transaction'] }",
  'balanceTransactionId',
  'processingFeeCents',
  'netCents',
  'Stripe ticket capture currency must be coherent USD across the PaymentIntent, Charge, and balance transaction.',
  'Stripe ticket capture amounts must match across the PaymentIntent, Charge, and balance transaction.',
  'Stripe capture balance transaction net must equal its amount less its processing fee.',
  'Stripe capture balance transaction source must match the latest Charge.'
]);
requireTerms(ticketService, 'Exact captured cash and processor fee evidence', [
  'Stripe balance-transaction fee evidence is not yet available.',
  'processorBalanceTransactionId: input.balanceTransactionId',
  'processorFeeCents: input.processingFeeCents',
  'processorNetCents: input.netCents',
  '`stripe:balance-transaction:${input.balanceTransactionId}`',
  "account: 'platform_cash'",
  'amountCents: input.netCents',
  "entryType: 'processor_fee_recorded'",
  "account: 'processor_fee_expense'",
  'amountCents: input.processingFeeCents'
]);
requireTerms(ticketService, 'Hosted checkout redirect safety', [
  'function normalizeHostedCheckoutUrl',
  "url.protocol === 'https:'",
  'normalizeHostedCheckoutUrl(recordString(result, \'checkoutUrl\'))',
  'Stripe Checkout did not return a safe HTTPS hosted URL.'
]);

// Webhook payloads are verified before durable ingestion and are deduplicated
// by provider event id plus a raw-payload digest.
requireTerms(webhookProvider, 'Signed Stripe webhook verification', [
  'if (!input.signatureHeader)',
  'stripe.webhooks.constructEvent',
  'input.rawBody',
  'input.signatureHeader',
  'webhookSecret'
]);
requireTerms(stripeProvider, 'Stripe webhook account scope', [
  'accountId: event.account ?? null'
]);
requireTerms(webhookIngestion, 'Verified webhook persistence', [
  'envelope = provider.parseVerifiedWebhookEvent(input)',
  "'ticket_webhook_signature_invalid'",
  'if (envelope.accountId !== null)',
  "return { status: 'not_ticket' as const }",
  'const payloadSha256 = sha256(rawBody)',
  '.insert(ticketProcessorEvents)',
  'processorEventId: envelope.providerEventId',
  '.onConflictDoNothing()',
  'processorEvent.payloadSha256 !== payloadSha256',
  "'ticket_webhook_payload_conflict'"
]);
requireTerms(server, 'Shared versus dedicated ticket webhook routing', [
  'const sharedTicketWebhookSecret = Boolean(',
  'eventTicketService',
  '&& sharedTicketWebhookSecret'
]);
forbidPatterns(server, 'Shared versus dedicated ticket webhook routing', [
  /rawStripeEventHasNativeTicketMarker/,
  /sharedTicketWebhookSecret\s*\|\|/
]);
requireTerms(doorPage, 'Door check-in UUID fallback', [
  'new Uint8Array(16)',
  'globalThis.crypto.getRandomValues(bytes)',
  'bytes[6] = (bytes[6] & 0x0f) | 0x40',
  'bytes[8] = (bytes[8] & 0x3f) | 0x80',
  "hex.slice(0, 4).join('')"
]);
forbidPatterns(doorPage, 'Door check-in UUID fallback', [
  /return `checkin-\$\{Date\.now\(\)\}/
]);

// Buyer routes must derive identity from the authenticated account. Performer
// and door routes must use the owner gate and then repeat ownership checks in
// the ticket service.
const buyerRoutes = [
  ['post', '/api/account/ticket-orders', 'createCheckoutOrder'],
  ['get', '/api/account/ticket-orders/:orderId', 'getBuyerOrder'],
  ['get', '/api/account/tickets', 'listBuyerTickets'],
  ['get', '/api/account/tickets/:ticketId', 'getBuyerTicketPass']
];
const buyerGate = sliceBetween(
  server,
  'async function requireTicketBuyer',
  'type PerformerEventOwnerContext',
  'Ticket buyer route gate'
);
requireTerms(buyerGate, 'Ticket buyer route gate', [
  'accessControl.requireAuthenticatedAccountAccess(req)',
  'if (accountAccess.allowed === false)',
  'if (!accountAccess.actor.actorId)',
  'if (!businessDb || !eventTicketService)',
  'return { buyerUserId: accountAccess.actor.actorId }'
]);
for (const [method, path, serviceMethod] of buyerRoutes) {
  const route = routeBlock(server, method, path);
  requireTerms(route, `${method.toUpperCase()} ${path} buyer boundary`, [
    'requireTicketBuyer(req, res)',
    `eventTicketService.${serviceMethod}`
  ]);
  requireAnyPattern(route, `${method.toUpperCase()} ${path} buyer identity`, [
    /\.\.\.buyer/,
    /\(buyer\)/,
    /buyerUserId:\s*buyer\.buyerUserId/
  ]);
  forbidPatterns(route, `${method.toUpperCase()} ${path} buyer boundary`, [
    /buyerUserId\s*:\s*req\.(?:body|query|params)/,
    /actorUserId\s*:\s*req\.(?:body|query|params)/
  ]);
}

const ownerRoutes = [
  ['get', '/api/talent/events/:eventId/ticketing', ['getOwnerTicketOffer', 'toOwnedEventResponseWithTicket']],
  ['put', '/api/talent/events/:eventId/ticketing', ['updateOwnerTicketOffer']],
  ['get', '/api/talent/events/:eventId/door', ['getDoorSummary']],
  ['post', '/api/talent/events/:eventId/check-ins', ['checkIn']]
];
for (const [method, path, serviceMethods] of ownerRoutes) {
  const route = routeBlock(server, method, path);
  requireTerms(route, `${method.toUpperCase()} ${path} owner boundary`, [
    'requirePerformerEventOwner(req, res)'
  ]);
  requireAnyPattern(
    route,
    `${method.toUpperCase()} ${path} ticket service`,
    serviceMethods.map((serviceMethod) => new RegExp(escapeRegExp(serviceMethod)))
  );
  requireAnyPattern(route, `${method.toUpperCase()} ${path} owner identity`, [
    /\.\.\.owner/,
    /performerId:\s*owner\.performerId[\s\S]*actorUserId:\s*owner\.actorUserId/,
    /actorUserId:\s*owner\.actorUserId[\s\S]*performerId:\s*owner\.performerId/
  ]);
  forbidPatterns(route, `${method.toUpperCase()} ${path} owner boundary`, [
    /performerId\s*:\s*req\.(?:body|query|params)/,
    /actorUserId\s*:\s*req\.(?:body|query|params)/
  ]);
}

requireTerms(ticketService, 'Defense-in-depth ticket actor checks', [
  'async function requireOwnerContext',
  'eq(performerEvents.performerId, input.performerId)',
  'eq(performers.ownerUserId, input.actorUserId)',
  "'ticket_event_owner_required'",
  'async function requireVerifiedBuyer',
  'emailVerifiedAt: users.emailVerifiedAt',
  "'ticket_buyer_auth_required'",
  "'ticket_buyer_email_verification_required'",
  'eq(ticketOrders.buyerUserId, input.buyerUserId)',
  'eq(eventTickets.buyerUserId, input.buyerUserId)'
]);

const publishRoute = routeBlock(server, 'post', '/api/talent/events/:eventId/publish');
const cancelRoute = routeBlock(server, 'post', '/api/talent/events/:eventId/cancel');
requireTerms(publishRoute, 'Native/external publish routing', [
  'requirePerformerEventOwner(req, res)',
  'ticketingMode',
  "'native_ga'",
  'eventTicketService.publishNativeEvent',
  'performerEventService.publishEvent'
]);
requireTerms(cancelRoute, 'Native/external cancellation routing', [
  'requirePerformerEventOwner(req, res)',
  'ticketingMode',
  "'native_ga'",
  'eventTicketService.cancelNativeEvent',
  'performerEventService.cancelEvent'
]);
requireTerms(ticketService, 'Native mixed cancellation settlement', [
  'let admittedTicketsPreserved = 0',
  'let disputedTicketsPreserved = 0',
  'disputedTicketsPreserved += 1',
  'admittedTicketsPreserved += 1',
  ".set({ status: 'refund_pending', refundPendingAt: now, updatedAt: now })",
  "inArray(ticketOrders.status, ['checkout_pending', 'checkout_open'])",
  "operationType: 'expire_checkout'",
  "reason: 'seller_event_cancellation'",
  'eq(performerEvents.status, \'published\')',
  'eq(eventTicketOffers.id, offer.id)',
  "admittedSettlementPolicy: 'continue_without_clawback'",
  "disputedSettlementPolicy: 'controlled_support'",
  'cancelledUnusedRefundRequired',
  "reason: 'dispute_won_after_seller_event_cancellation'",
  "'refund_queued_after_cancellation'"
]);
forbidPatterns(ticketService, 'Native mixed cancellation settlement', [
  /\bnative_ticket_cancellation_locked\b/,
  /\bconst cancellationLocked\b/
]);

const paymentWebhookRoute = routeBlock(server, 'post', '/api/payment/webhook');
requireTerms(paymentWebhookRoute, 'Shared signed payment webhook route', [
  'rawBody',
  "req.header('stripe-signature')",
  'eventTicketService.ingestVerifiedWebhook',
  'paymentWebhookService.ingestWebhook'
]);

requireTerms(server, 'Public native ticket projection', [
  'eventTicketService.getPublicOfferProjection',
  'nativeTicket',
  "ticketingMode === 'native_ga'"
]);

// The QR credential is signed, short-lived, event-bound, and checked only by
// the online owner route before an append-only admission record is written.
requireTerms(tokenService, 'Rotating admission QR', [
  "createHmac('sha256'",
  'timingSafeEqual',
  'DEFAULT_QR_LIFETIME_SECONDS = 45',
  'MAX_QR_LIFETIME_SECONDS = 120',
  'issuedAt: nowSeconds',
  'expiresAt: nowSeconds + lifetimeSeconds',
  'candidate.eventId !== input.eventId',
  '(candidate.expiresAt as number) <= nowSeconds'
]);
requireTerms(ticketService, 'Online admission verification', [
  'verifyEventTicketQrToken',
  "'ticket_qr_invalid'",
  "credentialType = 'rotating_qr'",
  "status: 'release_pending'",
  '.insert(ticketAdmissionEvents)',
  'onlineConfirmed: true',
  "'already_accepted'"
]);
requireTerms(doorPage, 'Door fail-closed behavior', [
  'if (navigator.onLine === false)',
  'Sway never queues offline admission.',
  'No second admission or transfer was recorded.',
  'This confirms admission, not completion of a bank payout.'
]);
requireTerms(doorPage, 'Door boundary refresh behavior', [
  'window.setInterval(refreshWhenUsable, 15_000)',
  'new Date(door.admissionWindow.opensAt).getTime()',
  'new Date(door.admissionWindow.closesAt).getTime()',
  'window.setTimeout(refreshWhenUsable',
  "document.addEventListener('visibilitychange', refreshWhenUsable)",
  "window.addEventListener('online', refreshWhenUsable)"
]);

// Settlement language must not imply regulated escrow, credit, resale, or a
// completed refund/transfer before processor confirmation.
requireTerms(ticketContract, 'Native ticket settlement terms', [
  "settlementPolicy: 'refund_only'",
  "fundsDescription: 'captured_on_platform_not_yet_transferred'",
  'contractual payment hold',
  'not represented as a bank account, trust account, protected account, or regulated escrow account',
  'full refund to the original payment method',
  'A queued or pending refund is not complete until the payment provider confirms it.',
  'Credits, no-show forfeitures, ticket resale, and paid holder transfers are not part of this version.'
]);
requireTerms(server, 'Published native ticket terms', [
  'Sway Native Ticket Terms',
  'renderExactTicketTerms(NATIVE_TICKET_BUYER_TERMS_TEXT)',
  'renderExactTicketTerms(NATIVE_TICKET_SELLER_TERMS_TEXT)',
  'Each native order and offer stores its accepted text, version, and hash as an immutable snapshot.'
]);
requireTerms(purchaseCard, 'Buyer ticket settlement copy', [
  'one ticket before applicable government tax',
  'Stripe will show any applicable government tax before payment.',
  'Your payment is held by Sway.',
  'does not transfer the performer share until your ticket is checked in',
  'queues a full refund',
  'refund if this ticket remains unaccepted'
]);
requireTerms(eventManager, 'Seller ticket settlement copy', [
  'before applicable government tax',
  'refund-only policy',
  'queues full refunds for eligible unused tickets',
  'Admitted tickets keep their recorded settlement',
  'disputed payments remain under support review',
  'refunds may remain pending while the payment processor completes them'
]);
requireTerms(publicEventPage, 'Public mixed-cancellation copy', [
  'full refunds for eligible unused native tickets',
  'Admitted tickets keep their recorded settlement',
  'disputed payments remain under support review'
]);
requireTerms(orderReturnPage, 'Ticket issuance confirmation copy', [
  'Backend confirmed',
  'Sway confirmed payment and issued your admission pass.',
  'Stripe returned you to Sway, but that alone does not prove payment.'
]);
requireTerms(ticketPassPage, 'Ticket refund and rotating-pass copy', [
  'Show this rotating QR to the performer. It can be accepted once.',
  'Sway has requested a refund, but it is not complete until the processor confirms it.',
  'refund to the original payment method',
  '20_000'
]);
requireTerms(ticketWalletPage, 'Authenticated ticket wallet', [
  "fetch('/api/account/tickets'",
  'Tickets appear here only after Sway confirms payment.',
  'settlementStatus',
  "ticket.settlementStatus === 'released'",
  "'Transfer pending'"
]);
requireTerms(ticketPassPage, 'Raw ticket settlement state', [
  'settlementStatus',
  "ticket.settlementStatus === 'released'",
  'the performer transfer is pending processor confirmation'
]);
requireTerms(ticketService, 'Raw ticket settlement projection', [
  'settlementStatus: row.ticket.status'
]);

const supportPageRoute = routeBlock(server, 'get', '/support');
const supportContactRoute = routeBlock(server, 'get', '/api/support/contact');
requireTerms(server, 'Monitored ticket support document', [
  'function renderSupportPageHtml',
  'const supportEmail = nativeTicketRuntimeConfig.supportEmail',
  'Email the monitored Sway support channel.',
  'href="mailto:',
  'Native ticket sales remain disabled while this contact is missing.'
]);
requireTerms(supportPageRoute, 'Ticket support reference context', [
  'req.query.orderId',
  'req.query.ticketId',
  'renderSupportPageHtml(reference)'
]);
requireTerms(supportContactRoute, 'Ticket support capability endpoint', [
  'nativeTicketRuntimeConfig.supportEmail',
  "supportPath: '/support'"
]);
requireTerms(orderReturnPage, 'Order-scoped ticket support', [
  '/support?',
  'orderId: order.id'
]);
requireTerms(ticketPassPage, 'Pass-scoped ticket support', [
  '/support?',
  'ticketId: ticket.id'
]);

if (failures.length) {
  console.error('Native GA event ticket contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

const qrBehaviorProgram = String.raw`
  import assert from 'node:assert/strict';
  import {
    issueEventTicketQrToken,
    verifyEventTicketQrToken
  } from './src/server/event-ticket-token.ts';

  const ticketId = '11111111-1111-4111-8111-111111111111';
  const eventId = '22222222-2222-4222-8222-222222222222';
  const otherEventId = '33333333-3333-4333-8333-333333333333';
  const secret = 'ticket-qr-contract-secret-material-0001';
  const otherSecret = 'ticket-qr-contract-secret-material-0002';
  const issuedAt = new Date('2026-07-26T18:00:00.000Z');

  const first = issueEventTicketQrToken({
    ticketId,
    eventId,
    secret,
    now: issuedAt
  });
  assert.equal(first.payload.ticketId, ticketId);
  assert.equal(first.payload.eventId, eventId);
  assert.equal(first.payload.expiresAt - first.payload.issuedAt, 45);
  assert.deepEqual(
    verifyEventTicketQrToken({ token: first.token, eventId, secret, now: issuedAt }),
    first.payload
  );

  const rotated = issueEventTicketQrToken({
    ticketId,
    eventId,
    secret,
    now: new Date(issuedAt.getTime() + 1_000)
  });
  assert.notEqual(rotated.token, first.token);
  assert.equal(
    verifyEventTicketQrToken({ token: first.token, eventId: otherEventId, secret, now: issuedAt }),
    null
  );
  assert.equal(
    verifyEventTicketQrToken({ token: first.token, eventId, secret: otherSecret, now: issuedAt }),
    null
  );
  const tampered = first.token.slice(0, -1) + (first.token.endsWith('A') ? 'B' : 'A');
  assert.equal(
    verifyEventTicketQrToken({ token: tampered, eventId, secret, now: issuedAt }),
    null
  );
  assert.equal(
    verifyEventTicketQrToken({
      token: first.token,
      eventId,
      secret,
      now: new Date(issuedAt.getTime() + 46_000)
    }),
    null
  );
  assert.throws(() => issueEventTicketQrToken({
    ticketId,
    eventId,
    secret,
    now: issuedAt,
    lifetimeSeconds: 14
  }));
  assert.throws(() => issueEventTicketQrToken({
    ticketId,
    eventId,
    secret,
    now: issuedAt,
    lifetimeSeconds: 121
  }));
`;

runGate(
  'Rotating event ticket QR behavior gate',
  ['--import', 'tsx', '--input-type=module', '--eval', qrBehaviorProgram]
);
runGate(
  'Native ticket contract behavior gate',
  [join(root, 'scripts/sway-event-ticket-contract.behavior.test.mjs')]
);
runGate(
  'Native ticket Stripe provider behavior gate',
  [join(root, 'scripts/sway-event-ticket-stripe-provider.behavior.test.mjs')]
);
runGate(
  'Native ticket migration integration gate',
  ['--import', 'tsx', join(root, 'scripts/sway-event-ticket-migration.integration.test.ts')]
);
runGate(
  'Native ticket service integration gate',
  ['--import', 'tsx', join(root, 'scripts/sway-event-ticket-service.integration.test.ts')]
);

console.log(`Native GA event ticket contract passed (${migrationName}).`);
