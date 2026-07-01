import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const nativeBridge = readFileSync(join(root, 'src/native/swayNativeBridge.ts'), 'utf8');
const patronView = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const wildcardDoc = readFileSync(join(root, 'docs/SWAY_WILDCARD_OBJECTIONS_ADDENDUM.md'), 'utf8');

const failures = [];

for (const term of [
  'getInitialNetworkStatus',
  'subscribeToNetworkStatus',
  'capacitor-network',
  'networkStatusChange',
  'browser-window',
  'isNativePlatform'
]) {
  if (!nativeBridge.includes(term)) failures.push(`Native bridge missing term: ${term}`);
}

for (const term of [
  "import { getInitialNetworkStatus, subscribeToNetworkStatus } from '../native/swayNativeBridge';",
  'subscribeToNetworkStatus((status) => {',
  '!getInitialNetworkStatus().connected'
]) {
  if (!patronView.includes(term)) failures.push(`PatronView missing native utility wiring: ${term}`);
}

if (!wildcardDoc.includes('scripts/sway-native-utility.contract.test.mjs')) {
  failures.push('Wildcard objections addendum must reference scripts/sway-native-utility.contract.test.mjs.');
}

if (failures.length) {
  console.error('Native utility contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Native utility contract passed.');
