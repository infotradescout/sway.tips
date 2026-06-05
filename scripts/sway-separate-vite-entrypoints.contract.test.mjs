import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md'), 'utf8');

const requiredEntries = [
  'src/entries/patron.tsx',
  'src/entries/talent.tsx',
  'src/entries/overlay.tsx',
  'src/entries/admin.tsx',
  'src/entries/dev-sandbox.tsx'
];

const failures = [];

for (const entry of requiredEntries) {
  if (!doc.includes(entry)) failures.push(`Structural doc missing Vite entrypoint: ${entry}`);
  if (!existsSync(join(root, entry))) failures.push(`Missing Vite entrypoint file: ${entry}`);
}

if (failures.length) {
  console.error('Separate Vite entrypoints contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Separate Vite entrypoints contract passed.');
