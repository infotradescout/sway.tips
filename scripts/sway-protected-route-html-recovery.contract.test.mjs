import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const access = readFileSync(join(root, 'src/server/access-control.ts'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(message);
}

function requirePattern(source, pattern, message) {
  if (!pattern.test(source)) failures.push(message);
}

requireIncludes(
  access,
  'function isBrowserHtmlRequest(req: Request)',
  'Access control must define a narrow browser HTML detection helper.'
);

requirePattern(
  access,
  /req\.method\s*===\s*['"]GET['"]/,
  'HTML recovery must be gated by GET.'
);

requirePattern(
  access,
  /typeof accept === ['"]string['"][\s\S]{0,100}accept\.includes\(['"]text\/html['"]\)/,
  'HTML recovery must require an explicit Accept: text/html header.'
);

if (/headers\.accept\s*\?\?/.test(access) || /accept\s*\|\|\s*['"]text\/html['"]/.test(access)) {
  failures.push('Missing Accept header must not default to HTML recovery.');
}

requireIncludes(
  access,
  'res.status(result.status).json({ error: result.reason });',
  'JSON/non-HTML failed protected route requests must preserve the existing JSON response.'
);

requirePattern(
  access,
  /if \(isBrowserHtmlRequest\(req\)\) \{[\s\S]*?\.set\(\{ ['"]Content-Type['"]:\s*['"]text\/html; charset=utf-8['"] \}\)[\s\S]*?\.send\(renderProtectedRouteRecovery\(result\.status, result\.reason(?:,[\s\S]*?)?\)\);[\s\S]*?return;[\s\S]*?\}\s*res\.status\(result\.status\)\.json\(\{ error: result\.reason \}\);/,
  'HTML recovery branch must return before the JSON fallback, and JSON fallback must remain after it.'
);

const guardFailureIndex = access.indexOf('if (result.allowed === false)');
const htmlBranchIndex = access.indexOf('if (isBrowserHtmlRequest(req))', guardFailureIndex);
const nextAfterFailureIndex = access.indexOf('next();', guardFailureIndex);
if (guardFailureIndex === -1 || htmlBranchIndex === -1) {
  failures.push('Failed protected route branch must contain the HTML recovery check.');
}
if (guardFailureIndex !== -1 && nextAfterFailureIndex !== -1 && nextAfterFailureIndex < access.indexOf('req.headers', guardFailureIndex)) {
  failures.push('Failed protected route branch must not call next().');
}

for (const term of [
  "req.path.startsWith('/api')",
  "req.path.startsWith('/assets')",
  "req.path.startsWith('/shells')",
  'routeFamilyGuard(accessControl)'
]) {
  requireIncludes(server, term, `Server must preserve middleware exclusion/wiring term: ${term}`);
}

for (const term of [
  'Session needed',
  'Sign in to continue',
  'This Sway area needs an active performer or operator session.',
  'Return home'
]) {
  requireIncludes(access, term, `Recovery HTML missing Sway-safe copy: ${term}`);
}

requireIncludes(
  access,
  "shell === 'talent' || shell === 'overlay' ? '/talent/login' : null",
  'Talent and overlay recovery HTML must link to the performer sign-in page, not just the homepage.'
);

for (const forbidden of [
  /checkout/i,
  /invoice/i,
  /desk board/i,
  /captured total/i,
  /preview/i,
  /stack trace/i,
  /MVP/i,
  /beta/i
]) {
  const recoveryStart = access.indexOf('function renderProtectedRouteRecovery');
  const recoverySource = recoveryStart === -1 ? access : access.slice(recoveryStart, access.indexOf('function resolveActor', recoveryStart));
  if (forbidden.test(recoverySource)) {
    failures.push(`Recovery HTML contains forbidden terminology: ${forbidden}`);
  }
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
requireIncludes(
  testContracts,
  'node scripts/sway-protected-route-html-recovery.contract.test.mjs',
  'test:contracts must include the protected route HTML recovery contract.'
);

if (failures.length) {
  console.error('Protected route HTML recovery contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Protected route HTML recovery contract passed.');
