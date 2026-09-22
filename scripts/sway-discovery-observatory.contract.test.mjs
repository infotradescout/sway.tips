import { execFileSync } from 'node:child_process';

// Preserve every existing observation, visibility, attribution and capture assertion.
execFileSync(process.execPath, ['scripts/sway-discovery-observatory.legacy.contract.test.mjs'], { stdio: 'inherit' });
// Read-side quality integration is part of the same existing contract gate.
execFileSync(process.execPath, ['--import', 'tsx', '--test', 'scripts/sway-acquisition-dashboard.test.mjs'], { stdio: 'inherit' });
