import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md'), 'utf8');

const requiredEntries = [
  'src/entries/patron.tsx',
  'src/entries/talent.tsx',
  'src/entries/overlay.tsx',
  'src/entries/admin.tsx',
  'src/entries/dev-sandbox.tsx'
];

const failures = [];

for (const entry of requiredEntries) {
  if (!doc.includes(entry)) failures.push(`Structural doc missing Vite entrypoint: ${entry}`);
  if (!existsSync(join(root, entry))) failures.push(`Missing Vite entrypoint file: ${entry}`);
}

const entrySources = requiredEntries.map((entry) => ({
  entry,
  source: existsSync(join(root, entry)) ? readFileSync(join(root, entry), 'utf8') : ''
}));

const importsMainCount = entrySources.filter(({ source }) => /import\s+['"]\.\.\/main['"]/.test(source)).length;
if (importsMainCount > 0) {
  failures.push('Vite entrypoints must not import ../main after Slice 2 route decoupling.');
}

for (const { entry, source } of entrySources) {
  if (source.includes('stub:') || source.includes('Slice 0A stub')) {
    failures.push(`${entry} is still marked as a Slice 0A stub.`);
  }
}

const expectedImports = {
  'src/entries/patron.tsx': '../shells/PatronApp',
  'src/entries/talent.tsx': '../shells/TalentApp',
  'src/entries/overlay.tsx': '../shells/OverlayApp',
  'src/entries/admin.tsx': '../shells/AdminApp',
  'src/entries/dev-sandbox.tsx': '../App'
};

for (const { entry, source } of entrySources) {
  if (!source.includes(expectedImports[entry])) {
    failures.push(`${entry} must import ${expectedImports[entry]}.`);
  }
}

const forbiddenImports = {
  'src/entries/patron.tsx': ['TalentDashboard', 'AdminApp', 'dev-sandbox', '../App'],
  'src/entries/talent.tsx': ['PatronView', 'role switcher'],
  'src/entries/overlay.tsx': ['PatronView', 'TalentDashboard', 'AdminApp', '../App'],
  'src/entries/admin.tsx': ['PatronView', 'TalentDashboard', '../App']
};

for (const { entry, source } of entrySources) {
  for (const forbidden of forbiddenImports[entry] ?? []) {
    if (source.includes(forbidden)) failures.push(`${entry} imports forbidden shell dependency: ${forbidden}`);
  }
}

const shellSources = {
  'src/shells/PatronApp.tsx': existsSync(join(root, 'src/shells/PatronApp.tsx')) ? readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8') : '',
  'src/shells/TalentApp.tsx': existsSync(join(root, 'src/shells/TalentApp.tsx')) ? readFileSync(join(root, 'src/shells/TalentApp.tsx'), 'utf8') : '',
  'src/shells/OverlayApp.tsx': existsSync(join(root, 'src/shells/OverlayApp.tsx')) ? readFileSync(join(root, 'src/shells/OverlayApp.tsx'), 'utf8') : '',
  'src/shells/AdminApp.tsx': existsSync(join(root, 'src/shells/AdminApp.tsx')) ? readFileSync(join(root, 'src/shells/AdminApp.tsx'), 'utf8') : ''
};

const shellRules = {
  'src/shells/PatronApp.tsx': {
    required: ['PatronView'],
    forbidden: ['TalentDashboard', 'AdminApp', 'DevSandbox', '../App']
  },
  'src/shells/TalentApp.tsx': {
    required: ['TalentDashboard'],
    forbidden: ['PatronView', 'DevSandbox', '../App']
  },
  'src/shells/OverlayApp.tsx': {
    required: ['LIVE GIG FEED'],
    forbidden: ['PatronView', 'TalentDashboard', 'AdminApp', '../App']
  },
  'src/shells/AdminApp.tsx': {
    required: ['Admin'],
    forbidden: ['PatronView', 'TalentDashboard', '../App']
  }
};

for (const [file, rule] of Object.entries(shellRules)) {
  const source = shellSources[file] ?? '';
  if (!source) failures.push(`Missing shell app file: ${file}`);
  for (const required of rule.required) {
    if (!source.includes(required)) failures.push(`${file} missing required shell marker: ${required}`);
  }
  for (const forbidden of rule.forbidden) {
    if (source.includes(forbidden)) failures.push(`${file} imports forbidden shell dependency: ${forbidden}`);
  }
}

const viteConfig = readFileSync(join(root, 'vite.config.ts'), 'utf8');
for (const shell of ['patron', 'talent', 'overlay', 'admin', 'dev-sandbox']) {
  if (!viteConfig.includes(`shells/${shell}.html`)) {
    failures.push(`Vite config missing shell input: shells/${shell}.html`);
  }
}

if (!doc.includes('entry files are real Slice 2 role-specific entrypoints')) {
  failures.push('Structural doc must mark entrypoints as real Slice 2 role-specific entrypoints.');
}

if (failures.length) {
  console.error('Separate Vite entrypoints contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Separate Vite entrypoints contract passed.');
