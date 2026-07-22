import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');

const doctrine = read('docs/VIBE_ENGINEERING_DOCTRINE.md');
const agentRules = read('AGENTS.md');
const gapLedger = read('docs/SWAY_COMPLETE_PRODUCT_GAP.md');
const readiness = JSON.parse(read('config/sway-complete-product-readiness.json'));
const packageJson = JSON.parse(read('package.json'));

for (const term of [
  'verified outcomes delivered without increasing uncontrolled risk',
  'No task is complete because an agent says it is complete.',
  'No deployment is successful merely because it deployed.',
  'Sway is one simple two-sided live product',
  'Customer side:',
  'Performer side:',
  'Historical audio-distribution schema may remain dormant',
  'npm run readiness:assert'
]) {
  if (!doctrine.includes(term)) failures.push(`Vibe engineering doctrine missing term: ${term}`);
}

for (const term of [
  'docs/VIBE_ENGINEERING_DOCTRINE.md',
  'No task is complete because an agent says it is complete',
  'No deployment is successful merely because it deployed'
]) {
  if (!agentRules.includes(term)) failures.push(`Agent rules missing term: ${term}`);
}

for (const term of [
  'Complete-product decision: **HOLD**',
  'Customer and performer shells exist.',
  'Historical audio-distribution schema exists but is retired',
  'Run a current production journey with one performer account and one separate customer.'
]) {
  if (!gapLedger.includes(term)) failures.push(`Complete-product gap ledger missing term: ${term}`);
}

if (readiness.schemaVersion !== 2) failures.push('Readiness config must use scope-correct schemaVersion 2.');
if (readiness.decision !== 'HOLD') failures.push('Readiness config must remain HOLD while production outcomes are unverified.');
if (readiness.pillars?.length !== 1 || readiness.pillars[0]?.id !== 'live_room_product') {
  failures.push('Readiness config must contain only the live_room_product pillar.');
}
for (const forbidden of ['distrokid_replacement', 'original_sway']) {
  if (JSON.stringify(readiness).includes(forbidden)) failures.push(`Readiness config contains retired pillar: ${forbidden}`);
}

for (const script of ['readiness:report', 'readiness:assert']) {
  if (!packageJson.scripts?.[script]) failures.push(`package.json missing script: ${script}`);
}

const report = spawnSync(process.execPath, ['scripts/sway-complete-product-readiness.mjs'], { cwd: root, encoding: 'utf8' });
if (report.status !== 0 || !report.stdout.includes('Sway complete-product readiness: HOLD')) {
  failures.push('Readiness report must truthfully report HOLD.');
}

const assertion = spawnSync(process.execPath, ['scripts/sway-complete-product-readiness.mjs', '--assert-ready'], { cwd: root, encoding: 'utf8' });
if (assertion.status !== 1 || !assertion.stderr.includes('failed closed')) {
  failures.push('Readiness assertion must fail closed while production evidence is incomplete.');
}

if (failures.length) {
  console.error('Sway complete-product readiness contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway complete-product readiness contract passed.');
