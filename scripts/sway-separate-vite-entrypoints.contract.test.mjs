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
  'src/entries/patron.tsx': '../shells/PatronAppShell',
  'src/entries/talent.tsx': '../shells/PerformerAppShell',
  'src/entries/overlay.tsx': '../shells/OverlayShell',
  'src/entries/admin.tsx': '../shells/AdminOpsShell',
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
  'src/shells/PatronAppShell.tsx': existsSync(join(root, 'src/shells/PatronAppShell.tsx')) ? readFileSync(join(root, 'src/shells/PatronAppShell.tsx'), 'utf8') : '',
  'src/shells/PerformerAppShell.tsx': existsSync(join(root, 'src/shells/PerformerAppShell.tsx')) ? readFileSync(join(root, 'src/shells/PerformerAppShell.tsx'), 'utf8') : '',
  'src/shells/OverlayShell.tsx': existsSync(join(root, 'src/shells/OverlayShell.tsx')) ? readFileSync(join(root, 'src/shells/OverlayShell.tsx'), 'utf8') : '',
  'src/shells/AdminOpsShell.tsx': existsSync(join(root, 'src/shells/AdminOpsShell.tsx')) ? readFileSync(join(root, 'src/shells/AdminOpsShell.tsx'), 'utf8') : '',
  'src/shells/OperatorAppShell.tsx': existsSync(join(root, 'src/shells/OperatorAppShell.tsx')) ? readFileSync(join(root, 'src/shells/OperatorAppShell.tsx'), 'utf8') : ''
};

const shellRules = {
  'src/shells/PatronAppShell.tsx': {
    required: ["import PatronApp from './PatronApp';", 'LEGACY_SURFACE_DELEGATE', 'FAIL_CLOSED_SCAFFOLD'],
    forbidden: ['TalentDashboard', 'AdminApp', 'DevSandbox', '../App']
  },
  'src/shells/PerformerAppShell.tsx': {
    required: ["import TalentApp from './TalentApp';", 'LEGACY_SURFACE_DELEGATE', 'FAIL_CLOSED_SCAFFOLD'],
    forbidden: ['PatronView', 'DevSandbox', '../App']
  },
  'src/shells/OverlayShell.tsx': {
    required: ["import OverlayApp from './OverlayApp';", 'LEGACY_SURFACE_DELEGATE', 'FAIL_CLOSED_SCAFFOLD'],
    forbidden: ['PatronView', 'TalentDashboard', 'AdminApp', '../App']
  },
  'src/shells/AdminOpsShell.tsx': {
    required: ["import AdminApp from './AdminApp';", 'LEGACY_SURFACE_DELEGATE', 'FAIL_CLOSED_SCAFFOLD'],
    forbidden: ['PatronView', 'TalentDashboard', '../App', "import PatronApp from './PatronApp';"]
  },
  'src/shells/OperatorAppShell.tsx': {
    required: ["import AdminApp from './AdminApp';", 'LEGACY_SURFACE_DELEGATE', 'FAIL_CLOSED_SCAFFOLD'],
    forbidden: ['PatronView', 'TalentDashboard', '../App', "import PatronApp from './PatronApp';"]
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
