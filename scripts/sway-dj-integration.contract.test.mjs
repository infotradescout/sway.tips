import { spawnSync } from 'node:child_process';

const checks = [
  ['--import', 'tsx', 'scripts/sway-dj-library-importers.test.mjs'],
  ['scripts/sway-dj-source-controller.test.mjs'],
  ['--import', 'tsx', 'scripts/sway-playback-control-store.integration.test.ts']
];

for (const args of checks) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    console.error(`DJ integration gate failed: node ${args.join(' ')}`);
    process.exit(1);
  }
}

console.log('Sway DJ integration contract passed.');
