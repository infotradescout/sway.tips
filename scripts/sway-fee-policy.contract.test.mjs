import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const failures = [];

const feePolicySource = readFileSync(join(root, 'src/server/fee-policy.ts'), 'utf8');
const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
const serviceSource = readFileSync(join(root, 'src/server/payment-service.ts'), 'utf8');
const storeSource = readFileSync(join(root, 'src/server/business-store.ts'), 'utf8');
const schemaSource = readFileSync(join(root, 'src/db/schema.ts'), 'utf8');
const partnerStoreSource = readFileSync(join(root, 'src/server/partner-entitlement-store.ts'), 'utf8');

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(message);
}

// 1. The old hardcoded flat-fee placeholders must be gone -- replaced by the
//    centralized fee-policy helper, at both the tip/request and boost routes.
if (/const proposedPlatformFeeCents = paymentsEnabledForAction \? 100 : 0;/.test(serverSource)) {
  failures.push('server.ts still contains the old hardcoded flat platform fee (tip/request route).');
}
if (/appliedBoostPlatformFeeCents = paymentsEnabledForRoom \? 100 : 0;/.test(serverSource)) {
  failures.push('server.ts still contains the old hardcoded flat platform fee (boost route).');
}
requireIncludes(serverSource, 'resolveProposedPlatformFee({ subtotalCents: amount_cents, attribution })', 'The tip/request route must compute the proposed fee via resolveProposedPlatformFee.');
requireIncludes(serverSource, 'resolveProposedPlatformFee({ subtotalCents: amount_cents, attribution: boostAttribution })', 'The boost route must compute the proposed fee via resolveProposedPlatformFee.');
requireIncludes(serverSource, 'businessStore.resolveCampaignAttribution(durableGigId, normalizedCampaignCode)', 'server.ts must resolve campaign attribution server-side before computing a fee.');
// campaign_code arrives as untyped req.body input -- must be type-guarded before use,
// never passed raw into a DB query (a non-string body value could otherwise throw
// inside an unguarded async handler).
requireIncludes(serverSource, "const normalizedCampaignCode = typeof campaign_code === 'string' ? campaign_code : null;", 'server.ts must type-guard campaign_code before querying with it.');

// 2. The proposed fee is a pure "what Sway wants to charge" number -- it must NOT
//    itself apply the patron/performer split or any cap. Both of those are owned
//    downstream (calculateSwayPaymentAmounts / resolveSwayPlatformFeePolicyForGig in
//    payment-service.ts + partner-entitlement-store.ts) so there is exactly one place
//    that ever clamps a fee for a Brand Partner.
if (/input\.feeType|\bfeeType:/.test(feePolicySource)) {
  failures.push('fee-policy.ts must not accept/use feeType/platformFeePayer as a parameter -- that split is owned by payment-service.ts.');
}
if (/platformFeeCapCents|partnerTermsVersion|partnerEntitlement/i.test(feePolicySource)) {
  failures.push('fee-policy.ts must not duplicate Brand Partner cap logic -- that lives in partner-entitlement-store.ts.');
}
requireIncludes(feePolicySource, 'proposedPlatformFeeCents:', 'resolveProposedPlatformFee must return a proposedPlatformFeeCents field.');

// 3. Sway never invents the promoted rate -- it must come from the campaign, never
//    a code constant, and the creator-direct tier must stay a fixed, independent
//    constant (not the room's configurable minimumTip).
requireIncludes(feePolicySource, 'CREATOR_DIRECT_TIER_THRESHOLD_CENTS = 500', 'Creator-direct tier threshold must be the fixed $5 breakpoint.');
requireIncludes(feePolicySource, 'CREATOR_DIRECT_PCT_BELOW_THRESHOLD = 0.20', 'Creator-direct rate below the threshold must be 20%.');
requireIncludes(feePolicySource, 'CREATOR_DIRECT_FLAT_CENTS_AT_OR_ABOVE = 100', 'Creator-direct flat rate at/above the threshold must be $1.');
requireIncludes(feePolicySource, "input.attribution.kind === 'sway_promoted'\n    ? Math.round(input.subtotalCents * input.attribution.commissionBps / 10000)", 'Promoted commission must be computed from the campaign-supplied commissionBps, never a hardcoded rate.');
if (/commissionBps\s*=\s*\d/.test(feePolicySource)) {
  failures.push('fee-policy.ts must not hardcode a promoted commissionBps value.');
}
if (/\.minimumTip/.test(feePolicySource)) {
  failures.push('fee-policy.ts must not couple the fee tier to the room\'s configurable minimumTip.');
}

// 4. server.ts must feed the proposed fee into the SAME field
//    (resolveSwayPlatformFeePolicyForGig's proposedPlatformFeeCents input, exposed as
//    AuthorizeActionInput.platformFeeCents) that the Brand Partner cap resolver reads --
//    a promoted campaign must never be able to bypass an existing partner's fee cap.
requireIncludes(serverSource, 'platformFeeCents: proposedPlatformFeeCents,', 'The tip/request route must pass the proposed fee as platformFeeCents so the Brand Partner cap resolver can clamp it.');
requireIncludes(serverSource, 'platformFeeCents: appliedBoostPlatformFeeCents,', 'The boost route must pass the proposed fee as platformFeeCents so the Brand Partner cap resolver can clamp it.');
requireIncludes(serviceSource, 'resolveSwayPlatformFeePolicyForGig', 'payment-service.ts must resolve the Brand Partner fee cap for every authorization -- this is the single point that may reduce a proposed fee.');
requireIncludes(partnerStoreSource, 'platformFeeCents: Math.min(proposedPlatformFeeCents, platformFeeCapCents)', 'An effective Brand Partner entitlement must cap the proposed fee, regardless of attribution source.');

// 5. Attribution and commission are persisted on the payment row.
requireIncludes(serverSource, 'attributionSource: proposedFee.attributionSource,', 'The tip/request route must persist attributionSource.');
requireIncludes(serverSource, 'attributionSource: proposedBoostFee.attributionSource,', 'The boost route must persist attributionSource.');
requireIncludes(serviceSource, 'attributionSource: input.attributionSource,', 'payment-service.ts must persist attributionSource on the payments row.');
requireIncludes(serviceSource, 'payment.attributionSource === input.attributionSource', 'confirmAuthorizedAction must re-verify attribution consistency, not just the fee amount.');

// 6. Attribution must be resolved server-side against a real, active,
//    performer-scoped campaign -- never trusted from the client directly, and
//    never inferred from mere "browsed Sway" traffic (no time-window/session hooks).
for (const term of [
  "eq(gigSessions.id, gigId)",
  "eq(promotionCampaigns.campaignCode, campaignCode)",
  "eq(promotionCampaigns.status, 'active')",
  "or(isNull(promotionCampaigns.expiresAt), gt(promotionCampaigns.expiresAt, new Date()))"
]) {
  requireIncludes(storeSource, term, `resolveCampaignAttribution missing required verification term: ${term}`);
}
requireIncludes(storeSource, "if (!db || !campaignCode) return { kind: 'creator_direct' };", 'resolveCampaignAttribution must default to creator_direct when no code is supplied.');

// 7. Sway never invents the promoted rate at the schema level either --
//    commissionBps is a required field on every campaign, not defaulted.
requireIncludes(schemaSource, "commissionBps: integer('commission_bps').notNull()", 'promotionCampaigns.commissionBps must be required.');
if (/commissionBps:\s*integer\('commission_bps'\)[^,\n]*\.default\(/.test(schemaSource)) {
  failures.push('promotionCampaigns.commissionBps must not have a code-level default.');
}

// 8. Runtime arithmetic check (executes the real pure function via tsx, not just
//    a text match) -- locks in the tier boundary and the promoted-rate math.
const tmpCheckFile = join(root, `_tmp_fee_policy_runtime_check_${process.pid}.mjs`);
try {
  writeFileSync(tmpCheckFile, `
import { resolveProposedPlatformFee } from './src/server/fee-policy.ts';
const cases = [
  { subtotalCents: 300, attribution: { kind: 'creator_direct' } },
  { subtotalCents: 499, attribution: { kind: 'creator_direct' } },
  { subtotalCents: 500, attribution: { kind: 'creator_direct' } },
  { subtotalCents: 1000, attribution: { kind: 'sway_promoted', campaignId: 'c1', commissionBps: 3500 } }
];
console.log(JSON.stringify(cases.map((c) => resolveProposedPlatformFee(c))));
`);

  const stdout = execFileSync(process.execPath, ['--import', 'tsx', tmpCheckFile], { cwd: root, encoding: 'utf8' });
  const results = JSON.parse(stdout.trim().split('\n').pop());

  const expectations = [
    { proposedPlatformFeeCents: 60, attributionSource: 'creator_direct' },   // $3.00 creator-direct: 20% = 60c
    { proposedPlatformFeeCents: 100, attributionSource: 'creator_direct' }, // $4.99 creator-direct: 20% rounds to $1, matches the flat tier
    { proposedPlatformFeeCents: 100, attributionSource: 'creator_direct' }, // $5.00 creator-direct: flat $1
    { proposedPlatformFeeCents: 350, attributionSource: 'sway_promoted', commissionBpsApplied: 3500 } // $10 at a 35% negotiated campaign rate
  ];

  expectations.forEach((expected, i) => {
    const actual = results[i];
    const mismatch = !actual
      || actual.proposedPlatformFeeCents !== expected.proposedPlatformFeeCents
      || actual.attributionSource !== expected.attributionSource
      || (expected.commissionBpsApplied !== undefined && actual.commissionBpsApplied !== expected.commissionBpsApplied);
    if (mismatch) {
      failures.push(`resolveProposedPlatformFee case ${i} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  });
} catch (error) {
  failures.push(`Failed to execute fee-policy runtime check: ${error.message}`);
} finally {
  try { unlinkSync(tmpCheckFile); } catch {}
}

// 9. The new contract test must actually be wired into the gate.
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
requireIncludes(
  packageJson.scripts?.['test:contracts'] ?? '',
  'node scripts/sway-fee-policy.contract.test.mjs',
  'test:contracts must include the fee policy contract.'
);

// The Brand Partner cap interaction can only be proven against a real database --
// this just confirms the DB-backed proof exists and is wired in, not that it passed.
requireIncludes(
  packageJson.scripts?.['test:integration:fee-policy-brand-partner-cap'] ?? '',
  'node scripts/sway-fee-policy-brand-partner-cap.integration.test.mjs',
  'package.json must wire up the Brand Partner cap integration test.'
);
if (!existsSync(join(root, 'scripts/sway-fee-policy-brand-partner-cap.integration.test.mjs'))) {
  failures.push('Brand Partner cap integration test file is missing.');
}

if (failures.length) {
  console.error('Fee policy contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Fee policy contract passed.');
