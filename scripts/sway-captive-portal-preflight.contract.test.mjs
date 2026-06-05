import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const wildCard = readFileSync(join(root, 'docs/SWAY_WILD_CARD_RISK_ADDENDUM.md'), 'utf8');
const objections = readFileSync(join(root, 'docs/SWAY_WILDCARD_OBJECTIONS_ADDENDUM.md'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const patron = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');

const failures = [];

function extractFunctionBody(source, functionName) {
  const startToken = `const ${functionName} =`;
  const start = source.indexOf(startToken);
  if (start === -1) return '';

  const firstBrace = source.indexOf('{', start);
  if (firstBrace === -1) return '';

  let depth = 0;
  for (let i = firstBrace; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(firstBrace, i + 1);
  }

  return '';
}

for (const term of [
  'GET /api/health/network-probe -> 204 No Content',
  'The patron entry must run a network preflight before checkout or payment UI mounts.',
  'Network sign-in required. Connect to the venue Wi-Fi or switch to cellular before sending a request. You were not charged.',
  'scripts/sway-captive-portal-preflight.contract.test.mjs'
]) {
  if (!wildCard.includes(term)) failures.push(`Missing captive portal contract term: ${term}`);
}

for (const term of [
  'No checkout mount before network readiness check',
  'No payment intent creation while captive portal state is unknown'
]) {
  if (!objections.includes(term)) failures.push(`Missing captive portal objection term: ${term}`);
}

for (const term of [
  '/api/health/network-probe',
  'res.status(204).end()'
]) {
  if (!server.includes(term)) failures.push(`Server missing network probe behavior: ${term}`);
}

for (const term of [
  'networkPreflightStatus',
  '/api/health/network-probe',
  "redirect: 'manual'",
  'CAPTIVE_PORTAL_BLOCK_COPY',
  "networkPreflightStatus !== 'ready'",
  'setCheckoutPayload'
]) {
  if (!patron.includes(term)) failures.push(`Patron client missing captive portal preflight guard: ${term}`);
}

const preflightCheckIndex = patron.indexOf("networkPreflightStatus !== 'ready'");
const checkoutMountIndex = patron.indexOf('setCheckoutPayload({');
if (preflightCheckIndex === -1 || checkoutMountIndex === -1 || preflightCheckIndex > checkoutMountIndex) {
  failures.push('Patron checkout setup must check network preflight before mounting checkout payload.');
}

for (const functionName of ['initiateCheckout', 'handleStraightTipSubmit']) {
  const body = extractFunctionBody(patron, functionName);
  if (!body) {
    failures.push(`Could not find ${functionName}.`);
    continue;
  }

  const functionPreflightIndex = body.indexOf("networkPreflightStatus !== 'ready'");
  const functionCheckoutIndex = body.indexOf('setCheckoutPayload({');

  if (functionPreflightIndex === -1) {
    failures.push(`${functionName} must check networkPreflightStatus before checkout payload creation.`);
  }

  if (functionCheckoutIndex === -1) {
    failures.push(`${functionName} must contain the checkout payload creation path being guarded.`);
  }

  if (functionPreflightIndex !== -1 && functionCheckoutIndex !== -1 && functionPreflightIndex > functionCheckoutIndex) {
    failures.push(`${functionName} can call setCheckoutPayload before checking networkPreflightStatus.`);
  }

  for (const term of ['setDegraded(true)', 'setPendingActionMessage(CAPTIVE_PORTAL_BLOCK_COPY)', 'alert(CAPTIVE_PORTAL_BLOCK_COPY)', 'return;']) {
    if (!body.includes(term)) failures.push(`${functionName} missing captive portal guard action: ${term}`);
  }
}

if (failures.length) {
  console.error('Captive portal preflight contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Captive portal preflight contract passed.');
