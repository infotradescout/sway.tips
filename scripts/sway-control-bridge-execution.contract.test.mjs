import { spawnSync } from 'node:child_process';

// The repository hard gate requires a direct script with explicit failure
// propagation. The child remains Node's real test runner, including exit codes.
const result = spawnSync(process.execPath, ['--test',
  'scripts/sway-control-bridge-execution.behavior.test.mjs',
  'scripts/sway-control-bridge-reconnect.behavior.test.mjs',
], { stdio: 'inherit', windowsHide: true, timeout: 60_000 });
if (result.error || result.signal || result.status !== 0) {
  console.error('Sway bridge execution/reconnect behavior gate failed.', result.error?.message ?? result.signal ?? result.status);
  process.exit(1);
}
console.log('Sway bridge execution/reconnect behavior gate passed.');
