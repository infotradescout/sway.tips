import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label} missing term: ${term}`);
}

const doctrine = read('docs/VIBE_ENGINEERING_DOCTRINE.md');
const agentRules = read('AGENTS.md');
const gapLedger = read('docs/SWAY_COMPLETE_PRODUCT_GAP.md');
const releaseGate = read('docs/process/QA_DRY_RELEASE_GATE.md');
const evidenceChecklist = read('docs/process/RELEASE_EVIDENCE_CHECKLIST.md');
const packageJson = JSON.parse(read('package.json'));
const readiness = JSON.parse(read('config/sway-complete-product-readiness.json'));

for (const term of [
  'We do not measure agent productivity by code produced.',
  'verified outcomes delivered without increasing uncontrolled risk',
  'Humans own:',
  'Agents own:',
  'Systems own:',
  'No task is complete because an agent says it is complete.',
  'No deployment is successful merely because it deployed.',
  'maximum verified throughput per unit of human attention',
  'Sway replaces the core DistroKid workflow',
  'Sway retains its original product',
  'npm run readiness:assert'
]) {
  requireIncludes(doctrine, term, 'Vibe engineering doctrine');
}

for (const term of [
  'docs/VIBE_ENGINEERING_DOCTRINE.md',
  'Productivity is measured by verified outcomes delivered without increasing uncontrolled risk',
  'No task is complete because an agent says it is complete',
  'No deployment is successful merely because it deployed'
]) {
  requireIncludes(agentRules, term, 'Agent rules');
}

for (const term of [
  'Complete-product decision: **HOLD**',
  'Production migration `0023_audio_publishing_foundation` is applied',
  'Pairing-token creation is production verified',
  'private Cloudflare R2 adapter',
  'independent recovery',
  'No contracted DSP delivery provider',
  'No royalty ledger, collaborator distribution splits, or distribution payouts'
]) {
  requireIncludes(gapLedger, term, 'Complete-product gap ledger');
}

for (const term of [
  'Agent output, a passing local command, a merged PR, a deployment hook, or a build marker is never sufficient by itself',
  'Evidence must identify the requested outcome, the verifier, the environment, the observed result',
  'Complete-product launch approval is separate from iterative deployment approval',
  'npm run readiness:assert'
]) {
  requireIncludes(releaseGate, term, 'QA dry release gate');
}

for (const term of [
  '## Requested Outcome',
  '## Independent Evidence',
  'What remains unproven:',
  'Automatic rollback trigger:',
  'Observability signal that activates the trigger:',
  '## Complete-Product Readiness',
  'DistroKid-replacement pillar evidence:',
  'Original-Sway pillar evidence:'
]) {
  requireIncludes(evidenceChecklist, term, 'Release evidence checklist');
}

if (readiness.decision !== 'HOLD') failures.push('Readiness config must remain HOLD while required capabilities are unverified.');
const pillarIds = new Set(readiness.pillars?.map((pillar) => pillar.id));
for (const pillarId of ['distrokid_replacement', 'original_sway']) {
  if (!pillarIds.has(pillarId)) failures.push(`Readiness config missing pillar: ${pillarId}`);
}

for (const script of ['readiness:report', 'readiness:assert']) {
  if (!packageJson.scripts?.[script]) failures.push(`package.json missing script: ${script}`);
}
requireIncludes(
  packageJson.scripts?.['test:contracts'] ?? '',
  'sway-complete-product-readiness.contract.test.mjs',
  'test:contracts'
);

const report = spawnSync(process.execPath, ['scripts/sway-complete-product-readiness.mjs'], {
  cwd: root,
  encoding: 'utf8'
});
if (report.status !== 0 || !report.stdout.includes('Sway complete-product readiness: HOLD')) {
  failures.push('Readiness report must truthfully report HOLD without claiming launch approval.');
}

const assertion = spawnSync(process.execPath, ['scripts/sway-complete-product-readiness.mjs', '--assert-ready'], {
  cwd: root,
  encoding: 'utf8'
});
if (assertion.status !== 1 || !assertion.stderr.includes('failed closed')) {
  failures.push('Readiness launch assertion must exit 1 and fail closed while blockers remain.');
}

if (failures.length) {
  console.error('Sway complete-product readiness contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway complete-product readiness contract passed.');
