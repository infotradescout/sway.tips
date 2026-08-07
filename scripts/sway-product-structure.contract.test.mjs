import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label}: missing ${term}`);
}

const structure = read('docs/SWAY_PRODUCT_STRUCTURE.md');
const dioEconomics = read('docs/SWAY_DIO_ECONOMIC_MODEL.md');
const agents = read('AGENTS.md');
const releaseControl = read('RELEASE_CONTROL.md');
const doctrine = read('docs/VIBE_ENGINEERING_DOCTRINE.md');
const gap = read('docs/SWAY_COMPLETE_PRODUCT_GAP.md');
const hold = read('docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md');
const readiness = JSON.parse(read('config/sway-complete-product-readiness.json'));

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
  'SWAY_DIO_ECONOMIC_MODEL.md',
  'zero-take, listener-directed streaming',
  'Sway streaming take',
  '**$0**'
]) {
  requireIncludes(structure, term, 'SWAY_PRODUCT_STRUCTURE.md');
}

for (const term of [
  'zero-take, listener-directed streaming',
  'monthly creator pool',
  'Sway keeps **$0**',
  'Do **not** use one platform-wide royalty pool',
  'verified listening share',
  'Creator retains the master copyright',
  'Sway Exclusive',
  'does **not** authorize Sway.DIO launch'
]) {
  requireIncludes(dioEconomics, term, 'SWAY_DIO_ECONOMIC_MODEL.md');
}

for (const term of [
  'SWAY_PRODUCT_STRUCTURE.md',
  'SWAY_DIO_ECONOMIC_MODEL.md',
  'zero-take, listener-directed streaming',
  'Live Rooms (current)',
  'Self-Production (in progress)',
  'does not make Live Rooms'
]) {
  requireIncludes(agents, term, 'AGENTS.md');
}

for (const term of [
  'SWAY_PRODUCT_STRUCTURE.md',
  'SWAY_DIO_ECONOMIC_MODEL.md',
  'zero-take, listener-directed streaming',
  'Live Rooms',
  'Self-Production',
  'do not redefine Live Rooms as incomplete'
]) {
  requireIncludes(releaseControl, term, 'RELEASE_CONTROL.md');
}

for (const term of [
  'SWAY_PRODUCT_STRUCTURE.md',
  'SWAY_DIO_ECONOMIC_MODEL.md',
  'zero-take, listener-directed streaming',
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
  'SWAY_DIO_ECONOMIC_MODEL.md',
  'zero-take, listener-directed',
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
  'SWAY_DIO_ECONOMIC_MODEL.md'
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
