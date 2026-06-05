import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const types = readFileSync(join(root, 'src/types.ts'), 'utf8');

const failures = [];

for (const term of [
  '48 hours',
  '24 hours',
  'SHA256(idempotency_key + patron_device_id_hash + gig_id + action_type + target_entity_id + amount_cents + currency + payload_hash)',
  'same idempotency key + same fingerprint',
  'same idempotency key + different fingerprint',
  'new idempotency key + different fingerprint'
]) {
  if (!doc.includes(term)) failures.push(`Missing idempotency fingerprint term: ${term}`);
}

for (const term of ['createHash', 'idempotencyFingerprint', 'patron_device_id_hash', 'payload_hash', 'amount_cents', 'currency']) {
  if (!server.includes(term) && !types.includes(term)) failures.push(`Runtime missing idempotency fingerprint field/helper: ${term}`);
}

if (!/409/.test(server) || !/idempotency.*misuse/i.test(server)) {
  failures.push('Server must reject same idempotency key with a different fingerprint as misuse.');
}

if (failures.length) {
  console.error('Idempotency fingerprint contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Idempotency fingerprint contract passed.');
