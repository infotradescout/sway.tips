import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_DAY1_BUILD_CONTRACT.md'), 'utf8');
const runtime = [
  'server.ts',
  'src/App.tsx',
  'src/components/PatronView.tsx',
  'src/components/TalentDashboard.tsx',
  'src/components/VictoryScreen.tsx',
  'src/types.ts'
].map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

const requiredTerms = [
  'auto_closeout_at',
  'last_activity_at',
  'auto_closeout_reason',
  'closeout_policy',
  'hard closeout worker',
  'void/refund unresolved holds',
  'audit events for every transition',
  'started_at + 4 hours',
  'scheduled_end_at + 30 minutes'
];

const failures = [];
for (const term of requiredTerms) {
  if (!doc.includes(term)) failures.push(`Missing auto-closeout contract term: ${term}`);
}

const bannedRuntime = [
  /manual-only closeout/i,
  /manual closeout only/i,
  /closeout depends on performer/i,
  /performer must close out/i,
  /auto-nuk/i
];

for (const pattern of bannedRuntime) {
  if (pattern.test(runtime)) failures.push(`Runtime contains prohibited auto-closeout pattern: ${pattern}`);
}

if (failures.length) {
  console.error('Auto-closeout contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Auto-closeout contract passed.');
