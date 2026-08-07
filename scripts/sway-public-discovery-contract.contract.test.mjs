import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label}: missing ${term}`);
}

for (const path of [
  'docs/PUBLIC_DISCOVERY_CONTRACT_V1.md',
  'docs/process/PUBLIC_DISCOVERY_PHASE1_AUDIT_MATRIX.md'
]) {
  if (!existsSync(join(root, path))) failures.push(`missing ${path}`);
}

const contract = read('docs/PUBLIC_DISCOVERY_CONTRACT_V1.md');
const matrix = read('docs/process/PUBLIC_DISCOVERY_PHASE1_AUDIT_MATRIX.md');
const agents = read('AGENTS.md');

for (const term of [
  'Public Discovery Contract v1',
  'JW Stone',
  'first server response',
  'Do not merge. Do not deploy.',
  'Start a Request',
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

requireIncludes(agents, 'PUBLIC_DISCOVERY_CONTRACT_V1.md', 'AGENTS.md');
requireIncludes(agents, 'PUBLIC_DISCOVERY_PHASE1_AUDIT_MATRIX.md', 'AGENTS.md');

if (failures.length) {
  console.error('Public discovery contract docs failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Public discovery contract docs passed.');
