# Payment repair acceptance — September 12, 2026

Decision: PR #239 passes bounded local acceptance and independent review. Merge
and production deployment require a separate owner decision. Issue #223 remains
open; this evidence does not establish the complete customer-to-recipient flow.

Business goal: Allow an otherwise approved PayPal-only configuration when Venmo
is disabled, and keep payment-operation/webhook scheduling correct when an
application clock differs from the database clock.

## Candidate and preserved work

- Original PR head: `c74370b0cffeb3ef175f2aeeda17ee662fb76812`.
- Released main integrated without conflict:
  `09d7a568a84057f776aee099fae2aced2cbeef71`.
- Validated runtime commit: `b1ecb70ee0734b246967020a34c3512a05cec3f6`.
- Subsequent acceptance commit adds this evidence document only. Production
  modules, tests, dependencies, migrations and build configuration match the
  validated runtime commit.
- The approved profile branding and dj3x-only public partner tag match released
  main. The canonical checkout and its unrelated county-map work were untouched.

## Independent evidence

All commands below exited zero in the isolated acceptance checkout, using its
lockfile dependencies:

- `npm ci`
- `npm run lint`
- `npm run build`
- `npm run test:contracts` — complete hard gate, including its nested browser and
  database tests; no skipped failure or Actions dependency.
- `npm run test:paypal-payout-readiness` — 26 added configuration regressions
  plus existing readiness cases.
- `npm run test:paypal-payouts`
- `npm run test:payout-destinations`
- `npm run test:performer-withdrawals`
- `npm run test:payment-pricing`
- `npm run test:browser:profile-payout-options` — actual Chromium and application
  components with synthetic API responses.

Standalone PostgreSQL 18.4, bound only to loopback in a newly owned disposable
cluster, also passed:

- `node --import tsx scripts/sway-payment-operation-clock.integration.test.mjs`
  — all 15 clock-skew assertions, with the database clock independent of the
  application process.
- `node --import tsx scripts/sway-withdrawal-refund-concurrency.integration.test.ts`
  — strict withdrawal/refund lock-order proof.
- `node --import tsx scripts/sway-live-room-crash-concurrency.integration.test.ts`
  — strict crash/recovery and concurrent-caller proof.

These three runs used `SWAY_REQUIRE_REAL_POSTGRES_PROOF=true` and the existing
disposable-target guard, separate new test databases, and deterministic provider
adapters. The cluster was stopped afterward. No production database, account,
provider credential, provider request, or money movement was used. The first
local launcher was stopped after Windows inherited pipe handles prevented it
from returning after database startup; using ignored launcher handles allowed
the complete new-cluster run above. No product code was changed for this issue.

The independent Objector reviewed all eight PR files and consumers. It confirmed
that disabled Venmo alone is bypassed; enabled Venmo still requires approval.
Funding, fee, KYC, execution, mode, and canary gates remain intact. Eligibility
and post-lock ownership checks use database time, while completion/failure
updates preserve owner-token predicates and durable provider idempotency.
No blocking finding was confirmed. The reviewer also reran readiness and
`git diff --check`, both passing.

Local logs and the owned-database launcher/identity/results are retained under
`artifacts/payment-acceptance-20260912/`. The final published PR head and
runtime-identity comparison are recorded in its conversation receipt.

## Required handoff

Files inspected: All eight PR files, their payment and payout route/service
consumers, schema/client and disposable database helpers, package scripts,
AGENTS.md, release control and governing product/doctrine instructions.

Files changed: Three production modules (`paypal-payout-readiness.ts`,
`live-room-payment-operation-store.ts`, `payment-webhook.ts`), their five
test/helper files, and this acceptance packet; the original PR owns the eight
code/test changes.

Routes touched: Existing payment/webhook and payout consumers; no route added.

Schema touched: None; all 52 existing migrations used by integration proofs.

Money behavior touched: Readiness and operation/webhook scheduler timing. No
fee policy, processor, provider activation, withdrawal canary or payment mode
configuration changed.

Persistence behavior touched: Database-generated eligibility, retry and lease
timestamps; existing idempotency and owner fencing preserved.

Role/access behavior touched: None.

AI behavior touched: None.

Moderation behavior touched: None.

App Store impact: No App Store readiness claim or submission change.

Validation commands: Listed above; all required local gates passed.

Known risks: These proofs do not demonstrate an external recipient receiving a
payout or establish whole-product readiness. Unchanged pending-action TTL
comparisons and some audit timestamps still use application time; the clock
claim is limited to operation/webhook scheduling.

Rollback path: Revert the bounded payment repair if an authorized release needs
rollback; no schema reversal or data rewrite is required.

Next required slice: Owner merge/deployment decision for this verified repair;
the remaining issue #223 acceptance work remains separate and open.

Commit SHA: Validated runtime commit above; final published head is in the PR
receipt and differs only by this evidence document.

Working tree status: Isolated repair checkout; generated local proof artifacts
are excluded from the implementation commit. Canonical WIP preserved.
