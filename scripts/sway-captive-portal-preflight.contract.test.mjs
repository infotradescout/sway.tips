import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const wildCard = readFileSync(join(root, 'docs/SWAY_WILD_CARD_RISK_ADDENDUM.md'), 'utf8');
const objections = readFileSync(join(root, 'docs/SWAY_WILDCARD_OBJECTIONS_ADDENDUM.md'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const patron = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');

const failures = [];

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

if (failures.length) {
  console.error('Captive portal preflight contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Captive portal preflight contract passed.');
