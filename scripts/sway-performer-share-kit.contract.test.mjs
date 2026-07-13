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
  'No active live session. Create a room to generate your room link and QR code.',
  'Patrons can scan this QR code or open this room link to land directly in your live Request, Tip, and Boost room.',
  'This print-ready room link and QR sign stay tied to the selected live room.',
  'Copy room link',
  'Copied',
  'Download QR sign',
  'Print QR sign',
  'QR code appears here after you create a room.',
  'data-share-kit-room-qr="true"',
  'bgColor="#ffffff"',
  'fgColor="#000000"',
  'value={roomLink}',
  'key={roomLink}'
]) {
  if (!performerShareKit.includes(term)) {
    failures.push(`PerformerShareKit missing required copy: ${term}`);
  }
}

for (const term of [
  'disabled={!roomLink}',
  'href={roomLink ?? undefined}',
  'aria-disabled={!roomLink}',
  '[activeGigId]'
]) {
  if (!performerShareKit.includes(term)) {
    failures.push(`PerformerShareKit missing required room-state guard: ${term}`);
  }
}

for (const forbidden of [
  'QR display is not available yet. Use the room link for now.',
  'Connect Your Audience',
  'Share Your Room',
  '/room/'
]) {
  if (performerShareKit.includes(forbidden) || talentDashboard.includes(forbidden)) {
    failures.push(`Performer share kit lane must not introduce forbidden term: ${forbidden}`);
  }
}

if (!talentDashboard.includes('<CompactRoomQr activeGigId={activeGigId} size={112} />')
  || !talentDashboard.includes('<CompactRoomQr activeGigId={activeGigId} size={224} />')) {
  failures.push('Canonical performer cockpit must render the selected room QR in its share and audience panels.');
}

if (!packageJson.includes('qrcode.react')) {
  failures.push('Performer share kit lane must install qrcode.react for room-specific QR rendering.');
}

for (const forbiddenPackageTerm of ['react-qr', '@zxing', 'qr-image']) {
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
