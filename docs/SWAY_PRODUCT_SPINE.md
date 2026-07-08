# Sway Product Spine

## Current Baseline

`main @ 4a35ce9743b14b712cb9049ec7334ef6a4a35923`

This baseline shipped the Live-Night Spine V1 repair. Future work must protect the live-night money loop before it expands the system.

## Product Law

Sway work must protect the live-night money loop first.

If a change does not help a performer use Sway tonight to make more money with less request chaos, it must wait or prove why it is necessary for that loop.

## Core Loop

Start room -> Show QR/link -> Request/Tip/Boost -> Approve/Deny/Complete -> Patron status -> Earnings -> End room -> Recap.

## One-Sentence Product Lock

Sway lets a performer start a live room, show a QR/link, collect paid requests, tips, and boosts, run the queue, and close the night with clear earnings.

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

- Hardware controls.
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

The shipped baseline centers the performer and patron live-night loop: start room, show QR/link, request/tip/boost, performer queue action, patron status, earnings, end room, and recap.

DB-backed local QA proved the deeper live-night flow. Production smoke verified the deployed build marker and non-mutating recovery surfaces. Do not describe that smoke as a real production room mutation or a Stripe retest.

PR #44 control bridge remains parked until the live-night loop proves adoption or an owner explicitly reorders the lane.
