import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const spine = readFileSync(join(root, 'docs/SWAY_PRODUCT_SPINE.md'), 'utf8');
const gap = readFileSync(join(root, 'docs/SWAY_COMPLETE_PRODUCT_GAP.md'), 'utf8');

for (const term of [
  'Do not ship an incomplete product',
  'One Sway account can act as audience and creator',
  'A live room is optional night mode',
  'Room settings -> Create room -> Show QR/link -> Request/Tip/Boost -> Approve/Deny/Complete -> Patron status -> Earnings -> End room -> Recap.',
  'Room Money Mode',
  'Paid request rooms use the room minimum for paid requests and paid boosts; the current floor is $5.',
  'Free request rooms make requests free and convert boosts into free upvotes with fixed weight 1.',
  'Room creation captures the selected `paymentsEnabled` mode.',
  'Publishing & collaboration',
  '0023_audio_publishing_foundation',
  'Complete-product ship decision: **NO**'
]) {
  if (!spine.includes(term)) {
    failures.push(`Product baseline missing required term: ${term}`);
  }
}

for (const term of [
  'Do not ship until the product is complete',
  'Audio publishing foundation',
  'Unified account',
  'Private file pairing QR'
]) {
  if (!gap.includes(term)) {
    failures.push(`Complete product gap ledger missing required term: ${term}`);
  }
}

for (const forbidden of [
  'marketed MVP',
  'Product must prioritize hardware controls',
  'Product must prioritize lyrics',
  'Product must prioritize marketplace',
  'Product must prioritize operator/admin expansion',
  'Sway work must protect the live-night money loop first.',
  'Do Not Prioritize Before Adoption Proof'
]) {
  if (spine.includes(forbidden)) {
    failures.push(`Product baseline must not include deprecated priority: ${forbidden}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Product baseline contract passed.');
