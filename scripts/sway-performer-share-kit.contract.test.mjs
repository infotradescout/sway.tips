import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const performerShareKitPath = join(root, 'src/components/PerformerShareKit.tsx');
const talentDashboardPath = join(root, 'src/components/TalentDashboard.tsx');
const packageJsonPath = join(root, 'package.json');

const performerShareKit = readFileSync(performerShareKitPath, 'utf8');
const talentDashboard = readFileSync(talentDashboardPath, 'utf8');
const packageJson = readFileSync(packageJsonPath, 'utf8');

if (!performerShareKit.includes('activeGigId')) {
  failures.push('PerformerShareKit must accept or reference activeGigId.');
}

if (!performerShareKit.includes('new URL(`/g/${activeGigId}`, window.location.origin).toString()')) {
  failures.push('PerformerShareKit must build the room link from /g/{activeGigId}.');
}

if (performerShareKit.includes('/room/')) {
  failures.push('PerformerShareKit must not introduce /room/ routes.');
}

for (const term of [
  'No active live session. Start a session to generate your room link.',
  'Copy room link',
  'Copied',
  'QR display is not available yet. Use the room link for now.'
]) {
  if (!performerShareKit.includes(term)) {
    failures.push(`PerformerShareKit missing required copy: ${term}`);
  }
}

for (const forbidden of [
  'Download QR',
  'Download QR Sign',
  'Print QR',
  'Connect Your Audience',
  'Share Your Room',
  '/room/',
  'QRCode',
  'qr-code',
  'qrcode'
]) {
  if (performerShareKit.includes(forbidden) || talentDashboard.includes(forbidden)) {
    failures.push(`Performer share kit lane must not introduce forbidden term: ${forbidden}`);
  }
}

if (!talentDashboard.includes("import PerformerShareKit from './PerformerShareKit';")) {
  failures.push('TalentDashboard must import PerformerShareKit.');
}

if (!talentDashboard.includes('<PerformerShareKit activeGigId={activeGigId} />')) {
  failures.push('TalentDashboard must render PerformerShareKit.');
}

for (const forbiddenPackageTerm of ['react-qr', 'qrcode', '@zxing', 'qr-image']) {
  if (packageJson.includes(forbiddenPackageTerm)) {
    failures.push(`No QR dependency may be added in this lane: ${forbiddenPackageTerm}`);
  }
}

if (!packageJson.includes('node scripts/sway-performer-share-kit.contract.test.mjs')) {
  failures.push('package.json must register the performer share kit contract in test:contracts.');
}

if (failures.length) {
  console.error('Performer share kit contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Performer share kit contract passed.');
