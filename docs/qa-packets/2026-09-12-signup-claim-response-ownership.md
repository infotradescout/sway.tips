# Signup claim response ownership — September 12, 2026

## Decision and business goal

Implement a bounded continuation of issue #223's account journey: the performer
shown beside a signup claim code must belong to the code currently entered.
Previously, editing or clearing the input did not invalidate an in-flight lookup.
Late success/error responses could describe the old code. Submission also ran a
second lookup after waiting for the first, including after the first was rejected.

Every edit, empty validation, and component cleanup now invalidates older checks.
New checks clear the previous preview. Validation returns an explicit result so
submission stops after a failed or superseded check and does not repeat it.
Server claim authorization and account creation remain the existing owners.

## Base and integration

- Base: main `181b46144391704d5baa6baf5fec065fec6b3b70`.
- Local branch: `fix/signup-claim-response-ownership-20260912`.
- Current unfinished PR #239 (`c74370b0cffeb3ef175f2aeeda17ee662fb76812`)
  changes eight payment/clock files. PR #238 changes nine profile/browser/CSS
  files. Their current changed-file lists do not overlap this repair.
- This is a main-based account repair, independently combinable with those
  candidates; it does not replace their canonical work or complete issue #223.

## Validation

- `npm ci --no-audit --no-fund`: passed with lockfile dependencies.
- `npm run lint`: passed.
- `npm run build`: passed.
- `node scripts/sway-account-claim-onboarding.contract.test.mjs`: passed,
  including the newly wired actual-component response-ownership test.
- Final component proof: **11/11 passed** using the actual AccountSignup,
  installed React, JSDOM, and controlled HTTP responses. Covers edit/clear versus
  late success/error, reordered checks, one-check submission, failed checks,
  pending submission superseded by edit/clear, a previously valid code replaced
  before submission, and a cleared URL-prefilled code. Superseded submissions
  preserve the current input, release pending state, and send no signup request.
- Baseline comparison on the unchanged base component: the original eight
  scenarios produced **1/8 passed, 7 failures**. Three additional submission
  challenges were added afterward and passed on the repaired source.
- Full `npm run test:contracts`: **not passed**. The first invocation stopped
  because this runtime exposed `process.execPath` as `node` and a pre-existing
  child test intentionally supplies an environment without PATH. Re-running
  with the installed Node executable addressed through its absolute path passed
  that test and progressed until the existing refund-confirmation browser test
  could not find Playwright Chromium. No product code or test guard was changed
  to accommodate the runtime.
- The six-case signup browser suite and fixture are prepared, **not executed**.
  Playwright's browser download returned HTTP 502. A separately obtained
  Chromium binary reported its version but exited with SIGTRAP on launch here.
  JSDOM proof is not browser/layout, backend, real-account or production proof.
- `git diff --check`: passed. Root independent diff review requested the three
  additional submission challenges above; those are included and passed.

## Handoff

- Files inspected: `AGENTS.md`, `RELEASE_CONTROL.md`, governing product/doctrine
  docs, `AccountAccess.tsx`, its account-claim contract, existing test harnesses,
  issue #223 and current PR #238/#239 scope.
- Files changed: `AccountAccess.tsx`, its existing onboarding contract, new
  component/browser regression tests and browser fixture, this evidence packet.
- Routes touched: client behavior on `/account/signup` and its existing aliases;
  no route registration or API contract changed.
- Schema, money, persistence, role/access, AI, moderation: unchanged.
- App Store impact: no readiness claim or submission change.
- Known risks: browser/full-contract completion remains unproved in this runtime.
- Rollback: revert this bounded source/test commit; no migration or data rewrite.
- Next required slice: run the prepared browser proof and complete contracts in
  the existing isolated validation environment before release consideration.
- Release state: local implementation only; no push, PR, merge, deployment,
  customer account mutation, payout or provider operation.
- Commit SHA and final working-tree status: supplied with the local handoff.
