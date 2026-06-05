import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_DAY1_BUILD_CONTRACT.md'), 'utf8');
const runtime = [
  'server.ts',
  'src/App.tsx',
  'src/components/PatronView.tsx',
  'src/components/TalentDashboard.tsx'
].map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

const requiredTerms = [
  'client_request_id',
  'idempotency_key',
  'local pending action record',
  'offline/degraded indicator',
  'exponential retry',
  'server reconciliation',
  'no duplicate charges',
  'no payment success before backend confirmation',
  'WebSocket is enhancement only'
];

const failures = [];
for (const term of requiredTerms) {
  if (!doc.includes(term)) failures.push(`Missing offline-resilience contract term: ${term}`);
}

const bannedRuntime = [
  /payment success before backend confirmation/i,
  /WebSocket-only transaction state/i,
  /retry without idempotency/i,
  /losing pending client actions on refresh/i,
  /setPaymentSuccess\(true\)(?![\s\S]{0,240}await)/i
];

for (const pattern of bannedRuntime) {
  if (pattern.test(runtime)) failures.push(`Runtime contains prohibited offline-resilience pattern: ${pattern}`);
}

if (failures.length) {
  console.error('Offline client resilience contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Offline client resilience contract passed.');
