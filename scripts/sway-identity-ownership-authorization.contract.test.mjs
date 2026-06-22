import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const accessPath = join(root, 'src/server/access-control.ts');
const businessStorePath = join(root, 'src/server/business-store.ts');
const serverPath = join(root, 'server.ts');

if (!existsSync(accessPath)) failures.push('Missing access control module.');
if (!existsSync(businessStorePath)) failures.push('Missing business store module.');

const accessSource = existsSync(accessPath) ? readFileSync(accessPath, 'utf8') : '';
const businessStoreSource = existsSync(businessStorePath) ? readFileSync(businessStorePath, 'utf8') : '';
const serverSource = readFileSync(serverPath, 'utf8');

for (const term of [
  'hydrateRequestActor',
  'resolveServerActor',
  'requireAdminOrSupportAccess',
  'requireGigMutationAccess',
  'requireTalentAccess',
  'ownerActorUserId',
  'lastMutationActorUserId',
  'actorUserId',
  'patronDeviceIdHash'
]) {
  if (!accessSource.includes(term) && !serverSource.includes(term) && !businessStoreSource.includes(term)) {
    failures.push(`Identity/authorization slice missing required term: ${term}`);
  }
}

for (const term of [
  'accessControl.requireGigMutationAccess',
  'resolveProtectedMutationActor',
  'persistStateWithAudit',
  'writeAuditEvent',
  'businessDb.transaction',
  '/api/session/start',
  '/api/talent/session/bootstrap',
  '/api/request/triage',
  '/api/request/fulfill',
  '/api/moderation/block',
  '/api/moderation/hide',
  '/api/moderation/remove'
]) {
  if (!serverSource.includes(term)) {
    failures.push(`Server route authorization wiring missing term: ${term}`);
  }
}

for (const term of [
  'ownerActorUserId',
  'lastMutationActorUserId',
  'patronUserId',
  'actorUserId'
]) {
  if (!businessStoreSource.includes(term)) {
    failures.push(`Business store missing durable actor attribution field handling: ${term}`);
  }
}

if (!/role === 'admin' \|\| role === 'support'/.test(accessSource)) {
  failures.push('Access control must preserve admin/support override for protected gig mutations.');
}

if (!/eq\(performers\.ownerUserId, actorId\)/.test(accessSource)) {
  failures.push('Talent access must authorize performer owners by ownerUserId for bootstrap session start.');
}

for (const eventType of [
  'session.start',
  'request.triage.',
  'request.fulfill',
  'moderation.block',
  'moderation.hide',
  'moderation.remove'
]) {
  if (!serverSource.includes(eventType)) {
    failures.push(`Server audit wiring missing event_type: ${eventType}`);
  }
}

if (/x-sway-test-role/i.test(serverSource) || /x-sway-test-role/i.test(accessSource)) {
  failures.push('Authorization must not trust client-provided test role headers directly.');
}

if (!/resolveServerActor\(req\)\.actorId/.test(serverSource)) {
  failures.push('Server mutations must use centralized server-side actor identity resolution.');
}

if (failures.length) {
  console.error('Identity/ownership/authorization contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Identity/ownership/authorization contract passed.');
