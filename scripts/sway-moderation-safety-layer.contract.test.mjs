import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const moderationService = readFileSync(join(root, 'src/server/moderation-service.ts'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');

const failures = [];

const requiredServiceTerms = [
  'createModerationService',
  'evaluateSubmission',
  'addBlockRule',
  'recordPatronReport',
  'hideRequest',
  'removeRequest',
  'writeModerationEvent',
  'moderationEvents',
  "allow_with_local_filter",
  "hold_for_review",
  "block_submission",
  'AI moderation remains assistive only'
];

for (const term of requiredServiceTerms) {
  if (!moderationService.toLowerCase().includes(term.toLowerCase())) {
    failures.push(`Moderation service missing required term: ${term}`);
  }
}

const requiredServerTerms = [
  'createModerationService',
  '/api/moderation/report',
  '/api/moderation/block',
  '/api/moderation/hide',
  '/api/moderation/remove',
  '/api/moderation/placeholders',
  '/api/support/contact',
  '/api/privacy/data-deletion-placeholder',
  'moderationOutcome.decision',
  "outage_behavior: 'block_submission'"
];

for (const term of requiredServerTerms) {
  if (!server.includes(term)) {
    failures.push(`Server moderation path missing required term: ${term}`);
  }
}

const bannedExecutionTerms = [
  /new\s+Stripe/i,
  /stripe\.paymentIntents/i,
  /apple\s*pay/i,
  /capture\s*\/\s*refund\s*\/\s*webhook\s*execution/i,
  /tip-pooling/i,
  /payroll/i,
  /pms\s*integrations/i
];

for (const pattern of bannedExecutionTerms) {
  if (pattern.test(moderationService) || pattern.test(server)) {
    failures.push(`Slice 6 moderation layer contains banned out-of-scope behavior: ${pattern}`);
  }
}

if (failures.length) {
  console.error('Moderation safety layer contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Moderation safety layer contract passed.');