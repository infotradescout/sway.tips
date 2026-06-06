import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const storeFile = join(root, 'src/server/business-store.ts');
const serverFile = join(root, 'server.ts');

if (!existsSync(storeFile)) {
  failures.push('Missing business store boundary module: src/server/business-store.ts');
}

const storeSource = existsSync(storeFile) ? readFileSync(storeFile, 'utf8') : '';
const serverSource = readFileSync(serverFile, 'utf8');

for (const term of [
  'createBusinessStore',
  'hydrateState',
  'persistState',
  'hasDurableStore',
  'gigSessions',
  'requests',
  'requestBoosts',
  'runtimeSessionState',
  'runtimeRequestState',
  'runtimeBoostState'
]) {
  if (!storeSource.includes(term)) {
    failures.push(`Business store boundary missing term: ${term}`);
  }
}

for (const term of [
  'createBusinessStore(process.env.DATABASE_URL, createInactiveSession)',
  'refreshBusinessState',
  'persistBusinessState',
  'await refreshBusinessState()',
  'await persistBusinessState()',
  '/api/state',
  '/api/session/start',
  '/api/session/end',
  '/api/session/closeout',
  '/api/request/create',
  '/api/request/boost',
  '/api/request/triage',
  '/api/request/fulfill',
  '/api/moderation/hide',
  '/api/moderation/remove'
]) {
  if (!serverSource.includes(term)) {
    failures.push(`Server missing business-store wiring term: ${term}`);
  }
}

if (failures.length) {
  console.error('Business store boundary contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Business store boundary contract passed.');
