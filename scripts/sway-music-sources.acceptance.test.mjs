import { spawnSync } from 'node:child_process';

// Required by the registered library-availability contract. Each child must
// finish successfully; cleanup or a missing browser cannot create a soft pass.
for (const script of [
  'scripts/sway-music-sources-failure-exit.test.mjs',
  'scripts/sway-music-list-import.test.mjs',
  'scripts/sway-music-file-import.test.mjs',
  'scripts/sway-library-source-count.behavior.test.ts',
  'scripts/sway-virtualdj-network-control.behavior.test.mjs',
  'scripts/sway-music-sources.browser.test.mjs'
]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], { stdio: 'inherit', timeout: 300000 });
  if (result.error || result.signal || result.status !== 0) {
    console.error('Music Sources acceptance failed:', script, result.error?.message || result.signal || result.status);
    process.exit(1);
  }
}
