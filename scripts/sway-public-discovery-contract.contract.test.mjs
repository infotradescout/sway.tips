import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label}: missing ${term}`);
}

function requireNotIncludes(source, term, label) {
  if (source.includes(term)) failures.push(`${label}: must not contain ${term}`);
}

for (const path of [
  'docs/PUBLIC_DISCOVERY_CONTRACT_V1.md',
  'docs/process/PUBLIC_DISCOVERY_PHASE1_AUDIT_MATRIX.md',
  'docs/process/PUBLIC_DISCOVERY_QUERY_MATRIX_V1.md'
]) {
  if (!existsSync(join(root, path))) failures.push(`missing ${path}`);
}

const contract = read('docs/PUBLIC_DISCOVERY_CONTRACT_V1.md');
const matrix = read('docs/process/PUBLIC_DISCOVERY_PHASE1_AUDIT_MATRIX.md');
const queryMatrix = read('docs/process/PUBLIC_DISCOVERY_QUERY_MATRIX_V1.md');
const agents = read('AGENTS.md');
const server = read('server.ts');
const surfaceMap = read('docs/SWAY_PRODUCTION_SURFACE_MAP.md');
const organic = read('scripts/sway-organic-discovery.contract.test.mjs');
const packageJson = JSON.parse(read('package.json'));
const frictionClient = read('src/shells/frictionClient.ts');
const discoveryAttr = read('src/shells/discoveryAttribution.ts');

for (const term of [
  'Public Discovery Contract v1',
  'JW Stone',
  'first server response',
  'Do not merge. Do not deploy.',
  'discovery_landing',
  'Sway Live Rooms',
  'Skill Gaming World'
]) {
  requireIncludes(contract, term, 'PUBLIC_DISCOVERY_CONTRACT_V1.md');
}

for (const term of [
  'Phase 1 forensic audit matrix',
  'Sway Live Rooms',
  'app.sway.tips',
  'partial',
  'Do not merge. Do not deploy.'
]) {
  requireIncludes(matrix, term, 'PUBLIC_DISCOVERY_PHASE1_AUDIT_MATRIX.md');
}

for (const term of [
  'Fixed query matrix',
  'methodology',
  'Do not fabricate clicks',
  'exact name',
  'category + location',
  'specific event',
  'problem phrasing'
]) {
  requireIncludes(queryMatrix, term, 'PUBLIC_DISCOVERY_QUERY_MATRIX_V1.md');
}

requireIncludes(agents, 'PUBLIC_DISCOVERY_CONTRACT_V1.md', 'AGENTS.md');
requireIncludes(agents, 'PUBLIC_DISCOVERY_PHASE1_AUDIT_MATRIX.md', 'AGENTS.md');

// First-response identity facts must be injected server-side (not JS-only).
for (const term of [
  'function renderDiscoveryBodyHtml',
  'sway-discovery-first-response',
  'structuredData: overrides.structuredData',
  'discoveryFacts: overrides.discoveryFacts',
  'function canonicalPublicUrl',
  "CANONICAL_APP_HOST = 'app.sway.tips'",
  'ne(musicReleases.distributionMode, \'private\')',
  'discovery_landing',
  'discovery_entity_view',
  'discovery_primary_action'
]) {
  requireIncludes(server, term, 'server.ts discovery foundation');
}

// Hard failure: robots/sitemap must not be implemented as HTML app shells.
requireIncludes(server, "app.get('/robots.txt'", 'robots route');
requireIncludes(server, "app.get('/sitemap.xml'", 'sitemap route');
requireIncludes(server, "res.type('text/plain')", 'robots content type');
requireIncludes(server, "res.type('application/xml')", 'sitemap content type');
requireNotIncludes(server, "app.get('/robots.txt', (_req, res) => {\n  res.type('html')", 'robots must not send HTML');
requireNotIncludes(server, "app.get('/sitemap.xml', async (_req, res) => {\n  res.type('html')", 'sitemap must not send HTML');

// Surface map must not still claim crawler files return HTML shells as current truth.
requireIncludes(surfaceMap, 'text/plain', 'SWAY_PRODUCTION_SURFACE_MAP.md current robots truth');
requireIncludes(surfaceMap, 'application/xml', 'SWAY_PRODUCTION_SURFACE_MAP.md current sitemap truth');
requireIncludes(surfaceMap, 'app.sway.tips', 'canonical host documented in surface map');

for (const event of [
  'discovery_landing',
  'discovery_entity_view',
  'discovery_primary_action'
]) {
  requireIncludes(frictionClient, event, 'frictionClient discovery events');
  requireIncludes(server, `'${event}'`, 'server discovery events');
}

requireIncludes(discoveryAttr, 'captureDiscoveryAttribution', 'discoveryAttribution');
requireIncludes(discoveryAttr, 'recordOfflineFindUs', 'offline find-us');
requireIncludes(discoveryAttr, 'overwroteFirstTouch: false', 'offline must not overwrite stronger attribution');

requireIncludes(
  packageJson.scripts?.['test:contracts'] ?? '',
  'sway-public-discovery-contract.contract.test.mjs',
  'test:contracts must include public discovery contract'
);
requireIncludes(
  packageJson.scripts?.['test:contracts'] ?? '',
  'sway-organic-discovery.contract.test.mjs',
  'test:contracts must include organic discovery contract'
);

requireIncludes(organic, 'sway-discovery-first-response', 'organic discovery must assert first-response block');
requireIncludes(organic, 'structuredData: overrides.structuredData', 'organic discovery must assert JSON-LD passthrough');

if (failures.length) {
  console.error('Public discovery contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Public discovery contract passed.');
