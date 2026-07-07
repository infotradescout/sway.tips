import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const adminAccountsPage = readFileSync(join(root, 'src/shells/AdminAccountsPage.tsx'), 'utf8');
const failures = [];

const routeStart = server.indexOf("app.delete('/api/admin/accounts/:userId'");
const routeEnd = routeStart === -1 ? -1 : server.indexOf('const shellTelemetryAllowedEvents', routeStart);
const routeSource = routeStart === -1 || routeEnd === -1 ? '' : server.slice(routeStart, routeEnd);

if (!routeSource) {
  failures.push('Admin account deletion route is missing.');
}

for (const term of [
  'accessControl.requireAdminAccess(req)',
  "res.status(503).json({ error: 'Admin accounts require durable persistence.' })",
  'UUID_PATTERN.test(req.params.userId)',
  'req.params.userId === adminAccess.actor.actorId',
  "email: null",
  "displayName: 'Deleted account'",
  "passwordHash: null",
  "emailVerifiedAt: null",
  'isActive: false',
  "onboardingStatus: 'suspended'",
  'performerSessionStore.revokeActiveSessionsForActorUser',
  "eventType: 'admin_account.delete'",
  'targetEmail: existingAccount.email',
  'targetHandle: existingAccount.handle'
]) {
  if (!routeSource.includes(term)) failures.push(`Admin account deletion route missing invariant: ${term}`);
}

for (const forbidden of [
  /delete\(users\)/,
  /delete\(performers\)/,
  /delete\(auditEvents\)/,
  /delete\(payments\)/,
  /delete\(paymentEvents\)/,
  /delete\(requests\)/,
  /delete\(gigSessions\)/
]) {
  if (forbidden.test(routeSource)) failures.push(`Admin account deletion route must not hard-delete retained records: ${forbidden}`);
}

for (const term of [
  'const deleteConfirmTarget = account.email ?? account.handle ?? account.id',
  'deleteConfirmText !== deleteConfirmTarget',
  "method: 'DELETE'",
  'Delete account',
  'This scrubs email, name, and password and deactivates the profile',
  'it does not erase payment, gig, or audit history'
]) {
  if (!adminAccountsPage.includes(term)) failures.push(`Admin account deletion UI missing safeguard/copy: ${term}`);
}

if (failures.length) {
  console.error('Admin account deletion contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Admin account deletion contract passed.');
