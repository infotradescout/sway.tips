import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const talentApp = readFileSync(join(root, 'src/shells/TalentApp.tsx'), 'utf8');
const talentDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

for (const term of [
  "if (session.status !== 'inactive')",
  'h-[var(--sway-viewport-height,100vh)] overflow-hidden',
  '<TalentDashboard',
  '<SplitViewShell'
]) {
  if (!talentApp.includes(term)) failures.push(`TalentApp missing performer cockpit routing term: ${term}`);
}

const activeBranchStart = talentApp.indexOf("if (session.status !== 'inactive')");
const activeBranchEnd = activeBranchStart === -1 ? -1 : talentApp.indexOf('return (', talentApp.indexOf('return (', activeBranchStart) + 1);
const activeBranch = activeBranchStart === -1 || activeBranchEnd === -1
  ? ''
  : talentApp.slice(activeBranchStart, activeBranchEnd);

if (activeBranch.includes('<SplitViewShell')) {
  failures.push('Active performer rooms must bypass SplitViewShell so the live console keeps the full phone viewport.');
}

for (const term of [
  'data-sway-performer-live-cockpit="true"',
  'data-sway-performer-audience-screen="true"',
  'data-sway-compact-room-qr="true"',
  '<QRCodeCanvas',
  'value={roomLink}',
  'Scan to open this live Sway room',
  'Scan to Request',
  'h-[var(--sway-viewport-height,100vh)] overflow-hidden',
  'grid-rows-[auto_auto_auto_auto_minmax(0,1fr)_auto]',
  'landscape:grid-rows-[auto_auto_minmax(0,1fr)_auto]',
  'landscape:grid-cols-[minmax(0,1fr)_minmax(280px,0.45fr)]',
  'landscape:hidden',
  "aria-label=\"Live-night sections\""
]) {
  if (!talentDashboard.includes(term)) failures.push(`TalentDashboard missing no-scroll cockpit term: ${term}`);
}

const compactQrStart = talentDashboard.indexOf('function CompactRoomQr');
const compactShareStart = talentDashboard.indexOf('function CompactSharePanel');
const compactQrSource = compactQrStart === -1 || compactShareStart === -1
  ? ''
  : talentDashboard.slice(compactQrStart, compactShareStart);

if (!compactQrSource.includes('if (!roomLink)')) {
  failures.push('Compact room QR must fail closed when there is no active room link.');
}

if (!talentDashboard.includes('<CompactRoomQr activeGigId={activeGigId} size={112} />')
  || !talentDashboard.includes('<CompactRoomQr activeGigId={activeGigId} size={224} />')) {
  failures.push('Both compact share and audience panels must render the real room QR.');
}

if (talentDashboard.match(/session\.status !== 'inactive'/g)?.length !== 2) {
  failures.push('TalentDashboard must have one active-room branch and no second live-session renderer below it.');
}

for (const retiredParallelSurface of [
  'FEATURED PERFORMER PREMIUM HUB',
  'Earnings tonight',
  '3. Live Core Session Workflows'
]) {
  if (talentDashboard.includes(retiredParallelSurface)) {
    failures.push(`TalentDashboard still contains retired parallel live UI: ${retiredParallelSurface}`);
  }
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
if (!testContracts.includes('node scripts/sway-performer-live-cockpit.contract.test.mjs')) {
  failures.push('test:contracts must include the performer live cockpit contract.');
}

if (failures.length) {
  console.error('Performer live cockpit contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Performer live cockpit contract passed.');
