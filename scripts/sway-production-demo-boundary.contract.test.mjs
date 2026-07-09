import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

const demoMode = read('src/demo-mode.tsx');
const viteConfig = read('vite.config.ts');
const accessControl = read('src/server/access-control.ts');
const publicShell = read('shells/public.html');
const legacyAppShell = read('src/App.tsx');
const patronShell = read('src/shells/PatronApp.tsx');
const packageJson = read('package.json');

const failures = [];

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(message);
}

requireIncludes(
  demoMode,
  "import.meta.env.VITE_SWAY_DEMO_MODE === 'true' && !import.meta.env.PROD",
  'Client demo mode must be disabled for production builds even if VITE_SWAY_DEMO_MODE is true.'
);

requireIncludes(
  viteConfig,
  "process.env.VITE_SWAY_DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production'",
  'Demo fixtures must not be published by production builds.'
);

requireIncludes(
  accessControl,
  "process.env.NODE_ENV !== 'production'",
  'Server demo preview shell bypass must be disabled in production.'
);

for (const demoRoute of [
  '/g/00000000-0000-4000-8000-000000000001',
  '/overlay/00000000-0000-4000-8000-000000000001'
]) {
  if (publicShell.includes(demoRoute)) {
    failures.push(`Public landing must not route production users to hardcoded demo route: ${demoRoute}`);
  }
}

for (const required of [
  'href="/home">SCAN</a>'
]) {
  requireIncludes(publicShell, required, `Public landing missing production-safe route target: ${required}`);
}

for (const forbiddenPublicOverlay of ['Open overlay', '/overlay/live']) {
  if (publicShell.includes(forbiddenPublicOverlay)) {
    failures.push(`Public landing must not expose overlay entry to unauthenticated patrons: ${forbiddenPublicOverlay}`);
  }
}

for (const source of [
  { name: 'src/App.tsx', text: legacyAppShell },
  { name: 'src/shells/PatronApp.tsx', text: patronShell }
]) {
  if (source.text.includes('Open overlay')) {
    failures.push(`${source.name} must not expose overlay entry to unauthenticated patrons.`);
  }
}

requireIncludes(
  packageJson,
  'sway-production-demo-boundary.contract.test.mjs',
  'test:contracts must include production demo boundary contract.'
);

if (failures.length) {
  console.error('Production demo boundary contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Production demo boundary contract passed.');
