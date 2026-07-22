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

const shellMappingBranches = [
  "if (urlPath.startsWith('/talent')) return 'talent';",
  "if (urlPath.startsWith('/overlay')) return 'overlay';",
  "if (urlPath.startsWith('/admin')) return 'admin';",
  "if (urlPath === '/dev/sandbox' || urlPath.startsWith('/dev-sandbox')) return 'dev-sandbox';",
  "if (urlPath.startsWith('/g/') || urlPath.startsWith('/p/')) return 'patron';"
];

for (const branch of shellMappingBranches) {
  if (!server.includes(branch)) failures.push(`Server route classifier missing exact branch: ${branch}`);
}

if (/res\.sendFile\(path\.join\(distPath,\s*['"]index\.html['"]\)\)/.test(server)) {
  failures.push('Production server still serves one universal index.html fallback.');
}

if (
  !/res\.sendFile\(path\.join\(distPath,\s*shellHtmlRelativePath\(shell\)\)\)/.test(server) &&
  !/readFileSync\(htmlPath,\s*['"]utf8['"]\)/.test(server)
) {
  failures.push('Production server must serve the resolved role-specific shell HTML.');
}

if (server.includes('injectShareMetadata') && !server.includes('const htmlPath = path.join(distPath, shellHtmlRelativePath(shell))')) {
  failures.push('Production share metadata injection must still read from the resolved role-specific shell HTML.');
}

if (failures.length) {
  console.error('Server route decoupling contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Server route decoupling contract passed.');
