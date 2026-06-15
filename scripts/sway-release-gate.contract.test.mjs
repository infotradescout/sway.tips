import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

const docs = {
  gate: 'docs/process/QA_DRY_RELEASE_GATE.md',
  guide: 'docs/process/FRONT_END_UI_QA_GUIDE.md',
  feature: 'docs/process/FEATURE_QA_CHECKLIST.md',
  bugTemplate: 'docs/process/BUG_REPORT_TEMPLATE.md',
  priority: 'docs/process/BUG_PRIORITY_GUIDE.md',
  evidence: 'docs/process/RELEASE_EVIDENCE_CHECKLIST.md',
  dry: 'docs/process/DRY_REFACTOR_INTAKE_CHECKLIST.md',
  packet: 'docs/process/QA_RELEASE_PACKET_TEMPLATE.md'
};

function read(relPath) {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) {
    failures.push(`Missing required release gate file: ${relPath}`);
    return '';
  }
  return readFileSync(fullPath, 'utf8');
}

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(label || `Missing required term: ${term}`);
}

const sources = Object.fromEntries(
  Object.entries(docs).map(([key, relPath]) => [key, read(relPath)])
);

const operatingOrder = [
  '1. QA the current user experience.',
  '2. Fix what is broken or confusing.',
  '3. Clean up duplicated/oversized code safely.',
  '4. Re-QA after cleanup.',
  '5. Only then introduce new features.'
];

for (const step of operatingOrder) {
  requireIncludes(sources.gate, step, `QA_DRY_RELEASE_GATE.md missing exact operating order step: ${step}`);
}

for (const term of [
  "Zachary's QA + DRY direction is mandatory operating law for Sway lanes",
  'No new feature stacking before Critical/High UX and maintainability issues are addressed',
  'No merge posture without completed release evidence',
  'Simulated validation output is a fatal release-blocking violation',
  'Runtime refactors require a separate scoped lane and behavior-parity evidence'
]) {
  requireIncludes(sources.gate, term, `QA_DRY_RELEASE_GATE.md missing doctrine: ${term}`);
}

for (const term of [
  'Flow Inventory',
  'Screen Inventory',
  'Clickable Path Testing',
  'Forms And Validation Testing',
  'Empty, Loading, Error, And Success States',
  'Responsive Viewport Checks',
  'Mobile QA',
  'Visual Overlap Checks',
  'Console And Network Inspection',
  'production-vs-demo data boundary checks',
  'Accessibility Basics',
  'Browser Compatibility',
  'Session Behavior',
  'AI Sloppiness Checks'
]) {
  requireIncludes(sources.guide, term, `FRONT_END_UI_QA_GUIDE.md missing QA area: ${term}`);
}

for (const term of [
  'Branch Scope',
  'User-Facing Routes Touched',
  'Acceptance Criteria',
  'Regression Surfaces',
  'Role/Access Checks',
  'Data-State Checks',
  'Money/Payment Checks When Applicable',
  'Production Demo-Data Boundary Check',
  'Explicit Pass/Fail Evidence Fields'
]) {
  requireIncludes(sources.feature, term, `FEATURE_QA_CHECKLIST.md missing section: ${term}`);
}

for (const term of [
  'Title',
  'Priority',
  'Route',
  'Device/Browser',
  'Steps To Reproduce',
  'Expected Result',
  'Actual Result',
  'Screenshot/Video Evidence',
  'Console Errors',
  'Network Errors',
  'Suspected Area',
  'Release Blocking Status'
]) {
  requireIncludes(sources.bugTemplate, term, `BUG_REPORT_TEMPLATE.md missing field: ${term}`);
}

for (const term of ['Critical', 'High', 'Medium', 'Low']) {
  requireIncludes(sources.priority, `## ${term}`, `BUG_PRIORITY_GUIDE.md missing priority: ${term}`);
}
requireIncludes(
  sources.priority,
  'Critical issues block release unless explicitly owner-approved with documented risk.',
  'BUG_PRIORITY_GUIDE.md must state Critical release blocking rule.'
);
requireIncludes(
  sources.priority,
  'High issues block release unless explicitly owner-approved with documented risk.',
  'BUG_PRIORITY_GUIDE.md must state High release blocking rule.'
);

for (const term of [
  'real command outputs only',
  'No simulated validation is allowed',
  'Local Validation Command List',
  'Production Marker Evidence When Deploying',
  'Route Smoke Evidence',
  'Role/Access Smoke Evidence',
  'Demo Fixture Boundary Evidence',
  'Rollback Path',
  'Known Risks',
  'Owner Approval Field'
]) {
  requireIncludes(sources.evidence, term, `RELEASE_EVIDENCE_CHECKLIST.md missing term: ${term}`);
}

for (const term of [
  'DRY/SRP targets are read-only audit targets in this lane',
  'Oversized Files Target List Placeholder',
  'Duplicated Logic Target List Placeholder',
  'Repeated Try/Catch Target List Placeholder',
  'Raw Fetch Bypass Target List Placeholder',
  'Behavior-Preserving Extraction Plan',
  'Test-Before/Test-After Requirement',
  'Separate Refactor Lane Requirement',
  'No opportunistic cleanup inside feature lanes'
]) {
  requireIncludes(sources.dry, term, `DRY_REFACTOR_INTAKE_CHECKLIST.md missing term: ${term}`);
}

for (const field of [
  'Decision',
  'Business goal',
  'Files inspected',
  'Files changed',
  'Routes touched',
  'Schema touched',
  'Money behavior touched',
  'Persistence behavior touched',
  'Role/access behavior touched',
  'AI behavior touched',
  'Moderation behavior touched',
  'App Store impact',
  'Validation commands with exact real outputs',
  'Manual QA evidence',
  'Production marker evidence if deployed',
  'Known risks',
  'Rollback path',
  'Commit SHA',
  'Working tree status'
]) {
  requireIncludes(sources.packet, `## ${field}`, `QA_RELEASE_PACKET_TEMPLATE.md missing required field: ${field}`);
}

requireIncludes(
  sources.packet,
  'No simulated validation is allowed',
  'QA_RELEASE_PACKET_TEMPLATE.md must reject simulated validation.'
);

if (failures.length) {
  console.error('Sway release gate contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway release gate contract passed.');
