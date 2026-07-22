# Sway Complete Product Gap Ledger

Date: 2026-07-21  
Branch baseline: `main` at `e1317bb1`
Complete-product decision: **HOLD**

The machine-readable source for the current decision is `config/sway-complete-product-readiness.json`. The fail-closed launch assertion is `npm run readiness:assert`.

Owner bar: **Do not ship until the product is complete.**

## Product Law

1. One account can be audience and creator. Stripe verification unlocks getting paid, not using the site.
2. A live room is night mode, not an entry tax. The site must be useful with zero live room.
3. Original Sway—rooms, requests, tips, boosts, queue control, QR sharing, profiles, moderation, earnings, and closeout—must remain intact.
4. Sway must replace the core DistroKid workflow: durable masters, releases, DSP delivery, delivery management, royalties, splits and payouts, promotion, and safe catalog transfer.
5. The original and distribution pillars must form one cohesive customer journey.
6. Schema, code, tests, PRs, deployments, and build markers are evidence inputs. None independently proves the customer outcome.

## Current Verified Production Facts

- The performer console is deployed with focused Home, Room, Profile, and Account workspaces.
- Production migration `0023_audio_publishing_foundation` is applied. The live migration ledger and required audio tables were inspected after the migration.
- Pairing-token creation is production verified with the authenticated performer account: the server created a one-time QR with an expiry and no database error.
- Pairing claim, selected-file grant, exact-original download, review/approval, replay denial, and revoke were not completed in that production smoke.
- The repository now uses a private Cloudflare R2 adapter for production masters; Render remains only the application host. The server verifies bucket access before accepting traffic and rejects local filesystem storage in production.
- Production commit `0fff1da9` reports verified R2 readiness and rejects an unauthenticated project-asset request with `401` plus `Cache-Control: no-store`; the sanitized packet is `docs/qa-packets/2026-07-22-audio-production-evidence.md`.
- Deterministic storage evidence proves multipart staging, exact sealing and retrieval after store reinitialization, staging cleanup, orphan abort, and identity/traversal denial. It does not prove the live bucket, production authorization journey, or independent recovery.
- The production build marker proves which commit is deployed. It does not prove complete-product readiness.

## Original Sway Pillar

| Capability | Current truth | Readiness impact |
|---|---|---|
| Performer signup, login, and session | Implemented | Needs a current production role/access evidence packet |
| Creator home and public profile | Implemented and deployed | Full audience-to-creator account journey remains unverified |
| Live room, QR, requests, tips, boosts, and queue | Implemented with contracts and historical QA | Needs current production transaction proof for the complete loop |
| Moderation, idempotency, and payment lifecycle | Implemented in code and contracts | Code/contracts alone are not production outcome evidence |
| Overlay, earnings, closeout, and recap | Implemented | Needs current production live-night closeout evidence |
| Unified account for audience and creator | Universal signup, login, session, logout, audience access, and Pro Mode activation are implemented | Full production audience-to-creator journey remains unverified |

## DistroKid-Replacement Pillar

| Capability | Current truth | Readiness impact |
|---|---|---|
| Audio publishing foundation schema and safety contracts | On `main`; migration applied in production | Foundation only |
| Durable exact-original master storage | Live private R2 upload/seal/download and unauthenticated HTTP denial verified | Cross-account evidence command still needs production execution; separately controlled independent recovery remains unverified |
| Projects and Private file pairing QR | Project/pairing routes exist; QR creation verified | Full two-account production journey remains unverified |
| Selected-file sharing, review, and approval | Durable runtime and disposable integration cover grant, exact download, review, approval, revoke, replay denial, and audit | Production two-account proof remains required |
| Release metadata, artwork, credits, territories, ISRC, and UPC | Audited editing, artwork, full recording credits, identifiers, territories, sealed rights declarations, independent review, and fail-closed readiness are implemented | Disposable PostgreSQL and production journey evidence are still required for this exact tree; store delivery remains disabled |
| DSP delivery | No contracted DSP delivery provider or live integration | Critical blocker |
| Store status, corrections, failures, and takedowns | State machine only | Critical blocker |
| Royalty statements and reconciliation | No distribution royalty ledger/runtime | Critical blocker |
| Collaborator splits, KYC/tax, and payouts | No distribution split/payout runtime | Critical blocker |
| Promotion and pre-save pages | Stable public release pages and profile release cards are implemented | Provider-backed destination links, true pre-saves, and destination updates remain missing |
| Catalog transfer and DistroKid cutover | Parity/continuity schema only; execution disabled | Critical blocker |

No contracted DSP delivery provider exists. No royalty ledger, collaborator distribution splits, or distribution payouts exist. Live-room payment records must never be reused as proof of distribution accounting.

## Correct Outcome Order

1. Configure durable private production object storage and prove upload, seal, exact-download, restore, and access denial.
2. Complete the project collaboration journey: connect, claim, share one immutable version, review, approve, revoke, and replay denial.
3. Build the cohesive Music workspace around projects, releases, delivery, promotion, earnings, and catalog transfer.
4. Build release readiness: metadata, identifiers, artwork, rights declarations, creator-deal evidence, and immutable approval.
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
- A provider submission does not prove store acceptance or a live release.
- A deployed commit does not prove a successful deployment outcome.
- Passing contracts do not prove complete-product readiness.
