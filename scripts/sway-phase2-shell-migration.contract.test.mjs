import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const entrypointContracts = [
  { entry: 'src/entries/patron.tsx', shellImport: '../shells/PatronAppShell', shellName: 'PatronAppShell' },
  { entry: 'src/entries/talent.tsx', shellImport: '../shells/PerformerAppShell', shellName: 'PerformerAppShell' },
  { entry: 'src/entries/overlay.tsx', shellImport: '../shells/OverlayShell', shellName: 'OverlayShell' },
  { entry: 'src/entries/admin.tsx', shellImport: '../shells/AdminOpsShell', shellName: 'AdminOpsShell' }
];

for (const { entry, shellImport, shellName } of entrypointContracts) {
  const abs = join(root, entry);
  if (!existsSync(abs)) {
    failures.push(`Missing entrypoint file: ${entry}`);
    continue;
  }

  const source = readFileSync(abs, 'utf8');
  if (!source.includes(shellImport)) {
    failures.push(`${entry} must import ${shellImport}.`);
  }

  if (!source.includes(`<${shellName} />`)) {
    failures.push(`${entry} must render ${shellName}.`);
  }

  if (!source.includes('mountSwayShell')) {
    failures.push(`${entry} must continue using mountSwayShell.`);
  }
}

const shellDelegationContracts = [
  { file: 'src/shells/PatronAppShell.tsx', legacyImport: "import PatronApp from './PatronApp';" },
  { file: 'src/shells/PerformerAppShell.tsx', legacyImport: "import TalentApp from './TalentApp';" },
  { file: 'src/shells/OverlayShell.tsx', legacyImport: "import OverlayApp from './OverlayApp';" },
  { file: 'src/shells/AdminOpsShell.tsx', legacyImport: "import AdminOpsRuntime from './AdminOpsRuntime';" },
  { file: 'src/shells/OperatorAppShell.tsx', legacyImport: "import OperatorRuntime from './OperatorRuntime';" }
];

for (const { file, legacyImport } of shellDelegationContracts) {
  const abs = join(root, file);
  if (!existsSync(abs)) {
    failures.push(`Missing migrated shell file: ${file}`);
    continue;
  }

  const source = readFileSync(abs, 'utf8');
  for (const required of [legacyImport, 'LEGACY_SURFACE_DELEGATE', 'FAIL_CLOSED_SCAFFOLD', 'createPhase1ShellScaffold']) {
    if (!source.includes(required)) {
      failures.push(`${file} missing required migration token: ${required}`);
    }
  }

  for (const forbidden of [
    'fetch(',
    'postJson(',
    '/api/',
    'XMLHttpRequest',
    'WebSocket',
    'localStorage',
    'sessionStorage'
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${file} must not introduce new live side effects: ${forbidden}`);
    }
  }
}

const publicShellFile = join(root, 'src/shells/PublicWebShell.tsx');
if (!existsSync(publicShellFile)) {
  failures.push('Missing shell file: src/shells/PublicWebShell.tsx');
} else {
  const source = readFileSync(publicShellFile, 'utf8');
  if (!source.toLowerCase().includes('fail-closed')) {
    failures.push('src/shells/PublicWebShell.tsx must remain fail-closed during Phase 2.');
  }
}

const vocabularyGuardSourceFiles = [
  'src/components/PatronView.tsx',
  'src/components/TalentDashboard.tsx',
  'src/components/VictoryScreen.tsx',
  'src/shells/OverlayApp.tsx',
  'src/shells/AdminApp.tsx'
];

let vocabularyCorpus = '';
for (const rel of vocabularyGuardSourceFiles) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    failures.push(`Missing vocabulary guard source file: ${rel}`);
    continue;
  }

  vocabularyCorpus += `\n${readFileSync(abs, 'utf8')}`;
}

const sharedLanguage = readFileSync(join(root, 'src/live-room-language.ts'), 'utf8');
const vocabularyReferences = new Map([
  ['Request', { value: 'Request', reference: 'LIVE_ROOM_ACTION_SLASH' }],
  ['Tip', { value: 'Tip', reference: 'LIVE_ROOM_ACTION_SLASH' }],
  ['Boost', { value: 'Boost', reference: 'LIVE_ROOM_ACTION_SLASH' }],
  ['Pending', { value: 'Pending', reference: 'LIVE_ROOM_LANGUAGE.pending' }],
  ['Approved', { value: 'Approved', reference: 'LIVE_ROOM_LANGUAGE.approved' }],
  ['Playing', { value: 'Now Playing', reference: 'LIVE_ROOM_LANGUAGE.nowPlaying' }],
  ['Up Next', { value: 'Up Next', reference: 'LIVE_ROOM_LANGUAGE.upNext' }],
  ['Paused', { value: 'Paused', reference: 'LIVE_ROOM_LANGUAGE.paused' }],
  ['Ended', { value: 'Ended', reference: 'LIVE_ROOM_LANGUAGE.ended' }]
]);

for (const [requiredTerm, { value, reference }] of vocabularyReferences) {
  if (!sharedLanguage.includes(`'${value}'`)) {
    failures.push(`Shared product vocabulary is missing required term: ${requiredTerm}`);
  }
  if (!vocabularyCorpus.includes(reference)) {
    failures.push(`Rendered surface corpus is missing shared vocabulary reference: ${reference}`);
  }
}

const performerDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const performerHome = readFileSync(join(root, 'src/components/PerformerAccountHome.tsx'), 'utf8');
for (const workspace of [
  "{ id: 'home', label: 'Home'",
  "{ id: 'room', label: 'Live Room'",
  "{ id: 'connections', label: 'Connections'",
  "{ id: 'library', label: 'Music'",
  "{ id: 'catalog', label: 'Files'",
  "{ id: 'profile', label: 'Public Page'",
  "{ id: 'account', label: 'Money'"
]) {
  if (!performerDashboard.includes(workspace)) {
    failures.push(`Performer app is missing workspace: ${workspace}`);
  }
}
for (const boundary of [
  'data-sway-performer-app-navigation="true"',
  'data-sway-library-workspace="true"',
  'data-sway-audio-catalog="true"',
  'data-sway-account-workspace="true"',
  'aria-label="Catalog audio tools"'
]) {
  if (!performerDashboard.includes(boundary)) {
    failures.push(`Performer app is missing workspace boundary: ${boundary}`);
  }
}
if (!performerDashboard.includes('<PerformerAudioFiles />') || !performerDashboard.includes('<PerformerFilePairing />')) {
  failures.push('Catalog workspace must own audio files and private pairing.');
}
if (performerHome.includes('<PerformerAudioFiles />') || performerHome.includes('<PerformerFilePairing />')) {
  failures.push('Home must stay an overview instead of absorbing library workflows.');
}
if (!performerDashboard.includes('Payments & payout setup')) {
  failures.push('Account workspace must own payout and access administration.');
}

if (failures.length) {
  console.error('Phase 2 shell migration contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Phase 2 shell migration contract passed.');
