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

const adminOpsRuntimeFile = 'src/shells/AdminOpsRuntime.tsx';
const adminOpsCompatFile = 'src/shells/admin/AdminOpsRuntimeCompat.tsx';
const operatorRuntimeFile = 'src/shells/OperatorRuntime.tsx';
const operatorCompatFile = 'src/shells/operator/OperatorRuntimeCompat.tsx';
const adminEntryFile = 'src/entries/admin.tsx';

const adminOpsRuntimeSource = read(adminOpsRuntimeFile);
const adminOpsCompatSource = read(adminOpsCompatFile);
const operatorRuntimeSource = read(operatorRuntimeFile);
const operatorCompatSource = read(operatorCompatFile);
const adminEntrySource = read(adminEntryFile);

if (adminOpsRuntimeSource) {
  if (!adminOpsRuntimeSource.includes("import AdminOpsRuntimeCompat from './admin/AdminOpsRuntimeCompat';")) {
    failures.push(`${adminOpsRuntimeFile} must import AdminOpsRuntimeCompat.`);
  }
  if (adminOpsRuntimeSource.includes("import AdminApp from './AdminApp';")) {
    failures.push(`${adminOpsRuntimeFile} must not import AdminApp directly after extraction.`);
  }
  for (const required of [
    'export const LEGACY_RUNTIME_DELEGATE = AdminOpsRuntimeCompat;',
    'const AdminOpsRuntime = LEGACY_RUNTIME_DELEGATE;'
  ]) {
    if (!adminOpsRuntimeSource.includes(required)) {
      failures.push(`${adminOpsRuntimeFile} missing required extraction token: ${required}`);
    }
  }
}

if (adminOpsCompatSource) {
  for (const required of [
    "import AdminApp from '../AdminApp';",
    'export const LEGACY_ADMIN_OPS_RUNTIME_DELEGATE = AdminApp;',
    'const AdminOpsRuntimeCompat = LEGACY_ADMIN_OPS_RUNTIME_DELEGATE;'
  ]) {
    if (!adminOpsCompatSource.includes(required)) {
      failures.push(`${adminOpsCompatFile} missing required legacy delegation token: ${required}`);
    }
  }
}

if (operatorRuntimeSource) {
  for (const required of [
    "import OperatorRuntimeCompat from './operator/OperatorRuntimeCompat';",
    'export const LEGACY_RUNTIME_DELEGATE = OperatorRuntimeCompat;',
    'const OperatorRuntime = LEGACY_RUNTIME_DELEGATE;'
  ]) {
    if (!operatorRuntimeSource.includes(required)) {
      failures.push(`${operatorRuntimeFile} operator boundary must remain intact: ${required}`);
    }
  }
}

if (operatorCompatSource) {
  if (!operatorCompatSource.includes("import AdminApp from '../AdminApp';")) {
    failures.push(`${operatorCompatFile} must preserve legacy AdminApp delegation for parity.`);
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

const scopeFiles = [
  { file: adminOpsRuntimeFile, source: adminOpsRuntimeSource },
  { file: adminOpsCompatFile, source: adminOpsCompatSource },
  { file: operatorRuntimeFile, source: operatorRuntimeSource },
  { file: operatorCompatFile, source: operatorCompatSource }
];

for (const { file, source } of scopeFiles) {
  if (!source) continue;
  for (const forbidden of [
    '/api/',
    'fetch(',
    'postJson(',
    'WebSocket',
    'localStorage',
    'sessionStorage',
    'drizzle',
    'stripe',
    'moderation',
    'authorize',
    'requireRole'
  ]) {
    if (source.includes(forbidden)) {
      failures.push(`${file} includes forbidden behavior token: ${forbidden}`);
    }
  }

  if (/\bai\b/i.test(source)) {
    failures.push(`${file} includes forbidden behavior token: ai`);
  }
}

const terminologyContract = read('scripts/sway-surface-terminology.contract.test.mjs');
if (terminologyContract && !terminologyContract.includes('Request, Tip, Boost, Pending, Approved, Playing,')) {
  failures.push('Surface terminology contract must preserve Sway vocabulary guard.');
}

if (failures.length) {
  console.error('Phase 5 admin ops runtime extraction contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Phase 5 admin ops runtime extraction contract passed.');
