import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const proxySource = readFileSync('src/server/trusted-proxy.ts', 'utf8');
const environmentExample = readFileSync('.env.example', 'utf8');

for (const term of [
  "environment.RENDER === 'true'",
  "environment.RENDER_SERVICE_TYPE === 'web'",
  "mode: 'render'",
  "app.set('trust proxy', true)",
  'must be empty on Render web services'
]) {
  if (!proxySource.includes(term)) {
    console.error(`Trusted proxy source is missing: ${term}`);
    process.exit(1);
  }
}

if (!environmentExample.includes('SWAY_TRUSTED_PROXY_CIDRS=""')) {
  console.error('The non-Render exact proxy-CIDR boundary is missing from .env.example.');
  process.exit(1);
}

function runProof(label, scriptPath) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', scriptPath],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit'
    }
  );

  if (result.error) {
    console.error(`${label} could not start:`);
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
    process.exit(1);
  }
}

runProof('Trusted proxy boundary contract', 'scripts/sway-trusted-proxy.integration.test.ts');
runProof('Moderation active-block PostgreSQL contract', 'scripts/sway-moderation-active-blocks.integration.test.mjs');

console.log('Moderation proxy, UTC report-window, retention, and active-block PostgreSQL contract passed.');
