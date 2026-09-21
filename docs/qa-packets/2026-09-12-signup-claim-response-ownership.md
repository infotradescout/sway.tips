# Signup claim response ownership — September 12, 2026

Decision: PR #240 passes bounded local acceptance and independent review. Merge
and Render production deployment await a separate owner decision. Issue #223
remains open.

Business goal: Keep claim feedback tied to the current input, avoid duplicate
checks when creating an account, and let a user explicitly retry after a
temporary connection or server failure.

## Behavior and demonstrated failures

Editing, clearing, or unmounting invalidates previous claim checks. A late
success or failure cannot describe an older code or continue an obsolete signup.
Blur and submit share an in-flight check only when both its code and observation
sequence still match. Changing away from a code and back requires a new check.

A failed check stops signup. Definitive claim rejections remain invalid. Network
failures, HTTP 408/429, and 5xx responses instead remain unavailable: they show
feedback without declaring the code invalid. Clicking Create account again can
explicitly retry without editing or refocusing the field. Nothing retries or
creates an account automatically.

The initial PR already repaired stale responses. Acceptance then demonstrated
and corrected two further ordinary-browser defects:

- Clicking Create account with the claim field focused issued two lookups; the
  seven-case reproduction passed 6/7 and failed the duplicate request assertion.
- After HTTP 503, clicking the already-focused button could not retry. The
  desktop/mobile reproduction passed 16/18, failing that scenario at both widths.

Server account creation and claim authorization retain their existing behavior.

## Candidate and validation

- Original PR head: `6c6d2670e5c579a2e3ce57ee9cca7db8c731011f`.
- Released main integrated without conflict:
  `09d7a568a84057f776aee099fae2aced2cbeef71`.
- Final validated runtime/test commit:
  `a516f417b281c6533d71da010e12bb22a91b2b55`.
- The subsequent acceptance commit rewrites only this evidence document.
  Published runtime/test files match the validated commit exactly.
- The ten files from the approved profile release, including its branding and
  dj3x-only public partner rule, match released main. Canonical WIP was untouched.

Passed with zero exit status:

- Clean `npm ci` with the committed lockfile.
- `npm run lint`, `npm run build`, and complete `npm run test:contracts` on the
  final runtime commit. The complete gate includes the claim component proof;
  no missing browser/runtime dependency, skipped failure, or Actions gate remains.
- `node scripts/sway-signup-claim.behavior.test.mjs` — **22/22**, using the actual
  component and installed React with controlled HTTP in JSDOM.
- `node scripts/sway-signup-claim.browser.test.mjs` — **18/18**, using actual
  Chromium, React, and synthetic API responses at 390x844 and 1440x1000. Covers
  edit/clear and out-of-order replies, Enter and ordinary button submission,
  rejected claims, explicit 503 retry, and no automatic retry or premature signup.
- `git diff --check`.

Component coverage additionally includes superseded pending submissions,
edit-away/back to identical text, stale 503 feedback, HTTP 408/429/500/503/599,
network rejection, and definitively rejected-code resubmission.

Independent Objector review confirmed matching-code/sequence ownership and safe
pending-reference cleanup. Its focused lifecycle checks passed StrictMode replay,
unmount during a shared check, and explicit retry after temporary failure. Its
final three adversarial checks also passed: stale network rejection cannot
release a newer submit; an older 503 cannot own edit-away/back text; and a retry
ending in 400 blocks further unchanged-code submission. The temporary retry
finding was accepted and repaired; no blocker remains in this bounded diff.

Reviewed git blobs, verified again against the committed candidate:

- Component: `ab1d2605d1a509ae9410c1ff77860eb4d740b238`.
- Component test: `2f3fdd974205c25fd08355054b2f36179b522671`.
- Browser test: `829c29ade8b22355134dfe1e6bafb3a709c9cc7b`.

Local reproduction and final logs are retained under
`artifacts/signup-acceptance-20260912/`. These are browser/component proofs, not
production account creation, email delivery, or a new server authorization proof.

## Required handoff

Files inspected: AccountSignup/ClaimCodeField, account JSON handling and existing
claim contract, component/browser harnesses, released profile files, package
scripts, AGENTS.md, release control and governing product/doctrine instructions.

Files changed: `AccountAccess.tsx`, the existing account-claim contract, component
and browser tests, their two browser-fixture files, and this evidence packet.

Routes touched: Client behavior at `/account/signup` and its existing aliases;
existing `/api/account/claim/peek` and `/api/account/signup` callers only.

Schema touched: None.

Money behavior touched: None.

Persistence behavior touched: No backend change; obsolete submissions stop before
account creation. Claim authorization remains server owned.

Role/access behavior touched: None.

AI behavior touched: None.

Moderation behavior touched: None.

App Store impact: No readiness or submission claim.

Validation commands: Listed above; all required final-source gates passed.

Known risks: HTTP is synthetic in these proofs. They do not demonstrate delivered
verification email, real account creation, or the rest of issue #223.

Rollback path: Revert this bounded account repair; no migration or data rewrite.

Next required slice: Owner decision to merge and let Render deploy the verified
signup/payment repairs, followed by release identity and smoke verification.

Commit SHA: Validated runtime commit above; final published head is recorded in
the PR receipt and differs only by this evidence document.

Working tree status: Isolated acceptance checkout with generated local evidence
excluded from implementation commits. Canonical WIP preserved.
