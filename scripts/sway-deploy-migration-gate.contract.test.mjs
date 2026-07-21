import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const read = (path) => readFileSync(join(root, path), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label} missing term: ${term}`);
}

const renderYaml = read('render.yaml');
const packageJson = JSON.parse(read('package.json'));
const ciWorkflow = read('.github/workflows/ci.yml');

// The deployment definition must invoke migrations before the new
// application version takes traffic. Render's preDeployCommand runs after
// build but before the new instance is put into service -- this is what
// closes the gap that caused the Slice 1A production incident (code went
// live assuming schema that had never been migrated). A failing
// preDeployCommand blocks the deploy by Render's own platform contract; this
// test can only prove the gate is wired, not independently re-prove Render's
// own fail-closed behavior.
requireIncludes(renderYaml, 'preDeployCommand: npm run db:migrate', 'render.yaml deployment definition');

// db:migrate must actually run drizzle-kit's real migration runner, not a
// placeholder or a no-op.
requireIncludes(packageJson.scripts?.['db:migrate'] ?? '', 'drizzle-kit migrate', 'package.json db:migrate script');

// CI must independently prove the migration ledger stays reconcilable
// (see sway-pro-mode-migration.integration.test.mjs) and that the public
// room-state projection boundary holds, on every push/PR -- not just at
// deploy time.
for (const term of [
  'test:integration:pro-mode-migration',
  'test:integration:public-room-state-projection'
]) {
  requireIncludes(ciWorkflow, term, 'CI workflow');
}

if (failures.length) {
  console.error('Deploy migration gate contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Deploy migration gate contract passed.');
