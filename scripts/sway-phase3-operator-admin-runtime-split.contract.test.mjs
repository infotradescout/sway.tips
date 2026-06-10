import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const operatorShellFile = 'src/shells/OperatorAppShell.tsx';
const adminOpsShellFile = 'src/shells/AdminOpsShell.tsx';
const operatorRuntimeFile = 'src/shells/OperatorRuntime.tsx';
const adminOpsRuntimeFile = 'src/shells/AdminOpsRuntime.tsx';
const operatorRuntimeCompatFile = 'src/shells/operator/OperatorRuntimeCompat.tsx';
const adminOpsRuntimeCompatFile = 'src/shells/admin/AdminOpsRuntimeCompat.tsx';

function read(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    failures.push(`Missing required file: ${rel}`);
    return '';
  }
  return readFileSync(abs, 'utf8');
}

const operatorShellSource = read(operatorShellFile);
const adminOpsShellSource = read(adminOpsShellFile);
const operatorRuntimeSource = read(operatorRuntimeFile);
const adminOpsRuntimeSource = read(adminOpsRuntimeFile);
const operatorRuntimeCompatSource = read(operatorRuntimeCompatFile);
const adminOpsRuntimeCompatSource = read(adminOpsRuntimeCompatFile);

if (operatorShellSource) {
  if (!operatorShellSource.includes("import OperatorRuntime from './OperatorRuntime';")) {
    failures.push(`${operatorShellFile} must delegate via OperatorRuntime.`);
  }
  if (operatorShellSource.includes("import AdminApp from './AdminApp';")) {
    failures.push(`${operatorShellFile} must not import AdminApp directly.`);
  }
}

if (adminOpsShellSource) {
  if (!adminOpsShellSource.includes("import AdminOpsRuntime from './AdminOpsRuntime';")) {
    failures.push(`${adminOpsShellFile} must delegate via AdminOpsRuntime.`);
  }
  if (adminOpsShellSource.includes("import AdminApp from './AdminApp';")) {
    failures.push(`${adminOpsShellFile} must not import AdminApp directly.`);
  }
}

if (operatorRuntimeSource) {
  for (const required of [
    "import OperatorRuntimeCompat from './operator/OperatorRuntimeCompat';",
    'export const LEGACY_RUNTIME_DELEGATE = OperatorRuntimeCompat;',
    'const OperatorRuntime = LEGACY_RUNTIME_DELEGATE;'
  ]) {
    if (!operatorRuntimeSource.includes(required)) {
      failures.push(`${operatorRuntimeFile} missing required legacy delegation token: ${required}`);
    }
  }
}

if (operatorRuntimeCompatSource) {
  for (const required of [
    "import AdminApp from '../AdminApp';",
    'export const LEGACY_OPERATOR_RUNTIME_DELEGATE = AdminApp;',
    'const OperatorRuntimeCompat = LEGACY_OPERATOR_RUNTIME_DELEGATE;'
  ]) {
    if (!operatorRuntimeCompatSource.includes(required)) {
      failures.push(`${operatorRuntimeCompatFile} missing required legacy delegation token: ${required}`);
    }
  }
}

if (adminOpsRuntimeSource) {
  for (const required of [
    "import AdminOpsRuntimeCompat from './admin/AdminOpsRuntimeCompat';",
    'export const LEGACY_RUNTIME_DELEGATE = AdminOpsRuntimeCompat;',
    'const AdminOpsRuntime = LEGACY_RUNTIME_DELEGATE;'
  ]) {
    if (!adminOpsRuntimeSource.includes(required)) {
      failures.push(`${adminOpsRuntimeFile} missing required legacy delegation token: ${required}`);
    }
  }
}

if (adminOpsRuntimeCompatSource) {
  for (const required of [
    "import AdminApp from '../AdminApp';",
    'export const LEGACY_ADMIN_OPS_RUNTIME_DELEGATE = AdminApp;',
    'const AdminOpsRuntimeCompat = LEGACY_ADMIN_OPS_RUNTIME_DELEGATE;'
  ]) {
    if (!adminOpsRuntimeCompatSource.includes(required)) {
      failures.push(`${adminOpsRuntimeCompatFile} missing required legacy delegation token: ${required}`);
    }
  }
}

if (operatorRuntimeFile === adminOpsRuntimeFile) {
  failures.push('Operator and Admin/Ops runtime modules must be distinct files.');
}

const routeEntrySource = read('src/entries/admin.tsx');
if (routeEntrySource) {
  if (!routeEntrySource.includes("import AdminOpsShell from '../shells/AdminOpsShell';")) {
    failures.push('src/entries/admin.tsx must keep AdminOpsShell route behavior.');
  }
  if (!routeEntrySource.includes('mountSwayShell(<AdminOpsShell />);')) {
    failures.push('src/entries/admin.tsx must continue mounting AdminOpsShell.');
  }
}

const shellSurfaceIndex = read('src/shells/index.ts');
if (shellSurfaceIndex) {
  if (!shellSurfaceIndex.includes("export { default as OperatorAppShell, SHELL_SURFACE_ID as OPERATOR_APP_SHELL_ID } from './OperatorAppShell';")) {
    failures.push('src/shells/index.ts must continue exporting OperatorAppShell boundary.');
  }
  if (!shellSurfaceIndex.includes("export { default as AdminOpsShell, SHELL_SURFACE_ID as ADMIN_OPS_SHELL_ID } from './AdminOpsShell';")) {
    failures.push('src/shells/index.ts must continue exporting AdminOpsShell boundary.');
  }
}

for (const sourceSpec of [
  { file: operatorShellFile, source: operatorShellSource },
  { file: adminOpsShellFile, source: adminOpsShellSource },
  { file: operatorRuntimeFile, source: operatorRuntimeSource },
  { file: adminOpsRuntimeFile, source: adminOpsRuntimeSource },
  { file: operatorRuntimeCompatFile, source: operatorRuntimeCompatSource },
  { file: adminOpsRuntimeCompatFile, source: adminOpsRuntimeCompatSource }
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
    'moderation',
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

if (failures.length) {
  console.error('Phase 3 operator/admin runtime split contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Phase 3 operator/admin runtime split contract passed.');
