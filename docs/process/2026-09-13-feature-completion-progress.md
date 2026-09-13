# Feature completion work — 13 September 2026

Decision: Reviewable implementation in progress. This is not a whole-product completion, production release, live-money activation, or 10/10 rating claim.

## Goal and scope

Implement the gaps identified in the 110-capability feature and competitive audit. The complete baseline is preserved in `2026-09-13-feature-completion-register.json`; baseline scores refer to main at `7db08c3946da01c8831a24b61fe54903d6c87c84`. Current implementation builds on PR242 (`b954c9f194f99dc41b9e62c8d5d898b24a9ed39c`) so its account, cash-out and source-import recovery is retained.

## First implementation batch

- Spotify: complete bounded pagination, legacy/migrated response formats, strict provider URLs, credential rotation, expiry and single401 refresh, rate-limit/status handling, operation deadlines, duplicate-track elimination, snapshot consistency and no partial replacement.
- Import workflow: one deliberate POST, current-account/source preflight, replacement consent, strict matching receipt, aborted/stale-result suppression, accurate saved-but-refresh-failed feedback, and matching source versions checked inside the write transaction. Ownership is rechecked under lock. Common track writes acquire the performer lock first to match Spotify source-lock order.
- Payout recovery: existing provider batches reconcile while new execution is paused. No new or retried payouts are submitted during that pause. Durable read-attempt scheduling prevents repeatedly failing early records from monopolizing later ticks; it uses the database clock and preserves financial timestamps and reservation state.
- VirtualDJ: both fetch and body reads have enforced deadlines; unreadable state cannot become a fabricated paused deck; only the documented execution acknowledgement succeeds. Timeout messages preserve uncertainty and never replay the command.
- Private collaboration: recipients with original-download authority can listen and seek to the exact granted audio version. Local and R2 range reads, HTTP206/416, If-Range, HEAD, no-store and per-request authorization are implemented. Access is rechecked after storage opens; early stream failures and cancellation are handled.

## Validation and limits

`npm ci`, TypeScript, production build and focused recovery tests pass. Focused tests cover27 Spotify adapter cases,20 browser-workflow helper cases,6 VirtualDJ behavior cases, actual HTTP/range behavior and a migrated database source-write guard rejecting16 malformed/stale/foreign attempts. The accumulated-withdrawal suite, including53 migrations and a26-record failure/restart/clock-skew case, and the existing file-collaboration integration suite pass with embedded PostgreSQL.

The mandatory full `npm run test:contracts` was run and failed at Chromium launch. The exact official Chrome148.0.7778.96 / Playwright1223 binary was installed and verified; it exits SIGTRAP before creating a page in this runtime. Browser cases are not passed, skipped-as-passed or removed. A separately labeled diagnostic initially passed126 of137 commands. Three additional failures exposed and drove fixes for migration snapshot continuity, direct-script gate wiring/native failure recognition, and isolated child executable lookup. The other five failures invoke browser tests internally; three direct browser commands were explicitly not run in that diagnostic. These results do not replace the full gate. Standalone multi-backend PostgreSQL concurrency, physical decks, actual Spotify permissions, real R2 privacy and deployed user journeys are not newly proven by these local tests.

Hard gate repair preserves all137 expanded commands in the same order and adds negative probes for native Node failure behavior. It does not convert Chromium failures into passes. Independent mutation checks reject forbidden success exits, missing required gates and a falsely successful failure probe.

Independent reviews found and drove repairs for malformed catalog results, duplicate counts, playlist snapshot changes, transactional ownership/source replacement, payout readback starvation/clock skew, storage-stream failure timing and cross-source lock order.

## Data and release impact

Routes: Spotify import/search and source-list receipts; private GET/HEAD `/api/talent/audio/file-grants/:grantId/listen`. Existing track replacement acquires the common performer lock first. No new payment route.

Schema: additive migration0052 adds `provider_read_attempted_at` and a pending-readback index. Migration precedes runtime startup through the existing release path. No historic migration is rewritten. The0052 snapshot was produced by Drizzle from the actual schema; six pre-existing constraint-expression differences normalize SQL keyword casing only. A fresh generation reports no further schema changes.

Money: already-submitted outcomes can reconcile while paused; existing financial transitions and audits remain authoritative. Prices, fees, payout recipients, canary limits and activation controls are unchanged.

Persistence: source replacement checks a version and owner in the same transaction as tracks; listening never changes original objects; readback scheduling is separate from financial updates.

Roles: no broader file permission; listening requires the recipient's existing original-download grant. No AI, moderation-policy or App Store activation changes.

Rollback: revert code to the prior reviewed branch; the nullable readback column/index may remain unused. Do not remove a migration already applied to a deployed database or change live-money configuration as part of rollback.

## Next implementation and external requirements

An isolated collaborator-revision branch is being prepared. It must keep returned candidates private and separate from original masters, enforce selected-file grants and quotas, handle upload/provider failures durably, and provide explicit owner review and acceptance. A hidden backend alone does not finish that workflow.

The full audit still contains unimplemented and externally unverified capabilities. Contracted DSP delivery, royalty operations, Sway.DIO funding/listening, ordinary general payout activation, third-party OAuth/device permission, ticket operating expansion and signed native/desktop distribution cannot be represented as completed by this batch. Provider access, contracts, deployed acceptance and comparative outcomes remain necessary where applicable.

AGENTS.md and RELEASE_CONTROL.md require separate authorization for pushing/merging to auto-deploying main, and live money remains separately controlled. Work here is prepared for review without changing those controls. GitHub Actions is not a release gate.

Commit and working tree: use the enclosing commit and `git status`; this document describes an implementation checkpoint, not a release attestation.
