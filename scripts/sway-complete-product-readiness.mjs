import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const configPath = join(root, 'config', 'sway-complete-product-readiness.json');
const assertReady = process.argv.includes('--assert-ready');

function failConfiguration(message) {
  console.error(`Invalid Sway complete-product readiness configuration: ${message}`);
  process.exit(2);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (error) {
  failConfiguration(error instanceof Error ? error.message : 'configuration could not be read');
}

if (config.schemaVersion !== 1) failConfiguration('schemaVersion must be 1');
if (!['HOLD', 'GO'].includes(config.decision)) failConfiguration('decision must be HOLD or GO');
if (!Array.isArray(config.allowedStatuses) || !config.allowedStatuses.includes('production_verified')) {
  failConfiguration('allowedStatuses must include production_verified');
}
if (!Array.isArray(config.pillars) || config.pillars.length !== 2) {
  failConfiguration('exactly two readiness pillars are required');
}

const requiredPillars = new Set(['distrokid_replacement', 'original_sway']);
const seenPillars = new Set();
const seenCapabilities = new Set();
const blockers = [];

for (const pillar of config.pillars) {
  if (!requiredPillars.has(pillar.id)) failConfiguration(`unexpected pillar: ${pillar.id}`);
  if (seenPillars.has(pillar.id)) failConfiguration(`duplicate pillar: ${pillar.id}`);
  seenPillars.add(pillar.id);
  if (!Array.isArray(pillar.capabilities) || pillar.capabilities.length === 0) {
    failConfiguration(`pillar ${pillar.id} must contain capabilities`);
  }

  for (const capability of pillar.capabilities) {
    if (!capability.id || seenCapabilities.has(capability.id)) {
      failConfiguration(`missing or duplicate capability id: ${capability.id || '(missing)'}`);
    }
    seenCapabilities.add(capability.id);
    if (!config.allowedStatuses.includes(capability.status)) {
      failConfiguration(`capability ${capability.id} has invalid status ${capability.status}`);
    }
    if (!Array.isArray(capability.evidence)) {
      failConfiguration(`capability ${capability.id} evidence must be an array`);
    }
    if (capability.status === 'production_verified' && capability.evidence.length === 0) {
      failConfiguration(`capability ${capability.id} cannot be production_verified without independent evidence`);
    }
    if (capability.status !== 'production_verified') {
      if (typeof capability.holdReason !== 'string' || !capability.holdReason.trim()) {
        failConfiguration(`capability ${capability.id} requires a holdReason`);
      }
      blockers.push({
        pillar: pillar.id,
        id: capability.id,
        label: capability.label,
        status: capability.status,
        reason: capability.holdReason
      });
    }
  }
}

for (const requiredPillar of requiredPillars) {
  if (!seenPillars.has(requiredPillar)) failConfiguration(`missing pillar: ${requiredPillar}`);
}

const derivedDecision = blockers.length === 0 ? 'GO' : 'HOLD';
if (config.decision !== derivedDecision) {
  failConfiguration(`declared decision ${config.decision} conflicts with derived decision ${derivedDecision}`);
}

console.log(`Sway complete-product readiness: ${derivedDecision}`);
console.log(`Verified capabilities: ${seenCapabilities.size - blockers.length}/${seenCapabilities.size}`);
if (blockers.length) {
  for (const blocker of blockers) {
    console.log(`- [${blocker.status}] ${blocker.pillar}/${blocker.id}: ${blocker.reason}`);
  }
}

if (assertReady && derivedDecision !== 'GO') {
  console.error('Complete-product launch assertion failed closed. Sway remains HOLD.');
  process.exit(1);
}
