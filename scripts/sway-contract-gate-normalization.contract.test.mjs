import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];

// Node's native test runner and uncaught strict assertions are hard failures
// too. Verify their exit behavior instead of requiring dead process.exit code
// in every test that already relies on those supported mechanisms.
const nativeFailureProofs = [
  "import assert from 'node:assert/strict'; assert.fail('expected gate probe');",
  "import test from 'node:test'; test('expected gate probe', () => { throw new Error('expected failure'); });"
].map((code) => spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
  encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH }
}));
const nativeFailuresAreHard = nativeFailureProofs.every((result) => !result.error && result.status === 1);
if (!nativeFailuresAreHard) failures.push('Native assertion/test failure probes must exit1.');

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scripts = packageJson.scripts ?? {};
const testContracts = scripts['test:contracts'] ?? '';
const auditContracts = scripts['audit:contracts'] ?? '';

if (!testContracts) failures.push('package.json must define test:contracts.');
if (!auditContracts) failures.push('package.json must define audit:contracts.');

if (!/^node\s+scripts\/contract-audit\.mjs$/.test(auditContracts)) {
  failures.push('audit:contracts must be the only soft diagnostic path: node scripts/contract-audit.mjs');
}

if (/contract-audit\.mjs/.test(testContracts)) {
  failures.push('test:contracts must not include the soft audit runner.');
}

const hardCommands = testContracts
  .split('&&')
  .map((command) => command.trim())
  .filter(Boolean);

const candidateDecisionScript = 'scripts/sway-audio-candidate-decisions.integration.test.mjs';
const embeddedDecisionCommand = `node --import tsx ${candidateDecisionScript} --embedded-postgres`;
function directHardScript(command) {
  // This one reviewed fixture switch explicitly refuses inherited database URLs.
  // Do not admit arbitrary arguments, shell prefixes, aliases or wrapper runners.
  if (command === embeddedDecisionCommand) return candidateDecisionScript;
  const match = command.match(/^node(?:\s+--import\s+tsx)?\s+(scripts\/[^\s]+\.(?:mjs|ts))$/);
  if (match?.[1] === candidateDecisionScript) return undefined;
  return match?.[1];
}
for (const [command, expected] of [
  [embeddedDecisionCommand, candidateDecisionScript],
  ['node scripts/contract-check.mjs', 'scripts/contract-check.mjs'],
  [`node --import tsx ${candidateDecisionScript}`, undefined],
  [`${embeddedDecisionCommand} --strict-real-postgres`, undefined],
  ['node scripts/contract-check.mjs --embedded-postgres', undefined],
  [`SWAY_DISPOSABLE_MIGRATION_PROOF=1 ${embeddedDecisionCommand}`, undefined],
  ['npm run test:integration:audio-candidate-decisions', undefined],
  [`${embeddedDecisionCommand}; true`, undefined]
]) {
  if (directHardScript(command) !== expected) failures.push(`Direct hard gate parser accepted an unsafe command or rejected an approved fixture: ${command}`);
}
const hardScriptPaths = hardCommands.map((command) => {
  const scriptPath = directHardScript(command);
  if (!scriptPath) failures.push(`test:contracts command is not a direct node script gate with approved fixture intent: ${command}`);
  return scriptPath;
}).filter(Boolean);

const requiredHardScripts = [
  'scripts/contract-check.mjs',
  ...readdirSync(join(root, 'scripts'))
    .filter((name) => name.endsWith('.contract.test.mjs'))
    .map((name) => `scripts/${name}`)
    .sort()
];

for (const scriptPath of requiredHardScripts) {
  if (!hardScriptPaths.includes(scriptPath)) {
    failures.push(`Hard contract script is not wired into test:contracts: ${scriptPath}`);
  }
}

for (const scriptPath of hardScriptPaths) {
  const absolutePath = join(root, scriptPath);
  if (!existsSync(absolutePath)) {
    failures.push(`test:contracts references missing script: ${scriptPath}`);
    continue;
  }

  const source = readFileSync(absolutePath, 'utf8');
  const explicitFailureExit = /process\.exit\(\s*1\s*\)|process\.exitCode\s*=\s*1\b/.test(source);
  const nativeFailureExit = nativeFailuresAreHard && /from\s+['"]node:(?:assert(?:\/strict)?|test)['"]/.test(source);
  if (!explicitFailureExit && !nativeFailureExit) {
    failures.push(`${scriptPath} must exit nonzero on failure.`);
  }
  if (/process\.exit\(\s*0\s*\)/.test(source)) {
    failures.push(`${scriptPath} must not soft-exit inside test:contracts.`);
  }
}

const auditSource = readFileSync(join(root, 'scripts/contract-audit.mjs'), 'utf8');
if (!/npm['"],\s*\[\s*['"]run['"],\s*['"]test:contracts['"]/.test(auditSource)) {
  failures.push('contract-audit.mjs must run test:contracts as its diagnostic input.');
}
if (!/process\.exit\(\s*0\s*\)/.test(auditSource)) {
  failures.push('contract-audit.mjs must remain the explicit soft-exit diagnostic runner.');
}

const docs = {
  'AGENTS.md': readFileSync(join(root, 'AGENTS.md'), 'utf8'),
  'docs/SWAY_DAY1_BUILD_CONTRACT.md': readFileSync(join(root, 'docs/SWAY_DAY1_BUILD_CONTRACT.md'), 'utf8'),
  'docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md': readFileSync(join(root, 'docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md'), 'utf8'),
  'docs/SWAY_AI_COUNCIL_PROTOCOL.md': readFileSync(join(root, 'docs/SWAY_AI_COUNCIL_PROTOCOL.md'), 'utf8')
};

const buildOrderTerms = [
  '0A. Repo truth normalization',
  '0B. Hard contract gates',
  '1. Database schema init',
  '2. Server route decoupling and separate entrypoints',
  '3. Middleware guards backed by persisted schema'
];

for (const [file, source] of Object.entries(docs)) {
  for (const term of buildOrderTerms) {
    if (!source.includes(term)) failures.push(`${file} missing accepted build-order term: ${term}`);
  }
}

for (const [file, source] of Object.entries(docs)) {
  if (/SHA256\(idempotency_key\s*\+/.test(source)) {
    failures.push(`${file} contains stale unsafe idempotency concatenation formula.`);
  }
}

const structuralDoc = docs['docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md'];
if (!structuralDoc.includes('route decoupling is complete for shell selection when entries import distinct role-specific shell code and the server serves distinct shell HTML')) {
  failures.push('Structural doc must describe Slice 2 route decoupling completion criteria.');
}

const wildcardRequiredScripts = [
  'scripts/sway-native-minimum-functionality.contract.test.mjs',
  'scripts/sway-offline-pending-ttl.contract.test.mjs',
  'scripts/sway-captive-portal-preflight.contract.test.mjs'
];

for (const scriptPath of wildcardRequiredScripts) {
  if (!hardScriptPaths.includes(scriptPath)) {
    failures.push(`Wild-card risk hard test is not wired into test:contracts: ${scriptPath}`);
  }
}

const entryPaths = [
  'src/entries/patron.tsx',
  'src/entries/talent.tsx',
  'src/entries/overlay.tsx',
  'src/entries/admin.tsx',
  'src/entries/dev-sandbox.tsx'
];

for (const entryPath of entryPaths) {
  const source = readFileSync(join(root, entryPath), 'utf8');
  if (/import\s+['"]\.\.\/main['"]/.test(source) || source.includes('stub:')) {
    failures.push(`${entryPath} must be a real Slice 2 entrypoint, not a Slice 0A stub or ../main alias.`);
  }
}

if (failures.length) {
  console.error('Contract gate normalization failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Contract gate normalization passed.');
