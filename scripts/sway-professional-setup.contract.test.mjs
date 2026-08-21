import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const server = read('server.ts');
const service = read('src/server/talent-professional-setup-service.ts');
const catalog = read('src/talent-capability-catalog.ts');
const component = read('src/components/PerformerProfessionalSetup.tsx');
const dashboard = read('src/components/TalentDashboard.tsx');
const editor = read('src/components/PerformerPublicProfileEditor.tsx');
const migration = read('drizzle/0038_professional_setup_receipts.sql');
const model = read('docs/SWAY_TALENT_CAPABILITY_MODEL.md');
const packageJson = JSON.parse(read('package.json'));
const failures = [];

function requireText(source, text, label) {
  if (!source.includes(text)) failures.push(`${label}: missing ${text}`);
}

function rejectText(source, text, label) {
  if (source.includes(text)) failures.push(`${label}: prohibited ${text}`);
}

for (const term of [
  "app.get('/api/talent/professional-setup'",
  "app.post('/api/talent/professional-setup'",
  'accessControl.requireTalentAccess(req)',
  'talentProfessionalSetupService.save(talentAccess.actor.actorId, req.body)',
  'TalentProfessionalSetupError'
]) requireText(server, term, 'Owner professional setup routes');

const routeStart = server.indexOf("app.post('/api/talent/professional-setup'");
const routeEnd = server.indexOf("app.get('/api/talent/profile/public'", routeStart);
const mutationRoute = server.slice(routeStart, routeEnd);
rejectText(mutationRoute, 'req.body?.performerId', 'Professional setup owner scope');
rejectText(mutationRoute, 'performerCapabilityGrantEvents', 'Owner route grant separation');
rejectText(mutationRoute, 'performerAuthorityEvents', 'Owner route authority separation');

for (const term of [
  ".for('update')",
  "eventType: 'professional_setup.update'",
  "publicationChanged: false",
  "capabilityGrantChanged: false",
  "authorityChanged: false",
  "eventType: 'selected' | 'withdrawn'",
  'mutation_reuse_conflict',
  'ambiguous_owner_subject',
  '.limit(2)',
  'idempotencyKeyHash: eventHash',
  'performerIdentityEvents',
  'performerIntentEvents',
  'performerCapabilityGrantEvents',
  "decision === 'granted'",
  "grantCurrent: decision === 'granted'",
  'naturallyExpired'
]) requireText(service, term, 'Persisted professional setup service');
rejectText(service, "available: decision === 'granted'", 'Capability grant naming must not imply executable permission');
rejectText(service, '.insert(performerCapabilityGrantEvents)', 'Owner setup must not grant capabilities');
rejectText(service, '.insert(performerAuthorityEvents)', 'Owner setup must not grant authority');
rejectText(service, '.update(performers)', 'Professional setup must not publish or mutate performer authority');

for (const term of [
  "{ id: 'comedian'",
  "{ id: 'singer'",
  "{ id: 'songwriter'",
  "{ id: 'bartender'",
  "{ id: 'service_professional'",
  "{ id: 'native_ticket_sales'",
  'Does not enable ticket sales.',
  'Working storage remains bounded; validated release count is not capped.'
]) requireText(catalog, term, 'Broad truthful talent catalog');

for (const term of [
  'Tell Sway what you do and what you want to use',
  'Capability requests ask for tools; they never grant money, ticketing, venue, catalog, payout, or administrative authority.',
  'Saving a request is not approval',
  'A recorded server grant is not final action permission; exact subject authority and action-specific gates still apply.',
  'Saving this setup never publishes your page.',
  "fetch('/api/talent/professional-setup'",
  'crypto.randomUUID()',
  'clientMutationId',
  'Server grant recorded'
]) requireText(component, term, 'Professional setup UX');
requireText(dashboard, '<PerformerProfessionalSetup previewMode={previewMode} />', 'Professional setup placement');
requireText(editor, 'Identity is saved in the append-only Professional setup above.', 'Profile identity separation');
rejectText(editor, 'primaryRole: form.primaryRole || null', 'Legacy profile identity mutation');
rejectText(editor, 'What kind of performer are you?', 'Duplicate profile identity control');

for (const term of [
  'Professional setup mutation receipts are append-only.',
  'BEFORE UPDATE OR DELETE ON "audit_events"',
  "NEW.event_type = 'professional_setup.update'"
]) requireText(migration, term, 'Durable setup mutation receipt');

requireText(server, 'Choose and save your primary professional identity before editing the public page.', 'Profile save identity gate');
requireText(server, 'professionalIdentity: professionalSetup.primaryIdentity', 'Canonical profile identity response');
if (!/primaryRole,\r?\n\s+professionalIdentity: professionalSetup\.primaryIdentity/.test(server)) {
  failures.push('Canonical profile identity response: save response must use primaryRole directly beside professionalIdentity');
}
requireText(model, 'A capability grant alone is never sufficient for a consequential action.', 'Consequential action boundary');

if (packageJson.scripts?.['test:integration:professional-setup'] !== 'node --import tsx scripts/sway-professional-setup.integration.test.ts') {
  failures.push('package scripts: professional setup integration command is missing');
}
if (!(packageJson.scripts?.['test:contracts'] ?? '').includes('node scripts/sway-professional-setup.contract.test.mjs')) {
  failures.push('package scripts: professional setup contract is not directly registered');
}

if (failures.length) {
  console.error('Sway professional setup contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway professional setup contract passed.');
