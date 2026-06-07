import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const failures = [];

for (const term of [
  'normalizeHost',
  "host === 'app.sway.tips'",
  "host === 'sway.tips'",
  "host === 'www.sway.tips'",
  "urlPath === '/' || urlPath === '/home'",
  "if (isAppSubdomain) return 'patron';",
  "if (isPublicHost) return 'public';"
]) {
  if (!server.includes(term)) {
    failures.push(`Host-aware routing missing term: ${term}`);
  }
}

const rootBranchStart = server.indexOf("urlPath === '/' || urlPath === '/home'");
const appBranch = server.indexOf("if (isAppSubdomain) return 'patron';", Math.max(rootBranchStart, 0));
const publicBranch = server.indexOf("if (isPublicHost) return 'public';", Math.max(rootBranchStart, 0));
if (rootBranchStart === -1 || appBranch === -1 || publicBranch === -1 || appBranch > publicBranch) {
  failures.push('Root/home host branch must resolve app.sway.tips to patron and apex hosts to public.');
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

if (failures.length) {
  console.error('Host subdomain routing contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Host subdomain routing contract passed.');
