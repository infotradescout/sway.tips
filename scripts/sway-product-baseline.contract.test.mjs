import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const spine = readFileSync(join(root, 'docs/SWAY_PRODUCT_SPINE.md'), 'utf8');

for (const term of [
  'main @ ab990921452a2cc64656ce877a121de98d79dc25',
  'Sway work must protect the live-night money loop first.',
  'Room settings -> Create room -> Show QR/link -> Request/Tip/Boost -> Approve/Deny/Complete -> Patron status -> Earnings -> End room -> Recap.',
  'Room Money Mode',
  'Paid request rooms use the room minimum for paid requests and paid boosts; the current floor is $5.',
  'Free request rooms make requests free and convert boosts into free upvotes with fixed weight 1.',
  'Room creation captures the selected `paymentsEnabled` mode.',
  'make more money with less request chaos',
  'Do Not Prioritize Before Adoption Proof',
  'New hardware/control expansion beyond the merged control-bridge baseline.',
  'Lyrics.',
  'Marketplace, browse, or discovery expansion.',
  'Operator/admin expansion.',
  'DJ software integrations.',
  'PR #44 control bridge is merged and deployed as a baseline by owner override',
  'Do not claim live hardware/control proof without a real room/token smoke'
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
