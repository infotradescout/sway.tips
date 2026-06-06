import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const server = readFileSync(join(root, 'server.ts'), 'utf8');

if (!/!isProduction\s*\|\|\s*businessStore\.hasDurableStore/.test(server)) {
  failures.push('requirePersistentBusinessStore must allow production writes only with durable business store configured.');
}

const persistenceProtectedRoutes = [
  '/api/session/start',
  '/api/session/feature',
  '/api/session/end',
  '/api/session/closeout',
  '/api/session/window/toggle',
  '/api/session/window/preset/activate',
  '/api/session/window/preset/create',
  '/api/session/window/preset/delete',
  '/api/request/create',
  '/api/request/boost',
  '/api/request/triage',
  '/api/request/fulfill',
  '/api/moderation/hide',
  '/api/moderation/remove'
];

for (const route of persistenceProtectedRoutes) {
  const routeIndex = server.indexOf(route);
  if (routeIndex === -1) {
    failures.push(`Missing required route: ${route}`);
    continue;
  }

  const routeBlock = server.slice(routeIndex, routeIndex + 7000);
  if (!routeBlock.includes('requirePersistentBusinessStore(res)')) {
    failures.push(`Route ${route} must keep production persistence gate.`);
  }

  if (!routeBlock.includes('await refreshBusinessState()')) {
    failures.push(`Route ${route} must refresh state through business-store boundary.`);
  }

  if (!routeBlock.includes('await persistBusinessState()') && !route.includes('/api/moderation/report') && !route.includes('/api/moderation/block')) {
    failures.push(`Route ${route} must persist durable business-state changes.`);
  }
}

if (/state\s*=\s*\{\s*session:/.test(server) && !server.includes('await refreshBusinessState();')) {
  failures.push('Server appears to initialize in-memory state without durable hydration path.');
}

if (failures.length) {
  console.error('Business store production persistence contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Business store production persistence contract passed.');
