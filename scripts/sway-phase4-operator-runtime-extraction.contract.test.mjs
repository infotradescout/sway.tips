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

const operatorRuntimeFile = 'src/shells/OperatorRuntime.tsx';
const operatorCompatFile = 'src/shells/operator/OperatorRuntimeCompat.tsx';
const adminOpsRuntimeFile = 'src/shells/AdminOpsRuntime.tsx';
const adminEntryFile = 'src/entries/admin.tsx';

const operatorRuntimeSource = read(operatorRuntimeFile);
const operatorCompatSource = read(operatorCompatFile);
const adminOpsRuntimeSource = read(adminOpsRuntimeFile);
const adminEntrySource = read(adminEntryFile);

if (operatorRuntimeSource) {
  if (!operatorRuntimeSource.includes("import OperatorRuntimeCompat from './operator/OperatorRuntimeCompat';")) {
    failures.push(`${operatorRuntimeFile} must import OperatorRuntimeCompat.`);
  }
  if (operatorRuntimeSource.includes("import AdminApp from './AdminApp';")) {
    failures.push(`${operatorRuntimeFile} must not import AdminApp directly after extraction.`);
  }
  for (const required of [
    'export const LEGACY_RUNTIME_DELEGATE = OperatorRuntimeCompat;',
    'const OperatorRuntime = LEGACY_RUNTIME_DELEGATE;'
  ]) {
    if (!operatorRuntimeSource.includes(required)) {
      failures.push(`${operatorRuntimeFile} missing required extraction token: ${required}`);
    }
  }
}

if (operatorCompatSource) {
  for (const required of [
    "import AdminApp from '../AdminApp';",
    'export const LEGACY_OPERATOR_RUNTIME_DELEGATE = AdminApp;',
    'const OperatorRuntimeCompat = LEGACY_OPERATOR_RUNTIME_DELEGATE;'
  ]) {
    if (!operatorCompatSource.includes(required)) {
      failures.push(`${operatorCompatFile} missing required legacy delegation token: ${required}`);
    }
  }
}

if (adminOpsRuntimeSource) {
  for (const required of [
    "import AdminApp from './AdminApp';",
    'export const LEGACY_RUNTIME_DELEGATE = AdminApp;',
    'const AdminOpsRuntime = LEGACY_RUNTIME_DELEGATE;'
  ]) {
    if (!adminOpsRuntimeSource.includes(required)) {
      failures.push(`${adminOpsRuntimeFile} must keep legacy AdminApp delegation token: ${required}`);
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

const scopeFiles = [
  { file: operatorRuntimeFile, source: operatorRuntimeSource },
  { file: operatorCompatFile, source: operatorCompatSource },
  { file: adminOpsRuntimeFile, source: adminOpsRuntimeSource }
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
  console.error('Phase 4 operator runtime extraction contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Phase 4 operator runtime extraction contract passed.');
