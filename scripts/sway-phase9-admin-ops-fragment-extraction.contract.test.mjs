import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    failures.push(`Missing required file: ${rel}`);
    return '';
  }
  return readFileSync(abs, 'utf8');
}

const adminAppFile = 'src/shells/AdminApp.tsx';
const adminOpsCompatFile = 'src/shells/admin/AdminOpsRuntimeCompat.tsx';
const adminOpsRuntimeFile = 'src/shells/AdminOpsRuntime.tsx';
const adminEntryFile = 'src/entries/admin.tsx';

const adminAppSource = read(adminAppFile);
const adminOpsCompatSource = read(adminOpsCompatFile);
const adminOpsRuntimeSource = read(adminOpsRuntimeFile);
const adminEntrySource = read(adminEntryFile);

if (adminOpsCompatSource) {
  for (const required of [
    'ADMIN_OPS_DEMO_SECTION_LABELS',
    'ADMIN_OPS_DEMO_ITEM_BODY',
    'ADMIN_OPS_EMPTY_STATE_COPY',
    'ADMIN_OPS_DEMO_HEADING',
    'Operations overview',
    'export function createAdminOpsRuntimeCompat',
    'const AdminOpsRuntimeCompat = LegacyAdminApp;'
  ]) {
    if (!adminOpsCompatSource.includes(required)) {
      failures.push(`${adminOpsCompatFile} missing required Phase 9 extracted fragment token: ${required}`);
    }
  }
}

if (adminAppSource) {
  for (const required of [
    "./admin/AdminOpsRuntimeCompat';",
    'ADMIN_OPS_DEMO_HEADING',
    '{ADMIN_OPS_DEMO_HEADING}'
  ]) {
    if (!adminAppSource.includes(required)) {
      failures.push(`${adminAppFile} must consume Phase 9 extracted fragment token: ${required}`);
    }
  }
}

if (adminOpsRuntimeSource) {
  for (const required of [
    "import AdminApp from './AdminApp';",
    "import { createAdminOpsRuntimeCompat } from './admin/AdminOpsRuntimeCompat';",
    'export const LEGACY_RUNTIME_DELEGATE = createAdminOpsRuntimeCompat(AdminApp);'
  ]) {
    if (!adminOpsRuntimeSource.includes(required)) {
      failures.push(`${adminOpsRuntimeFile} must keep parity delegation token: ${required}`);
    }
  }
}

if (adminEntrySource) {
  if (!adminEntrySource.includes("import AdminOpsShell from '../shells/AdminOpsShell';")) {
    failures.push(`${adminEntryFile} route behavior changed: expected AdminOpsShell import.`);
  }
  if (!adminEntrySource.includes('mountSwayShell(<AdminOpsShell />);')) {
    failures.push(`${adminEntryFile} route behavior changed: expected AdminOpsShell mount.`);
  }
}

for (const sourceSpec of [
  { file: adminAppFile, source: adminAppSource },
  { file: adminOpsCompatFile, source: adminOpsCompatSource },
  { file: adminOpsRuntimeFile, source: adminOpsRuntimeSource }
]) {
  if (!sourceSpec.source) continue;
  for (const forbidden of [
    '/api/',
    'fetch(',
    'postJson(',
    'WebSocket',
    'localStorage',
    'sessionStorage',
    'drizzle',
    'stripe',
    'authorize',
    'requireRole'
  ]) {
    if (sourceSpec.source.includes(forbidden)) {
      failures.push(`${sourceSpec.file} includes forbidden behavior token: ${forbidden}`);
    }
  }

  if (/\bai\b/i.test(sourceSpec.source)) {
    failures.push(`${sourceSpec.file} includes forbidden behavior token: ai`);
  }
}

const terminologyContract = read('scripts/sway-surface-terminology.contract.test.mjs');
if (terminologyContract && !terminologyContract.includes('Request, Tip, Boost, Pending, Approved, Playing,')) {
  failures.push('Surface terminology contract must preserve Sway vocabulary guard.');
}

if (failures.length) {
  console.error('Phase 9 admin ops fragment extraction contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Phase 9 admin ops fragment extraction contract passed.');
