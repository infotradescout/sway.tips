# Event Listings And Future Native Ticket Sales

**Status:** External event listings activated for performers; native ticket sales remain a locked future lane.
**Date locked:** 2026-07-23
**External-listing slice activated:** 2026-07-26
**Owner direction:** Events belong in Sway, but listing an event and selling a ticket are separate capabilities with separate evidence bars.

## Intent

The activated slice lets a performer publish an event on their Sway profile and hand a customer off to a performer-supplied HTTPS ticket URL. Sway does not process that external purchase, claim inventory, issue admission proof, or report external sales.

Native Sway ticket sales remain a future product lane — not a side feature bolted onto live-room tips/requests/boosts, and not a silent add-on to audio publishing or merch. The performer remains the seller-side product actor; a venue is descriptive event context, not an account type, role, or permission boundary.

## Lane Boundary

| Activated external-listing slice owns | Activated slice does not own |
| --- | --- |
| Performer-owned event create, edit, publish, and cancel | Native checkout, payment capture, refunds, credits, or settlement |
| Public profile, event page, and discovery-feed listing | Capacity, inventory, ticket issuance, QR admission, or transfer market |
| Safe external HTTPS ticket handoff | Claims about external availability, price, purchase success, or sales |
| Ownership, suspension, public filtering, idempotency, and audit evidence | Live-room money, publishing/royalties, merch, or paid streams |

External handoff labels are limited to `Get tickets`, `RSVP`, or `View details`. Cancelling in Sway only changes the listing; performers remain responsible for external-provider cancellation, buyer communication, and refunds. Completed events remain historical records rather than being rewritten as cancelled.

The future native lane must use its own order, ticket, payment, settlement, and audit records. Live-room payment records must never be reused as proof of ticket sales. Ticket fees must never silently stack onto tips, requests, boosts, publishing downloads, or merch.

## Relationship To Current Product

- Current production loop remains: live gig → QR/link → tip/request/boost → queue → ledger.
- The activated event-listing loop is: performer profile → published event → external HTTPS ticket provider.
- An external link is a handoff only. Sway does not know whether inventory remains or whether a customer completes a purchase.
- Publishing / collaboration remains its own pillar (see `SWAY_COMPLETE_PRODUCT_GAP.md` and `SWAY_AUDIO_PUBLISHING_FOUNDATION.md`).
- Native ticket sales remains a separate future revenue lane beside merch and paid streams in the audio publishing foundation fee doctrine.

## Activation Rules

The performer-owned external-listing slice is activated. It may not expand into native sale or admission behavior without a new explicit authorization.

Do not start native paid-ticket implementation until Gawain explicitly opens that money lane with:

1. Scope and non-goals
2. Separate payment/ledger contract from live-room money
3. Fee language and Partner Terms snapshot for ticket sales
4. Evidence bar (contracts + production proof) before any public claim

Until then, native ticketing remains docs and planning only. No schema, route, UI, or marketing copy may claim that Sway sells tickets, controls capacity, confirms a purchase, issues admission, holds funds, settles sellers, or operates a transfer market.

## Planning Doc

Active plan (tickets + public feed): `docs/SWAY_EVENT_TICKETS_AND_PUBLIC_FEED_PLAN.md`

Owner locks already captured there:

- Performers are the only seller-side product actor; location details are event context, not a separate role.
- Fraud, refunds, chargebacks, inventory, and admission proof remain in scope.
- **Money is escrowed until QR accept** — customer has paid; seller has not. Seller may settle held tickets with **refund**, **credit**, or disclosed **you agreed** forfeit. Official **face-value transfer** swaps buyers in escrow (Sell ticket → new buyer pays → original refunded); no scalping markup market.
- Not Ticketmaster-scale; no fluff tools; power with the individual.
- Public feed needs work and ships as part of the same plan (truthful live rooms + upcoming shows).

Those money locks describe the future native lane only. They are not claims about the activated external-link slice.

## Related Docs

- `docs/SWAY_EVENT_TICKETS_AND_PUBLIC_FEED_PLAN.md` — planning
- `docs/REPO_LANES.md` — future product lanes registry
- `docs/SWAY_REVENUE_MODEL.md` — future revenue streams
- `docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md` — separate-lane fee doctrine
- `docs/SWAY_PRODUCT_SPINE.md` — current product law (ticket sales not required for current completeness bar)
