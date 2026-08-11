# Sway Product Spine

Updated: 2026-08-09

## Current Baseline

`origin/main @ 7d29d4` before this Collaborator Inbox lane. The current worktree builds on the existing `0023_audio_publishing_foundation` baseline and adds the unmerged Inbox changes described below; the eventual merge SHA is intentionally not guessed.

Owner bar (2026-07-21): **Do not ship an incomplete product.** Live-room money alone is not completeness. Publishing, collaboration, file sharing, and a usable account home without a live room are in-scope product, not “later expansion.”

See `docs/SWAY_COMPLETE_PRODUCT_GAP.md` for the honest shipped-vs-missing ledger.

## Product Law

1. One Sway account can act as audience and creator. Stripe verification unlocks receiving payouts / paid intake — not permission to use the site.
2. A live room is optional night mode. Users must be able to use Sway with zero live room (home, profile, join others, files/collab entry).
3. The live-night money loop remains sacred and must stay truthful, but it is **one surface**, not the whole product.
4. Publishing / collaboration / file-sharing foundations that exist only as schema or side branches are unfinished until durable runtime + UI + production evidence exist.
5. Do not market DistroKid replacement, lossless collab, or catalog cutover until those runtimes are fail-closed and proven.

## Core Surfaces

### A. Account home (required; broader surface not yet complete)
- Sign in once
- Join a room / scan
- Start a room when ready
- Profile and public page
- Always-visible entry to the universal Collaborator Inbox
- Private connections, selected files shared with/by the account, permission-gated download/review, and revocation
- Stripe Connect status for getting paid

### B. Live-night money loop (shipped locally; production payments in test)
Room settings -> Create room -> Show QR/link -> Request/Tip/Boost -> Approve/Deny/Complete -> Patron status -> Earnings -> End room -> Recap.

### C. Publishing & collaboration (current runtime slice implemented; broader product incomplete)
- Preserve original masters with integrity
- Project-scoped collaborators
- Private account pairing, explicit selected-version grants, and grant-scoped review
- Universal `/account/collaboration` inbox for collaborators with or without Pro Mode
- Release delivery and catalog transfer contracts
- Continuum connector (fail-closed until real)

## One-Sentence Product Lock

Sway is the creator’s account for live audience money **and** audio collaboration/publishing — usable every day, with live rooms and payouts when the creator chooses.

## Room Money Mode

- Paid request rooms use the room minimum for paid requests and paid boosts; the current floor is $5.
- Free request rooms make requests free and convert boosts into free upvotes with fixed weight 1.
- Direct tips remain paid even when request mode is free.
- Room creation captures the selected `paymentsEnabled` mode.
- Stripe/payment provider integration remains separate from room-entry UX and money-mode copy changes unless explicitly scoped.

## Core Users

- A **user** can join rooms as audience and, when they choose, create/perform.
- **Collaborators** (producer, engineer, reviewer) use the same authenticated account through private connections and grants — not a third public marketing side.
- **Admin** remains internal-only.

## Production Principles

- Public totals must only reflect real persisted activity.
- Payment language must describe the processor flow exactly as implemented.
- Moderation must remain active even when AI providers are unavailable.
- Every money event must have a lifecycle and ledger trail.
- Public room state is a projection, never the internal room object (PR #109 boundary).
- Any `drizzle/` change must apply via deploy `preDeployCommand`, not hope.
- Capability flags stay false until durable implementation + production evidence exist.
- Side-branch schema is not shipped product.

## Phase 2 / Pro Mode

`users.proModeStatus` is deployed. It is account-layer state for authenticated users.

- Old “patron accounts held” gate is **lifted by owner direction** (2026-07-21): unified account home is required for completeness.
- Pro Mode must not be marketed as a patron upsell until the account home and payment gates are honest.
- Stripe Connect / payout readiness remains the gate for **getting paid**, not for logging in or joining rooms.

## Required Route Spine (current + target)

### Live today
- `/` public landing
- `/home` audience scan/entry
- `/account` universal account home
- `/account/collaboration` authenticated Collaborator Inbox
- `/account/collaboration/connect` private pairing claim; `/talent/connect/files` is a fragment-preserving legacy redirect only
- `/talent/login`, `/talent/signup`, `/talent/gigs`, `/talent/gigs/:gigId`
- `/g/:gigId`
- `/p/:performerHandle`
- `/overlay/:gigId`
- `/admin` internal-only

### Required for completeness (not complete until runtime exists)
- Broader account home and project workspace that do not require an active gig
- Publishing/project routes when runtime lands

### Public profile law
- Curated `/p/:handle` pages stay **public when unclaimed**. Unclaimed ≠ unpublished.
- Claim locks booking/tipping to the verified owner; it does not gate page visibility.
- Only **suspended** handles go dark (no curated-preview fallback).

## Current Product State

- Live-night loop: implemented and locally QA’d; Stripe publishable/secret/webhook present on Render in **test** mode as of 2026-07-21.
- Audio publishing foundation: durable original-file and release-contract foundations exist; external delivery and catalog cutover remain fail-closed until provider integration and production evidence exist.
- Private file collaboration is user-usable in the current implementation: performer-authorized creators can create pairing invitations and share selected immutable versions, while any authenticated account can use `/account/collaboration` to claim a connection, see its connections and granted files, download/review when permitted, and revoke access or connections. Before consuming the one-time claim, the confirmation names the signed-in account by display name or email. Pairing purpose records request/send direction only; it does not give an ordinary account Catalog upload or sharing authority.
- The universal Collaborator Inbox reuses existing persistence boundaries. It adds no schema migration and does not change distribution fees, sales, royalties, payouts, Stripe behavior, or live-room money.
- DistroKid replacement, external store delivery, public playback, creator-deal execution, and royalty accounting remain **not live**.
- Complete-product ship decision: **NO** until the gap ledger’s missing rows are closed or explicitly cut with owner sign-off.
