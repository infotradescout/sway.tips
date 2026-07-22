import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import './sway-core-product-completion.contract.mjs';

const root = process.cwd();

const requiredFiles = [
  'README.md',
  'docs/SWAY_DAY1_BUILD_CONTRACT.md',
  'docs/SWAY_APPSTORE_ROADMAP.md',
  'docs/SWAY_PRODUCT_SPINE.md',
  'docs/SWAY_LAUNCH_GATE.md',
  'docs/SWAY_ENVIRONMENT_CONTRACT.md'
];

const requiredAppRoutes = [
  '/talent/login',
  '/talent/signup',
  '/talent/gigs',
  '/g/',
  '/p/',
  '/overlay/',
  '/admin'
];

const bannedRuntimePatterns = [
  /AI Studio/i,
  /DJ Shadow/i,
  /Gemini Vibe/i,
  /generatedByAI/i,
  /Apple Pay/i,
  /Google Pay/i,
  /authorized cards/i,
  /Escrow Authorized/i,
  /Payment Authorized/i,
  /Simulating Hold/i,
  /demo-\d/i,
  /mockup/i
];

const runtimeFiles = [
  'server.ts',
  'src/App.tsx',
  'src/components/PatronView.tsx',
  'src/components/TalentDashboard.tsx',
  'src/components/VictoryScreen.tsx',
  'src/types.ts'
];

const failures = [];

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) {
    failures.push(`Missing required spine file: ${file}`);
  }
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (packageJson.name !== 'sway-tips') {
  failures.push(`package.json name must be "sway-tips"; found "${packageJson.name}"`);
}

const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8');
for (const route of requiredAppRoutes) {
  if (!appSource.includes(route)) {
    failures.push(`App route spine missing "${route}"`);
  }
}

const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
if (!serverSource.includes('requirePersistentBusinessStore')) {
  failures.push('Production write guard is missing from server.ts');
}

if (/return\s+\{\s*isAllowed:\s*true\s*\}\s*;\s*\/\/\s*No AI configured/i.test(serverSource)) {
  failures.push('Moderation still fails open when AI is not configured');
}

for (const file of runtimeFiles) {
  const source = readFileSync(join(root, file), 'utf8');
  for (const pattern of bannedRuntimePatterns) {
    if (pattern.test(source)) {
      failures.push(`${file} contains banned runtime pattern: ${pattern}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Sway contract check failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Sway contract check passed.');
