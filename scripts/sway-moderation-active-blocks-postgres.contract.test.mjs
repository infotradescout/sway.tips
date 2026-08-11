import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'scripts/sway-moderation-active-blocks.integration.test.mjs'],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  }
);

if (result.error) {
  console.error('Moderation active-block PostgreSQL contract could not start:');
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`Moderation active-block PostgreSQL contract failed with exit code ${result.status ?? 'unknown'}.`);
  process.exit(1);
}

console.log('Moderation active-block PostgreSQL contract passed.');
