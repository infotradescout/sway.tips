import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'scripts/sway-windows-booth-launcher.test.ts'],
  { cwd: process.cwd(), encoding: 'utf8' }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  console.error('Sway Windows booth launcher contract failed.');
  process.exit(1);
}

console.log('Sway Windows booth launcher contract passed.');
