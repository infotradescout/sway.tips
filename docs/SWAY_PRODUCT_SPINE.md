# Sway Product Spine

## Current Baseline

`main @ ab990921452a2cc64656ce877a121de98d79dc25`

This baseline shipped the Live-Night Spine V1 repair, then PRs #105-#109: universal Pro Mode account state (Phase 2 Slice 1A, deployed but not user-facing), the mandatory pre-deploy migration gate, patron room-lookup transient-error handling, removal of performer signup/login CTAs from patron recovery surfaces, and the public/performer room-state projection boundary. Future work must protect the live-night money loop before it expands the system.

## Phase 2 Slice 1A Status (Pro Mode)

`users.proModeStatus` and its supporting audit trail (`pro_mode_status_events`) are deployed to production. This is foundation-layer account state only:

- It has no patron-facing surface, no marketing, and no way for a patron to activate or see it today.
- Existing performer accounts were backfilled from `performers.onboarding_status` on migration.
- The honest current statement is: Pro Mode infrastructure exists for authenticated accounts, but Sway does not currently provide patron account creation or login.
- Phase 2 Slice 2 (patron signup/login, and any patron-facing meaning for Pro Mode) is explicitly HELD. Do not begin it until a separate product decision document resolves the concrete patron job, optional-vs-required accounts, low-friction QR-to-payment preservation, anonymous-activity claiming, identity/account-recovery, and privacy/retention questions. Schema existing is not authorization to build the surface that uses it.

## Product Law

Sway work must protect the live-night money loop first.

If a change does not help a performer use Sway tonight to make more money with less request chaos, it must wait or prove why it is necessary for that loop.

## Core Loop

Room settings -> Create room -> Show QR/link -> Request/Tip/Boost -> Approve/Deny/Complete -> Patron status -> Earnings -> End room -> Recap.

## One-Sentence Product Lock

Sway lets a performer set room settings, create a room, show a QR/link, collect paid requests, tips, and boosts, run the queue, and close the night with clear earnings.

## Room Money Mode

- Paid request rooms use the room minimum for paid requests and paid boosts; the current floor is $5.
- Free request rooms make requests free and convert boosts into free upvotes with fixed weight 1.
- Direct tips remain paid even when request mode is free.
- Room creation captures the selected `paymentsEnabled` mode.
- Stripe/payment provider integration remains separate from room-entry UX and money-mode copy changes unless explicitly scoped.

## Core Users

- Patrons scan a QR code, submit a request or tip, and boost live ladder items.
- Talent starts a gig, controls the request queue, accepts or denies items, marks fulfilled work, and reviews earnings.
- Admin remains internal-only if it exists at all and is not part of the first-use product spine.

## Production Principles

- A patron route must never expose talent controls.
- A talent route must never rely on patron-side sandbox switching.
- Public totals must only reflect real persisted gig activity.
- Payment language must describe the processor flow exactly as implemented.
- Moderation must remain active even when AI providers are unavailable.
- Every money event must have a lifecycle and ledger trail.
- First-use glass must be premium, simple, live, and money-focused.
- Internal-console wording must stay off patron and performer first-use surfaces.
- Do not claim new Stripe/payment-provider behavior from product-glass changes.
- Do not claim production live-room proof from recovery-surface smoke alone.
- Public room state is a projection, never the internal room object. A patron can see only that patron's own request status. Performer-only operational state requires performer authorization. Payment identifiers, idempotency keys, device hashes, moderation flags, and other internal fields never enter the public projection. This is a permanent security boundary, not a point-in-time fix (see PR #109).
- Any change to `drizzle/` schema must ship with its migration applied through the deploy pipeline's `preDeployCommand`, not merely generated locally. A schema-changing PR that lacks a verified production migration path is incomplete, regardless of whether the application code compiles and passes contract tests.

## Do Not Prioritize Before Adoption Proof

- New hardware/control expansion beyond the merged control-bridge baseline.
- Lyrics.
- Marketplace, browse, or discovery expansion.
- Operator/admin expansion.
- New infrastructure that does not directly protect the live-night loop.
- DJ software integrations.

## Required Route Spine

- `/talent/login`
- `/talent/gigs`
- `/talent/gigs/:gigId`
- `/g/:gigId`
- `/p/:performerHandle`
- `/overlay/:gigId`
- `/admin` internal-only

## Current Product State

The shipped baseline centers the performer and patron live-night loop: room settings, create room, show QR/link, request/tip/boost, performer queue action, patron status, earnings, end room, and recap.

DB-backed local QA proved the deeper live-night flow. Production smoke verified the deployed build marker and non-mutating recovery surfaces. Do not describe that smoke as a real production room mutation or a Stripe retest.

PR #44 control bridge is merged and deployed as a baseline by owner override. Do not claim live hardware/control proof without a real room/token smoke, and do not prioritize new hardware/control expansion before adoption proof unless the owner explicitly reorders the lane.
