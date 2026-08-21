import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const capabilityModel = read('docs/SWAY_TALENT_CAPABILITY_MODEL.md');
const copyTruth = read('docs/SWAY_PUBLIC_COPY_TRUTH_MATRIX.md');
const productStructure = read('docs/SWAY_PRODUCT_STRUCTURE.md');
const accountAccess = read('src/components/AccountAccess.tsx');
const server = read('server.ts');
const organicDiscoveryContract = read('scripts/sway-organic-performer-discovery.contract.test.mjs');
const failures = [];

function requireText(source, text, label) {
  if (!source.includes(text)) failures.push(`${label}: missing ${text}`);
}

function rejectText(source, text, label) {
  if (source.includes(text)) failures.push(`${label}: prohibited ${text}`);
}

for (const term of [
  'independent talent, creators, and gig professionals',
  'Comedians are the first focused growth wedge',
  '**Primary identity**',
  '**Secondary identities**',
  '**Earning modes**',
  '**Desired capabilities**',
  '**Capability grants**',
  '**Seller or venue authority**',
  'Labels never grant money, ticketing, publication, venue, catalog, payout, moderation, or administrative authority.',
  'A shareable profile is not automatically index eligible.',
  'no onboarding control may preselect `Public`',
  'Release count is not numerically capped.'
]) {
  requireText(capabilityModel, term, 'talent capability model');
}

for (const term of [
  'Money is Stripe test-only today.',
  'Native ticket capability stays disabled',
  'Preparation is not DSP delivery.',
  'public comedy audio',
  '`/for-comedians`',
  'at least 5 eligible comedians',
  '`/discover`',
  'at least 3 qualified public profiles',
  '`/for-gig-pros`',
  'OQPS: organic qualified pro signup',
  'within 14 days',
  'within 30 days'
]) {
  requireText(copyTruth, term, 'public copy truth matrix');
}

for (const term of [
  'default: 5 GiB',
  'default: 10,000',
  'not numerically capped'
]) {
  requireText(productStructure, term, 'protected storage and release policy');
}

requireText(productStructure, 'docs/SWAY_TALENT_CAPABILITY_MODEL.md', 'product structure related docs');
requireText(productStructure, 'docs/SWAY_PUBLIC_COPY_TRUTH_MATRIX.md', 'product structure related docs');

rejectText(accountAccess, "useState<PerformerVisibilityState>('public')", 'publication intent');
rejectText(accountAccess, 'Public is selected', 'publication intent');
requireText(server, "sql`nullif(trim(${performers.bio}), '') is not null`", 'public profile sufficient-information boundary');
rejectText(server, 'listEligiblePublicPerformers', 'public directory implementation boundary');
rejectText(server, 'public-performer-directory', 'public directory implementation boundary');

const routeBlock = (needle) => {
  const start = server.indexOf(needle);
  if (start < 0) return '';
  const end = server.indexOf('\napp.', start + needle.length);
  return server.slice(start, end < 0 ? undefined : end);
};

const publicFeed = routeBlock("app.get('/api/public/feed'");
requireText(publicFeed, 'rooms:', 'public feed live-room boundary');
requireText(publicFeed, 'events:', 'public feed event boundary');
if (/(?:^|\n)\s*performers\s*:/.test(publicFeed)) {
  failures.push('public feed boundary: a top-level performer directory was coupled into the live-room and event feed');
}

const sitemap = routeBlock("app.get('/sitemap.xml'");
if (/const staticPaths\s*=\s*\[[^\]]*['"]\/discover['"]/.test(sitemap)) {
  failures.push('public discovery index hold: /discover must stay out of the static sitemap before the eligible-supply threshold is implemented');
}
requireText(server, 'function applyPublicDiscoveryIndexHold', 'public discovery index hold');
requireText(server, "req.path === '/discover'", 'public discovery index hold');
requireText(server, "res.setHeader('X-Robots-Tag', 'noindex, follow')", 'public discovery index hold');
const indexHoldCallCount = (server.match(/applyPublicDiscoveryIndexHold\(req, res\);/g) ?? []).length;
if (indexHoldCallCount !== 2) {
  failures.push(`public discovery index hold: expected dev and production shell enforcement, found ${indexHoldCallCount}`);
}

rejectText(organicDiscoveryContract, "import('./sway-passive-discovery.contract.test.mjs')", 'direct contract registration');
rejectText(organicDiscoveryContract, 'import("./sway-passive-discovery.contract.test.mjs")', 'direct contract registration');

const expectedCommand = 'node scripts/sway-passive-discovery.contract.test.mjs';
if (packageJson.scripts?.['test:passive-discovery'] !== expectedCommand) {
  failures.push('package scripts: focused passive-discovery command is missing');
}
const hardCommands = (packageJson.scripts?.['test:contracts'] ?? '')
  .split('&&')
  .map((command) => command.trim());
if (!hardCommands.includes(expectedCommand)) {
  failures.push('package scripts: passive-discovery contract is not directly registered in test:contracts');
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join('\n'));
  process.exit(1);
}

console.log('PASS sway-passive-discovery contract');
