import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

function requireIncludes(label, source, terms) {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${label} missing required evidence term: ${term}`);
  }
}

function requireExcludes(label, source, terms) {
  for (const term of terms) {
    if (source.includes(term)) failures.push(`${label} must not include forbidden claim: ${term}`);
  }
}

const packet = read('docs/SWAY_LIVE_PILOT_QA_PACKET_TEMPLATE.md');
const checklist = read('docs/SWAY_LIVE_PILOT_READINESS_CHECKLIST.md');
const packageJson = read('package.json');

requireIncludes('Live pilot QA packet template', packet, [
  'Pilot date:',
  'Environment tested:',
  'Build marker / commit SHA:',
  'Room URL:',
  'Request mode: Paid / Free requests',
  'Room minimum:',
  'Boost mode observed: Paid room minimum / Free upvote weight 1',
  'QR/Link Proof',
  'Performer Room-Settings Proof',
  'Performer Create-Room Proof',
  'Patron Room-Entry Proof',
  'Request Proof',
  'Tip Proof',
  'Boost Proof',
  'Paid boost amount respects room minimum:',
  'Free request mode boost is free upvote weight 1:',
  'Queue Action Proof',
  'Patron Status Proof',
  'Pending',
  'Approved',
  'Playing',
  'Up Next',
  'Paused',
  'Ended',
  'Earnings Or End-Room Proof',
  'Recap Proof',
  'Known Failures',
  'Hold/go decision:',
  'Operator name:',
  'Payment/provider mode:',
  'does not automate payments',
  'does not claim that a pilot has passed',
  'does not claim App Store readiness',
  'PR #44 remains parked'
]);

requireExcludes('Live pilot QA packet template', packet, [
  'Pilot passed',
  'Payment behavior changed.',
  'App Store ready',
  'App Store readiness achieved',
  'Merge PR #44 before pilot',
  'resume PR #44 immediately'
]);

requireIncludes('Live pilot readiness checklist', checklist, [
  'docs/SWAY_LIVE_PILOT_QA_PACKET_TEMPLATE.md',
  'QA packet',
  'evidence package',
  'hold/go decision'
]);

requireIncludes('package.json', packageJson, [
  '"test:sway-live-pilot-evidence": "node scripts/sway-live-pilot-evidence.contract.test.mjs"',
  'node scripts/sway-live-pilot-evidence.contract.test.mjs',
  '"validate": "npm run lint && npm run build && npm run test:contracts"'
]);

if (failures.length) {
  console.error('Sway live pilot evidence contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway live pilot evidence contract passed.');
