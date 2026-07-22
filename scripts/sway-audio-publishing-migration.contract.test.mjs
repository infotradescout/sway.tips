import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const migration = join(root, 'drizzle/0023_audio_publishing_foundation.sql');
if (!existsSync(migration)) failures.push('Historical migration 0023 must remain available for ordered production migration replay.');
const spine = readFileSync(join(root, 'docs/SWAY_PRODUCT_SPINE.md'), 'utf8');
if (!spine.includes('Historical schema for retired experiments remains untouched')) {
  failures.push('Product spine must distinguish retained historical schema from active product scope.');
}
if (failures.length) {
  console.error('Sway retired migration safety contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('Sway retired migration safety contract passed.');
