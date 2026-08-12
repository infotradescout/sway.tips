import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
const serviceSource = readFileSync(join(root, 'src/server/payment-service.ts'), 'utf8');

const failures = [];

// 1. authorizeAction must return 'authorized' ONLY when the provider confirms a
//    real hold (requires_capture). Otherwise it must return requires_confirmation.
for (const term of [
  "status: 'requires_confirmation'",
  "authorization.status !== 'requires_capture'",
  "payment.paymentStatus === 'payment_pending'",
  "status: 'authorized'"
]) {
  if (!serviceSource.includes(term)) {
    failures.push(`Payment service missing authorization-gating term: ${term}`);
  }
}

// The 'authorized' result must not advertise a capturable boolean that callers
// could misread as "authorized regardless of hold state".
if (/status:\s*'authorized'[\s\S]{0,160}capturable/.test(serviceSource)) {
  failures.push('authorizeAction must not return capturable alongside an authorized result.');
}

// 2/3. Request and boost routes must expose the confirmation + fail-closed paths.
for (const term of [
  "payment_status: 'requires_confirmation'",
  "payment_status: 'provider_unavailable'",
  'payment_intent_id',
  'paymentService.confirmAuthorizedAction',
  '} else if (isProduction) {'
]) {
  if (!serverSource.includes(term)) {
    failures.push(`Server missing money-action gating term: ${term}`);
  }
}

// 4. No request/boost runtime item may be created in payment_pending state.
if (/(newItem|newBoost)\.paymentStatus\s*=\s*['"]payment_pending['"]/.test(serverSource)) {
  failures.push('Runtime request/boost items must never be created in payment_pending state.');
}
if (/paymentStatus\s*=\s*authorization\.capturable\s*\?/.test(serverSource)) {
  failures.push('Runtime payment status must not branch on a capturable flag (payment_pending leak).');
}

// 5. Request creation must only happen after a confirmed (capturable) hold:
//    the requires_confirmation early return must precede state mutation.
const requestConfirmIndex = serverSource.indexOf("payment_status: 'requires_confirmation'");
const requestActivationIndex = serverSource.indexOf('businessStore.activateRequestAction(durableGigId, newItem, actionOwner)');
if (requestConfirmIndex === -1 || requestActivationIndex === -1 || requestConfirmIndex > requestActivationIndex) {
  failures.push('Request must not enter app state before the requires_confirmation gate.');
}
const requestReservationIndex = serverSource.indexOf('businessStore.reserveRequestAction(durableGigId, newItem, {');
const requestAuthorizeIndex = serverSource.indexOf('paymentService.authorizeAction({', requestReservationIndex);
if (requestReservationIndex === -1 || requestAuthorizeIndex === -1 || requestReservationIndex > requestAuthorizeIndex) {
  failures.push('Request must reserve its durable invisible identity before processor authorization.');
}
if (!/newItem\.paymentStatus\s*=\s*'authorized'/.test(serverSource)) {
  failures.push('Request must be marked authorized only via the confirmed-hold branch.');
}

// Boost creation must likewise be gated before the boost is pushed.
const boostConfirmIndex = serverSource.lastIndexOf("payment_status: 'requires_confirmation'");
const boostActivationIndex = serverSource.indexOf('businessStore.activateBoostAction(durableGigId, request, newBoost, actionOwner)');
if (boostConfirmIndex === -1 || boostActivationIndex === -1 || boostConfirmIndex > boostActivationIndex) {
  failures.push('Boost must not enter app state before the requires_confirmation gate.');
}
const boostReservationIndex = serverSource.indexOf('businessStore.reserveBoostAction(durableGigId, request, newBoost, {');
const boostAuthorizeIndex = serverSource.indexOf('paymentService.authorizeAction({', boostReservationIndex);
if (boostReservationIndex === -1 || boostAuthorizeIndex === -1 || boostReservationIndex > boostAuthorizeIndex) {
  failures.push('Boost must reserve its durable invisible identity before processor authorization.');
}
if (!/newBoost\.paymentStatus\s*=\s*'authorized'/.test(serverSource)) {
  failures.push('Boost must be marked authorized only via the confirmed-hold branch.');
}

if (failures.length) {
  console.error('Payment authorization gating contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Payment authorization gating contract passed.');
