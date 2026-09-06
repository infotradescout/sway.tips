import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
const talentApp = readFileSync(join(root, 'src/shells/TalentApp.tsx'), 'utf8');
const roomRestart = readFileSync(join(root, 'src/components/PerformerRoomRestart.tsx'), 'utf8');

const failures = [];

const requiredRoutes = [
  '/talent/login',
  '/talent/signup',
  '/talent/gigs',
  '/g/',
  '/p/',
  '/overlay/',
  '/admin'
];

for (const route of requiredRoutes) {
  if (!app.includes(route)) failures.push(`Missing separated route: ${route}`);
}

const sandboxPatterns = [
  /userMode/i,
  /setUserMode/i,
  /sandbox/i,
  /TEST ENVIRONMENT PROFILE/i,
  /Patron scan view/i,
  /Talent booth screen/i
];

for (const pattern of sandboxPatterns) {
  if (pattern.test(app)) failures.push(`App route shell contains sandbox role-switching pattern: ${pattern}`);
}

const patronBlockStart = app.indexOf('<PatronView');
if (patronBlockStart === -1) failures.push('Patron route branch missing.');

for (const forbidden of [
  "import TalentDashboard from './components/TalentDashboard'",
  "import TalentLoginCard from './components/TalentLoginCard'",
  "import TalentSignupCard from './components/TalentSignupCard'",
  "route.name === 'talent-gigs'",
  'handleStartSession',
  'handleEndSession',
  'handleCloseout',
  'handleTriageRequest',
  'handleFulfillRequest'
]) {
  if (app.includes(forbidden)) failures.push(`Legacy/dev App must not own performer runtime behavior: ${forbidden}`);
}

for (const required of [
  "import TalentDashboard from '../components/TalentDashboard'",
  "import PerformerRoomRestart from '../components/PerformerRoomRestart'",
  "pathname === '/talent/login'",
  "pathname === '/talent/signup'",
  'handleStartSession',
  'handleEndSession',
  'handleCloseout',
  'handleTriageRequest',
  'handleFulfillRequest',
  '<PerformerRoomRestart'
]) {
  if (!talentApp.includes(required)) failures.push(`Canonical TalentApp missing performer runtime behavior: ${required}`);
}

// The recap moved into a performer-owned restart component; it was not removed.
// Check both layers so replacing the recap with an empty wrapper cannot pass.
for (const required of [
  "import VictoryScreen from './VictoryScreen'",
  '<VictoryScreen session={session} requests={requests}',
  '<PerformerRoomSetup',
  'onStartSession={startNextRoom}'
]) {
  if (!roomRestart.includes(required)) failures.push(`Performer restart must preserve recap and reviewed setup: ${required}`);
}
const restartBlock = /<PerformerRoomRestart\b[\s\S]*?\/>/.exec(talentApp)?.[0] ?? '';
if (!restartBlock.includes('onStartSession={handleStartSession}')) {
  failures.push('Performer restart must use the canonical guarded room-start handler.');
}

if (failures.length) {
  console.error('Role route separation contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Role route separation contract passed.');
