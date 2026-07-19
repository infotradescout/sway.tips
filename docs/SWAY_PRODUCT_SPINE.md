# Sway Product Spine

## Current Baseline

`main @ 7d6fbf735d4794383323a43ac67f447680ecb390`

This baseline shipped the Live-Night Spine V1 repair. Future work must protect the live-night money loop before it expands the system.

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

## Owner-Directed Expansion (2026-07-18)

The owner has explicitly reordered the roadmap to add creator-owned audio collaboration, catalog migration, Sway-only publication/playback, and external distribution as a strategic lane under the broader FlavorGood Marketing goal. This expansion does not remove or weaken the live-night loop, public performer/customer split, payment truth, or moderation boundaries above.

Producer, engineer, collaborator, and reviewer remain private resource-scoped roles on the performer side. File-connection QRs are one-time account-pairing links, separate from the static room QR; pairing creates no room, project, or file authorization. Selected-file access references the immutable stored version without moving or copying its original bytes.

No new publishing capability may be presented as live until its persistence, access, rights, failure, audit, and production boundaries are proven. See `docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md`.
