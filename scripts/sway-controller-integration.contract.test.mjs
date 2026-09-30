import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commands = [
  ['--import', 'tsx', 'scripts/sway-dj-library-importers.test.mjs'],
  ['--import', 'tsx', 'scripts/sway-music-list-import.test.mjs'],
  ['scripts/sway-dj-source-controller.test.mjs'],
  ['scripts/sway-control-bridge-ledger.test.mjs'],
  ['--import', 'tsx', 'scripts/sway-playback-control-store.integration.test.ts'],
  ['--import', 'tsx', 'scripts/sway-windows-booth-launcher.test.ts']
];

try {
  for (const args of commands) {
    execFileSync(process.execPath, args, {
      cwd: root,
      stdio: 'inherit',
      timeout: 180_000
    });
  }
  console.log('Controller integration contract passed: all six child gates passed.');
} catch (error) {
  console.error('Controller integration contract failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
}
