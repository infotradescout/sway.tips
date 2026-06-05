import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_DAY1_BUILD_CONTRACT.md'), 'utf8');
const patron = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');

const failures = [];

for (const term of ['local pending action record', 'offline/degraded indicator', 'exponential retry', 'server reconciliation']) {
  if (!doc.includes(term)) failures.push(`Missing degraded-connection contract term: ${term}`);
}

for (const term of ['pendingAction', 'navigator.onLine', 'degraded', 'localStorage']) {
  if (!patron.includes(term)) failures.push(`Patron client missing degraded-connection state: ${term}`);
}

if (/WebSocket-only transaction state/i.test(patron)) {
  failures.push('Patron client contains prohibited WebSocket-only transaction state.');
}

if (failures.length) {
  console.error('Degraded connection state contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Degraded connection state contract passed.');
