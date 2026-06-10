import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const shellContracts = [
  { file: 'src/shells/PublicWebShell.tsx', id: 'PublicWebShell', exportName: 'PUBLIC_WEB_SHELL_ID' },
  { file: 'src/shells/PatronAppShell.tsx', id: 'PatronAppShell', exportName: 'PATRON_APP_SHELL_ID' },
  { file: 'src/shells/PerformerAppShell.tsx', id: 'PerformerAppShell', exportName: 'PERFORMER_APP_SHELL_ID' },
  { file: 'src/shells/OperatorAppShell.tsx', id: 'OperatorAppShell', exportName: 'OPERATOR_APP_SHELL_ID' },
  { file: 'src/shells/OverlayShell.tsx', id: 'OverlayShell', exportName: 'OVERLAY_SHELL_ID' },
  { file: 'src/shells/AdminOpsShell.tsx', id: 'AdminOpsShell', exportName: 'ADMIN_OPS_SHELL_ID' }
];

for (const { file, id } of shellContracts) {
  const abs = join(root, file);
  if (!existsSync(abs)) {
    failures.push(`Missing Phase 1 shell scaffold file: ${file}`);
    continue;
  }

  const source = readFileSync(abs, 'utf8');

  if (!source.includes("createPhase1ShellScaffold")) {
    failures.push(`${file} must be built with createPhase1ShellScaffold.`);
  }

  if (!source.includes(`export const SHELL_SURFACE_ID = '${id}' as const;`)) {
    failures.push(`${file} must export stable SHELL_SURFACE_ID for ${id}.`);
  }

  if (!source.toLowerCase().includes('fail-closed')) {
    failures.push(`${file} must document fail-closed default behavior.`);
  }

  for (const forbidden of [
    'postJson(',
    'fetch(',
    '/api/',
    'XMLHttpRequest',
    'WebSocket',
    'setInterval(',
    'setTimeout(',
    'window.location',
    'localStorage',
    'sessionStorage'
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${file} contains forbidden live behavior token: ${forbidden}`);
    }
  }
}

const scaffoldFactoryFile = 'src/shells/phase1-scaffold.tsx';
const scaffoldFactoryPath = join(root, scaffoldFactoryFile);
if (!existsSync(scaffoldFactoryPath)) {
  failures.push(`Missing scaffold factory file: ${scaffoldFactoryFile}`);
} else {
  const source = readFileSync(scaffoldFactoryPath, 'utf8');
  for (const required of [
    'export type Phase1ShellSurfaceId =',
    "| 'PublicWebShell'",
    "| 'PatronAppShell'",
    "| 'PerformerAppShell'",
    "| 'OperatorAppShell'",
    "| 'OverlayShell'",
    "| 'AdminOpsShell'",
    'export type Phase1ShellScaffoldConfig =',
    'export function createPhase1ShellScaffold'
  ]) {
    if (!source.includes(required)) {
      failures.push(`Scaffold factory missing stable contract token: ${required}`);
    }
  }

  for (const forbidden of ['fetch(', 'postJson(', '/api/', 'setInterval(', 'setTimeout(']) {
    if (source.includes(forbidden)) {
      failures.push(`Scaffold factory must remain side-effect free. Found: ${forbidden}`);
    }
  }
}

const shellIndexFile = 'src/shells/index.ts';
const shellIndexPath = join(root, shellIndexFile);
if (!existsSync(shellIndexPath)) {
  failures.push(`Missing shell barrel export file: ${shellIndexFile}`);
} else {
  const source = readFileSync(shellIndexPath, 'utf8');
  for (const { file, id, exportName } of shellContracts) {
    const moduleName = file.split('/').pop()?.replace('.tsx', '') ?? '';
    if (!source.includes(`{ default as ${id}, SHELL_SURFACE_ID as ${exportName} } from './${moduleName}';`)) {
      failures.push(`${shellIndexFile} must export ${id} and ${exportName}.`);
    }
  }

  for (const required of [
    "export { createPhase1ShellScaffold } from './phase1-scaffold';",
    "export type { Phase1ShellScaffoldConfig, Phase1ShellSurfaceId } from './phase1-scaffold';"
  ]) {
    if (!source.includes(required)) {
      failures.push(`${shellIndexFile} missing stable scaffold export: ${required}`);
    }
  }
}

const legacyEntryExpectations = {
  'src/entries/patron.tsx': '../shells/PatronApp',
  'src/entries/talent.tsx': '../shells/TalentApp',
  'src/entries/overlay.tsx': '../shells/OverlayApp',
  'src/entries/admin.tsx': '../shells/AdminApp'
};

for (const [entryFile, expectedImport] of Object.entries(legacyEntryExpectations)) {
  const abs = join(root, entryFile);
  if (!existsSync(abs)) {
    failures.push(`Missing legacy entrypoint while scaffolding: ${entryFile}`);
    continue;
  }

  const source = readFileSync(abs, 'utf8');
  if (!source.includes(expectedImport)) {
    failures.push(`${entryFile} must keep legacy shell import ${expectedImport} during scaffold-only slice.`);
  }

  for (const forbidden of [
    '../shells/PublicWebShell',
    '../shells/PatronAppShell',
    '../shells/PerformerAppShell',
    '../shells/OperatorAppShell',
    '../shells/OverlayShell',
    '../shells/AdminOpsShell',
    "from '../shells'"
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${entryFile} must not wire Phase 1 scaffold shell import: ${forbidden}`);
    }
  }
}

if (failures.length) {
  console.error('Phase 1 shell scaffold contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Phase 1 shell scaffold contract passed.');
