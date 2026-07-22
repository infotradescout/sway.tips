import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const spine = readFileSync(join(root, 'docs/SWAY_PRODUCT_SPINE.md'), 'utf8');

for (const term of [
  'Sway is a two-sided live request, tip, and boost product.',
  '### Customer',
  '### Performer',
  'One account can use both sides.',
  'Room settings -> Create room -> Show QR/link -> Customer joins -> Request/Tip/Boost',
  'Payment success appears only after backend confirmation.',
  'Music distribution or DSP delivery.',
  'A third customer-facing side beyond customer and performer.',
  'Complete-product decision: **HOLD**'
]) {
  if (!spine.includes(term)) failures.push(`Product baseline missing required term: ${term}`);
}

for (const forbidden of [
  'Publishing & collaboration',
  'DistroKid replacement',
  'Sway is the creator’s account for live audience money **and** audio collaboration/publishing'
]) {
  if (spine.includes(forbidden)) failures.push(`Product baseline contains retired scope: ${forbidden}`);
}

if (failures.length) {
  console.error('Sway product baseline contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway product baseline contract passed.');
