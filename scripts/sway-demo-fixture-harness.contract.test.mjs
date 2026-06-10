import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const fixtureDir = join(root, 'fixtures/demo');
const fixturePath = join(fixtureDir, 'sway-demo-fixtures.json');
const read = (path) => readFileSync(join(root, path), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(label || `Missing term: ${term}`);
}

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) return walkFiles(fullPath);
    return [fullPath];
  });
}

const demoMode = read('src/demo-mode.tsx');
const shared = read('src/shells/shared.tsx');
const server = read('server.ts');
const accessControl = read('src/server/access-control.ts');
const viteConfig = read('vite.config.ts');
const packageJson = read('package.json');
const patronView = read('src/components/PatronView.tsx');
const talentDashboard = read('src/components/TalentDashboard.tsx');
const patronShell = read('src/shells/PatronApp.tsx');
const talentShell = read('src/shells/TalentApp.tsx');
const overlayShell = read('src/shells/OverlayApp.tsx');
const adminShell = read('src/shells/AdminApp.tsx');
const adminCompat = read('src/shells/admin/AdminOpsRuntimeCompat.tsx');
const splitView = read('src/components/SplitViewShell.tsx');
const demoReadme = read('fixtures/demo/README.md');

for (const term of [
  "import.meta.env.VITE_SWAY_DEMO_MODE === 'true'",
  "if (!isDemoModeEnabled()) return null;",
  "const demoFixtureUrl = '/sway-demo-fixtures.json';",
  "fixtureSource === demoFixtureSource",
  "candidate.id.startsWith('demo_')",
  'loadDemoBackendState'
]) {
  requireIncludes(demoMode, term, `Demo mode boundary missing: ${term}`);
}

for (const term of [
  'loadDemoBackendState',
  'if (isDemoModeEnabled())',
  "fetch('/api/state')",
  'setInterval(fetchState, 4000)'
]) {
  requireIncludes(shared, term, `Shared state loader missing demo/real split: ${term}`);
}

for (const term of [
  "process.env.VITE_SWAY_DEMO_MODE === 'true'",
  "req.method === 'GET'",
  "shell === 'talent' || shell === 'admin'",
  'demoPreviewShellAllowed'
]) {
  requireIncludes(accessControl, term, `Demo preview shell guard missing safe shell-only allowance: ${term}`);
}

for (const term of [
  "req.path.startsWith('/api')",
  "req.path.startsWith('/assets')",
  "req.path.startsWith('/shells')",
  'routeFamilyGuard(accessControl)'
]) {
  requireIncludes(server, term, `Server must keep demo shell preview allowance outside API/static routes: ${term}`);
}

requireIncludes(viteConfig, "process.env.VITE_SWAY_DEMO_MODE === 'true' ? path.resolve(__dirname, 'fixtures/demo') : false", 'Vite must only publish demo fixtures when VITE_SWAY_DEMO_MODE is explicitly true.');
requireIncludes(packageJson, 'sway-demo-fixture-harness.contract.test.mjs', 'test:contracts must include the demo fixture harness contract.');

for (const [name, source] of [
  ['patron shell', patronShell],
  ['talent shell', talentShell],
  ['overlay shell', overlayShell],
  ['admin shell', `${adminShell}\n${adminCompat}`]
]) {
  requireIncludes(source, 'Demo data', `${name} must visibly label demo data.`);
}

for (const [name, source] of [
  ['patron shell', patronShell],
  ['talent shell', talentShell]
]) {
  requireIncludes(source, 'rejectDemoMutation', `${name} must keep demo data read-only.`);
  requireIncludes(source, 'No backend mutation was sent.', `${name} must make demo mutation suppression explicit.`);
}

for (const term of [
  'previewMode',
  'Demo data only. No payment or moderation action will be sent.',
  'Demo data. No payment or request will be recorded.',
  'Demo only: sending disabled'
]) {
  requireIncludes(patronView, term, `Patron demo mode must prevent payment interpretation risk: ${term}`);
}

for (const term of [
  'previewMode',
  'Demo data only; no live tips are being collected.'
]) {
  requireIncludes(talentDashboard, term, `Talent demo mode must prevent live-activity interpretation risk: ${term}`);
}

for (const term of [
  'Demo only',
  'Demo total shown:',
  'Demo only: boost locked',
  'Demo only: no boost action'
]) {
  requireIncludes(talentDashboard, term, `Talent demo mode must not imply capture or promotion authority: ${term}`);
}

for (const term of [
  'SplitViewShell',
  'primaryLabel',
  'secondaryLabel',
  'emptyState',
  'isEmpty',
  'lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.55fr)]'
]) {
  requireIncludes(splitView, term, `Split View primitive missing reusable layout capability: ${term}`);
}

for (const [name, source] of [
  ['patron shell', patronShell],
  ['talent shell', talentShell],
  ['admin shell', adminShell]
]) {
  requireIncludes(source, 'SplitViewShell', `${name} must use reusable Split View architecture.`);
  requireIncludes(source, 'emptyState', `${name} Split View must handle empty state.`);
}

for (const forbidden of [
  'demo-fixture-harness',
  'sway-demo-fixtures',
  'loadDemoBackendState',
  'fixtures/demo'
]) {
  if (splitView.includes(forbidden)) failures.push(`Split View must not import or depend on demo fixtures: ${forbidden}`);
}

for (const term of [
  'Split View is production UI architecture',
  'not demo-only code',
  'Deleting this fixture folder must not remove or break Split View'
]) {
  requireIncludes(demoReadme, term, `Demo README missing Split View removal rule: ${term}`);
}

if (!existsSync(fixturePath)) {
  failures.push('Missing sealed demo fixture payload at fixtures/demo/sway-demo-fixtures.json.');
} else {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (fixture.fixtureKind !== 'demo') failures.push('Demo fixture payload must declare fixtureKind: demo.');
  if (fixture.fixtureSource !== 'demo-fixture-harness') failures.push('Demo fixture payload must declare fixtureSource: demo-fixture-harness.');

  const requiredSurfaces = [
    'public-landing',
    'patron-dashboard',
    'performer-dashboard',
    'overlay',
    'admin-console',
    'moderation-queue',
    'payments-preview',
    'events-feed',
    'profiles',
    'requests',
    'tips'
  ];
  for (const surface of requiredSurfaces) {
    if (!Object.prototype.hasOwnProperty.call(fixture.surfaces || {}, surface)) {
      failures.push(`Demo fixture missing surface: ${surface}.`);
    }
  }

  const assertRecord = (record, path) => {
    if (!record || typeof record !== 'object') return;
    if (typeof record.id === 'string') {
      if (!record.id.startsWith('demo_')) failures.push(`${path} id must use demo_ prefix.`);
      if (record.demo !== true) failures.push(`${path} must include demo: true.`);
      if (record.fixtureSource !== 'demo-fixture-harness') failures.push(`${path} must include fixtureSource: demo-fixture-harness.`);
    }
    for (const [key, value] of Object.entries(record)) {
      if (Array.isArray(value)) {
        value.forEach((child, index) => assertRecord(child, `${path}.${key}[${index}]`));
      } else if (value && typeof value === 'object') {
        assertRecord(value, `${path}.${key}`);
      }
    }
  };

  assertRecord(fixture, 'fixture');
}

const forbiddenRuntimeRoots = [
  'server.ts',
  'src/server',
  'src/db'
];
const forbiddenDemoTerms = [
  'demo-fixture-harness',
  'sway-demo-fixtures',
  'loadDemoBackendState',
  'isDemoModeEnabled',
  'fixtures/demo'
];

for (const runtimeRoot of forbiddenRuntimeRoots) {
  const fullRoot = join(root, runtimeRoot);
  const files = statSync(fullRoot).isDirectory() ? walkFiles(fullRoot) : [fullRoot];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const term of forbiddenDemoTerms) {
      if (source.includes(term)) failures.push(`Production backend file must not import or depend on demo fixtures: ${file}`);
    }
  }
}

if (failures.length) {
  console.error('Demo fixture harness contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Demo fixture harness contract passed.');
