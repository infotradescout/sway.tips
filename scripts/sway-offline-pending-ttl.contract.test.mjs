import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const wildCard = readFileSync(join(root, 'docs/SWAY_WILD_CARD_RISK_ADDENDUM.md'), 'utf8');
const patron = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');

const failures = [];

for (const term of [
  'Default pending action TTL',
  '5 minutes',
  'Network dropped. Your request expired and you were not charged.',
  'client_pending_actions.expires_at',
  'server rejects stale action',
  'scripts/sway-offline-pending-ttl.contract.test.mjs'
]) {
  if (!wildCard.includes(term)) failures.push(`Missing offline pending TTL contract term: ${term}`);
}

for (const term of [
  'PENDING_ACTION_TTL_MS = 5 * 60 * 1000',
  'expires_at',
  'PENDING_ACTION_EXPIRED_COPY',
  'sway.pendingAction',
  'localStorage.removeItem'
]) {
  if (!patron.includes(term)) failures.push(`Patron client missing pending action TTL guard: ${term}`);
}

if (!/const\s+PENDING_ACTION_TTL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000\s*;/.test(patron)) {
  failures.push('Pending action TTL must be exactly five minutes for Slice 0A guardrail.');
}

if (/setBackendConfirmed\(true\)[\s\S]{0,240}localStorage\.removeItem/.test(patron)) {
  // This is acceptable only if the pending action is removed after backend confirmation.
} else {
  failures.push('Pending action must be cleared only on backend-confirmed completion.');
}

if (failures.length) {
  console.error('Offline pending TTL contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Offline pending TTL contract passed.');
