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
  'recordBlockEnforcement',
  'hideRequest',
  'removeRequest',
  'writeModerationEvent',
  'activeBlocks',
  'findMatchingBlock',
  "eq(activeBlocks.status, 'active')",
  'isNull(activeBlocks.revokedAt)',
  'lockModerationBlockIdentities',
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

if (/new\s+Map\s*<.*BlockRule.*>\s*\(/i.test(moderationService) || /blockRules\.set\(/i.test(moderationService)) {
  failures.push('Moderation service still uses an in-memory blockRules map as enforcement source of truth.');
}

const requiredServerTerms = [
  'createModerationService',
  '/api/moderation/report',
  '/api/moderation/block',
  '/api/moderation/block/revoke',
  '/api/moderation/hide',
  '/api/moderation/remove',
  '/api/moderation/placeholders',
  '/api/support/contact',
  '/api/privacy/data-deletion-placeholder',
  'moderationOutcome.decision',
  "outage_behavior: 'block_submission'"
];

for (const term of [
  'requireAdminOrSupportAccess',
  'requireAdminAccess',
  'executeModerationMutation',
  'moderationMutationKeys',
  "eventType: 'moderation.block.revoke'",
  "moderation_action: 'block_already_inactive'",
  "error: 'This submission is unavailable due to an active safety restriction.'"
]) {
  if (!server.includes(term)) {
    failures.push(`Server moderation revocation path missing required term: ${term}`);
  }
}

if (/req\.headers\[[^\]]*resolved/i.test(readFileSync(join(root, 'src/server/access-control.ts'), 'utf8'))) {
  failures.push('Server-resolved actor identity must not be stored in or read from inbound request headers.');
}

if (/recordPatronReport\([\s\S]{0,240}block_submission/.test(server)) {
  failures.push('Active-block enforcement must not be misreported as a patron report.');
}

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
