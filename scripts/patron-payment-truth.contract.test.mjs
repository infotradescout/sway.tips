import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const patronView = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(message);
}

function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) failures.push(message);
}

function assertForbiddenCopy() {
  for (const forbidden of [
    'No card is charged',
    'No card was charged',
    'No charges will be applied',
    'Payment is not final'
  ]) {
    if (patronView.includes(forbidden)) {
      failures.push(`Forbidden patron payment copy remains in PatronView.tsx: ${forbidden}`);
    }
  }
}

function assertRequiresConfirmationHandling() {
  requireIncludes(
    patronView,
    "status === 402 && paymentStatus === 'requires_confirmation'",
    'PatronView.tsx must explicitly branch on 402 requires_confirmation.'
  );
  requireIncludes(
    patronView,
    'PAYMENT_AUTHORIZATION_REQUIRED_COPY',
    'PatronView.tsx must expose dedicated payment confirmation copy.'
  );
  requireMatch(
    patronView,
    /status === 402[\s\S]*setPaymentConfirmationState\(/,
    'PatronView.tsx must route 402 requires_confirmation into a dedicated payment confirmation state.'
  );
  requireIncludes(
    patronView,
    'PaymentElement',
    'PatronView.tsx must render Stripe Payment Element after requires_confirmation.'
  );
  requireIncludes(
    patronView,
    'stripe.confirmPayment',
    'PatronView.tsx must confirm the PaymentIntent through Stripe.js.'
  );
  requireIncludes(
    patronView,
    "result.paymentIntent?.status !== 'requires_capture'",
    'PatronView.tsx must require a capturable PaymentIntent before finalizing app state.'
  );
  requireIncludes(
    patronView,
    'payment_intent_id: paymentIntentId',
    'PatronView.tsx must send the confirmed PaymentIntent id back to the backend finalization path.'
  );
  requireIncludes(
    patronView,
    'error?.status === 402',
    'PatronView.tsx must not retry 402 requires_confirmation as a transient network error.'
  );
}

function assertPaymentConfirmationState() {
  requireIncludes(
    patronView,
    "phase: 'PAYMENT_PENDING_CONFIRMATION'",
    'PatronView.tsx must define a dedicated payment confirmation pending state.'
  );
  requireIncludes(
    patronView,
    'isPaymentConfirmationPending',
    'PatronView.tsx must expose a dedicated payment confirmation pending flag.'
  );
  requireIncludes(
    patronView,
    'Payment authorization required',
    'PatronView.tsx must render a dedicated payment authorization required UI state.'
  );
}

function assertDoubleSubmitGuard() {
  requireIncludes(
    patronView,
    'const isSubmitLocked = isPaying || isPaymentConfirmationPending;',
    'PatronView.tsx must guard double submit while payment confirmation or submission is pending.'
  );
  requireIncludes(
    patronView,
    'if (!checkoutPayload || isSubmitLocked) return;',
    'PatronView.tsx must block duplicate payment confirmation submits.'
  );
  requireIncludes(
    patronView,
    'disabled={isSubmitLocked}',
    'PatronView.tsx must disable submit actions while locked.'
  );
}

assertForbiddenCopy();
assertRequiresConfirmationHandling();
assertPaymentConfirmationState();
assertDoubleSubmitGuard();

if (packageJson.dependencies?.['@stripe/react-stripe-js'] !== '^6.7.0') {
  failures.push(`@stripe/react-stripe-js must stay on the verified current release (^6.7.0); found ${packageJson.dependencies?.['@stripe/react-stripe-js'] ?? 'missing'}.`);
}

if (packageJson.dependencies?.['@stripe/stripe-js'] !== '^9.9.0') {
  failures.push(`@stripe/stripe-js must stay on the verified current release (^9.9.0); found ${packageJson.dependencies?.['@stripe/stripe-js'] ?? 'missing'}.`);
}

requireIncludes(
  packageJson.scripts?.['test:contracts'] ?? '',
  'node scripts/patron-payment-truth.contract.test.mjs',
  'test:contracts must include the patron payment truth contract.'
);

if (failures.length) {
  console.error('Patron payment truth contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Patron payment truth contract passed.');
