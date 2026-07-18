import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label} missing term: ${term}`);
}

function requireExcludes(source, term, label) {
  if (source.includes(term)) failures.push(`${label} must exclude term: ${term}`);
}

function sliceBetween(source, start, end, label) {
  const startIndex = source.indexOf(start);
  const endIndex = startIndex === -1 ? -1 : source.indexOf(end, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    failures.push(`Unable to locate ${label}.`);
    return '';
  }
  return source.slice(startIndex, endIndex);
}

const requiredFiles = [
  'src/db/schema.ts',
  'drizzle/0016_performer_link_profiles.sql',
  'drizzle/0017_unclaimed_performer_profile_previews.sql',
  'drizzle/0018_public_profile_featured_media.sql',
  'src/server/public-profile.ts',
  'src/server/partner-entitlement.ts',
  'src/server/partner-entitlement-store.ts',
  'src/server/payment-service.ts',
  'src/server/performer-login.ts',
  'src/components/PerformerPublicProfilePage.tsx',
  'src/components/PerformerPublicProfileEditor.tsx',
  'src/components/TalentInviteAcceptCard.tsx',
  'src/shells/PatronApp.tsx',
  'src/shells/AdminAccountsPage.tsx',
  'docs/SWAY_PARTNER_TERMS_V1.md',
  'scripts/sway-performer-link-profile.behavior.test.ts',
  'scripts/sway-performer-link-profile-migration.integration.test.mjs',
  'scripts/sway-seed-performer-previews.mjs'
];

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`Missing performer profile release-gate file: ${file}`);
}

const schema = read('src/db/schema.ts');
const migration = read('drizzle/0016_performer_link_profiles.sql');
const previewMigration = read('drizzle/0017_unclaimed_performer_profile_previews.sql');
const mediaMigration = read('drizzle/0018_public_profile_featured_media.sql');
const server = read('server.ts');
const normalizers = read('src/server/public-profile.ts');
const partnerTerms = read('src/server/partner-entitlement.ts');
const partnerStore = read('src/server/partner-entitlement-store.ts');
const paymentService = read('src/server/payment-service.ts');
const performerLogin = read('src/server/performer-login.ts');
const publicPage = read('src/components/PerformerPublicProfilePage.tsx');
const editor = read('src/components/PerformerPublicProfileEditor.tsx');
const inviteCard = read('src/components/TalentInviteAcceptCard.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
const sharedShell = read('src/shells/shared.tsx');
const admin = read('src/shells/AdminAccountsPage.tsx');
const accessControl = read('src/server/access-control.ts');
const appRoutes = read('src/App.tsx');
const talentApp = read('src/shells/TalentApp.tsx');
const termsDoc = read('docs/SWAY_PARTNER_TERMS_V1.md');
const migrationProof = read('scripts/sway-performer-link-profile-migration.integration.test.mjs');
const packageJson = read('package.json');
const previewSeed = read('scripts/sway-seed-performer-previews.mjs');

for (const term of [
  "export const performerProfileLinks = pgTable('performer_profile_links'",
  "export const performerPartnerEntitlements = pgTable('performer_partner_entitlements'",
  "export const performerPartnerEntitlementStatusEvents = pgTable('performer_partner_entitlement_status_events'",
  "export const performerPartnerTermsAcceptances = pgTable('performer_partner_terms_acceptances'",
  "termsHash: text('terms_hash').notNull()",
  "termsText: text('terms_text').notNull()",
  "statusAllowed: check('performer_partner_entitlement_status_events_status_allowed'",
  "handleNotReserved: check('performers_handle_not_reserved'"
]) requireIncludes(schema, term, 'Profile schema');

requireIncludes(schema, "export const performerProfilePreviews = pgTable('performer_profile_previews'", 'Unclaimed preview schema');
requireIncludes(schema, "handleLowerIdx: uniqueIndex('performer_profile_previews_handle_lower_idx')", 'Unclaimed preview schema');
requireIncludes(previewMigration, 'CREATE TABLE IF NOT EXISTS "performer_profile_previews"', 'Unclaimed preview migration');
requireIncludes(previewMigration, 'lower("handle")', 'Unclaimed preview migration');
requireExcludes(previewMigration, 'owner_user_id', 'Unclaimed preview migration');
for (const term of ['featured_media', 'performer_public_profiles', 'performer_profile_previews']) {
  requireIncludes(mediaMigration, term, 'Featured media migration');
}
for (const term of [
  'db:seed:performer-previews',
  'sway-seed-performer-previews.mjs'
]) requireIncludes(packageJson, term, 'Unclaimed preview seed command');
for (const term of [
  "handle: 'dj3x'",
  "handle: 'coreymack'",
  "displayName: 'Broughton Frank'",
  "avatarUrl: '/assets/frank-broughton-avatar.png'",
  "DJ Three X · Crowd-first DJ · Sound design · Event energy",
  'Performing since 1992',
  'kinanddignity.com/blog/taking-a-spin-with-dj-three-x',
  "displayName: 'Corey Mack'",
  "title: 'Kita P x Corey Mack in New Orleans'",
  'www.youtube.com/watch?v=--7MMybc6Vw',
  'img1.wsimg.com/isteam/ip/',
  'no email, phone, password, owner id, invitation token, or terms acceptance'
]) requireIncludes(previewSeed, term, 'Curated preview seed');
if (!existsSync(join(root, 'public/assets/frank-broughton-avatar.png'))) {
  failures.push('Frank curated avatar asset is missing.');
}
for (const forbidden of [
  'owner_user_id',
  'password_hash',
  'invitation_token',
  'terms_hash',
  'djthreeex.com',
  "label: 'DJ Three X website'"
]) {
  requireExcludes(previewSeed, forbidden, 'Curated preview seed');
}

for (const term of [
  '"booking_email" text',
  '"booking_phone" text',
  '"facebook_url" text',
  '"specialties" jsonb',
  '"performer_profile_links"',
  '"performer_partner_entitlements"',
  '"performer_partner_entitlement_status_events"',
  '"performer_partner_terms_acceptances"',
  '"performers_handle_not_reserved"',
  '"performer_partner_terms_acceptances_validate_owner_terms"',
  'performer."owner_user_id" = NEW."account_user_id"',
  'entitlement."terms_hash" = NEW."terms_hash"',
  'entitlement."terms_text" = NEW."terms_text"',
  'entitlement."terms_snapshot" = NEW."terms_snapshot"',
  '"sway_reject_immutable_partner_record_mutation"',
  'BEFORE UPDATE OR DELETE ON "performer_partner_entitlements"',
  'BEFORE UPDATE OR DELETE ON "performer_partner_entitlement_status_events"',
  'BEFORE UPDATE OR DELETE ON "performer_partner_terms_acceptances"'
]) requireIncludes(migration, term, 'Profile migration');
requireExcludes(migration, ') NOT VALID;', 'Profile migration reserved-handle constraint');

const inviteAcceptRoute = sliceBetween(
  server,
  "app.post('/api/talent/invite/accept'",
  "app.post('/api/talent/password-reset/accept'",
  'owner invitation acceptance route'
);
for (const term of [
  'termsAccepted === true',
  'validatePerformerPasswordStrength(password)',
  'expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_ACCOUNT_INVITE',
  'isNull(users.passwordHash)',
  'passwordHash,',
  'termsAcceptedAt: completedAt',
  'passwordSetByOwner: true',
  'issuedBy: account.userId'
]) requireIncludes(inviteAcceptRoute, term, 'Owner invitation acceptance route');

const passwordResetAcceptRoute = sliceBetween(
  server,
  "app.post('/api/talent/password-reset/accept'",
  "app.post('/api/talent/signup'",
  'owner password reset acceptance route'
);
for (const term of [
  'expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_PASSWORD_RESET',
  'validatePerformerPasswordStrength(password)',
  'revokeActiveSessionsForActorUser',
  'passwordSetByOwner: true'
]) requireIncludes(passwordResetAcceptRoute, term, 'Owner password reset acceptance route');

const adminOnboardRoute = sliceBetween(
  server,
  "app.post('/api/admin/accounts/onboard'",
  "app.post('/api/admin/accounts/:userId/invite'",
  'admin onboarding route'
);
for (const term of [
  'passwordHash: null',
  'termsAcceptedAt: null',
  'emailVerifiedAt: null',
  'isActive: false',
  'PERFORMER_LOGIN_CHALLENGE_TYPE_ACCOUNT_INVITE',
  'sendAccountInvitation',
  'passwordSetByAdmin: false',
  'termsAcceptedByAdmin: false'
]) requireIncludes(adminOnboardRoute, term, 'Admin onboarding route');
for (const forbidden of [
  'req.body?.password',
  'hashPerformerPassword(',
  'termsAcceptedAt: new Date(',
  'emailVerifiedAt: new Date('
]) requireExcludes(adminOnboardRoute, forbidden, 'Admin onboarding route');

const adminResetRoute = sliceBetween(
  server,
  "app.post('/api/admin/accounts/:userId/reset-password'",
  "app.delete('/api/admin/accounts/:userId'",
  'admin password reset route'
);
for (const term of [
  'PERFORMER_LOGIN_CHALLENGE_TYPE_PASSWORD_RESET',
  'sendOwnerPasswordReset',
  'passwordSetByAdmin: false'
]) requireIncludes(adminResetRoute, term, 'Admin password reset route');
for (const forbidden of ['req.body?.password', 'hashPerformerPassword(', '.update(users)']) {
  requireExcludes(adminResetRoute, forbidden, 'Admin password reset route');
}

const partnerAcceptRoute = sliceBetween(
  server,
  "app.post('/api/talent/partner/terms/accept'",
  "app.post('/api/talent/profile/public'",
  'Brand Partner owner acceptance route'
);
for (const term of [
  'requireTalentAccess(req)',
  'req.body?.accepted !== true',
  'loadOwnedPerformerByActorUserId(talentAccess.actor.actorId)',
  'requestedTermsVersion !== partnerState.termsVersion',
  'requestedTermsHash !== partnerState.termsHash',
  '.insert(performerPartnerTermsAcceptances)',
  'accountUserId: talentAccess.actor.actorId',
  'termsVersion: partnerState.termsVersion',
  'termsHash: partnerState.termsHash',
  'termsText: partnerState.termsText',
  'termsSnapshot: partnerState.termsSnapshot',
  'acceptedAt',
  'acceptedByAdmin: false'
]) requireIncludes(partnerAcceptRoute, term, 'Brand Partner owner acceptance route');

const acceptanceInsertCount = (server.match(/\.insert\(performerPartnerTermsAcceptances\)/g) || []).length;
if (acceptanceInsertCount !== 1) {
  failures.push(`Brand Partner acceptance must have exactly one owner-authenticated insert path; found ${acceptanceInsertCount}.`);
}
for (const forbidden of [
  '.delete(performerPartnerEntitlements)',
  '.update(performerPartnerEntitlements)',
  '.delete(performerPartnerEntitlementStatusEvents)',
  '.update(performerPartnerEntitlementStatusEvents)',
  '.delete(performerPartnerTermsAcceptances)',
  '.update(performerPartnerTermsAcceptances)'
]) requireExcludes(server, forbidden, 'Product routes');

for (const term of [
  "PERFORMER_LOGIN_CHALLENGE_TYPE_ACCOUNT_INVITE = 'account_invite'",
  "PERFORMER_LOGIN_CHALLENGE_TYPE_PASSWORD_RESET = 'password_reset'",
  'expectedChallengeType',
  'isNull(performerLoginChallenges.consumedAt)',
  'isNull(performerLoginChallenges.revokedAt)',
  'RESERVED_PERFORMER_HANDLES.has(trimmed.toLowerCase())'
]) requireIncludes(performerLogin, term, 'Performer login security');

for (const term of [
  "fetch(isReset ? '/api/talent/password-reset/accept' : '/api/talent/invite/accept'",
  'Choose your own password',
  'This secure link can be used once.',
  'administrators cannot choose your password',
  'termsAccepted'
]) requireIncludes(inviteCard, term, 'Owner invitation UI');
for (const sourceTerm of [
  [accessControl, "req.path === '/talent/invite'", 'Talent invite public shell entry'],
  [appRoutes, "'/talent/invite'", 'Route spine'],
  [talentApp, "pathname === '/talent/invite'", 'Talent shell invite route']
]) requireIncludes(...sourceTerm);

for (const term of [
  'loadPartnerEntitlementStateForPerformer',
  'eq(performerPartnerTermsAcceptances.accountUserId, grant.ownerUserId)',
  "currentStatus !== 'active'",
  'isEffective: isAccepted && !isSuspended',
  'Math.min(proposedPlatformFeeCents, platformFeeCapCents)'
]) requireIncludes(partnerStore, term, 'Partner entitlement resolver');

const resolverCallCount = (paymentService.match(/resolveSwayPlatformFeePolicyForGig\(/g) || []).length;
if (resolverCallCount !== 2) {
  failures.push(`Payment service must resolve the fee policy for create and confirm paths; found ${resolverCallCount} calls.`);
}
for (const term of [
  'platform_fee_policy_unavailable',
  'platformFee: feePolicy.platformFeeCents',
  'calculateSwayPaymentAmounts',
  "input.platformFeePayer === 'performer' ? 'performer' : 'patron'",
  "platformFeePayer === 'patron'",
  'amountTotalCents: input.amountSubtotalCents + platformFeeChargedToPatronCents',
  'applicationFeeAmountCents: feePolicy.platformFeeCents',
  'sway_platform_fee_cents: String(feePolicy.platformFeeCents)',
  'sway_platform_fee_payer: platformFeePayer',
  'sway_platform_fee_charged_to_patron_cents: String(platformFeeChargedToPatronCents)',
  'payment.platformFee === feePolicy.platformFeeCents'
]) requireIncludes(paymentService, term, 'Central payment fee enforcement');

const requestCreateRoute = sliceBetween(
  server,
  'app.post("/api/request/create"',
  'app.post("/api/request/boost"',
  'Request and Tip payment route'
);
for (const term of [
  "actionType: isStraightTip ? 'tip' : 'request'",
  "normalizedCurrency !== 'USD'",
  'Sway Request and Tip payments currently support USD only.',
  'currency: normalizedCurrency',
  'platformFeeCents: proposedPlatformFeeCents',
  'platformFeePayer,',
  'newItem.platformFee = authorization.platformFeeCents / 100'
]) requireIncludes(requestCreateRoute, term, 'Request and Tip payment route');

const boostRoute = sliceBetween(
  server,
  'app.post("/api/request/boost"',
  'app.post("/api/request/triage"',
  'Boost payment route'
);
for (const term of [
  "actionType: 'boost'",
  "normalizedCurrency !== 'USD'",
  'Sway Boost payments currently support USD only.',
  'currency: normalizedCurrency',
  'platformFeeCents: appliedBoostPlatformFeeCents',
  'platformFeePayer: boostPlatformFeePayer',
  'appliedBoostPlatformFeeCents = authorization.platformFeeCents',
  'request.platformFee += appliedBoostPlatformFeeCents / 100'
]) requireIncludes(boostRoute, term, 'Boost payment route');
requireExcludes(boostRoute, 'request.platformFee += 1.0', 'Boost payment route');

for (const [term, source, label] of [
  ['publicProfileHostingFeeCents: 0', partnerTerms, 'Partner terms code'],
  ['performerSubscriptionFeeCents: 0', partnerTerms, 'Partner terms code'],
  ['paidInteractionPlatformFeeCents: 100', partnerTerms, 'Partner terms code'],
  ["createHash('sha256')", partnerTerms, 'Partner terms code'],
  ['Request, Tip, or Boost', partnerTerms, 'Partner terms code'],
  ['payment processor fees', partnerTerms, 'Partner terms code'],
  ['taxes', partnerTerms, 'Partner terms code'],
  ['refunds', partnerTerms, 'Partner terms code'],
  ['disputes', partnerTerms, 'Partner terms code'],
  ['Only the Sway-controlled `platformFee` is capped.', termsDoc, 'Partner terms document']
]) requireIncludes(source, term, label);

for (const term of [
  'PUBLIC_PROFILE_MAX_LINKS = 12',
  'SUPPRESSED_PUBLIC_PROFILE_DOMAINS',
  "'djthreeex.com'",
  'hostname.endsWith(`.${domain}`)',
  'isSuppressedPublicProfileUrl',
  "parsed.protocol !== 'https:' && parsed.protocol !== 'http:'",
  'parsed.username || parsed.password',
  'escapePublicProfileMetadataAttribute',
  ".replace(/&/g, '&amp;')",
  ".replace(/\"/g, '&quot;')",
  ".replace(/</g, '&lt;')",
  ".replace(/>/g, '&gt;')",
  'resolveVerifiedPublicBookingContact',
  'ownerEmailVerifiedAt',
  'verificationRequired: !ownerEmailVerified && hasConfiguredContact'
]) requireIncludes(normalizers, term, 'Public profile normalizer');

const shareMetadataRoute = sliceBetween(server, 'async function resolveShareMetadata', 'function renderStaticDocument', 'share metadata resolver');
for (const term of [
  'eq(performers.isActive, true)',
  "notInArray(performers.onboardingStatus, ['suspended'])",
  "inArray(activeRoomRegistry.registryStatus, ['active', 'ending'])",
  'normalizePublicProfileUrl(room.avatarUrl)'
]) requireIncludes(shareMetadataRoute, term, 'Share metadata resolver');

const publicFeedRoute = sliceBetween(server, "app.get('/api/public/feed'", "app.get('/api/public/performer/:handle'", 'public feed route');
for (const term of [
  'eq(performers.isActive, true)',
  "notInArray(performers.onboardingStatus, ['suspended'])",
  '.filter((room) => detailsByGigId.has(room.gigId))',
  'normalizePublicProfileUrl(detail.avatarUrl)'
]) requireIncludes(publicFeedRoute, term, 'Public feed route');

const publicPerformerRoute = sliceBetween(server, "app.get('/api/public/performer/:handle'", 'app.get("/api/lyrics"', 'public performer route');
for (const term of [
  'eq(performers.isActive, true)',
  "notInArray(performers.onboardingStatus, ['suspended'])",
  'ownerEmailVerifiedAt: users.emailVerifiedAt',
  '.innerJoin(users, eq(users.id, performers.ownerUserId))',
  'normalizePublicProfileUrl(effectiveAvatarUrl)',
  'resolveVerifiedPublicBookingContact',
  'normalizePublicProfileFeaturedMedia',
  'booking: publicBooking',
  'partnerState?.isEffective',
  'performerProfilePreviews',
  'existingPerformer',
  "claimState: preview.claimedPerformerId ? 'pending' : 'unclaimed'"
]) requireIncludes(publicPerformerRoute, term, 'Public performer route');
const publicPayload = publicPerformerRoute.slice(publicPerformerRoute.indexOf('return res.json({'));
for (const forbidden of [
  'performerId: profile.performerId',
  'id: performerProfileLinks.id',
  'grantedAt:',
  'termsHash:',
  'termsText:',
  'statusReason:'
]) requireExcludes(publicPayload, forbidden, 'Public performer payload');

for (const term of [
  'PerformerPublicProfilePage',
  'Sway Brand Partner',
  'profile.specialties',
  'profile.links.map',
  'profile.booking.email',
  'profile.booking.verificationRequired',
  'profile.isPreview',
  'Unclaimed · ready to review',
  'Prepared for the performer',
  'Featured performance',
  'media.embedUrl',
  'allowFullScreen',
  'QRCodeCanvas',
  'data-public-profile-qr="true"',
  'Sway tip QR code',
  'Copy tip link',
  'Pay through Sway',
  'Scan to tip {stageName}',
  'profileTipUrl',
  'const [tipOpen, setTipOpen] = useState(false)',
  "stageName = profile.stageName || (profile.handle?.toLowerCase() === 'dj3x' ? 'DJ3X' : profile.displayName)",
  'Tip {stageName}',
  'stageName: string | null',
  'canonicalHandle',
  'Tipping is unavailable until this profile is claimed and verified by the performer. No payment was started.',
  'Direct profile payments are not enabled for this performer yet. No payment was started.',
  'claims and verifies the profile',
  'Create your own free Sway page'
]) requireIncludes(publicPage, term, 'Standalone public page');
for (const forbidden of ['performerId', 'entitlementId', 'termsHash', 'grantedAt']) {
  requireExcludes(publicPage, forbidden, 'Standalone public page');
}

for (const term of [
  'Review the exact Brand Partner terms',
  'partner.termsText',
  'partner.termsHash',
  "fetch('/api/talent/partner/terms/accept'",
  'accepted: true',
  'Accept exact Brand Partner terms'
]) requireIncludes(editor, term, 'Authenticated profile editor');

for (const term of [
  'includePreviews: false',
  'reservedPreview',
  'claimedPerformerId: createdPerformer.id'
]) requireIncludes(server, term, 'Preview handle reservation');

for (const term of [
  'one-time invitation to the owner',
  'administrators never receive or set either one',
  'append-only grandfather grant',
  'Pending owner',
  'Operationally suspend partner benefits without deleting history',
  'Administrators never see or choose the replacement password.'
]) requireIncludes(admin, term, 'Admin account controls');

for (const term of [
  'return <PerformerPublicProfilePage performerHandle={route.performerHandle} />',
  "if (route.name === 'performer') return;",
  'PatronNoSessionRecovery'
]) requireIncludes(patronApp, term, 'Patron route separation');
requireExcludes(patronApp, 'performerHandle={route.name', 'Patron route separation');
requireIncludes(sharedShell, 'if (!statePath || isDemoModeEnabled()) return;', 'Standalone profile polling guard');

for (const term of [
  "SWAY_DISPOSABLE_MIGRATION_PROOF === '1'",
  "['127.0.0.1', 'localhost']",
  "'0015_performer_music_source_connections.sql'",
  "applyMigrationFile(client, '0016_performer_link_profiles.sql')",
  'assert.deepEqual(afterMigration.rows, beforeMigration.rows',
  'Existing room must remain discoverable as active.',
  'An administrator must not accept terms on behalf of a performer.',
  'Accepted active Brand Partner fee must cap at $1.',
  'Entitlement grants must be immutable.',
  'New handles must reject reserved names case-insensitively.'
]) requireIncludes(migrationProof, term, 'Disposable migration proof');
requireIncludes(
  migrationProof,
  'Reserved-handle protection must validate all existing performer rows during 0016.',
  'Disposable migration proof'
);

requireIncludes(packageJson, 'node scripts/sway-performer-link-profile.contract.test.mjs', 'package.json contract gate');
requireIncludes(packageJson, 'node scripts/sway-performer-link-profile-migration.integration.test.mjs', 'package.json migration proof command');

for (const source of [publicPage, editor]) {
  for (const forbidden of ['payoutsEnabled', 'chargesEnabled']) {
    requireExcludes(source, forbidden, 'Free performer profile surface');
  }
}

if (!failures.length) {
  const behavior = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/sway-performer-link-profile.behavior.test.ts'], {
    cwd: root,
    encoding: 'utf8'
  });
  if (behavior.status !== 0) {
    failures.push(`Performer profile behavior test failed:\n${behavior.stdout || ''}${behavior.stderr || ''}`);
  }
}

if (failures.length) {
  console.error('Performer link profile contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Performer link profile contract passed.');
