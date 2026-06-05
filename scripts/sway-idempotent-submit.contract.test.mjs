import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_DAY1_BUILD_CONTRACT.md'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const patron = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');

const failures = [];

for (const term of ['client_request_id', 'idempotency_key', 'server reconciliation', 'no duplicate charges']) {
  if (!doc.includes(term)) failures.push(`Missing idempotent-submit contract term: ${term}`);
}

const bannedPatterns = [
  /id:\s*["'`]req-[\s\S]{0,120}Math\.random/i,
  /id:\s*["'`]boost-[\s\S]{0,120}Math\.random/i,
  /retry without idempotency/i,
  /duplicate charges/i
];

for (const pattern of bannedPatterns) {
  if (pattern.test(server) || pattern.test(patron)) {
    failures.push(`Submit path contains prohibited idempotency pattern: ${pattern}`);
  }
}

if (failures.length) {
  console.error('Idempotent submit contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Idempotent submit contract passed.');
