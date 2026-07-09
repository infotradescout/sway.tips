import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const businessStore = readFileSync(join(root, 'src/server/business-store.ts'), 'utf8');
const types = readFileSync(join(root, 'src/types.ts'), 'utf8');
const talentDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const patronView = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const overlayApp = readFileSync(join(root, 'src/shells/OverlayApp.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

for (const term of [
  "operatingMode: 'manual' | 'open_call' | 'crowd_autopilot'",
  "mode !== 'manual' && mode !== 'open_call' && mode !== 'crowd_autopilot'",
  "roomState.session.operatingMode === 'crowd_autopilot'",
  'shouldAutopilotApprove',
  "status: shadowBanned ? 'hold' : (isStraightTip ? 'fulfilled' : (shouldAutopilotApprove ? 'approved' : 'hold'))",
  'crowd_autopilot_auto_approved: shouldAutopilotApprove',
  "input.operatingMode === 'open_call' || input.operatingMode === 'crowd_autopilot'",
  'clean_requests_auto_approved_after_moderation_and_payment_authorization'
]) {
  if (!server.includes(term) && !businessStore.includes(term) && !types.includes(term)) {
    failures.push(`Crowd autopilot runtime missing term: ${term}`);
  }
}

for (const term of [
  'data-sway-crowd-autopilot-control="true"',
  "onSetMode('crowd_autopilot')",
  'Autopilot live',
  'Clean requests jump straight to up next',
  'Autopilot is moving clean requests into the queue',
  'Crowd Picks What Is Next'
]) {
  if (!talentDashboard.includes(term)) {
    failures.push(`Talent cockpit missing crowd autopilot UX term: ${term}`);
  }
}

for (const term of [
  'Crowd Autopilot',
  'Clean requests can move straight into the crowd-ranked queue',
  'Clean requests can move into up next automatically'
]) {
  if (!patronView.includes(term)) {
    failures.push(`Patron room missing crowd autopilot copy term: ${term}`);
  }
}

for (const term of [
  'Crowd Pick Leading',
  'Crowd Ranked Up Next',
  'Crowd Controls Next',
  'Scan to control what comes next'
]) {
  if (!overlayApp.includes(term)) {
    failures.push(`Projector overlay missing crowd autopilot term: ${term}`);
  }
}

const requestCreateStart = server.indexOf('app.post("/api/request/create"');
const requestCreateEnd = server.indexOf('// Boost an existing request', requestCreateStart);
const requestCreateRoute = requestCreateStart === -1 || requestCreateEnd === -1
  ? ''
  : server.slice(requestCreateStart, requestCreateEnd);

if (requestCreateRoute.includes('resolveProtectedMutationActor(req, res')) {
  failures.push('Crowd autopilot request creation must not require a performer mutation actor in the patron happy path.');
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
if (!testContracts.includes('node scripts/sway-crowd-autopilot.contract.test.mjs')) {
  failures.push('test:contracts must include the crowd autopilot contract.');
}

if (failures.length) {
  console.error('Crowd autopilot contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Crowd autopilot contract passed.');
