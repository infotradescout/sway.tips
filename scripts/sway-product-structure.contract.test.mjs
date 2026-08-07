import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label}: missing ${term}`);
}

function requireAbsent(source, term, label) {
  if (source.includes(term)) failures.push(`${label}: must not require/ship ${term} in this lane`);
}

const structure = read('docs/SWAY_PRODUCT_STRUCTURE.md');
const agents = read('AGENTS.md');
const releaseControl = read('RELEASE_CONTROL.md');
const doctrine = read('docs/VIBE_ENGINEERING_DOCTRINE.md');
const gap = read('docs/SWAY_COMPLETE_PRODUCT_GAP.md');
const hold = read('docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md');
const readiness = JSON.parse(read('config/sway-complete-product-readiness.json'));

// This PR intentionally excludes docs/SWAY_DIO_ECONOMIC_MODEL.md.
requireAbsent(
  JSON.stringify({
    structureExists: false
  }),
  'never',
  'sanity'
);
try {
  read('docs/SWAY_DIO_ECONOMIC_MODEL.md');
  failures.push('docs/SWAY_DIO_ECONOMIC_MODEL.md must remain excluded from this dual-lane PR');
} catch {
  // expected: file absent
}

for (const term of [
  'Live Rooms',
  'Self-Production',
  'Sway.DIO',
  'Digital Independent Original',
  'dio.sway.tips',
  'sway.tips/dio',
  '`.dio` is **not** a public TLD',
  'Current operating product',
  'Active build in progress',
  'Planned native streaming layer within Self-Production',
  'One Self-Production capability, not Sway’s identity',
  'Separate release gate for Live Rooms',
  'Unfinished Self-Production does **not** make Live Rooms unfinished',
  'External distribution',
  'decision D',
  'subscription-funded Sway Exclusives',
  'Sway Exclusive ≠ ownership',
  'Sway streaming take',
  '**$0**',
  'does **not** ship or depend on `docs/SWAY_DIO_ECONOMIC_MODEL.md`'
]) {
  requireIncludes(structure, term, 'SWAY_PRODUCT_STRUCTURE.md');
}

for (const term of [
  'SWAY_PRODUCT_STRUCTURE.md',
  'decision D staged all-three funding',
  'subscription-funded Sway Exclusives',
  'Sway Exclusive ≠ ownership',
  'Live Rooms (current)',
  'Self-Production (in progress)',
  'does not make Live Rooms'
]) {
  requireIncludes(agents, term, 'AGENTS.md');
}

for (const term of [
  'SWAY_PRODUCT_STRUCTURE.md',
  'decision D staged all-three funding',
  'Live Rooms',
  'Self-Production',
  'do not redefine Live Rooms as incomplete'
]) {
  requireIncludes(releaseControl, term, 'RELEASE_CONTROL.md');
}

for (const term of [
  'SWAY_PRODUCT_STRUCTURE.md',
  'decision D staged all-three funding',
  'Live Rooms',
  'Self-Production',
  'not Sway’s identity',
  'Sway replaces the core DistroKid workflow',
  'Sway retains its original product'
]) {
  requireIncludes(doctrine, term, 'VIBE_ENGINEERING_DOCTRINE.md');
}

for (const term of [
  'SWAY_PRODUCT_STRUCTURE.md',
  'decision D staged all-three funding',
  'Sway.DIO pillar',
  'Sway replaces the core DistroKid workflow',
  'do not make Live Rooms unfinished',
  'Live Rooms — current operating product'
]) {
  requireIncludes(gap, term, 'SWAY_COMPLETE_PRODUCT_GAP.md');
}

for (const term of [
  'Lane:** Live Rooms',
  'Self-Production progress is judged separately',
  'does **not** authorize live Stripe',
  'SWAY_PRODUCT_STRUCTURE.md'
]) {
  requireIncludes(hold, term, 'TEST_MODE_PILOT_MILESTONE_HOLD.md');
}

if (readiness.decision !== 'HOLD') {
  failures.push('complete-product readiness must remain HOLD');
}
if (!String(readiness.ownerStandard || '').includes('two connected products')) {
  failures.push('readiness ownerStandard must state two connected products');
}

if (failures.length) {
  console.error('Sway product structure contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway product structure contract passed.');
