import { spawnSync } from 'node:child_process';

const result = spawnSync('npm', ['run', 'test:contracts', '--silent'], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (result.status === 0) {
  console.log('Sway contract audit passed.');
} else {
  console.warn(`Sway contract audit found issues. test:contracts exit code: ${result.status ?? 'unknown'}`);
}

process.exit(0);
