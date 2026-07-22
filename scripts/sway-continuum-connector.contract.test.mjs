import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const spine = readFileSync(join(root, 'docs/SWAY_PRODUCT_SPINE.md'), 'utf8');
const restart = readFileSync(join(root, 'docs/SWAY_RESTART_TRUTH_MAP.md'), 'utf8');
if (!spine.includes('Supporting profiles, libraries, integrations, overlays, and admin tools must directly serve the live loop.')) {
  failures.push('Integrations must be subordinate to the live customer/performer loop.');
}
if (!restart.includes('Do not restart music distribution')) {
  failures.push('Restart truth map must block connector-driven scope re-entry.');
}
if (failures.length) {
  console.error('Sway connector scope contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('Sway connector scope contract passed.');
