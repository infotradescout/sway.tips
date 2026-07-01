import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const patronApp = readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(message);
}

for (const term of [
  'Scan',
  'Create account',
  'Login',
  'sway to play',
  'https://sway.tips/'
]) {
  requireIncludes(patronApp, term, `Patron recovery copy missing required term: ${term}`);
}

for (const forbidden of [
  /checkout/i,
  /invoice/i,
  /desk board/i,
  /captured total/i,
  /\bMVP\b/i,
  /\bbeta\b/i
]) {
  const recoveryStart = patronApp.indexOf('function PatronNoSessionRecovery');
  const recoverySource = recoveryStart === -1 ? patronApp : patronApp.slice(recoveryStart);
  if (forbidden.test(recoverySource)) {
    failures.push(`Patron recovery contains forbidden terminology: ${forbidden}`);
  }
}

if (/getUserMedia|MediaDevices|Html5Qrcode|QrReader|react-qr-reader/i.test(patronApp)) {
  failures.push('Patron recovery must not introduce QR camera or scanner implementation.');
}

if (/analytics|segment|mixpanel|amplitude|gtag|ga\(|posthog|telemetry/i.test(patronApp)) {
  failures.push('Patron recovery must not introduce telemetry or tracking frameworks.');
}

for (const term of [
  'const hasPatronRouteContext',
  'const hasSessionContext',
  'const shouldShowNoSessionRecovery'
]) {
  requireIncludes(patronApp, term, `Patron recovery detection missing term: ${term}`);
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
requireIncludes(
  testContracts,
  'node scripts/sway-patron-recovery.contract.test.mjs',
  'test:contracts must include the patron recovery contract.'
);

if (failures.length) {
  console.error('Patron recovery contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Patron recovery contract passed.');
