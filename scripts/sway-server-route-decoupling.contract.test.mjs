import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');

const failures = [];

for (const term of ['the server must be the authority', 'client checks are useful for ux, but they are not security boundaries']) {
  if (!doc.toLowerCase().includes(term)) failures.push(`Missing route-decoupling contract term: ${term}`);
}

if (!server.includes('/talent') || !server.includes('/g/') || !server.includes('/overlay') || !server.includes('/admin')) {
  failures.push('Server does not explicitly recognize production route families.');
}

if (/window\.location\.pathname/.test(app) && !server.includes('resolveShellForRoute')) {
  failures.push('Client-side route resolution exists before server-side shell selection.');
}

if (failures.length) {
  console.error('Server route decoupling stub contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Server route decoupling stub contract passed; full route decoupling remains pending until distinct bundles are served.');
