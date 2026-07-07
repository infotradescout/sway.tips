import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const overlayApp = readFileSync(join(root, 'src/shells/OverlayApp.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

for (const term of [
  "import { QRCodeCanvas } from 'qrcode.react';",
  'function resolveRoomLink(gigId: string)',
  'const roomLink = resolveRoomLink(routeGigId);',
  'const roomPath = `/g/${routeGigId}`;',
  'aria-label="Scan to open this Sway live room"',
  'Request / Tip / Boost',
  "grid h-full grid-cols-[minmax(0,1fr)_minmax(280px,0.42fr)]",
  'LIVE GIG FEED'
]) {
  if (!overlayApp.includes(term)) failures.push(`OverlayApp missing projector QR term: ${term}`);
}

if (!overlayApp.includes("if (roomLookup.status !== 'active')")) {
  failures.push('OverlayApp must keep the active-room gate before rendering the live projector view.');
}

if (!overlayApp.includes('{transparent ? (') || !overlayApp.includes('{transparent && lyricsOpen && (')) {
  failures.push('Projector audience mode must not render operator-only lyrics controls.');
}

for (const forbidden of ['postJson(', "method: 'POST'", 'method: "POST"', "method: 'DELETE'", 'method: "DELETE"', "method: 'PATCH'", 'method: "PATCH"']) {
  if (overlayApp.includes(forbidden)) failures.push(`OverlayApp must remain read-only for projector/audience display: found ${forbidden}`);
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
if (!testContracts.includes('node scripts/sway-overlay-projector-qr.contract.test.mjs')) {
  failures.push('test:contracts must include the overlay projector QR contract.');
}

if (failures.length) {
  console.error('Overlay projector QR contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Overlay projector QR contract passed.');
