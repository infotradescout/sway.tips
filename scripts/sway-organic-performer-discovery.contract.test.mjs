import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const schema = read('src/db/schema.ts');
const policy = read('src/server/public-profile.ts');
const professionalSetup = read('src/server/talent-professional-setup-service.ts');
const server = read('server.ts');
const discoverPage = read('src/components/PublicDiscoverPage.tsx');
const migration = read('drizzle/0030_tough_joseph.sql');
const packageJson = JSON.parse(read('package.json'));
const failures = [];

function requireText(source, text, label) {
  if (!source.includes(text)) failures.push(`${label}: missing ${text}`);
}

requireText(schema, "export const performerVisibilityStateEnum = pgEnum('performer_visibility_state', [", 'visibility schema');
requireText(schema, "visibilityState: performerVisibilityStateEnum('visibility_state').notNull().default('draft')", 'visibility schema');
requireText(schema, "handleLowerIdx: uniqueIndex('idx_performers_handle_lower')", 'case-insensitive duplicate handle prevention');
requireText(migration, 'CREATE TYPE "public"."performer_visibility_state" AS ENUM', 'visibility migration');
requireText(migration, 'ADD COLUMN "visibility_state" "performer_visibility_state" DEFAULT \'draft\' NOT NULL', 'visibility migration');
requireText(policy, 'export function evaluatePublicPerformerVisibility', 'shared visibility policy');
requireText(policy, '!input.claimed', 'shared visibility policy');
requireText(policy, '!input.hasOwner', 'shared visibility policy');
requireText(policy, "input.visibilityState === 'public'", 'shared visibility policy');
requireText(policy, "input.visibilityState === 'unlisted'", 'shared visibility policy');
requireText(policy, 'export function evaluatePublicProfessionalDirectoryEligibility', 'shared directory policy');
requireText(policy, "ownerProModeStatus !== 'active'", 'shared directory policy');
requireText(policy, '!input.profilePublicationGrantCurrent', 'shared directory policy');
requireText(policy, "reason: 'profile_publication_not_granted'", 'shared directory policy');
requireText(policy, "reason: 'reserved_test_record'", 'shared directory policy');
requireText(professionalSetup, 'export function resolveCurrentProfessionalIdentities', 'durable identity ledger reducer');
requireText(server, 'resolvePublicPerformerDiscovery', 'server discovery resolver');
requireText(server, 'loadQualifiedPublicProfessionalDirectory', 'server professional directory resolver');
requireText(server, 'performerIdentityEvents.identityKind', 'server professional identity ledger authority');
requireText(server, 'resolveCurrentProfessionalIdentities', 'server professional identity ledger reduction');
requireText(server, 'professionalIdentityLabel', 'server professional identity label truth');
requireText(server, 'performerCapabilityGrantEvents.capability', 'server profile-publication grant ledger authority');
requireText(server, "eq(performerCapabilityGrantEvents.capability, 'profile_publication')", 'server profile-publication grant scope');
requireText(server, 'latestProfilePublicationGrantByPerformer', 'server latest profile-publication grant reduction');
requireText(server, "profilePublicationGrant?.decision === 'granted'", 'server current profile-publication grant decision');
requireText(server, 'profilePublicationGrant.expiresAt.getTime() > grantEvaluationTime', 'server profile-publication grant expiry enforcement');
requireText(server, 'ownerPerformerCount:', 'ambiguous owner subject count');
requireText(server, 'conflicted: Number(row.ownerPerformerCount) !== 1', 'ambiguous owner subject exclusion');
requireText(server, 'PUBLIC_DISCOVERY_QUALIFIED_PROFILE_THRESHOLD = 3', 'server professional directory threshold');
requireText(server, 'if (matchingRows.length !== 1) continue', 'defensive duplicate handle exclusion');
requireText(server, 'sendPublicProfileNotFound', 'server profile boundary');
requireText(server, 'sendPublicProfileUnavailable', 'server profile boundary');
requireText(server, 'PUBLIC_PROFILE_NOT_FOUND_HTML', 'server profile boundary');
requireText(server, 'visibilityState: performers.visibilityState', 'server discovery resolver');

const explicitProfileRoute = server.match(/app\.get\(\s*["']\/p\/:handle["']/);
const wildcardRoute = server.match(/app\.get\(\s*["']\*["']/);
if (!explicitProfileRoute) failures.push('profile route: explicit /p/:handle route is missing');
if (!wildcardRoute) failures.push('profile route: wildcard shell route is missing');
if (explicitProfileRoute && wildcardRoute && explicitProfileRoute.index >= wildcardRoute.index) {
  failures.push('profile route: /p/:handle must be registered before the wildcard shell route');
}

const routeBlock = (needle) => {
  const start = server.indexOf(needle);
  if (start < 0) return '';
  const end = server.indexOf('\napp.', start + needle.length);
  return server.slice(start, end < 0 ? undefined : end);
};

const apiBlock = routeBlock('/api/public/performer/:handle');
if (apiBlock.includes('performerProfilePreviews') || apiBlock.includes('curatedPreview')) {
  failures.push('performer API: preview supplementation remains in the canonical API path');
}
requireText(apiBlock, 'resolvePublicPerformerDiscovery', 'performer API');
requireText(apiBlock, 'res.status(503)', 'performer API unavailable response');

requireText(server, "canonicalPublicUrl(req.path || '/')", 'canonical URL must omit query tokens');
requireText(server, 'responseStatus: overrides.responseStatus', 'share metadata response status propagation');

const sitemapBlock = routeBlock("app.get('/sitemap.xml'");
if (sitemapBlock.includes('performerProfilePreviews') || sitemapBlock.includes('previewRows')) {
  failures.push('sitemap: preview enumeration remains in the canonical sitemap path');
}
requireText(sitemapBlock, 'loadQualifiedPublicProfessionalDirectory()', 'sitemap shared directory policy');
requireText(sitemapBlock, 'directory.discoverIndexEligible', 'sitemap dynamic discover threshold');
requireText(sitemapBlock, 'directory.professionals', 'sitemap qualified profile enumeration');
requireText(sitemapBlock, '.status(503)', 'sitemap unavailable response');

const feedBlock = routeBlock("app.get('/api/public/feed'");
requireText(feedBlock, 'professionals: directory.professionals', 'public feed professional directory');
requireText(feedBlock, 'const roomCandidates = activeRooms.slice', 'bounded public room candidates');
requireText(feedBlock, 'professionalsById.has(detail.performerId)', 'public room directory qualification');
if (feedBlock.includes('qualifiedProfileCount:') || feedBlock.includes('discoverIndexEligible:')) {
  failures.push('public feed: internal index-threshold state must not be exposed');
}

const directoryBlock = server.slice(
  server.indexOf('async function loadQualifiedPublicProfessionalDirectory'),
  server.indexOf('async function resolvePublicPerformerDiscovery')
);
if (directoryBlock.includes('resolvePublicPrimaryRole') || directoryBlock.includes('metadata: performerPublicProfiles.metadata')) {
  failures.push('professional directory: profile metadata must not be the current professional identity authority');
}
for (const term of [
  'if (isPublicDiscoverPath(req.path))',
  'id="sway-professional-directory"',
  "'@type': 'CollectionPage'",
  "'@type': 'ItemList'",
  "robots: directory.discoverIndexEligible ? undefined : 'noindex, follow'",
  'applyPublicDiscoveryIndexHold(req, res, metadata)'
]) {
  requireText(server, term, 'server-rendered discovery document');
}
for (const term of [
  "app.get(/^\\/discover\\/*$/i",
  "return res.redirect(308, `/discover${query}`)",
  'responseStatus: 503',
  "res.setHeader('Retry-After', '300')"
]) {
  requireText(server, term, 'canonical and outage-safe discovery document');
}
for (const term of [
  'primaryRole: profile.primaryRole',
  'primaryRoleLabel: profile.primaryRoleLabel',
  'jobTitle: profile.primaryRoleLabel || undefined'
]) {
  requireText(server, term, 'public profile canonical ledger identity');
}

for (const term of [
  'comedians',
  'singers',
  'songwriters',
  'DJs',
  'bartenders',
  'hosts',
  'creators',
  'gig or service',
  'data.professionals',
  "entity_kind: 'performer'"
]) {
  requireText(discoverPage, term, 'broad professional discovery page');
}

const llmsBlock = routeBlock("app.get('/llms.txt'");
if (llmsBlock.includes('businessDb') || llmsBlock.includes('performerProfilePreviews')) {
  failures.push('llms.txt: static crawler guidance must not enumerate performers or depend on the database');
}
requireText(llmsBlock, 'Only published, public, non-suspended records belong in search results.', 'llms.txt static guidance');

if (packageJson.scripts?.['test:integration:performer-discovery'] !== 'node --import tsx scripts/sway-organic-performer-discovery.integration.test.mjs') {
  failures.push('package scripts: focused performer discovery integration command is missing');
}
if (packageJson.scripts?.['test:performer-discovery'] !== 'node scripts/sway-organic-performer-discovery.contract.test.mjs && npm run test:integration:performer-discovery') {
  failures.push('package scripts: focused performer discovery aggregate command is missing');
}
if (!packageJson.scripts?.['test:contracts']?.includes('sway-organic-performer-discovery.contract.test.mjs')) {
  failures.push('package scripts: performer discovery contract is not in test:contracts');
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join('\n'));
  process.exit(1);
}

console.log('PASS sway-organic-performer-discovery contract');
