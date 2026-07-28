import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.on('uncaughtException', (error) => {
  console.error('Hard-gate composition contract failed:', error);
  process.exit(1);
});

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const hardGate = packageJson.scripts?.['test:contracts'];

assert.equal(typeof hardGate, 'string', 'package.json must define the hard test:contracts gate.');

const requiredContracts = [
  'scripts/sway-public-event-listings.contract.test.mjs',
  'scripts/sway-event-ticket-native-ga.contract.test.mjs',
  'scripts/sway-native-ticket-production-proof.contract.test.mjs',
  'scripts/sway-distribution-delivery.contract.test.mjs'
];

for (const contractPath of requiredContracts) {
  assert.match(
    hardGate,
    new RegExp(`(?:^|&&\\s*)node(?:\\s+--import\\s+tsx)?\\s+${contractPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s*&&|$)`),
    `test:contracts must retain ${contractPath}.`
  );
}

console.log('Hard-gate composition contract passed.');
