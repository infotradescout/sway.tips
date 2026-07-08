import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const spine = readFileSync(join(root, 'docs/SWAY_PRODUCT_SPINE.md'), 'utf8');

for (const term of [
  'main @ 4a35ce9743b14b712cb9049ec7334ef6a4a35923',
  'Sway work must protect the live-night money loop first.',
  'Start room -> Show QR/link -> Request/Tip/Boost -> Approve/Deny/Complete -> Patron status -> Earnings -> End room -> Recap.',
  'make more money with less request chaos',
  'Do Not Prioritize Before Adoption Proof',
  'Hardware controls.',
  'Lyrics.',
  'Marketplace, browse, or discovery expansion.',
  'Operator/admin expansion.',
  'DJ software integrations.',
  'PR #44 control bridge remains parked'
]) {
  if (!spine.includes(term)) {
    failures.push(`Product baseline missing required term: ${term}`);
  }
}

for (const forbidden of [
  'marketed MVP',
  'Product must prioritize hardware controls',
  'Product must prioritize lyrics',
  'Product must prioritize marketplace',
  'Product must prioritize operator/admin expansion'
]) {
  if (spine.includes(forbidden)) {
    failures.push(`Product baseline must not include deprecated priority: ${forbidden}`);
  }
}

if (failures.length) {
  console.error('Sway product baseline contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway product baseline contract passed.');
