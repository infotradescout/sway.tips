import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_DAY1_BUILD_CONTRACT.md'), 'utf8');
const runtime = [
  'src/App.tsx',
  'src/components/PatronView.tsx',
  'src/components/TalentDashboard.tsx',
  'src/components/VictoryScreen.tsx',
  'server.ts'
].map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

const requiredTerms = [
  'verification_required_at_amount = 10000',
  'gig_ready',
  'payouts_enabled',
  'UI copy cannot promise unverified payouts',
  'Stripe Connect verification requirements vary',
  'Incremental onboarding'
];

const failures = [];
for (const term of requiredTerms) {
  if (!doc.includes(term)) failures.push(`Missing deferred-KYC contract term: ${term}`);
}

const bannedRuntime = [
  /instant payout/i,
  /payouts? guaranteed/i,
  /cash out now/i,
  /wallet balance/i,
  /stored-value/i,
  /unverified payouts?/i
];

for (const pattern of bannedRuntime) {
  if (pattern.test(runtime)) failures.push(`Runtime contains prohibited payout/KYC pattern: ${pattern}`);
}

if (failures.length) {
  console.error('Deferred KYC contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Deferred KYC contract passed.');
