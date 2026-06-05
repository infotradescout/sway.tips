import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const accessFile = 'src/server/access-control.ts';
if (!existsSync(join(root, accessFile))) failures.push(`Missing persisted access guard module: ${accessFile}`);

const access = existsSync(join(root, accessFile)) ? readFileSync(join(root, accessFile), 'utf8') : '';
const server = readFileSync(join(root, 'server.ts'), 'utf8');

for (const term of [
  'createAccessControl',
  'routeFamilyGuard',
  'resolveActor',
  'requireTalentAccess',
  'requireAdminAccess',
  'allowPublicPatronAccess',
  'allowPublicOverlayAccess',
  'requireDevSandboxAccess'
]) {
  if (!access.includes(term)) failures.push(`Access guard missing required function: ${term}`);
}

for (const term of [
  "from(users)",
  "from(performerMemberships)",
  "from(gigAccessGrants)",
  "eq(users.role, 'admin')",
  'eq(performerMemberships.userId, actorId)',
  'eq(gigAccessGrants.userId, actorId)'
]) {
  if (!access.includes(term)) failures.push(`Access guard must query persisted schema term: ${term}`);
}

for (const term of [
  "shell === 'talent'",
  'accessControl.requireTalentAccess',
  "shell === 'admin'",
  'accessControl.requireAdminAccess',
  "shell === 'overlay'",
  'accessControl.allowPublicOverlayAccess',
  "shell === 'dev-sandbox'",
  'accessControl.requireDevSandboxAccess',
  'accessControl.allowPublicPatronAccess'
]) {
  if (!access.includes(term)) failures.push(`Route-family guard missing dispatch term: ${term}`);
}

for (const term of [
  "databaseUrl: process.env.DATABASE_URL",
  'routeFamilyGuard(accessControl)',
  "req.path.startsWith('/api')",
  "req.path.startsWith('/assets')",
  "req.path.startsWith('/shells')"
]) {
  if (!server.includes(term)) failures.push(`Server missing persisted middleware wiring term: ${term}`);
}

if (!/if\s*\(isProduction\)[\s\S]{0,160}Dev sandbox is unavailable in production/.test(access)) {
  failures.push('Dev sandbox guard must explicitly block production.');
}

if (!/async\s+allowPublicPatronAccess[\s\S]{0,160}allowed:\s*true/.test(access)) {
  failures.push('Patron QR route guard must remain explicitly public.');
}

if (!/async\s+allowPublicOverlayAccess[\s\S]{0,160}allowed:\s*true/.test(access)) {
  failures.push('Overlay route guard must be explicitly public or token-gated by rule.');
}

const forbiddenAccessPatterns = [
  /state\./,
  /BackendState/,
  /requests\./,
  /performers\./,
  /role\s*===\s*req\.headers/i,
  /x-sway-role/i,
  /isAdmin\s*=\s*true/i,
  /mock/i,
  /fake/i
];

for (const pattern of forbiddenAccessPatterns) {
  if (pattern.test(access)) failures.push(`Access guard contains forbidden mock/client-only pattern: ${pattern}`);
}

if (!/if \(await hasTalentRole\(db, actor\.actorId\)\) return \{ allowed: true, actor \}/.test(access)) {
  failures.push('Talent guard must allow only after persisted membership/access lookup.');
}

if (!/if \(await hasAdminRole\(db, actor\.actorId\)\) return \{ allowed: true, actor \}/.test(access)) {
  failures.push('Admin guard must allow only after persisted admin lookup.');
}

if (failures.length) {
  console.error('Persisted middleware guard contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Persisted middleware guard contract passed.');
