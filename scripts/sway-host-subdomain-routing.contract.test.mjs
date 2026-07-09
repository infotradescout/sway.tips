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
  "if (urlPath === '/') return 'public';",
  "if (urlPath === '/home') return 'patron';"
]) {
  requireTerm(term);
}

const rootBranch = server.indexOf("if (urlPath === '/') return 'public';");
const homeBranch = server.indexOf("if (urlPath === '/home') return 'patron';");
if (rootBranch === -1 || homeBranch === -1 || rootBranch > homeBranch) {
  failures.push('Root route must resolve to the public landing before /home resolves to the patron app.');
}

const legacyHostSplitPattern = /if \(isAppSubdomain\) return 'patron';|if \(isLocalPublicHost\) return 'public';|const isLocalPublicHost =/;
if (legacyHostSplitPattern.test(server)) {
  failures.push('Root public landing must not split app/local hosts into different shells.');
}

const rootHomeBranchPattern = /if \(urlPath === '\/'\) return 'public';\s*if \(urlPath === '\/home'\) return 'patron';/;
if (!rootHomeBranchPattern.test(server)) {
  failures.push('Root/home branch must keep / on the public landing and /home on the patron app.');
}

for (const host of ['sway.tips', 'www.sway.tips']) {
  requireTerm(host, `${host} share host detection`);
}

for (const routePath of ['/', '/home']) {
  requireTerm(`urlPath === '${routePath}'`, `root/home route branch: ${routePath}`);
}
requireTerm("return 'public'", 'app/local/root public landing shell');
requireTerm("return 'patron'", '/home patron shell');

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
