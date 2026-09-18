# Sway direct-control continuation — September 17, 2026

## Scope and release hold
Resume PR #249 / `implement/direct-music-control-20260916`, not the already shipped Sources PR #248. PR #247 is incorporated and must not be re-released. Product: third-party authorization, live authorized library, explicit destination and remote controls, with audio in the original player; no CSV and no room requirement.

No merge, production deploy/migration, provider activation, payment changes or outbound email are authorized by this continuation. Soundtrack outreach remains a draft according to the supplied handoff; no send action was performed here.

## Reproduced and corrected defect
At `9a7188fa5709b7feacbe75d53685f09aac7f737e`, injected `/me` data containing both a mutable public `id` and immutable `account_id` returned the mutable identifier. The standalone assertion failed with exit 1; the red JSON receipt records the exact source head and zero real provider calls.

Runtime candidate `39d85f514bbbbf21f1eaff79fa15db4e72e03072` uses `account_id` for stored identity, never falls back to public `id`, and treats display name as presentation only. Missing, empty, whitespace-only, malformed or oversized immutable IDs fail closed. No schema, migration, payment or provider-approval configuration changed.

Regression coverage verifies public-ID changes and omission, distinct immutable accounts, malformed immutable identity, the stored connection after OAuth, and stable identity after deliberate reconnect. The browser fixture now intentionally returns different public and immutable identifiers, and the signed-in browser test checks the stored immutable value.

Primary sources checked September 17, 2026:
- https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile
- https://developer.spotify.com/documentation/web-api/references/changes/may-2026

## Evidence provenance
The original `5d13581e` native report and image files were recovered from the existing checkout and copied before any rerun. They supplement, rather than rewrite, the earlier transcribed receipt. Their successful synthetic-provider result does not prove the new runtime or real playback.

The first gate started here at `9a7188fa` completed lint/build but was deliberately cancelled during contracts when the identity defect was reproduced. Preserve it as superseded/incomplete, not a passing full gate. The final gate and native run have separate receipts and source identities; results must be copied only after observing completion.

GitHub's `validate` run did not start because of a billing lock. Repository `AGENTS.md` explicitly says Actions is not a release gate. This work does not change billing, bypass any required local check, or treat unused Actions as an activation prerequisite.

## Completed technical verification
Required lint, build and the complete contract command chain passed at `39d85f514bbbbf21f1eaff79fa15db4e72e03072`, tree `6f20bb12f53d4c0a612fa3787c865b7c9cc760c0`, with tracked source unchanged. The chain retains 127 top-level commands and their nested checks. Native store/router tests reported 24 passes; the embedded and native signed-in browser journeys each passed all 15 checks. Actual provider calls: zero. Actual audio playback: not tested. See full-gate.json, summary.json and environment-specific raw JSON.

Desktop and 320px native application captures were inspected. These are synthetic-provider UI evidence, not a real account grant or physical-player proof.

The executed Windows runner copies retain their original temporary checkout/dependency paths for reproducibility; the portable required commands are npm run lint, npm run build and npm run test:contracts. Raw original logs remain on the authorized machine; archived current logs redact synthetic email output, database URLs and payment-key-shaped values.

Archived lint output omits the final empty line only; the original local log is retained.
