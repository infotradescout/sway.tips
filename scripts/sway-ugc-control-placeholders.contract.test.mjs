import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
const talentApp = readFileSync(join(root, 'src/shells/TalentApp.tsx'), 'utf8');
const patronView = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const talentDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');

const failures = [];

const requiredPatronUiTerms = [
  'Safety Controls',
  'Report',
  'Block',
  'Support / Contact',
  'Data Deletion Request',
  'onReportContent',
  'onBlockFoundation',
  'onSupportContact',
  'onDataDeletionPlaceholder'
];

for (const term of requiredPatronUiTerms) {
  if (!patronView.includes(term)) {
    failures.push(`Patron UGC controls missing term: ${term}`);
  }
}

const requiredTalentUiTerms = [
  'onHide',
  'onRemove',
  'Hide',
  'Remove'
];

for (const term of requiredTalentUiTerms) {
  if (!talentDashboard.includes(term)) {
    failures.push(`Talent moderation controls missing term: ${term}`);
  }
}

for (const term of ['handleReportContent', 'handleBlockFoundation']) {
  if (!app.includes(term)) {
    failures.push(`Patron dev app moderation wiring missing handler: ${term}`);
  }
}

for (const term of ['handleHideRequest', 'handleRemoveRequest']) {
  if (!talentApp.includes(term)) {
    failures.push(`Canonical TalentApp moderation wiring missing handler: ${term}`);
  }
}

const requiredServerPlaceholderTerms = [
  '/api/moderation/placeholders',
  '/api/moderation/patron-block',
  '/api/support/contact',
  '/api/privacy/data-deletion-placeholder',
  'getAppStoreUgcControlPlaceholders'
];

for (const term of requiredServerPlaceholderTerms) {
  if (!server.includes(term)) {
    failures.push(`Server placeholder route missing term: ${term}`);
  }
}

if (failures.length) {
  console.error('UGC control placeholders contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('UGC control placeholders contract passed.');
