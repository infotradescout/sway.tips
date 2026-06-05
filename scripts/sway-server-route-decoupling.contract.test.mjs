import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');

const failures = [];

for (const term of ['the server must be the authority', 'client checks are useful for ux, but they are not security boundaries']) {
  if (!doc.toLowerCase().includes(term)) failures.push(`Missing route-decoupling contract term: ${term}`);
}

const requiredRouteTerms = [
  '/talent',
  '/g/',
  '/p/',
  '/overlay',
  '/admin',
  '/dev/sandbox',
  'resolveShellForRoute',
  'shellHtmlRelativePath',
  'vite.transformIndexHtml',
  '/shells/dev-sandbox.html',
  '/^\\/assets\\/dev-sandbox-.*\\.js$/',
  'express.static(distPath, { index: false })',
  "shell === 'dev-sandbox'",
  "res.status(404).send('Not found')"
];

for (const term of requiredRouteTerms) {
  if (!server.includes(term)) failures.push(`Server route decoupling missing term: ${term}`);
}

const shellMappings = [
  { route: '/talent', shell: 'talent' },
  { route: '/overlay', shell: 'overlay' },
  { route: '/admin', shell: 'admin' },
  { route: '/dev/sandbox', shell: 'dev-sandbox' },
  { route: '/g/', shell: 'patron' },
  { route: '/p/', shell: 'patron' }
];

for (const { route, shell } of shellMappings) {
  const routeIndex = server.indexOf(route);
  const shellIndex = server.indexOf(`return '${shell}'`, Math.max(routeIndex, 0));
  if (routeIndex === -1 || shellIndex === -1 || shellIndex - routeIndex > 180) {
    failures.push(`Server must map ${route} to ${shell} shell.`);
  }
}

if (/res\.sendFile\(path\.join\(distPath,\s*['"]index\.html['"]\)\)/.test(server)) {
  failures.push('Production server still serves one universal index.html fallback.');
}

if (!/res\.sendFile\(path\.join\(distPath,\s*shellHtmlRelativePath\(shell\)\)\)/.test(server)) {
  failures.push('Production server must serve the resolved role-specific shell HTML.');
}

if (failures.length) {
  console.error('Server route decoupling contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Server route decoupling contract passed.');
