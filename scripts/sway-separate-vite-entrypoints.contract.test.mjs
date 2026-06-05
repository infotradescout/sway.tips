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

const entrySources = requiredEntries.map((entry) => ({
  entry,
  source: existsSync(join(root, entry)) ? readFileSync(join(root, entry), 'utf8') : ''
}));

const importsMainCount = entrySources.filter(({ source }) => /import\s+['"]\.\.\/main['"]/.test(source)).length;
if (importsMainCount === requiredEntries.length) {
  failures.push('All Vite entrypoints import ../main; this proves file presence, not separate production shells.');
}

for (const { entry, source } of entrySources) {
  if (/import\s+['"]\.\.\/main['"]/.test(source) && !source.includes('stub:')) {
    failures.push(`${entry} imports ../main without an explicit Slice 0A stub marker.`);
  }
}

if (!doc.includes('entry files are explicit Slice 0A stubs')) {
  failures.push('Structural doc must mark current entrypoints as explicit Slice 0A stubs until real shells exist.');
}

if (failures.length) {
  console.error('Separate Vite entrypoints contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Separate Vite entrypoints contract passed.');
