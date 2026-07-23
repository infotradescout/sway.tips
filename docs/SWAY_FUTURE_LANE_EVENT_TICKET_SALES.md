# Future Lane Memo: Event Ticket Sales

**Status:** Locked future product lane — memo only. Not active build work.  
**Date locked:** 2026-07-23  
**Owner direction:** Event ticket sales is a lane of Sway.

## Intent

Sway will sell event tickets as its own product lane — not a side feature bolted onto live-room tips/requests/boosts, and not a silent add-on to audio publishing or merch.

Performers, venues, and event hosts should be able to list ticketed shows, collect payment, issue admission proof, and reconcile sales under terms that are disclosed separately from other Sway money lanes.

## Lane Boundary

| This lane owns | This lane does not own |
| --- | --- |
| Ticketed event listing and inventory | Live-room Request / Tip / Boost lifecycle |
| Ticket purchase, refund, and admission proof | Audio master vault / DSP delivery / royalties |
| Event-specific fee disclosure and ledger | Merch fulfillment |
| Venue/host reporting for ticketed shows | Paid stream playback (separate future lane) |

Live-room payment records must never be reused as proof of ticket sales. Ticket sales must never silently stack fees onto tips, requests, boosts, publishing downloads, or merch.

## Relationship To Current Product

- Current production loop remains: live gig → QR/link → tip/request/boost → queue → ledger.
- Publishing / collaboration remains its own pillar (see `SWAY_COMPLETE_PRODUCT_GAP.md` and `SWAY_AUDIO_PUBLISHING_FOUNDATION.md`).
- Ticket sales is already named as a separate future revenue lane beside merch and paid streams in the audio publishing foundation fee doctrine.
- This memo promotes that mention into an explicit Sway product lane so it cannot be forgotten or absorbed into another slice.

## Activation Rules

Do not start implementation until Gawain explicitly opens an `event-tickets` (or equivalent) lane with:

1. Scope and non-goals
2. Separate payment/ledger contract from live-room money
3. Fee language and Partner Terms snapshot for ticket sales
4. Evidence bar (contracts + production proof) before any public claim

Until then: docs and planning only. No schema, routes, UI, or marketing copy that claims ticket sales are live.

## Planning Doc

Active plan (tickets + public feed): `docs/SWAY_EVENT_TICKETS_AND_PUBLIC_FEED_PLAN.md`

Owner locks already captured there:

- Individuals sell tickets — venue is optional, not a gate.
- Fraud, refunds, chargebacks, inventory, and admission proof remain in scope.
- **Money is escrowed until QR accept** — customer has paid; seller has not. Seller may settle held tickets with **refund**, **credit**, or disclosed **you agreed** forfeit. Official **face-value transfer** swaps buyers in escrow (Sell ticket → new buyer pays → original refunded); no scalping markup market.
- Not Ticketmaster-scale; no fluff tools; power with the individual.
- Public feed needs work and ships as part of the same plan (truthful live rooms + upcoming shows).

## Related Docs

- `docs/SWAY_EVENT_TICKETS_AND_PUBLIC_FEED_PLAN.md` — planning
- `docs/REPO_LANES.md` — future product lanes registry
- `docs/SWAY_REVENUE_MODEL.md` — future revenue streams
- `docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md` — separate-lane fee doctrine
- `docs/SWAY_PRODUCT_SPINE.md` — current product law (ticket sales not required for current completeness bar)
