import { spawnSync } from 'node:child_process';

// One direct hard gate also exposed as npm run test:music-sources.
for (const script of [
  'scripts/sway-music-sources-failure-exit.test.mjs',
  'scripts/sway-music-list-import.test.mjs',
  'scripts/sway-music-file-import.test.mjs',
  'scripts/sway-library-source-count.behavior.test.ts',
  'scripts/sway-music-sources.browser.test.mjs'
]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', script], { stdio: 'inherit', timeout: 300000 });
  if (result.error || result.signal || result.status !== 0) {
    console.error('Music Sources acceptance failed:', script, result.error?.message || result.signal || result.status);
    process.exit(1);
  }
}
