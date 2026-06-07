import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const publicShell = readFileSync(join(root, 'shells/public.html'), 'utf8');
const appShell = readFileSync(join(root, 'src/App.tsx'), 'utf8');
const failures = [];

function requireIncludes(term, label = term) {
  if (!publicShell.includes(term)) {
    failures.push(`Public product preview missing: ${label}`);
  }
}

for (const term of [
  '<div id="root"></div>',
  '<script type="module" src="/src/main.tsx"></script>',
  'Sway — Live Tip Jar &amp; Request Platform',
  'Demo preview data'
]) {
  requireIncludes(term);
}

for (const forbidden of [
  'sway-demo-fixtures.json',
  'fixtureSource',
  'demo-fixture-harness',
  'demo_',
  'Preview layout, not live data',
  'product preview layout, not live production data'
]) {
  if (publicShell.includes(forbidden)) {
    failures.push(`Public product preview must not reference demo fixture payload: ${forbidden}`);
  }
}

for (const term of [
  'Sway lets live performers, DJs, bartenders, and event acts accept paid tips, requests, and audience boosts through a QR-powered live ladder.',
  'Talent login',
  'Open patron gig route'
]) {
  if (!appShell.includes(term)) {
    failures.push(`Restored public app surface missing original home term: ${term}`);
  }
}

if (failures.length) {
  console.error('Public product preview contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Public product preview contract passed.');
