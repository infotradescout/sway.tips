import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');

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

const talentBlockStart = app.indexOf("route.name === 'talent-gigs'");
const patronBlockStart = app.indexOf('<PatronView');
if (talentBlockStart === -1) failures.push('Talent route branch missing.');
if (patronBlockStart === -1) failures.push('Patron route branch missing.');
if (talentBlockStart !== -1 && patronBlockStart !== -1 && talentBlockStart > patronBlockStart) {
  failures.push('Talent and patron route branches are not cleanly separated.');
}

if (failures.length) {
  console.error('Role route separation contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Role route separation contract passed.');
