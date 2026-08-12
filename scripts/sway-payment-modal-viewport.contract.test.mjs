import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const patronView = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const browserEnvironment = readFileSync(join(root, 'src/browserEnvironment.ts'), 'utf8');
const renderedTest = readFileSync(join(root, 'scripts/sway-payment-modal-viewport.browser.test.ts'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

const modalStart = patronView.indexOf('/* 4. TEMPORARY CONFIRMATION MODAL OVERLAY */');
const modalEnd = patronView.indexOf('</AnimatePresence>', modalStart);
const modalSource = modalStart >= 0 && modalEnd > modalStart
  ? patronView.slice(modalStart, modalEnd)
  : '';

if (!modalSource) {
  failures.push('PatronView.tsx must retain the payment confirmation modal.');
} else {
  if (!modalSource.includes('items-start')) {
    failures.push('The payment modal overlay must align from the viewport start on constrained screens.');
  }
  if ((modalSource.match(/var\(--sway-viewport-height, 100vh\)/g) ?? []).length < 3) {
    failures.push('The payment overlay and dialog must be bounded by Sway visualViewport height.');
  }
  if (modalSource.includes('100dvh')) {
    failures.push('The payment dialog must not rely on 100dvh because the mobile keyboard can shrink visualViewport independently.');
  }
  if ((modalSource.match(/overflow-y-auto/g) ?? []).length < 2) {
    failures.push('Both the overlay and payment dialog must allow vertical scrolling.');
  }
  if ((modalSource.match(/overscroll-contain/g) ?? []).length < 2) {
    failures.push('Both payment scroll containers must contain overscroll.');
  }
  if (/max-w-sm[^"\n]*overflow-hidden/.test(modalSource)) {
    failures.push('The payment dialog must not hide overflow and strand authorization controls below the viewport.');
  }

  for (const term of [
    'role="dialog"',
    'aria-modal="true"',
    'aria-labelledby="sway-payment-dialog-title"',
    'aria-describedby="sway-payment-dialog-description"',
    'data-sway-payment-dialog="true"',
    'data-sway-payment-focus-start="true"',
    'data-sway-payment-focus-end="true"',
    'data-sway-payment-actions="true"',
    "left: 'var(--sway-viewport-offset-left, 0px)'",
    "top: 'var(--sway-viewport-offset-top, 0px)'",
    'onKeyDown={handleCheckoutDialogKeyDown}'
  ]) {
    if (!modalSource.includes(term)) failures.push(`Payment dialog missing required accessibility term: ${term}`);
  }
}

for (const term of [
  'data-sway-payment-form-body="true"',
  'checkoutSuccessTimeoutRef',
  'completedClientRequestId',
  'checkoutPayloadRef.current?.clientRequestId !== expectedClientRequestId',
  'matchingCheckoutIsOpen',
  'stripeAuthorizationInFlightRef',
  'onAuthorizationStateChange={setStripeAuthorizationState}',
  'isPaying || isStripeAuthorizing || isDurableActionPending'
]) {
  if (!patronView.includes(term)) failures.push(`Payment dialog lifecycle missing required term: ${term}`);
}

for (const term of [
  "window.visualViewport?.addEventListener('resize', updateViewport",
  "window.visualViewport?.addEventListener('scroll', updateViewportOffset",
  "root.style.setProperty('--sway-viewport-height'",
  "root.style.setProperty('--sway-viewport-offset-left'",
  "root.style.setProperty('--sway-viewport-offset-top'"
]) {
  if (!browserEnvironment.includes(term)) failures.push(`Viewport environment missing required behavior: ${term}`);
}

for (const term of [
  'compact portrait',
  'short landscape',
  'keyboard-shrunken visual viewport',
  "viewport.dispatchEvent(new Event('resize'))",
  "viewport.dispatchEvent(new Event('scroll'))",
  "Object.defineProperty(viewport, 'offsetTop'",
  "Object.defineProperty(viewport, 'width'",
  'A completed checkout timer must not close a newly opened checkout.',
  'Success dismissal and reopen must not duplicate the completed submission.',
  'Backend-confirmed success must move focus to the status dialog.',
  'The secure provider iframe must receive parent-document focus.',
  'Shift+Tab leaving the first secure provider field must wrap to the last dialog action.',
  'Escape must not close the dialog while Stripe authorization is in flight.',
  'Cancel must remain disabled while Stripe authorization is in flight.',
  'Delayed Stripe authorization must finalize exactly one submission.',
  'Restored reconciliation must not open a stale success dialog.',
  'A new checkout after restored reconciliation must show payment controls, not stale success.',
  'Tab leaving the secure provider iframe must reach the next action inside the dialog.',
  'Shift+Tab must return focus to the secure provider iframe.',
  'Cancel must be reachable inside the visible viewport.',
  "page.keyboard.press('Escape')",
  "page.keyboard.press('Shift+Tab')"
]) {
  if (!renderedTest.includes(term)) failures.push(`Rendered payment modal coverage missing: ${term}`);
}

if (!(packageJson.scripts?.['test:contracts'] ?? '').includes('node scripts/sway-payment-modal-viewport.contract.test.mjs')) {
  failures.push('test:contracts must include the payment modal viewport contract.');
}

if (packageJson.scripts?.['test:browser:payment-modal-viewport'] !== 'node --import tsx scripts/sway-payment-modal-viewport.browser.test.ts') {
  failures.push('package.json must expose the rendered payment modal viewport test.');
}

if (!failures.length) {
  const interaction = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/sway-payment-modal-viewport.browser.test.ts'],
    { cwd: root, stdio: 'inherit' }
  );
  if (interaction.status !== 0) {
    failures.push(`Rendered payment modal viewport test failed with status ${interaction.status ?? 'unknown'}.`);
  }
}

if (failures.length) {
  console.error('Sway payment modal viewport contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway payment modal viewport contract passed.');
