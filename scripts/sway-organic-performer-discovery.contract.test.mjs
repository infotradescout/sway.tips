import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const schema = read('src/db/schema.ts');
const policy = read('src/server/public-profile.ts');
const server = read('server.ts');
const migration = read('drizzle/0030_tough_joseph.sql');
const handleClaimMigration = read('drizzle/0043_bored_sleeper.sql');
const packageJson = JSON.parse(read('package.json'));
const failures = [];

function requireText(source, text, label) {
  if (!source.includes(text)) failures.push(`${label}: missing ${text}`);
}

requireText(schema, "export const performerVisibilityStateEnum = pgEnum('performer_visibility_state', [", 'visibility schema');
requireText(schema, "visibilityState: performerVisibilityStateEnum('visibility_state').notNull().default('draft')", 'visibility schema');
requireText(migration, 'CREATE TYPE "public"."performer_visibility_state" AS ENUM', 'visibility migration');
requireText(migration, 'ADD COLUMN "visibility_state" "performer_visibility_state" DEFAULT \'draft\' NOT NULL', 'visibility migration');
requireText(policy, 'export function evaluatePublicPerformerVisibility', 'shared visibility policy');
requireText(policy, '!input.claimed', 'shared visibility policy');
requireText(policy, '!input.hasOwner', 'shared visibility policy');
requireText(policy, "input.visibilityState === 'public'", 'shared visibility policy');
requireText(policy, "input.visibilityState === 'unlisted'", 'shared visibility policy');
requireText(server, 'resolvePublicPerformerDiscovery', 'server discovery resolver');
requireText(server, 'sendPublicProfileNotFound', 'server profile boundary');
requireText(server, 'sendPublicProfileUnavailable', 'server profile boundary');
requireText(server, 'PUBLIC_PROFILE_NOT_FOUND_HTML', 'server profile boundary');
requireText(server, 'visibilityState: performers.visibilityState', 'server discovery resolver');
requireText(schema, "export const performerHandleClaims = pgTable('performer_handle_claims'", 'handle claim schema');
requireText(server, 'performerHandleClaims.normalizedHandle', 'handle redirect resolver');
requireText(server, "eq(performerHandleClaims.claimKind, 'redirect')", 'redirect-only public resolver');
requireText(server, 'resolvedViaAlias: requestedHandle !== storedHandle?.toLowerCase()', 'handle alias resolver');
requireText(server, 'res.redirect(308, canonicalPerformerRedirectPath(req, resolution.profile.handle!))', 'canonical profile redirect');
requireText(server, 'res.redirect(308, canonicalPerformerRedirectPath(req, profile.handle))', 'legacy short-link redirect');
requireText(server, "'Content-Location'", 'historical API and share-card continuity');
requireText(handleClaimMigration, 'BEFORE INSERT OR UPDATE OR DELETE ON "performer_handle_claims"', 'immutable handle claims');
requireText(handleClaimMigration, 'performer_handle_claim_identity_is_immutable', 'immutable handle claims');
requireText(handleClaimMigration, "'edgewize',\n    target_performer_id,\n    'reservation'", 'EdgeWize reservation');
requireText(handleClaimMigration, 'AFTER INSERT OR UPDATE OF "handle" ON "performers"', 'canonical claim synchronization');
requireText(handleClaimMigration, 'ADD CONSTRAINT "idx_performers_handle_lower" PRIMARY KEY', 'authoritative handle namespace');
if ((handleClaimMigration.match(/pg_advisory_xact_lock\(hashtextextended\(/g) ?? []).length !== 2) {
  failures.push('handle claims: performer and claim writes must use the same advisory-lock protocol');
}

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

const sitemapBlock = routeBlock("app.get('/sitemap.xml'");
if (sitemapBlock.includes('performerProfilePreviews') || sitemapBlock.includes('previewRows')) {
  failures.push('sitemap: preview enumeration remains in the canonical sitemap path');
}
requireText(sitemapBlock, "eq(performers.visibilityState, 'public')", 'sitemap public filter');
requireText(sitemapBlock, 'evaluatePublicPerformerVisibility', 'sitemap shared policy');
requireText(sitemapBlock, '.status(503)', 'sitemap unavailable response');

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
