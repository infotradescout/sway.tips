import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const failures = [];

function requireTerm(term, label = term) {
  if (!server.includes(term)) {
    failures.push(`Host-aware routing missing term: ${label}`);
  }
}

for (const term of [
  'normalizeHost',
  "CANONICAL_APP_HOST = 'app.sway.tips'",
  "CANONICAL_APP_ORIGIN = `https://${CANONICAL_APP_HOST}`",
  "new Set(['sway.tips', 'www.sway.tips'])",
  'shouldRedirectToAppHost',
  'buildAppHostRedirectUrl',
  'req.originalUrl',
  'redirect(308, buildAppHostRedirectUrl(req.originalUrl))',
  "urlPath === '/' || urlPath === '/home'",
  "if (isAppSubdomain) return 'patron';",
  "if (isLocalPublicHost) return 'public';"
]) {
  requireTerm(term);
}

const rootBranchStart = server.indexOf("urlPath === '/' || urlPath === '/home'");
const appBranch = server.indexOf("if (isAppSubdomain) return 'patron';", Math.max(rootBranchStart, 0));
const publicBranch = server.indexOf("if (isLocalPublicHost) return 'public';", Math.max(rootBranchStart, 0));
if (rootBranchStart === -1 || appBranch === -1 || publicBranch === -1 || appBranch > publicBranch) {
  failures.push('Root/home host branch must resolve app.sway.tips to patron and local dev hosts to public.');
}

const localPublicHostBranchPattern = /const isLocalPublicHost = host === '' \|\| host === 'localhost' \|\| host === '127\.0\.0\.1';/;
if (!localPublicHostBranchPattern.test(server)) {
  failures.push('Public shell branch must be local-dev only.');
}

const rootHomeBranchPattern = /if \(urlPath === '\/' \|\| urlPath === '\/home'\) \{\s*if \(isAppSubdomain\) return 'patron';\s*if \(isLocalPublicHost\) return 'public';\s*return 'patron';\s*\}/;
if (!rootHomeBranchPattern.test(server)) {
  failures.push('Root/home branch must keep app.sway.tips on patron shell, local dev on public shell, and unknown hosts on patron.');
}

for (const host of ['sway.tips', 'www.sway.tips']) {
  requireTerm(host, `${host} share host detection`);
}

if (/host === 'sway\.tips'[\s\S]{0,220}return 'public'/.test(server) || /host === 'www\.sway\.tips'[\s\S]{0,220}return 'public'/.test(server)) {
  failures.push('Apex/www share hosts must not resolve to the public landing shell.');
}

for (const routePath of ['/', '/home']) {
  requireTerm(`urlPath === '${routePath}'`, `root/home route branch: ${routePath}`);
}
requireTerm("host === CANONICAL_APP_HOST", 'app.sway.tips host detection');
requireTerm("return 'patron'", 'app.sway.tips root/home patron shell');
requireTerm("return 'public'", 'local dev root/home public shell');

for (const routeToShell of [
  { route: '/g/', shell: "return 'patron'" },
  { route: '/p/', shell: "return 'patron'" },
  { route: '/talent', shell: "return 'talent'" },
  { route: '/overlay', shell: "return 'overlay'" },
  { route: '/admin', shell: "return 'admin'" }
]) {
  const routeIndex = server.indexOf(routeToShell.route);
  const shellIndex = server.indexOf(routeToShell.shell, Math.max(routeIndex, 0));
  if (routeIndex === -1 || shellIndex === -1 || shellIndex - routeIndex > 240) {
    failures.push(`Expected ${routeToShell.route} to map to ${routeToShell.shell}.`);
  }
}

for (const term of [
  "if (urlPath.startsWith('/talent')) return 'talent';",
  "if (urlPath.startsWith('/overlay')) return 'overlay';",
  "if (urlPath.startsWith('/admin')) return 'admin';",
  "if (urlPath === '/dev/sandbox' || urlPath.startsWith('/dev-sandbox')) return 'dev-sandbox';",
  "if (urlPath.startsWith('/g/') || urlPath.startsWith('/p/')) return 'patron';",
  "return !(isProduction && shell === 'dev-sandbox');",
  "app.get('/shells/dev-sandbox.html'",
  "app.get(/^\\/assets\\/dev-sandbox-.*\\.js$/",
  "res.status(404).send('Not found')"
]) {
  requireTerm(term);
}

if (failures.length) {
  console.error('Host subdomain routing contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Host subdomain routing contract passed.');
