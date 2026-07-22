# Sway Product Spine

## Decision

Sway is a two-sided live request, tip, and boost product. It is not a music distribution or file-collaboration platform.

## Product Sides

### Customer

Join a performer room, request, tip, boost, pay, and track the result.

### Performer

Activate Pro Mode, start a room, share the QR/link, control requests, complete the session, and review earnings.

One account can use both sides. Pro Mode is a capability state, not a separate account type.

## Core Loop

Room settings -> Create room -> Show QR/link -> Customer joins -> Request/Tip/Boost -> Backend payment confirmation -> Performer approves/denies/completes -> Customer sees status -> Performer sees earnings -> End room -> Recap.

## Money Modes

- Paid request rooms use the configured minimum for paid requests and boosts; the current floor is $5.
- Free request rooms make requests free and convert boosts into free upvotes with fixed weight 1.
- Direct tips remain paid when requests are free.
- Payment success appears only after backend confirmation.

## Product Rules

- A customer route never exposes performer controls.
- A performer route never relies on customer-side routing as security.
- Public totals reflect real persisted room activity only.
- Every money mutation is idempotent and auditable.
- Degraded networks never turn an unavailable room lookup into a false “room not found.”
- Moderation remains available without AI.
- End-room closeout is durable and does not rely on one browser staying open.
- Supporting profiles, libraries, integrations, overlays, and admin tools must directly serve the live loop.

## Explicitly Out of Scope

- Music distribution or DSP delivery.
- Releases, UPC/ISRC workflows, royalties, splits, or catalog transfer.
- Master-audio vaults, file pairing, review, or collaboration.
- Venue accounts or venue-management product surfaces.
- A third customer-facing side beyond customer and performer.

Historical schema for retired experiments remains untouched until a separately approved data-retention cleanup. It is not roadmap authority.

## Build Order

1. Keep account, role, and Pro Mode boundaries correct.
2. Prove room creation and QR/link joining.
3. Prove request, tip, boost, and payment confirmation.
4. Prove performer queue control and customer status updates.
5. Prove moderation, degraded-network recovery, and idempotency.
6. Prove earnings, end-room closeout, and recap.
7. Improve the shortest real customer or performer journey based on production evidence.

Complete-product decision: **HOLD** until the current production evidence ledger proves the whole two-sided loop.
