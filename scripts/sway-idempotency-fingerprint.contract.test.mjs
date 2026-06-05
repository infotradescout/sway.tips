import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md'), 'utf8');
const dayOneContract = readFileSync(join(root, 'docs/SWAY_DAY1_BUILD_CONTRACT.md'), 'utf8');
const serializationNote = readFileSync(join(root, 'docs/SWAY_IDEMPOTENCY_SERIALIZATION_NOTE.md'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const types = readFileSync(join(root, 'src/types.ts'), 'utf8');

const failures = [];

for (const term of [
  '48 hours',
  '24 hours',
  'SHA256(canonical_json(input))',
  'same idempotency key + same fingerprint',
  'same idempotency key + different fingerprint',
  'new idempotency key + different fingerprint'
]) {
  if (!doc.includes(term)) failures.push(`Missing idempotency fingerprint term: ${term}`);
}

for (const term of ['createHash', 'canonicalJson', 'idempotencyFingerprint', 'patron_device_id_hash', 'payload_hash', 'amount_cents', 'currency']) {
  if (!server.includes(term) && !types.includes(term)) failures.push(`Runtime missing idempotency fingerprint field/helper: ${term}`);
}

const unsafeSerializationPatterns = [
  /\.join\(\s*['"`]\|['"`]\s*\)/,
  /\.join\(\s*['"`]:['"`]\s*\)/,
  /idempotency_key\s*\+\s*patron_device_id_hash/,
  /patron_device_id_hash\s*\+\s*gig_id/,
  /amount_cents\s*\+\s*currency/
];

for (const pattern of unsafeSerializationPatterns) {
  if (pattern.test(server)) failures.push(`Runtime uses unsafe idempotency serialization: ${pattern}`);
}

for (const [name, source] of [
  ['SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md', doc],
  ['SWAY_DAY1_BUILD_CONTRACT.md', dayOneContract],
  ['SWAY_IDEMPOTENCY_SERIALIZATION_NOTE.md', serializationNote]
]) {
  if (/SHA256\(idempotency_key\s*\+/.test(source)) {
    failures.push(`${name} still documents unsafe raw idempotency concatenation.`);
  }
}

if (!/v:\s*1/.test(server)) {
  failures.push('Runtime idempotency fingerprint input must include version field v: 1.');
}

if (!/Math\.trunc\(Number\(input\.amount_cents\)\)/.test(server)) {
  failures.push('Runtime must normalize amount_cents as an integer before fingerprinting.');
}

if (!/currency:\s*String\(input\.currency\)\.toUpperCase\(\)/.test(server)) {
  failures.push('Runtime must normalize currency to uppercase before fingerprinting.');
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
