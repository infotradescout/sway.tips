import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const planPath = join(root, 'docs/SWAY_SURFACE_SPLIT_ARCHITECTURE_PLAN.md');
const plan = readFileSync(planPath, 'utf8');
const lowerPlan = plan.toLowerCase();
const failures = [];

function requireIncludes(term, message) {
  if (!plan.includes(term)) failures.push(message);
}

function requireLower(term, message) {
  if (!lowerPlan.includes(term.toLowerCase())) failures.push(message);
}

for (const surface of [
  'Public Web Layer',
  'Patron App',
  'Performer/DJ App',
  'Operator App',
  'Overlay',
  'Admin/Ops'
]) {
  requireIncludes(surface, `Surface split plan must name ${surface}.`);
}

for (const shell of [
  'PublicWebShell',
  'PatronAppShell',
  'PerformerAppShell',
  'OperatorAppShell',
  'OverlayShell',
  'AdminOpsShell'
]) {
  requireIncludes(shell, `Surface split plan must require ${shell}.`);
}

for (const route of [
  '/',
  '/room/:roomId',
  '/app',
  '/patron',
  '/performer',
  '/dj',
  '/operator',
  '/overlay',
  '/admin',
  '/ops'
]) {
  requireIncludes(route, `Surface split plan must define target route ${route}.`);
}

for (const term of [
  'physically isolated',
  'not role-conditionals inside one primary wrapper',
  'Patron App and Operator App must not share the same primary shell wrapper',
  'god shell',
  'PublicWebShell must consume the same CSS variables/tokens as the core app',
  '--night',
  '--rose',
  '--mint',
  'Generic SaaS UI libraries/templates are forbidden',
  'configure Stripe',
  'introduce live payment logic',
  'payment behavior must remain fail-closed',
  'pause/end submission blocks',
  'manual Boost approval gates',
  'weaken access/role guards',
  'Overlay remains display-only'
]) {
  requireIncludes(term, `Surface split plan missing Objector gate term: ${term}`);
}

for (const vocab of [
  'Request',
  'Tip',
  'Boost',
  'Pending',
  'Approved',
  'Playing',
  'Up Next',
  'Paused',
  'Ended',
  'Demo',
  'Live Room'
]) {
  requireIncludes(vocab, `Surface split plan missing required vocabulary: ${vocab}`);
}

for (const styleTerm of [
  'color tokens',
  'typography',
  'button styles',
  'cards/panels',
  'live-room glow/energy',
  'dark-first assumptions',
  'glow/contrast',
  'button treatment'
]) {
  requireLower(styleTerm, `Surface split plan missing style preservation requirement: ${styleTerm}`);
}

for (const banned of [
  'Patron Preview',
  'Admin Preview',
  'Preview only',
  'Preview total shown',
  'DEMO PREVIEW DATA',
  'SWAY LIVE LADDER',
  'Payment lifecycle preview'
]) {
  if (plan.includes(banned)) {
    failures.push(`Surface split plan contains stale terminology: ${banned}`);
  }
}

if (failures.length) {
  console.error('Surface split architecture plan contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Surface split architecture plan contract passed.');
