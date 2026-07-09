import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const checklist = readFileSync(join(root, 'docs/SWAY_LIVE_PILOT_READINESS_CHECKLIST.md'), 'utf8');

for (const term of [
  'Request',
  'Tip',
  'Boost',
  'QR',
  'live room',
  'Pending',
  'Approved',
  'Playing',
  'Up Next',
  'Paused',
  'Ended',
  'no-session recovery',
  'expected non-claims remain',
  'Paid boost floor follows the room minimum',
  'Free request mode makes boosts free upvotes with fixed weight 1',
  'Room creation captures the selected `paymentsEnabled` mode',
  'Stripe/payment provider integration is not changed',
  'PR #44 remains parked',
  'runtime claims',
  'No App Store readiness claim',
  'Performer Can Create A Room Before Going Live',
  'Performer Can Share QR/Link',
  'Patron Can Enter The Correct Room',
  'Money-Loop Smoke Expectations',
  'Hold Criteria Before PR #44 Resumes'
]) {
  if (!checklist.includes(term)) {
    failures.push(`Live pilot readiness checklist missing required term: ${term}`);
  }
}

for (const forbidden of [
  'Merge PR #44 before pilot',
  'resume PR #44 immediately',
  'Runtime behavior changed.',
  'Payment behavior changed.',
  'App Store ready',
  'App Store readiness achieved'
]) {
  if (checklist.includes(forbidden)) {
    failures.push(`Live pilot readiness checklist must not include forbidden claim: ${forbidden}`);
  }
}

if (failures.length) {
  console.error('Sway live pilot readiness contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway live pilot readiness contract passed.');
