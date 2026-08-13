# Sway Complete Product Gap Ledger

Date: 2026-08-12
Production evidence baseline: `main` at `b89d4033`
Complete-product decision: **HOLD**

The machine-readable source for the current decision is `config/sway-complete-product-readiness.json`. The fail-closed launch assertion is `npm run readiness:assert`.

Owner bar: **Do not ship until the product is complete.**

## Product Law

Governing structure: `docs/SWAY_PRODUCT_STRUCTURE.md` — Live Rooms (current) and Self-Production (in progress) are separate lanes.

1. One account can be audience and creator. Stripe verification unlocks getting paid, not using the site.
2. A live room is night mode, not an entry tax. The site must be useful with zero live room.
3. Original Sway—**Live Rooms**: rooms, requests, tips, boosts, queue control, QR sharing, profiles, moderation, earnings, and closeout—must remain intact as the current operating product.
4. Sway replaces the core DistroKid workflow **as one Self-Production external-distribution outlet**: durable masters, releases, DSP delivery, delivery management, royalties, splits and payouts, promotion, and safe catalog transfer. DistroKid-class distribution is not Sway’s identity and is not the whole of Self-Production (which also includes files, collaboration, releases, events/tickets, and planned Sway.DIO streaming).
5. Planned Sway.DIO streaming follows the decision D staged all-three funding summary in `docs/SWAY_PRODUCT_STRUCTURE.md`: subscription-funded Sway Exclusives first; advertising and sponsorships later; forever 100% attributable streaming income to qualifying Sway Exclusive artists; Sway takes $0 streaming cut; Sway Exclusive ≠ ownership. No royalty runtime yet — this is product law for the future lane, not a shipped capability.
6. The Live Rooms and Self-Production lanes should form one cohesive customer journey under one account, but readiness judgments, roadmaps, and release gates remain **independent**. Unfinished Self-Production does not make Live Rooms unfinished.
7. Schema, code, tests, PRs, deployments, and build markers are evidence inputs. None independently proves the customer outcome.
8. Live payment activation is a separate Live Rooms release gate after the Stripe test-mode production pilot is proven.

## Current Verified Production Facts

- The performer console is deployed with focused Home, Room, Profile, and Account workspaces.
- Production migration `0023_audio_publishing_foundation` is applied. The live migration ledger and required audio tables were inspected after the migration.
- The repository now uses a server-mediated Cloudflare R2 adapter intended for private production masters; Render remains only the application host. The server verifies bucket access before accepting traffic and rejects local filesystem storage in production, while the live bucket's actual public-access settings remain subject to the separate control below.
- Production merge `b89d4033` reports verified R2 readiness. A generated `16,044`-byte WAV was uploaded, sealed, downloaded with its exact SHA-256 before and after application restart, exported, independently hashed, and restored into a separate production project.
- A separately verified account was denied before sharing and after pairing; a one-use link returned exact bytes once and denied replay. Nine of the ten master-vault controls are recorded in `docs/qa-packets/2026-08-12-audio-master-storage-production-evidence.md`.
- The operator-accessible Cloudflare account has an active R2 subscription but zero buckets. The live credentials still pass R2 health and exact-byte retrieval, but the live bucket-owning account and disabled public URL/custom-domain settings remain unverified. Durable master storage therefore remains `implemented_unverified`.
- Two separately verified production accounts completed pairing, no-access-before-share, selected-version sharing, exact download, review, approval, grant revocation, re-share, and connection cascade-revocation. Final reconciliation found zero active connections and grants; `project_collaboration` is production verified in `docs/qa-packets/2026-08-12-audio-file-collaboration-production-evidence.md`.
- Deterministic storage evidence also proves multipart staging, exact sealing and retrieval after store reinitialization, staging cleanup, orphan abort, identity/traversal denial, one-use audit rollback, and concurrent one-use exclusion.
- The production build marker proves which commit is deployed. It does not prove complete-product readiness.

## Original Sway Pillar (Live Rooms — current operating product)

Judge this lane independently of Self-Production progress.

| Capability | Current truth | Readiness impact |
|---|---|---|
| Performer signup, login, and session | Implemented | Needs a current production role/access evidence packet |
| Creator home and public profile | Implemented and deployed | Full audience-to-creator account journey remains unverified |
| Live room, QR, requests, tips, boosts, and queue | Production verified in Stripe test mode | Test-mode milestone passed; live Stripe remains a separate release gate |
| Moderation, idempotency, and payment lifecycle | Production verified for the test-mode pilot | Authorized active-block lifecycle, isolated control account, terminal denial, and zero-payment enforcement are recorded |
| Overlay, earnings, closeout, and recap | Production verified for the test-mode pilot | Closed registry, terminal drain, and truthful non-payable test volume are recorded |
| Unified account for audience and creator | Universal signup, login, session, logout, audience access, and Pro Mode activation are implemented | Full production audience-to-creator journey remains unverified |

## DistroKid-Replacement Pillar (Self-Production external-distribution outlet)

This pillar tracks DistroKid-class external distribution work **inside Self-Production**. It is one outlet — not Sway’s identity, and not the full Self-Production product (files, collaboration, releases, events/tickets, planned Sway.DIO under the decision D economic summary in `docs/SWAY_PRODUCT_STRUCTURE.md`). Gaps here do not make Live Rooms unfinished.

| Capability | Current truth | Readiness impact |
|---|---|---|
| Audio publishing foundation schema and safety contracts | On `main`; migration applied in production | Foundation only |
| Durable exact-original master storage | Nine of ten live controls pass: verified R2 health, upload/seal, exact retrieval before and after restart, cross-account denial, one-use exhaustion, and independent recovery | **HOLD:** identify the live bucket-owning Cloudflare account and verify that its public development URL and custom public domains are disabled |
| Projects and Private file pairing QR | Production verified with two separate accounts; the recipient saw the no-access warning and pairing alone exposed no file | Preserve regression coverage; no remaining blocker in this capability row |
| Selected-file sharing, review, and approval | Production verified for selected immutable-version grant, exact download, note, approval, grant revoke, re-share, connection revoke, and terminal replay denial | Final active connection and grant counts were zero; no remaining blocker in this capability row |
| Release metadata, artwork, credits, territories, ISRC, and UPC | Audited editing, artwork, full recording credits, identifiers, territories, sealed rights declarations, independent review, and fail-closed readiness are implemented | Disposable PostgreSQL and production journey evidence are still required for this exact tree; store delivery remains disabled |
| Ordered multi-recording single, EP, and album assembly | Track add, per-track metadata and credits, reorder, remove, track-count validation, optimistic conflict denial, and rights-review locking are implemented | **Implemented, unverified:** the exact disposable PostgreSQL journey and a production creator journey remain required; store delivery remains disabled |
| DSP delivery | No contracted DSP delivery provider or live integration | Critical blocker |
| Store status, corrections, failures, and takedowns | State machine only | Critical blocker |
| Royalty statements and reconciliation | No distribution royalty ledger/runtime | Critical blocker |
| Collaborator splits, KYC/tax, and payouts | No distribution split/payout runtime | Critical blocker |
| Promotion and pre-save pages | Stable public release pages and profile release cards are implemented | Provider-backed destination links, true pre-saves, and destination updates remain missing |
| Catalog transfer and DistroKid cutover | Parity/continuity schema only; execution disabled | Critical blocker |

No contracted DSP delivery provider exists. No royalty ledger, collaborator distribution splits, or distribution payouts exist. Live-room payment records must never be reused as proof of distribution accounting.

## Sway.DIO pillar (planned native streaming — Self-Production)

Judge independently of Live Rooms. Economic law is the decision D staged all-three funding spine in `docs/SWAY_PRODUCT_STRUCTURE.md`; runtime is not shipped.

| Capability | Current truth | Readiness impact |
|---|---|---|
| Decision D staged funding + $0 streaming cut | Summarized in `docs/SWAY_PRODUCT_STRUCTURE.md` | Product law only |
| Subscription-funded Sway Exclusives (private beta / first earnable streams) | Not implemented | Future Self-Production lane |
| Later advertising-funded and sponsor-funded listening | Not implemented | Future Self-Production lane |
| 100% attributable streaming income to qualifying Sway Exclusive artists | Not implemented | Future Self-Production lane |
| Paid-listener beta + three audited payout cycles | Not started | Required before public Sway.DIO launch claims |

## Correct Outcome Order

1. Identify the Cloudflare account that owns the live bucket and prove its public development URL and custom domains are disabled; if ownership cannot be established, migrate deliberately to a controlled private bucket and rerun the exact-byte gate.
2. Preserve the completed production collaboration journey as a regression gate: connect, claim, share one immutable version, review, approve, revoke, and replay denial.
3. Build the cohesive Music workspace around projects, releases, delivery, promotion, earnings, and catalog transfer.
4. Prove release assembly and readiness end to end: ordered multi-recording metadata, identifiers, artwork, rights declarations, creator-deal evidence, and immutable approval.
5. Contract with and integrate one external DSP delivery provider; prove sandbox then controlled production delivery.
6. Build provider-backed status, correction, failure, takedown, and observability controls.
7. Build a separate append-only royalty ledger, statement reconciliation, splits, KYC/tax, and payouts.
8. Prove safe catalog parity, overlap, store matching, artist approval, cutover, and tail-royalty reconciliation.
9. Re-run the original Sway live-night production proof so distribution work cannot regress the original product.
10. Change the readiness decision to `GO` only after every required capability has independent production evidence.

## Explicit Non-Claims

- Applying migration `0023` does not ship music distribution.
- A generated pairing QR does not prove collaboration or file transfer.
- A configured storage path does not prove durability or restore.
- Verified application access to R2 does not prove which account owns the bucket or whether its public-access controls are disabled.
- A provider submission does not prove store acceptance or a live release.
- A deployed commit does not prove a successful deployment outcome.
- Passing contracts do not prove complete-product readiness.
- Locking Sway.DIO economics in product-structure language does not ship Sway.DIO streaming or royalty payouts.
