import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');

const failures = [];

for (const term of [
  '0A. Repo truth normalization',
  '0B. Hard contract gates',
  'Database schema init',
  'Server route decoupling and separate entrypoints',
  'Middleware guards backed by persisted schema',
  'Move schema initialization before role middleware',
  'PostgreSQL + Drizzle ORM + explicit SQL-friendly schema files'
]) {
  if (!doc.includes(term)) failures.push(`Missing structural build-order term: ${term}`);
}

const schemaExists = existsSync(join(root, 'src/db/schema.ts')) || existsSync(join(root, 'db/schema.sql')) || existsSync(join(root, 'drizzle'));
const middlewareGuardPatterns = [
  /requireRole/i,
  /roleMiddleware/i,
  /authorizeRole/i,
  /app\.use\([^)]*role/i
];

if (!schemaExists) {
  for (const pattern of middlewareGuardPatterns) {
    if (pattern.test(server)) {
      failures.push(`Role middleware appears before persisted schema exists: ${pattern}`);
    }
  }
}

if (failures.length) {
  console.error('Schema-before-middleware contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Schema-before-middleware contract passed.');
