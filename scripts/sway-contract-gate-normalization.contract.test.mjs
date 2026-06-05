import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

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

const hardScriptPaths = hardCommands.map((command) => {
  const match = command.match(/^node\s+(scripts\/[^\s]+\.mjs)$/);
  if (!match) failures.push(`test:contracts command is not a direct node script gate: ${command}`);
  return match?.[1];
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
  if (!/process\.exit\(\s*1\s*\)/.test(source)) {
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
if (!structuralDoc.includes('route decoupling is not complete until entries import distinct role-specific shell code and the server serves distinct bundles')) {
  failures.push('Structural doc must not claim route decoupling complete while entry files are Slice 0A stubs.');
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
  if (!source.includes('Slice 0A stub') || !source.includes('stub:')) {
    failures.push(`${entryPath} must remain an explicit Slice 0A stub until route decoupling implementation begins.`);
  }
}

if (failures.length) {
  console.error('Contract gate normalization failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Contract gate normalization passed.');
