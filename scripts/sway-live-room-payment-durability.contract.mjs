import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = process.cwd();
const migrationDirectory = join(root, 'drizzle');
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const migration0028 = migrationFiles.find((name) => name.startsWith('0028_'));
assert.ok(migration0028, 'Live-room payment durability migration 0028 is required.');

const migrationSql = readFileSync(join(migrationDirectory, migration0028), 'utf8');
const businessStoreSource = readFileSync(join(root, 'src/server/business-store.ts'), 'utf8');
const idempotencyStoreSource = readFileSync(join(root, 'src/server/idempotency-store.ts'), 'utf8');
const operationStoreSource = readFileSync(join(root, 'src/server/live-room-payment-operation-store.ts'), 'utf8');
const paymentProviderSource = readFileSync(join(root, 'src/server/payment-provider.ts'), 'utf8');
const paymentServiceSource = readFileSync(join(root, 'src/server/payment-service.ts'), 'utf8');
const sellerReadinessSource = readFileSync(join(root, 'src/server/live-room-seller-readiness.ts'), 'utf8');
const paymentWebhookSource = readFileSync(join(root, 'src/server/payment-webhook.ts'), 'utf8');
const paymentLifecycleSource = readFileSync(join(root, 'src/server/payment-lifecycle.ts'), 'utf8');
const publicRoomStateSource = readFileSync(join(root, 'src/server/public-room-state.ts'), 'utf8');
const patronViewSource = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
const renderConfigSource = readFileSync(join(root, 'render.yaml'), 'utf8');
assert.doesNotMatch(migrationSql, /\bDROP\b|\bRENAME\b/i, 'Migration 0028 must be expand-only.');
assert.match(migrationSql, /legacy_unlinked[^;]+DEFAULT true[^;]+NOT NULL/is);
assert.match(migrationSql, /UPDATE "request_boosts"[\s\S]+SET "client_request_id" = 'legacy-'/);
assert.doesNotMatch(migrationSql, /ALTER COLUMN "client_request_id" SET NOT NULL/);
assert.match(migrationSql, /'legacy-' \|\| "id"::text/);
assert.match(migrationSql, /WHERE "payments"\."legacy_unlinked" = false and "payments"\."request_id" is not null/);
assert.match(migrationSql, /ADD COLUMN "activated_at" timestamp with time zone DEFAULT now\(\)/);
assert.doesNotMatch(migrationSql, /UPDATE "payments" AS p[\s\S]+"request_(?:boost_)?id"/);
assert.doesNotMatch(businessStoreSource, /\.delete\(requests\)|\.delete\(requestBoosts\)/);
assert.match(businessStoreSource, /eq\(gigSessions\.stateRevision, expectedSessionRevision\)/);
assert.match(businessStoreSource, /eq\(requests\.stateRevision, request\.stateRevision\)/);
assert.match(businessStoreSource, /eq\(requestBoosts\.stateRevision, boost\.stateRevision\)/);
assert.match(businessStoreSource, /request\.boosts\.reduce\(\(total, boost\) => total \+ Number\(boost\.platformFee \|\| 0\), 0\)/);
assert.equal(
  businessStoreSource.match(/if \(reserved\.activatedAt\)/g)?.length,
  2,
  'Request and boost activation must treat the same already-activated durable action as idempotent success.'
);
assert.match(businessStoreSource, /durable_request_activation_identity_conflict/);
assert.match(businessStoreSource, /durable_boost_activation_identity_conflict/);
assert.match(idempotencyStoreSource, /transaction\(async \(tx\)/);
assert.match(idempotencyStoreSource, /onConflictDoNothing\(\)\.returning/);
assert.match(idempotencyStoreSource, /kind: 'pending'/);
assert.match(idempotencyStoreSource, /patron_status_receipt_response_mismatch/);
assert.match(idempotencyStoreSource, /\.for\('update'\)[\s\S]+record\.firstResponseStatus[\s\S]+updatedAction/);
assert.match(idempotencyStoreSource, /runtimeRequestState: sql`jsonb_set/);
assert.match(idempotencyStoreSource, /runtimeBoostState: sql`jsonb_set/);

const patronReservationSource = idempotencyStoreSource.slice(
  idempotencyStoreSource.indexOf('async function reservePendingAction'),
  idempotencyStoreSource.indexOf('async function reserveDurableActorAction')
);
assert.doesNotMatch(
  patronReservationSource,
  /const \[reclaimed\]|return reclaimed \?/,
  'Patron HTTP ownership must not be reclaimed without a fencing token.'
);
assert.match(patronReservationSource, /return replay\.kind === 'new' \? \{ kind: 'pending' \} : replay/);
assert.match(idempotencyStoreSource, /async function claimPendingActionOwner/);
assert.match(idempotencyStoreSource, /ownerGeneration: sql`\$\{clientPendingActions\.ownerGeneration\} \+ 1`/);
assert.match(idempotencyStoreSource, /pending_action_owner_fenced/);

const terminalFailureSource = idempotencyStoreSource.slice(
  idempotencyStoreSource.indexOf('async function completePendingActionFailure'),
  idempotencyStoreSource.indexOf('async function expireStalePendingActions')
);
assert.match(terminalFailureSource, /pendingAction\.clientRequestId !== input\.clientRequestId/);
assert.doesNotMatch(terminalFailureSource, /pending_action_not_found/);
assert.match(terminalFailureSource, /if \(action\?\.activatedAt\) throw new Error\('pending_action_already_visible'\)/);
assert.equal(
  terminalFailureSource.match(/status: 'denied'/g)?.length,
  2,
  'A terminal request or boost response must fence its own invisible business row.'
);
assert.equal(
  terminalFailureSource.match(/isNull\((?:requestBoosts|requests)\.activatedAt\)/g)?.length,
  2,
  'Terminal HTTP failure fencing must never deny a visible request or boost.'
);

const expiryWorkerSource = idempotencyStoreSource.slice(
  idempotencyStoreSource.indexOf('async function expireStalePendingActions'),
  idempotencyStoreSource.indexOf('async function reconcilePendingAction')
);
assert.match(expiryWorkerSource, /if \(action\?\.activatedAt\) return null/);
assert.equal(
  expiryWorkerSource.match(/status: 'denied'/g)?.length,
  2,
  'The expiry worker must separately fence either kind of invisible business row.'
);
assert.equal(
  expiryWorkerSource.match(/isNull\((?:requestBoosts|requests)\.activatedAt\)/g)?.length,
  2,
  'Expiry fencing must never deny a visible request or boost.'
);
assert.doesNotMatch(serverSource, /businessStore\.setPatronStatusReceipt/);
assert.match(serverSource, /responseStatus: completion\.status/);
assert.match(serverSource, /Object\.assign\(inputState, refreshed\.state\)/);
assert.match(serverSource, /Room maintenance cycle failed; it will retry safely\./);
assert.match(serverSource, /SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED/);
assert.match(serverSource, /const liveRoomDurabilityWritesEnabled = !liveRoomDurabilityKillSwitchActive;/);
assert.match(serverSource, /LIVE_ROOM_MUTATION_ROLLOUT_PATHS/);
assert.equal(
  (serverSource.match(/\^\\\/api\\\/[\s\S]*?\/i/g) ?? []).length >= 5,
  true,
  'Every rollout-gated Express path must be case-insensitive.'
);
assert.match(serverSource, /if \(!liveRoomDurabilityWritesEnabled\) return;/);
assert.match(serverSource, /!liveRoomDurabilityWritesEnabled \|\| !paymentService\.hasDurableStore/);
const liveRoomWorkerSource = serverSource.slice(
  serverSource.indexOf('function startLiveRoomPaymentWorker'),
  serverSource.indexOf('// Vite Middleware & Front-End Serving Config')
);
assert.doesNotMatch(
  liveRoomWorkerSource.split('const tick')[0],
  /paymentService\.isEnabled\(\)/,
  'Provider-disabled rooms still need the durable visibility worker for DB-only actions.'
);
assert.match(
  liveRoomWorkerSource,
  /if \(paymentService\.isEnabled\(\)\) \{[\s\S]+runDueOperations[\s\S]+\}[\s\S]+reconcileActionVisibility/,
  'Provider operations must stay gated while DB-only visibility reconciliation always runs.'
);
assert.match(renderConfigSource, /SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED[\s\S]+value: "false"/);
assert.match(operationStoreSource, /ne\(liveRoomPaymentOperations\.id, operation\.id\)/);
assert.match(operationStoreSource, /gt\(liveRoomPaymentOperations\.leaseExpiresAt, now\)/);
assert.match(paymentServiceSource, /reverseConnectedTransfer = !isSwayTestPlatformBalanceDestination/);
assert.match(paymentServiceSource, /reverseTransfer: reverseConnectedTransfer,[\s\S]+refundApplicationFee: reverseConnectedTransfer/);
assert.match(paymentServiceSource, /usesTestPlatformBalance \? undefined : operation\.destinationAccountId/);
assert.match(paymentServiceSource, /usesTestPlatformBalance \? undefined : payment\.platformFee/);
assert.match(sellerReadinessSource, /baseEligible && input\.allowTestPlatformBalance/);
assert.match(sellerReadinessSource, /seller\.onboardingStatus !== 'restricted'/);
assert.match(serverSource, /testModePlatformBalancePerformerIds = resolveTestModePlatformBalancePerformerIds/);
assert.match(serverSource, /SWAY_TEST_MODE_PLATFORM_BALANCE_PERFORMER_IDS/);
assert.match(sellerReadinessSource, /input\.paymentMode === 'test'/);
assert.match(paymentLifecycleSource, /export function isKnownPredecessorPaymentState/);
assert.match(paymentWebhookSource, /ignored_out_of_order'[\s\S]+isKnownPredecessorPaymentState[\s\S]+status: 'ignored'[\s\S]+stale_predecessor_event/);
assert.match(paymentWebhookSource, /concurrent_noop'[\s\S]+retry after predecessor state/);
assert.match(
  paymentWebhookSource,
  /event\.livemode !== expectedLivemode[\s\S]+markProcessed\(event, \{ status: 'ignored' \}\)[\s\S]+opposite_payment_mode/
);

const terminalProcessorClassifier = paymentServiceSource.slice(
  paymentServiceSource.indexOf('function isTerminalProcessorError'),
  paymentServiceSource.indexOf('function feePolicyFromPayload')
);
assert.doesNotMatch(
  terminalProcessorClassifier,
  /'StripeIdempotencyError'/,
  'A Stripe idempotency-key-in-use response is provider uncertainty, not terminal proof that no intent exists.'
);
assert.match(operationStoreSource, /neverTerminal[\s\S]+!neverTerminal && \(terminal \|\| operation\.attemptCount >= operation\.maxAttempts\)/);
assert.match(paymentServiceSource, /providerAmbiguousAuthorization[\s\S]+operationStore\.markFailed\([\s\S]+providerAmbiguousAuthorization/);

const confirmationSource = paymentServiceSource.slice(
  paymentServiceSource.indexOf('async function confirmAuthorizedAction'),
  paymentServiceSource.indexOf('async function ensureDurablePaymentBinding')
);
assert.match(confirmationSource, /\['created', 'payment_pending', 'failed'\]\.includes\(payment\.paymentStatus\)/);
assert.match(confirmationSource, /retrievePaymentAuthorization[\s\S]+alignPaymentWithProviderTruth/);

assert.match(paymentProviderSource, /expand: \['latest_charge'\]/);
assert.match(paymentProviderSource, /amountRefundedCents[\s\S]+fullyRefunded/);
assert.match(paymentWebhookSource, /Partial refund detected; full reversal is still pending/);
assert.match(paymentWebhookSource, /service\.voidOrRefund\(paymentId\)/);
assert.match(paymentWebhookSource, /Bind provider identity before refund convergence/);
assert.match(paymentWebhookSource, /Reconcile every refund from current provider truth/);
assert.match(paymentServiceSource, /isFullRefundTruth[\s\S]+refund_provider_truth_not_terminal/);
assert.match(paymentServiceSource, /`\$\{operation\.idempotencyKey\}:refund`/);
assert.match(paymentServiceSource, /`\$\{operation\.idempotencyKey\}:void`/);
assert.match(paymentServiceSource, /refundStatus: 'pending'[\s\S]+supersedePendingCaptureForCloseout/);
assert.match(paymentLifecycleSource, /paid_out: \['refunded', 'disputed'\]/);

assert.match(paymentServiceSource, /loadInvisibleRequestDisposition[\s\S]+stillInvisible[\s\S]+eligible/);
assert.match(paymentServiceSource, /loadInvisibleBoostDisposition[\s\S]+stillInvisible[\s\S]+eligible/);
assert.match(paymentServiceSource, /latest\.stillInvisible && !latest\.eligible/);

const visibilityReconcilerSource = paymentServiceSource.slice(
  paymentServiceSource.indexOf('async function reconcileActionVisibility'),
  paymentServiceSource.indexOf('return {\n    isEnabled')
);
assert.match(visibilityReconcilerSource, /if \(!db\) return/);
assert.doesNotMatch(visibilityReconcilerSource, /if \(!db \|\| !provider\) return/);
assert.match(serverSource, /if \(paymentService\.isEnabled\(\)\) \{[\s\S]+runDueOperations[\s\S]+reconcileActionVisibility/);

assert.match(paymentServiceSource, /loadInvisibleActionTerminalOutcome/);
assert.match(paymentServiceSource, /eq\(payments\.paymentStatus, 'failed'\)[\s\S]+isNull\(payments\.processorPaymentIntentId\)/);
assert.match(idempotencyStoreSource, /completePendingActionFailure/);
assert.match(serverSource, /loadInvisibleActionTerminalOutcome[\s\S]+completePendingActionFailure/);
assert.match(serverSource, /pending_action_already_visible/);
assert.match(serverSource, /sendCanonicalPatronActionFailure/);
assert.equal(
  serverSource.match(/durableReservationEstablished = true/g)?.length,
  2,
  'Request and boost owners must enable canonical completion after durable reservation.'
);
assert.equal(
  serverSource.match(/if \(!terminal\) return res\.status\(202\)\.json\(responseBody\)/g)?.length,
  2,
  'A request or boost reversal must remain pending until provider truth is terminal.'
);
assert.match(publicRoomStateSource, /body\.terminal[\s\S]+body\.payment_status/);
assert.match(patronViewSource, /error\?\.body\?\.terminal === true[\s\S]+removeItem\('sway\.pendingAction'\)/);

const reserveRequestSection = businessStoreSource.slice(
  businessStoreSource.indexOf('async function reserveRequestAction'),
  businessStoreSource.indexOf('async function reserveBoostAction')
);
const reserveBoostSection = businessStoreSource.slice(
  businessStoreSource.indexOf('async function reserveBoostAction'),
  businessStoreSource.indexOf('async function activateRequestAction')
);
const activateRequestSection = businessStoreSource.slice(
  businessStoreSource.indexOf('async function activateRequestAction'),
  businessStoreSource.indexOf('async function activateBoostAction')
);
const activateBoostSection = businessStoreSource.slice(
  businessStoreSource.indexOf('async function activateBoostAction'),
  businessStoreSource.indexOf('async function beginRoomCloseout')
);
const boostModerationPersistenceSource = businessStoreSource.slice(
  businessStoreSource.indexOf('async function shadowRequestForBoostModeration'),
  businessStoreSource.indexOf('async function activateRequestAction')
);
for (const [label, section] of [
  ['request', reserveRequestSection],
  ['boost', reserveBoostSection]
]) {
  const existingSuccessIndex = section.indexOf('if (existing.activatedAt)');
  const admissionGateIndex = section.indexOf("if (!room || room.status !== 'active')");
  assert.ok(existingSuccessIndex >= 0, `Durable ${label} reservation must recognize exact already-activated success.`);
  assert.ok(
    admissionGateIndex > existingSuccessIndex,
    `Durable ${label} reservation must return exact already-activated success before current admission gates.`
  );
  assert.match(section, /return \{ durableId: existing\.id, created: false, activated: true \}/);
}

const lockedRequestWindowIndex = reserveRequestSection.indexOf('const lockedSession = coerceGigSession');
assert.ok(
  lockedRequestWindowIndex > reserveRequestSection.indexOf('return { durableId: existing.id, created: false, activated: false }'),
  'An exact admitted request must bypass later request-window changes.'
);
assert.match(reserveRequestSection, /runtimeSessionState: gigSessions\.runtimeSessionState/);
assert.match(reserveRequestSection, /request\.type !== 'tip' && !lockedSession\.requestsOpen/);
assert.match(reserveRequestSection, /room_not_accepting_requests/);
assert.match(activateRequestSection, /eq\(requests\.status, 'payment_pending'\)/);
assert.match(activateBoostSection, /eq\(requestBoosts\.status, 'payment_pending'\)/);
assert.match(activateBoostSection, /parent\.status !== 'approved'[\s\S]+parentRuntime\?\.shadowBanned/);
assert.match(boostModerationPersistenceSource, /\.for\('update'\)[\s\S]+shadowBanned: true/);
assert.match(boostModerationPersistenceSource, /eq\(requests\.stateRevision, parent\.stateRevision\)/);
assert.match(visibilityReconcilerSource, /eq\(requests\.status, 'payment_pending'\)/);
assert.match(visibilityReconcilerSource, /eq\(requestBoosts\.status, 'payment_pending'\)/);
assert.match(visibilityReconcilerSource, /targetEligible[\s\S]+latest\.stillInvisible && !latest\.eligible/);

const requestRouteSource = serverSource.slice(
  serverSource.indexOf('app.post("/api/request/create"'),
  serverSource.indexOf('app.post("/api/request/boost"')
);
const boostRouteSource = serverSource.slice(
  serverSource.indexOf('app.post("/api/request/boost"'),
  serverSource.indexOf('app.post("/api/request/triage"')
);
assert.match(visibilityReconcilerSource, /claimPendingActionOwner/);
assert.match(visibilityReconcilerSource, /pending\.ownerToken !== recoveryOwner\.token/);
assert.match(requestRouteSource, /refreshPendingActionOwner[\s\S]+activateRequestAction\(durableGigId, newItem, actionOwner\)/);
assert.match(boostRouteSource, /refreshPendingActionOwner[\s\S]+activateBoostAction\(durableGigId, request, newBoost, actionOwner\)/);
assert.doesNotMatch(
  requestRouteSource,
  /if \(!isStraightTip && \(!roomState\.session\.requestsOpen/,
  'Snapshot request-window state must not preempt the locked reservation gate.'
);
assert.doesNotMatch(
  boostRouteSource,
  /const isBoostEligible/,
  'Snapshot boost eligibility must not preempt the locked parent reservation gate.'
);
const boostModerationDecisionIndex = boostRouteSource.indexOf("moderationOutcome.decision === 'hold_for_review'");
const boostModerationPersistIndex = boostRouteSource.indexOf('businessStore.shadowRequestForBoostModeration');
const boostReservationIndex = boostRouteSource.indexOf('businessStore.reserveBoostAction');
const boostAuthorizationIndex = boostRouteSource.indexOf('paymentService.authorizeAction');
assert.ok(boostModerationDecisionIndex >= 0, 'Boost hold-for-review moderation must be explicit.');
assert.ok(
  boostModerationPersistIndex > boostModerationDecisionIndex
  && boostModerationPersistIndex < boostReservationIndex
  && boostModerationPersistIndex < boostAuthorizationIndex,
  'Boost moderation must durably shadow the parent and stop before boost reservation or payment.'
);
assert.match(boostRouteSource, /This boost was held by safety review and was not applied/);

const requestCapIndex = reserveRequestSection.indexOf('const sameDeviceRequests = await tx');
const requestInsertIndex = reserveRequestSection.indexOf('.insert(requests)');
assert.ok(
  requestCapIndex > reserveRequestSection.indexOf('return { durableId: existing.id, created: false, activated: false }'),
  'Exact existing request identity must bypass durable per-device caps.'
);
assert.ok(requestInsertIndex > requestCapIndex, 'Request caps must be enforced before the durable reservation insert.');
assert.match(reserveRequestSection, /eq\(requests\.gigId, gigId\)[\s\S]+eq\(requests\.patronDeviceIdHash, request\.patronDeviceIdHash\)/);
assert.match(reserveRequestSection, /request_device_per_gig_cap_reached/);
assert.match(reserveRequestSection, /request_custom_note_device_per_gig_cap_reached/);
assert.match(
  reserveRequestSection.slice(requestCapIndex, requestInsertIndex),
  /!\(!row\.activatedAt && \['denied', 'voided_or_refunded'\]\.includes\(row\.status\)\)/,
  'Request caps must count visible and pending rows while releasing only terminal invisible reservations.'
);

const boostCapIndex = reserveBoostSection.indexOf('const sameDeviceBoosts = await tx');
const boostInsertIndex = reserveBoostSection.indexOf('.insert(requestBoosts)');
assert.ok(
  boostCapIndex > reserveBoostSection.indexOf('return { durableId: existing.id, created: false, activated: false }'),
  'Exact existing boost identity must bypass durable per-device caps.'
);
assert.ok(boostInsertIndex > boostCapIndex, 'Boost cap must be enforced before the durable reservation insert.');
assert.match(reserveBoostSection, /eq\(requestBoosts\.gigId, gigId\)[\s\S]+eq\(requestBoosts\.patronDeviceIdHash, boost\.patronDeviceIdHash\)/);
assert.match(reserveBoostSection, /boost_device_per_gig_cap_reached/);
assert.match(
  reserveBoostSection.slice(boostCapIndex, boostInsertIndex),
  /!row\.activatedAt && \['denied', 'voided_or_refunded'\]\.includes\(row\.status\)/,
  'Boost caps must count visible and pending rows while releasing only terminal invisible reservations.'
);

assert.match(serverSource, /maxRequestsPerDevicePerGig: MAX_REQUESTS_PER_DEVICE_PER_SESSION/);
assert.match(serverSource, /maxCustomNotesPerDevicePerGig: MAX_CUSTOM_NOTES_PER_DEVICE_PER_SESSION/);
assert.match(serverSource, /maxBoostsPerDevicePerGig: MAX_BOOSTS_PER_DEVICE_PER_SESSION/);
assert.match(serverSource, /request_device_per_gig_cap_reached'[\s\S]+rejectAfterConfirmedAuthorization\(429/);
assert.match(serverSource, /request_custom_note_device_per_gig_cap_reached'[\s\S]+rejectAfterConfirmedAuthorization\(429/);
assert.match(serverSource, /boost_device_per_gig_cap_reached'[\s\S]+rejectAfterConfirmedAuthorization\(429/);
assert.doesNotMatch(
  serverSource,
  /sameDeviceSessionRequests|sameActorBoostCount/,
  'Snapshot-only patron cap checks must not preempt the gig-locked exact-identity reservation path.'
);

function statements(filename) {
  return readFileSync(join(migrationDirectory, filename), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigration(database, filename) {
  for (const [index, statement] of statements(filename).entries()) {
    try {
      await database.exec(statement);
    } catch (error) {
      throw new Error(`Migration failed: ${filename}, statement ${index + 1}`, { cause: error });
    }
  }
}

async function expectFailure(database, label, statement) {
  try {
    await database.exec(statement);
  } catch {
    return;
  }
  throw new Error(label);
}

const database = new PGlite();

for (const filename of migrationFiles.filter((name) => name < migration0028)) {
  await applyMigration(database, filename);
}

// Seed the exact pre-0028 shape. Existing rows must survive the expand step,
// stay visible, and remain writable by the old server during Render rollout.
await database.exec(`
  insert into users (id, email, email_verified_at)
  values ('00000000-0000-0000-0000-000000000001', 'durability-owner@example.test', now());

  insert into performers (id, owner_user_id, handle, display_name, stripe_connected_account_id)
  values (
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000001',
    'durability-proof',
    'Durability Proof',
    'acct_legacy_test'
  );

  insert into gig_sessions (
    id, performer_id, status, title, auto_closeout_at, runtime_session_state
  ) values (
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000010',
    'active',
    'Pre-0028 room',
    now() + interval '4 hours',
    '{"status":"active","requestsOpen":true}'::jsonb
  );

  insert into requests (
    id, gig_id, client_request_id, status, request_type, amount_cents,
    runtime_request_state
  ) values (
    '00000000-0000-0000-0000-000000000030',
    '00000000-0000-0000-0000-000000000020',
    'pre-0028-request',
    'approved',
    'music',
    500,
    '{"id":"req-old","status":"approved","idempotencyKey":"pre-0028-payment-key","paymentId":"00000000-0000-0000-0000-000000000050","boosts":[]}'::jsonb
  );

  insert into request_boosts (
    id, request_id, gig_id, status, amount_cents, runtime_boost_state
  ) values (
    '00000000-0000-0000-0000-000000000040',
    '00000000-0000-0000-0000-000000000030',
    '00000000-0000-0000-0000-000000000020',
    'approved',
    200,
    '{"id":"boost-old","clientRequestId":"pre-0028-boost"}'::jsonb
  );

  insert into payments (
    id, gig_id, payment_status, processor, amount_subtotal, platform_fee,
    amount_total, currency
  ) values (
    '00000000-0000-0000-0000-000000000050',
    '00000000-0000-0000-0000-000000000020',
    'authorized',
    'stripe',
    500,
    50,
    550,
    'USD'
  );
`);

await applyMigration(database, migration0028);

// The old server remains live while Render runs predeploy migrations. Its
// boost insert does not know about client_request_id, so the expand step must
// keep that insert legal until a later contract-only migration.
await database.exec(`
  insert into request_boosts (
    request_id, gig_id, status, amount_cents, runtime_boost_state
  ) values (
    '00000000-0000-0000-0000-000000000030',
    '00000000-0000-0000-0000-000000000020',
    'approved', 100, '{"id":"rolling-old-server-boost"}'::jsonb
  );
`);

const rollingInsert = await database.query(`
  select activated_at from request_boosts
  where runtime_boost_state->>'id' = 'rolling-old-server-boost'
`);
assert.ok(rollingInsert.rows[0]?.activated_at, 'An old-server boost written during predeploy must stay visible after cutover.');

// The pre-0028 server replaces the whole queue. The expand migration must not
// attach legacy payment foreign keys that make its delete/reinsert transaction
// fail while the old instance is still serving traffic.
await database.exec('begin');
await database.exec(`delete from request_boosts where gig_id = '00000000-0000-0000-0000-000000000020'`);
await database.exec(`delete from requests where gig_id = '00000000-0000-0000-0000-000000000020'`);
await database.exec('rollback');

const backfill = await database.query(`
  select
    r.activated_at as request_activated_at,
    b.activated_at as boost_activated_at,
    b.client_request_id,
    p.legacy_unlinked,
    p.performer_id,
    p.request_id as payment_request_id,
    p.action_type,
    p.idempotency_key as payment_idempotency_key,
    p.destination_account_id,
    g.state_revision
  from requests r
  join request_boosts b
    on b.request_id = r.id
   and b.id = '00000000-0000-0000-0000-000000000040'
  join payments p on p.id = '00000000-0000-0000-0000-000000000050'
  join gig_sessions g on g.id = r.gig_id
  where r.id = '00000000-0000-0000-0000-000000000030'
`);
assert.equal(backfill.rows.length, 1);
assert.ok(backfill.rows[0].request_activated_at);
assert.ok(backfill.rows[0].boost_activated_at);
assert.equal(backfill.rows[0].client_request_id, 'legacy-00000000-0000-0000-0000-000000000040');
assert.equal(backfill.rows[0].legacy_unlinked, true);
assert.equal(backfill.rows[0].performer_id, null);
assert.equal(backfill.rows[0].payment_request_id, null);
assert.equal(backfill.rows[0].action_type, null);
assert.equal(backfill.rows[0].payment_idempotency_key, null);
assert.equal(backfill.rows[0].destination_account_id, null);
assert.equal(Number(backfill.rows[0].state_revision), 0);

// A predeploy old-server insert remains legal because it defaults into the
// explicit legacy lane; new-server writes opt out and must be fully bound.
await database.exec(`
  insert into payments (
    gig_id, payment_status, processor, amount_subtotal, platform_fee, amount_total
  ) values (
    '00000000-0000-0000-0000-000000000020', 'created', 'stripe', 100, 10, 110
  );

  insert into requests (
    id, gig_id, client_request_id, idempotency_key, intent_fingerprint,
    patron_device_id_hash, status, request_type, amount_cents, activated_at,
    runtime_request_state
  ) values (
    '00000000-0000-0000-0000-000000000031',
    '00000000-0000-0000-0000-000000000020',
    'durable-request-client',
    'durable-request-key',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'device-hash',
    'payment_pending',
    'music',
    600,
    null,
    '{"id":"req-new","status":"hold","boosts":[]}'::jsonb
  );
`);

await expectFailure(database, 'Strict new payments must reject missing seller binding.', `
  insert into payments (
    gig_id, request_id, action_type, idempotency_key, destination_account_id,
    legacy_unlinked, payment_status, processor, amount_subtotal, platform_fee, amount_total
  ) values (
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000031',
    'request', 'invalid-binding', 'acct_test', false, 'created', 'stripe', 600, 60, 660
  )
`);

await database.exec(`
  insert into payments (
    id, gig_id, performer_id, request_id, action_type, idempotency_key,
    destination_account_id, legacy_unlinked, payment_status, processor,
    amount_subtotal, platform_fee, amount_total
  ) values (
    '00000000-0000-0000-0000-000000000051',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000031',
    'request', 'durable-payment-key', 'acct_test', false,
    'created', 'stripe', 600, 60, 660
  );

  insert into live_room_payment_operations (
    id, payment_id, gig_id, performer_id, request_id, operation_type,
    processor, idempotency_key, destination_account_id, request_payload
  ) values (
    '00000000-0000-0000-0000-000000000060',
    '00000000-0000-0000-0000-000000000051',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000031',
    'authorize', 'stripe', 'authorize:durable-payment-key', 'acct_test',
    '{"amountTotalCents":660}'::jsonb
  );

  insert into live_room_processor_events (
    processor, processor_event_id, event_type, payload_sha256, payload, livemode
  ) values (
    'stripe', 'evt_durable', 'payment_intent.amount_capturable_updated',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '{"processorPaymentIntentId":"pi_durable"}'::jsonb, false
  );
`);

await expectFailure(database, 'One request must not bind to two new payments.', `
  insert into payments (
    gig_id, performer_id, request_id, action_type, idempotency_key,
    destination_account_id, legacy_unlinked, payment_status, processor,
    amount_subtotal, platform_fee, amount_total
  ) values (
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000031',
    'request', 'second-payment-key', 'acct_test', false,
    'created', 'stripe', 600, 60, 660
  )
`);

await expectFailure(database, 'Webhook event ids must be unique per processor.', `
  insert into live_room_processor_events (
    processor, processor_event_id, event_type, payload_sha256, payload, livemode
  ) values (
    'stripe', 'evt_durable', 'payment_intent.succeeded',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '{}'::jsonb, false
  )
`);

await database.exec(`
  update gig_sessions
  set status = 'closeout_pending', state_revision = state_revision + 1
  where id = '00000000-0000-0000-0000-000000000020'
`);
const closeout = await database.query(`
  select status, state_revision
  from gig_sessions
  where id = '00000000-0000-0000-0000-000000000020'
`);
assert.equal(closeout.rows[0].status, 'closeout_pending');
assert.equal(Number(closeout.rows[0].state_revision), 1);

const roomWinner = await database.query(`
  update gig_sessions
  set title = 'winner', state_revision = state_revision + 1
  where id = '00000000-0000-0000-0000-000000000020' and state_revision = 1
  returning state_revision
`);
const roomStale = await database.query(`
  update gig_sessions
  set title = 'stale-overwrite', state_revision = state_revision + 1
  where id = '00000000-0000-0000-0000-000000000020' and state_revision = 1
  returning state_revision
`);
assert.equal(roomWinner.rows.length, 1);
assert.equal(roomStale.rows.length, 0, 'A stale room snapshot must lose the compare-and-swap race.');

const requestWinner = await database.query(`
  update requests
  set message = 'winner', state_revision = state_revision + 1
  where id = '00000000-0000-0000-0000-000000000031' and state_revision = 0
  returning state_revision
`);
const requestStale = await database.query(`
  update requests
  set message = 'stale-overwrite', state_revision = state_revision + 1
  where id = '00000000-0000-0000-0000-000000000031' and state_revision = 0
  returning state_revision
`);
assert.equal(requestWinner.rows.length, 1);
assert.equal(requestStale.rows.length, 0, 'A stale request snapshot must not overwrite the winning mutation.');
const requestTruth = await database.query(`
  select message, state_revision from requests
  where id = '00000000-0000-0000-0000-000000000031'
`);
assert.equal(requestTruth.rows[0].message, 'winner');
assert.equal(Number(requestTruth.rows[0].state_revision), 1);

await database.close();
console.log('Sway live-room payment durability migration contract passed.');
