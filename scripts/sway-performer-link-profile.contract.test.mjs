import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');
const files = [
  'src/db/schema.ts',
  'drizzle/0016_performer_link_profiles.sql',
  'src/server/public-profile.ts',
  'src/server/partner-entitlement.ts',
  'src/components/PerformerPublicProfilePage.tsx',
  'src/components/PerformerPublicProfileEditor.tsx',
  'src/shells/PatronApp.tsx',
  'src/shells/shared.tsx',
  'src/shells/AdminAccountsPage.tsx',
  'docs/SWAY_PARTNER_TERMS_V1.md',
  'scripts/sway-performer-link-profile.behavior.test.ts'
];

for (const file of files) {
  if (!existsSync(join(root, file))) failures.push(`Missing performer profile foundation file: ${file}`);
}

const schema = read('src/db/schema.ts');
const migration = read('drizzle/0016_performer_link_profiles.sql');
const server = read('server.ts');
const normalizers = read('src/server/public-profile.ts');
const partnerTerms = read('src/server/partner-entitlement.ts');
const publicPage = read('src/components/PerformerPublicProfilePage.tsx');
const editor = read('src/components/PerformerPublicProfileEditor.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
const sharedShell = read('src/shells/shared.tsx');
const admin = read('src/shells/AdminAccountsPage.tsx');
const termsDoc = read('docs/SWAY_PARTNER_TERMS_V1.md');
const packageJson = read('package.json');

for (const term of [
  "export const performerProfileLinks = pgTable('performer_profile_links'",
  "export const performerPartnerEntitlements = pgTable('performer_partner_entitlements'",
  "specialties: jsonb('specialties')",
  "partnerKind: text('partner_kind').notNull().default('brand')",
  "termsSnapshot: jsonb('terms_snapshot')"
]) {
  if (!schema.includes(term)) failures.push(`Profile schema missing durable term: ${term}`);
}

for (const term of [
  '"booking_email" text',
  '"booking_phone" text',
  '"facebook_url" text',
  '"specialties" jsonb',
  '"performer_profile_links"',
  '"performer_partner_entitlements"',
  '"partner_kind" text NOT NULL DEFAULT \'brand\'',
  '"terms_snapshot" jsonb NOT NULL'
]) {
  if (!migration.includes(term)) failures.push(`Profile migration missing durable term: ${term}`);
}

for (const term of [
  "app.get('/api/talent/profile/public'",
  "app.post('/api/talent/profile/public'",
  "app.get('/api/public/performer/:handle'",
  'businessDb.transaction(async (tx)',
  'await tx.delete(performerProfileLinks)',
  'eq(performerProfileLinks.isActive, true)',
  'eq(performers.isActive, true)',
  "notInArray(performers.onboardingStatus, ['suspended'])",
  "eventType: 'performer_public_profile.update'",
  "eventType: 'admin_account.partner_grant'",
  'buildSwayPartnerTermsSnapshot()',
  "partnerKind: 'brand'"
]) {
  if (!server.includes(term)) failures.push(`Profile server path missing term: ${term}`);
}

if (server.includes('delete(performerPartnerEntitlements)')) {
  failures.push('Brand Partner grants must remain append-only from product routes.');
}

for (const term of [
  'PUBLIC_PROFILE_MAX_LINKS = 12',
  "parsed.protocol !== 'https:' && parsed.protocol !== 'http:'",
  'parsed.username || parsed.password',
  'normalizePublicProfileSpecialties'
]) {
  if (!normalizers.includes(term)) failures.push(`Profile normalizer missing safety term: ${term}`);
}

for (const term of [
  'PerformerPublicProfilePage',
  'Sway Brand Partner',
  'profile.specialties',
  'profile.links.map',
  'profile.booking.email',
  'Create your own free Sway page'
]) {
  if (!publicPage.includes(term)) failures.push(`Standalone public page missing term: ${term}`);
}

for (const term of [
  'PerformerPublicProfileEditor',
  'A free website that works between events',
  'A live room and payment setup are optional.',
  'Media is optional.',
  'min-h-12',
  'moveLink',
  'specialties'
]) {
  if (!editor.includes(term)) failures.push(`Profile editor missing term: ${term}`);
}

for (const term of [
  'return <PerformerPublicProfilePage performerHandle={route.performerHandle} />',
  "if (route.name === 'performer') return;",
  'PatronNoSessionRecovery'
]) {
  if (!patronApp.includes(term)) failures.push(`Patron route separation missing term: ${term}`);
}

if (patronApp.includes('performerHandle={route.name')) {
  failures.push('Standalone performer pages must not be rendered inside no-session scan/login recovery.');
}

if (!sharedShell.includes('if (!statePath || isDemoModeEnabled()) return;')) {
  failures.push('A standalone profile route must not leave the live-room polling interval running without a state path.');
}

for (const term of [
  'Grant Sway Brand Partner status',
  'append-only grandfather grant',
  'disabled={Boolean(account.partnerTermsVersion)}',
  'partnerNote'
]) {
  if (!admin.includes(term)) failures.push(`Admin Brand Partner control missing term: ${term}`);
}

for (const [term, source, label] of [
  ['publicProfileHostingFeeCents: 0', partnerTerms, 'partner terms code'],
  ['performerSubscriptionFeeCents: 0', partnerTerms, 'partner terms code'],
  ['paidInteractionPlatformFeeCents: 100', partnerTerms, 'partner terms code'],
  ['Future billing or subscription code must read the entitlement', termsDoc, 'partner terms document'],
  ['does not bypass identity verification, KYC, payout eligibility', termsDoc, 'partner terms document']
]) {
  if (!source.includes(term)) failures.push(`${label} missing term: ${term}`);
}

for (const source of [publicPage, editor]) {
  for (const forbidden of ['Stripe', 'payoutsEnabled', 'chargesEnabled']) {
    if (source.includes(forbidden)) failures.push(`Free profile surface must not depend on ${forbidden}.`);
  }
}

if (!packageJson.includes('node scripts/sway-performer-link-profile.contract.test.mjs')) {
  failures.push('package.json must register the performer link profile contract in test:contracts.');
}

if (!failures.length) {
  const behavior = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/sway-performer-link-profile.behavior.test.ts'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (behavior.status !== 0) failures.push(`Performer profile behavior test failed:\n${behavior.stdout || ''}${behavior.stderr || ''}`);
}

if (failures.length) {
  console.error('Performer link profile contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Performer link profile contract passed.');
