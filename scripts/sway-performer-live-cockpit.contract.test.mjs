import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const talentApp = readFileSync(join(root, 'src/shells/TalentApp.tsx'), 'utf8');
const talentDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const performerRoomShare = readFileSync(join(root, 'src/components/PerformerRoomShare.tsx'), 'utf8');
const performerAudienceScreen = readFileSync(join(root, 'src/components/PerformerAudienceScreen.tsx'), 'utf8');
const liveStyles = readFileSync(join(root, 'src/index.css'), 'utf8');
const performerCockpit = `${talentDashboard}\n${performerRoomShare}\n${performerAudienceScreen}`;
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

for (const term of [
  'if (shouldRenderPerformerLiveRoom(session.status, requestedWorkspace))',
  'h-[var(--sway-viewport-height,100vh)] overflow-hidden',
  '<TalentDashboard',
  '<SplitViewShell'
]) {
  if (!talentApp.includes(term)) failures.push(`TalentApp missing performer cockpit routing term: ${term}`);
}

const activeBranchStart = talentApp.indexOf('if (shouldRenderPerformerLiveRoom(session.status, requestedWorkspace))');
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
  'className="sway-live-layout"',
  'className="sway-live-content"',
  'data-mobile-panel={mobilePanel}',
  "aria-label=\"Live-night sections\""
]) {
  if (!performerCockpit.includes(term)) failures.push(`Performer cockpit missing bounded workspace term: ${term}`);
}

for (const term of ['.sway-live-content { flex: 1; min-height: 0;', 'overflow-y: auto;', '(min-width: 900px) and (min-height: 600px)', '.sway-live-layout[data-mobile-panel="share"]', '.sway-live-layout[data-mobile-panel="settings"]']) {
  if (!liveStyles.includes(term)) failures.push(`Live layout must preserve responsive, reachable controls: ${term}`);
}
if (talentDashboard.includes('more visible after clearing the top items.')) {
  failures.push('Reaching later requests must never require clearing earlier requests.');
}
if (!talentDashboard.includes('aria-label={`${title} request pages`}')) {
  failures.push('Bounded request panels must provide accessible page navigation.');
}

const compactQrStart = performerRoomShare.indexOf('function PerformerRoomQr');
const compactShareStart = performerRoomShare.indexOf('export default function PerformerRoomShare');
const compactQrSource = compactQrStart === -1 || compactShareStart === -1
  ? ''
  : performerRoomShare.slice(compactQrStart, compactShareStart);

if (!compactQrSource.includes('if (!roomLink)')) {
  failures.push('Compact room QR must fail closed when there is no active room link.');
}

if (!performerRoomShare.includes('<PerformerRoomQr activeGigId={activeGigId} size={112} />')
  || !performerAudienceScreen.includes('<PerformerRoomQr activeGigId={activeGigId} size={224} />')) {
  failures.push('Both compact share and audience panels must render the real room QR.');
}

if (talentDashboard.match(/shouldRenderPerformerLiveRoom\(session\.status, inactiveWorkspace\)/g)?.length !== 1) {
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
