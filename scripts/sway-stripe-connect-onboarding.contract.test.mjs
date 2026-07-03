import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
const connectSource = readFileSync(join(root, 'src/server/stripe-connect.ts'), 'utf8');
const talentDashboardSource = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');

const failures = [];

const requiredServerTerms = [
  "app.post('/api/talent/connect/onboard'",
  'stripeConnectService.createRecipientAccount',
  'stripeConnectService.createOnboardingLink',
  "console.error('Stripe Connect onboarding failed.'",
  'Stripe Connect onboarding could not be started',
  'return res.status(502).json'
];

for (const term of requiredServerTerms) {
  if (!serverSource.includes(term)) {
    failures.push(`Connect onboarding route missing required JSON failure term: ${term}`);
  }
}

const requiredConnectTerms = [
  'STRIPE_API_VERSION',
  "apiVersion: STRIPE_API_VERSION",
  'stripe.v2.core.accounts.create',
  'configuration:',
  'recipient:',
  'stripe_transfers',
  "dashboard: 'express'",
  'stripe.parseEventNotification',
  'v2.core.account_link.returned',
  "event.type !== 'account.updated'"
];

for (const term of requiredConnectTerms) {
  if (!connectSource.includes(term)) {
    failures.push(`Connect service missing required Accounts v2 term: ${term}`);
  }
}

const bannedConnectPatterns = [
  /accounts\.create\(\s*\{\s*type:\s*['"]express['"]/,
  /type:\s*['"]custom['"]/,
  /type:\s*['"]standard['"]/
];

for (const pattern of bannedConnectPatterns) {
  if (pattern.test(connectSource)) {
    failures.push(`Connect service contains banned legacy account-type pattern: ${pattern}`);
  }
}

const connectRouteStart = serverSource.indexOf("app.post('/api/talent/connect/onboard'");
const connectRouteEnd = serverSource.indexOf("app.get('/talent/connect/refresh'", connectRouteStart);
const connectRouteSource = connectRouteStart >= 0 && connectRouteEnd > connectRouteStart
  ? serverSource.slice(connectRouteStart, connectRouteEnd)
  : '';

if (!/try\s*\{[\s\S]*createRecipientAccount[\s\S]*createOnboardingLink[\s\S]*\}\s*catch\s*\(error\)/.test(connectRouteSource)) {
  failures.push('Connect onboarding Stripe account/link creation must be wrapped in try/catch.');
}

if (!talentDashboardSource.includes('await response.json().catch(() => null)')) {
  failures.push('Talent dashboard must tolerate non-JSON Connect onboarding failures.');
}

if (/Unexpected token.*DOCTYPE/i.test(talentDashboardSource)) {
  failures.push('Talent dashboard must not expose raw HTML parse errors for Connect onboarding.');
}

if (failures.length) {
  console.error('Stripe Connect onboarding contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Stripe Connect onboarding contract passed.');
