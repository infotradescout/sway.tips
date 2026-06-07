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
  "host === 'app.sway.tips'",
  "host === 'sway.tips'",
  "host === 'www.sway.tips'",
  "urlPath === '/' || urlPath === '/home'",
  "if (isAppSubdomain) return 'patron';",
  "if (isPublicHost) return 'public';"
]) {
  requireTerm(term);
}

const rootBranchStart = server.indexOf("urlPath === '/' || urlPath === '/home'");
const appBranch = server.indexOf("if (isAppSubdomain) return 'patron';", Math.max(rootBranchStart, 0));
const publicBranch = server.indexOf("if (isPublicHost) return 'public';", Math.max(rootBranchStart, 0));
if (rootBranchStart === -1 || appBranch === -1 || publicBranch === -1 || appBranch > publicBranch) {
  failures.push('Root/home host branch must resolve app.sway.tips to patron and apex hosts to public.');
}

const publicHostBranchPattern = /const isPublicHost = host === '' \|\| host === 'sway\.tips' \|\| host === 'www\.sway\.tips' \|\| host === 'localhost' \|\| host === '127\.0\.0\.1';/;
if (!publicHostBranchPattern.test(server)) {
  failures.push('Public host branch must explicitly include sway.tips and www.sway.tips.');
}

const rootHomeBranchPattern = /if \(urlPath === '\/' \|\| urlPath === '\/home'\) \{\s*if \(isAppSubdomain\) return 'patron';\s*if \(isPublicHost\) return 'public';\s*return 'patron';\s*\}/;
if (!rootHomeBranchPattern.test(server)) {
  failures.push('Root/home branch must keep app.sway.tips on patron shell, public hosts on public shell, and unknown hosts on patron.');
}

for (const requiredCase of [
  { host: 'sway.tips', paths: ['/', '/home'], shell: 'public' },
  { host: 'www.sway.tips', paths: ['/', '/home'], shell: 'public' },
  { host: 'app.sway.tips', paths: ['/', '/home'], shell: 'patron' }
]) {
  requireTerm(`host === '${requiredCase.host}'`, `${requiredCase.host} host detection`);
  for (const routePath of requiredCase.paths) {
    requireTerm(`urlPath === '${routePath}'`, `${requiredCase.host} ${routePath} route branch`);
  }
  requireTerm(`return '${requiredCase.shell}'`, `${requiredCase.host} root/home ${requiredCase.shell} shell`);
}

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
