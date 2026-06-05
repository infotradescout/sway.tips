import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const wildCard = readFileSync(join(root, 'docs/SWAY_WILD_CARD_RISK_ADDENDUM.md'), 'utf8');
const wildcardObjections = readFileSync(join(root, 'docs/SWAY_WILDCARD_OBJECTIONS_ADDENDUM.md'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');

const failures = [];

for (const term of [
  'native push notifications',
  'native local notifications',
  'native deep link handling',
  'native secure storage',
  'native network status integration',
  'native payment SDK path',
  'must not be submitted as a simple webview wrapper'
]) {
  if (!wildCard.includes(term)) failures.push(`Missing native minimum functionality term: ${term}`);
}

for (const term of [
  'scripts/sway-native-minimum-functionality.contract.test.mjs',
  'No App Store submission as a web-only wrapper'
]) {
  if (!wildCard.includes(term) && !wildcardObjections.includes(term)) {
    failures.push(`Missing native wrapper contract term: ${term}`);
  }
}

const nativeWrapperSignals = [
  existsSync(join(root, 'ios')),
  existsSync(join(root, 'android')),
  existsSync(join(root, 'capacitor.config.ts')),
  existsSync(join(root, 'capacitor.config.json')),
  /@capacitor\//.test(packageJson)
];

if (nativeWrapperSignals.some(Boolean)) {
  const nativeCapabilityDocs = [
    'native push notifications',
    'native deep link handling',
    'native secure storage',
    'native network status integration'
  ];
  for (const term of nativeCapabilityDocs) {
    if (!wildCard.includes(term) && !wildcardObjections.includes(term)) {
      failures.push(`Native wrapper present without documented utility: ${term}`);
    }
  }
}

if (/webview-only|web-only wrapper/i.test(packageJson)) {
  failures.push('Package metadata must not present Sway as a webview-only native wrapper.');
}

if (failures.length) {
  console.error('Native minimum functionality contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Native minimum functionality contract passed.');
