import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const storeFile = 'src/server/idempotency-store.ts';
if (!existsSync(join(root, storeFile))) failures.push(`Missing idempotency persistence helper: ${storeFile}`);

const store = existsSync(join(root, storeFile)) ? readFileSync(join(root, storeFile), 'utf8') : '';
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const patron = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const patronApp = readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8');
const schema = readFileSync(join(root, 'src/db/schema.ts'), 'utf8');

function extractFunctionBody(source, functionName) {
  const start = source.indexOf(`const ${functionName} =`);
  if (start === -1) return '';
  const firstBrace = source.indexOf('{', start);
  if (firstBrace === -1) return '';
  let depth = 0;
  for (let i = firstBrace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') depth -= 1;
    if (depth === 0) return source.slice(firstBrace, i + 1);
  }
  return '';
}

for (const term of [
  'idempotencyKeys',
  'clientPendingActions',
  'reservePendingAction',
  'completePendingAction',
  'reconcilePendingAction',
  'PENDING_ACTION_TTL_MS = 5 * 60 * 1000',
  'IDEMPOTENCY_TTL_HOURS = 48',
  'firstResponseBody',
  'firstResponseBodyHash'
]) {
  if (!store.includes(term) && !schema.includes(term)) failures.push(`Persistence helper/schema missing term: ${term}`);
}

for (const term of [
  'tx.insert(clientPendingActions)',
  'tx.insert(idempotencyKeys)',
  '.onConflictDoNothing().returning',
  "return { kind: 'pending' }",
  'db.update(idempotencyKeys)',
  'tx.update(clientPendingActions)',
  'eq(idempotencyKeys.idempotencyKey, input.idempotencyKey)',
  "record.intentFingerprint !== input.intentFingerprint",
  "return { kind: 'misuse' }",
  "return { kind: 'expired' }",
  "return { kind: 'replay'",
  "status: 'reconciled'"
]) {
  if (!store.includes(term)) failures.push(`Idempotency persistence helper missing behavior: ${term}`);
}

for (const term of [
  'createIdempotencyStore(process.env.DATABASE_URL)',
  '/api/pending-action/reconcile',
  'parseDurableGigId(gig_id)',
  'A valid route gig_id is required for durable request submission.',
  'A valid route gig_id is required for durable boost submission.',
  'idempotencyStore.reservePendingAction',
  'idempotencyStore.completePendingAction',
  "durableReplay.kind === 'expired'",
  "durableReplay.kind === 'misuse'",
  "durableReplay.kind === 'replay'",
  'Pending action expired before request creation.',
  'Pending action expired before boost creation.'
]) {
  if (!server.includes(term)) failures.push(`Server missing degraded/idempotency behavior: ${term}`);
}

if (/gig_id\s*=\s*["']local["']/.test(server)) {
  failures.push('Server durable request/boost paths must not default gig_id to "local".');
}

const requestReserveIndex = server.indexOf('idempotencyStore.reservePendingAction(durableInput)');
const requestCreationIndex = server.indexOf('const newItem: RequestItem');
if (requestReserveIndex === -1 || requestCreationIndex === -1 || requestReserveIndex > requestCreationIndex) {
  failures.push('Request route must reserve/check durable idempotency before request creation.');
}

const boostReserveIndex = server.lastIndexOf('idempotencyStore.reservePendingAction(durableInput)');
const boostCreationIndex = server.indexOf('const newBoost');
if (boostReserveIndex === -1 || boostCreationIndex === -1 || boostReserveIndex > boostCreationIndex) {
  failures.push('Boost route must reserve/check durable idempotency before boost creation.');
}

for (const term of [
  'MAX_PENDING_ACTION_RETRIES = 3',
  'submitWithBoundedRetry',
  'waitForRetryBackoff',
  'checkoutPayload.expires_at',
  'expires_at: payload.expires_at',
  'gig_id: payload.gigId',
  'reconcilePendingActionRef.current(',
  'identity.gigId',
  'PENDING_ACTION_STORAGE_VERSION = 2',
  'pendingActionStorageKeyForRoom',
  'isCompletePersistedPendingAction',
  'resubmitPersistedPendingAction',
  "result?.status === 'reconciled'",
  "result?.status === 'pending'",
  "result?.recovery !== 'resubmit_original_action'",
  'window.setTimeout(reconcile, 2000)',
  'if (response?.pending)',
  'setBackendConfirmed(matchingCheckoutIsOpen)',
  'writePendingAction(localStorage, pendingActionStorageKey',
  'removePendingAction(localStorage, pendingActionStorageKey)'
]) {
  if (!patron.includes(term)) failures.push(`Patron client missing bounded retry/pending behavior: ${term}`);
}

const completePaymentBody = extractFunctionBody(patron, 'completePayment');
if (!completePaymentBody) failures.push('Patron client missing completePayment function.');
const completeCheckoutSuccessBody = extractFunctionBody(patron, 'completeCheckoutSuccess');
if (!completeCheckoutSuccessBody) failures.push('Patron client missing completeCheckoutSuccess function.');
const boundedRetryBody = extractFunctionBody(patron, 'submitWithBoundedRetry');
if (!boundedRetryBody) failures.push('Patron client missing submitWithBoundedRetry function.');
const checkoutErrorBody = extractFunctionBody(patron, 'handleCheckoutError');
if (!checkoutErrorBody) failures.push('Patron client missing handleCheckoutError function.');

if (completePaymentBody.indexOf('beginPendingSubmit') === -1 || completePaymentBody.indexOf('beginPendingSubmit') > completePaymentBody.indexOf('submitCheckoutPayload')) {
  failures.push('Patron client must persist pending action before network submit.');
}

if (completePaymentBody.indexOf('completeCheckoutSuccess') < completePaymentBody.indexOf('submitCheckoutPayload')) {
  failures.push('Patron client must not show success before backend confirmation.');
}

if (!/setBackendConfirmed\(matchingCheckoutIsOpen\)[\s\S]{0,360}removePendingAction\(localStorage, pendingActionStorageKey\)/.test(completeCheckoutSuccessBody)) {
  failures.push('Patron client must clear pending action only after backend confirmation.');
}

const pending202Start = checkoutErrorBody.indexOf('if (status === 202 || body?.pending)');
const confirmationRequiredStart = checkoutErrorBody.indexOf("if (status === 402 && paymentStatus === 'requires_confirmation')");
const pending202Body = pending202Start >= 0 && confirmationRequiredStart > pending202Start
  ? checkoutErrorBody.slice(pending202Start, confirmationRequiredStart)
  : '';
if (!pending202Body) {
  failures.push('Patron client must classify durable HTTP 202 as nonterminal pending state.');
} else if (
  pending202Body.includes('removePendingAction(localStorage, pendingActionStorageKey)')
  || pending202Body.includes('setPendingAction(null)')
  || pending202Body.includes('setCheckoutPayload(null)')
) {
  failures.push('Patron client must preserve the pending payload and checkout while HTTP 202 reconciles.');
}

if (!patron.includes('const isSubmitLocked = isPaying || isStripeAuthorizing || isPaymentConfirmationPending || isDurableActionPending;')) {
  failures.push('Patron client must lock duplicate submit while a durable action is reconciling.');
}

if (!/const response = await resubmitPersistedPendingAction\(persistedAction\)[\s\S]{0,320}response\?\.success \|\| response\?\.reconciled[\s\S]{0,220}completeCheckoutSuccess\(persistedAction\.type, persistedAction\.clientRequestId\)/.test(patron)) {
  failures.push('Patron reconciliation success must enter the request-bound confirmed checkout completion path.');
}

if (!patronApp.includes('expires_at: expiresAt')) {
  failures.push('Patron shell must forward expires_at for boost submissions.');
}

for (const term of [
  'const routeGigId =',
  'UUID_PATTERN.test(route.gigId)',
  'gig_id: gigId',
  '/api/pending-action/reconcile',
  'expected_gig_id: expectedGigId',
  'return data;'
]) {
  if (!patronApp.includes(term)) failures.push(`Patron shell missing route gig/reconciliation behavior: ${term}`);
}

if (/applyPatronMutationResponse\(data\.responseBody\)/.test(patronApp)) {
  failures.push('Patron shell must not treat the legacy status endpoint as a mutation-response replay channel.');
}

if (!patron.includes('This room link is incomplete.')) {
  failures.push('Patron client must block checkout when a valid route gig ID is unavailable.');
}

// WebSocket-only / premature-success guards apply to every degraded-path surface.
for (const pattern of [
  /WebSocket-only transaction state/i,
  /new WebSocket/i,
  /payment success before backend confirmation/i,
  /retry without idempotency/i
]) {
  if (pattern.test(store) || pattern.test(server) || pattern.test(patron)) {
    failures.push(`Slice 4 contains forbidden WebSocket-only/premature-success pattern: ${pattern}`);
  }
}

// Provider calls must stay out of the idempotency store and bounded retry
// helper. The store may inspect an opaque persisted processor reference when
// deciding whether expiry still carries financial liability, but it must not
// import an SDK or invoke Stripe. The patron component may render Stripe's
// confirmation surface after the backend returns client_secret; bounded retry
// itself remains provider-agnostic.
for (const pattern of [
  /from\s+['"]stripe['"]/i,
  /import\s+Stripe/i,
  /new\s+Stripe\b/i,
  /\bstripe\s*\./i,
  /\.paymentIntents\s*\./i,
  /\.refunds\s*\./i,
  /webhook/i
]) {
  if (pattern.test(store)) {
    failures.push(`Idempotency store must not import or call a payment provider: ${pattern}`);
  }
}

for (const pattern of [/stripe/i, /PaymentIntent/i, /webhook/i]) {
  if (pattern.test(boundedRetryBody)) {
    failures.push(`Bounded retry helper must stay provider-free: ${pattern}`);
  }
}

if (failures.length) {
  console.error('Degraded idempotency persistence contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Degraded idempotency persistence contract passed.');
