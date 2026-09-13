# Account and cash-out recovery — September 12, 2026

Decision: Passes bounded local acceptance and independent review on runtime/test
commit `a86f26bd43ff57d0d40607ed7ed904d871e50b85`. All required gates and the
standalone PostgreSQL proof pass. Merge and Render deployment await a separate
owner decision. Issue 223 remains open.

Business goal: Let account holders recover from failed reads and actions, and
make cash-out feedback agree with the durable withdrawal and balance.

## Delivered behavior

- An unavailable, expired, or malformed account session cannot expose account
  actions or crash the page. Session and claim reads have a 15-second deadline
  and explicit retry. Valid nullable names and email addresses remain supported.
- Claim and sign-out failures remain visible. Account mutations cannot compete;
  abandoned or superseded responses cannot redirect or overwrite a newer view.
  A confirmed claim is never repeated when its subsequent account refresh fails.
- Signup links to the existing `/terms` page in a separate tab, preserving the
  form without accepting terms or submitting an account.
- An authoritative PayPal batch denial without an item now uses the existing
  failed-withdrawal policy during submission readback, webhook processing, and
  scheduled reconciliation. It restores availability without inventing a payment,
  item ID, transaction ID, or fee debit. Batch success alone cannot prove payment.
- Cash-out displays paid, processing, held, unclaimed, failed, and returned
  outcomes distinctly. Balances come from a fresh server read after submission;
  the client no longer subtracts money optimistically. Unavailable totals remain
  unavailable and block another cash-out until an explicit read succeeds.
- Initial balance errors also offer recovery. Read generations and account
  lifecycle guards stop old successes or failures from overwriting a newer
  balance or reopening cash-out after a later withdrawal.

## Independent findings and resolution

The Objector reproduced and the implementation resolved these findings:

| Finding | Resolution and evidence |
| --- | --- |
| Operational risk: valid unnamed accounts rejected; malformed email crashed rendering | Match nullable API fields and validate rendered values. Native account matrix passes; independent actual React proof covers DTO and lifecycle cases. |
| Operational/copy risk: delayed old balance restored $15 after a newer cash-out showed $0 | Fence initial, explicit, and post-submit reads; invalidate at cash-out and account lifecycle changes. Independent Chromium passed delayed 200 and 503 cases at 390 and 1440 widths, preserving $0 and the disabled action. |
| Operational risk: denied withdrawal audit reported a fee debit despite full reservation release | Failed transition audit records zero debited fee while retaining quoted and actual fee evidence. Fresh database proof confirms $15 available, zero reserved, one transition audit, and duplicate no-op. |
| Operational risk: initial balance error hid the entire cash-out section | Render an unavailable state with an explicit read retry. Independent Chromium passed initial 503 and malformed 200 recovery at both widths with zero withdrawal POSTs. |

No remaining concrete objection was reported for the reviewed runtime blobs:

- `AccountAccess.tsx`: `bd7018a9dcca86478020b64330e1d5136496c712`
- `TalentDashboard.tsx`: `4710d405b09e9027eecb23e300aabfea08161a63`
- `performer-withdrawal-service.ts`: `3f1a7b268fe1d8525f4935303c24c63e2bc3afc8`

The Objector used actual application modules with controlled HTTP/provider
responses in independent React/JSDOM, Chromium, and fresh PGlite executions.
Its proofs ran in memory. The maintained browser and database tests below are
the reproducible repository evidence. No vote or reviewer assertion substitutes
for those tests.

## Validation

- Clean `npm ci` using the unchanged dependency lockfile: PASS.
- `npm run lint`: PASS on the runtime/test commit above.
- `npm run build`: PASS on that commit.
- `npm run test:contracts`: PASS in full, with zero exit status on the final
  runtime/test commit, including the browser runners and nested database proofs.
- `node scripts/sway-account-claim-onboarding.contract.test.mjs`: PASS, including
  22 actual React/JSDOM signup cases, 20 native Chromium signup cases, and 34
  native Chromium account cases. Browser widths are 390 and 1440.
- `node --import tsx scripts/sway-profile-payout-options.browser.test.ts`: PASS
  on the reviewed runtime, including withdrawal statuses, actual versus quoted
  fees, concurrent earnings, initial and post-submit read recovery, and delayed
  success/failure response ordering. The complete contract gate now includes
  this browser runner; it propagates failure rather than soft-passing.
- `git diff --check`: PASS.

Standalone PostgreSQL 18.4 also passed the complete performer withdrawal suite
and its native withdrawal/refund lock-order prerequisite. The strict launcher
used a freshly owned loopback-only cluster and the existing disposable database
guard, with `SWAY_REQUIRE_REAL_POSTGRES_PROOF=true`. It ran the exact service
blob above and withdrawal-test blob `2c944acb56f6115fa4abdc21e85ce1dcbd529eca`.
These match the candidate. All 52 existing migrations were applied; provider
responses were deterministic. The cluster was stopped after the run. There were
no production database connections, provider calls, or money movements.

An earlier contract/native attempt correctly exited nonzero because a new test
seed bypassed the database's terminal timestamp constraint. The fixture was
replaced with actual item-webhook transitions; the constraint was preserved.
Failed and final logs are retained separately.

Integration also retained the repository's required explicit nonzero browser
failure exit and nullable restriction-mapping form. Their existing contracts
were preserved; no assertion or gate was weakened to pass the repair.

Local evidence is under `artifacts/journey-repair-20260912/`, including
`final-lint.log`, `final-build.log`, `final-contracts.log`, `native-final.log`,
and `native-postgres-final/results.json`. Account browser receipts/screenshots
are under `artifacts/account-home-browser/`; cash-out screenshots are in `.tmp/`.
Fixtures use actual application styles/assets and the performer shell's inherited
dark background. These are synthetic browser proofs, not real account creation,
email delivery, or proof that an external recipient received money.

## Preserved release and boundaries

The separately approved PRs 239 and 240 were already released at
`7db08c3946da01c8831a24b61fe54903d6c87c84`. Live signup checks passed 18/18 on that
deployed build, and public profile checks passed 4/4 at 390/1440. The dj3x-only
public Partner tag remains in place. The ten files of the approved profile
release compare byte-for-byte with `09d7a568a84057f776aee099fae2aced2cbeef71`.

This follow-on work is based on that released main. It does not modify provider
activation, payment mode, fee policy, KYC or canary gates, accepted pricing,
profile content, or the canonical checkout's unrelated work. Issue 223 and
whole-product readiness remain open. This repair is not Sway completion or a
live-money authorization.

## Required handoff

Files inspected: Account access and its session/claim/logout/activation routes,
Terms route, payout service/provider/audit/destination consumers, dashboard,
schema and disposable database helper, browser harnesses, package gates,
AGENTS.md, release control, product structure and engineering doctrine.

Files changed: Three production components/services listed above; account and
signup browser tests and fixtures; payout browser test and fixture; withdrawal
behavior test; account-claim contract runner; package contract wiring; this packet.

Routes touched: Existing `/account`, `/account/signup`, account session/claim/
activation/logout callers, and the `/terms` link; existing talent payout balance,
withdrawal, PayPal webhook and scheduled reconciliation consumers. No route added.

Schema touched: None.

Money behavior touched: Delayed batch denial releases the existing reservation.
Audit fee debit matches the unchanged failed-withdrawal balance policy. Dashboard
status and balance display become authoritative. No real money action occurred.

Persistence behavior touched: Existing transactional withdrawal updates and
audit records; batch/item identity, payment mode, terminal and replay guards
remain in force. No account persistence or server authorization change.

Role/access behavior touched: Hide account actions without a valid session;
ignore replies from an abandoned account/performer view. Server authorization
remains the security boundary.

AI behavior touched: None.

Moderation behavior touched: None.

App Store impact: No readiness claim, submission or native package change.

Validation commands: Listed above; all required final-source gates passed.

Known risks: Provider and account responses are synthetic in local proofs. No
external recipient delivery, production email, or whole-product completion is
established. A new release still needs its own approval and post-deploy proof.

Rollback path: Revert this bounded repair after an authorized release decision;
no schema reversal or data rewrite is needed. Existing terminal payout records
and audit history must be retained.

Next required slice: Owner decision for this verified candidate's merge and
Render deployment, followed by release identity and changed-path verification.
Remaining customer-to-recipient and broader product work continues separately
under issue 223.

Commit SHA: Runtime/test candidate `a86f26bd43ff57d0d40607ed7ed904d871e50b85`;
subsequent acceptance changes must be documentation only.

Working tree status: Isolated branch `codex/sway-journey-readiness-20260912`;
generated proof files excluded from implementation commits. The canonical
checkout, including other ongoing music/catalog and county-map work, was not
edited by this task.
