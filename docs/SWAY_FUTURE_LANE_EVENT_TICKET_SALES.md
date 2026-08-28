# Event Listings And Future Native Ticket Sales

**Status:** Walk-in and external event listings are active. The first native paid-GA implementation slice is authorized but production sales remain fail-closed.
**Date locked:** 2026-07-23
**External-listing slice activated:** 2026-07-26
**Native paid-GA slice activated:** 2026-07-26
**Owner direction:** Events belong in Sway, but listing an event and selling a ticket are separate capabilities with separate evidence bars.

## Intent

The activated slice lets a performer publish a walk-in event with an actionable location, an external RSVP, or an external ticket handoff. Walk-in creates no Sway ticket/RSVP record and makes no price claim. Sway does not process an external purchase, claim inventory, issue admission proof, or report external sales.

Native Sway ticket sales are a separate money lane — not a side feature bolted onto live-room tips/requests/boosts, and not a silent add-on to audio publishing or merch. The performer remains the seller-side product actor; a venue is descriptive event context, not an account type, role, or permission boundary.

## Lane Boundary

| Activated performer-listing slice owns | Activated slice does not own |
| --- | --- |
| Performer-owned event create, edit, publish, and cancel | Native checkout, payment capture, refunds, credits, or settlement |
| Public profile, event page, and discovery-feed listing | Capacity, inventory, ticket issuance, QR admission, or transfer market |
| Safe external HTTPS ticket handoff | Claims about external availability, price, purchase success, or sales |
| Walk-in listing with actionable public location | Sway RSVP, reservation, capacity, or admission records for walk-in |
| Ownership, suspension, public filtering, idempotency, and audit evidence | Live-room money, publishing/royalties, merch, or paid streams |

External ticket labels are limited to `Get tickets` or `View details`; external RSVP uses `RSVP`. Cancelling in Sway only changes the listing. Performers remain responsible for external-provider cancellation, buyer communication, and refunds when a linked provider exists; walk-in cancellation points visitors to the performer or venue. Completed events remain historical records rather than being rewritten as cancelled.

The native lane must use its own order, ticket, payment, settlement, and audit records. Live-room payment records must never be reused as proof of ticket sales. Ticket fees must never silently stack onto tips, requests, boosts, publishing downloads, or merch.

## Activated Native Paid-GA Slice

The authorized first native slice is deliberately smaller than the complete target:

```text
verified performer configures one paid general-admission offer
→ authenticated customer buys one ticket through Stripe-hosted Checkout
→ Stripe confirms an automatic-capture platform charge
→ Sway issues a rotating single-use admission pass
→ performer accepts the pass online
→ a durable outbox transfers the performer share
```

If the ticket is not accepted, the v1 policy is refund-only:

- performer cancellation queues a full refund for every unused ticket;
- an unused ticket is queued for a full refund after event end plus the disclosed grace window;
- refund, transfer, and ticket issuance copy stays pending until backend/provider evidence exists.

This slice does **not** implement credits, forfeiture, resale, paid transfers, guest checkout, multiple tickets per order, reserved seating, venue accounts, or offline admission. Those stay closed until the single-ticket charge → hold → admit → transfer/refund loop is independently proven.

“Held by Sway” describes the product behavior. The product must not call ordinary platform-balance retention a bank, trust, protected, or regulated escrow. Stripe funds segregation is a separate provider capability and may not be implied when it is not enabled.

Production sales remain disabled unless the server has an explicit fee policy, tax posture, admission-signing secret, app URL, Stripe configuration, and the feature flag. Legal/tax review and a controlled low-value production proof are still required before enabling that flag.

## Relationship To Current Product

- Current production loop remains: live gig → QR/link → tip/request/boost → queue → ledger.
- The activated event-listing loop is: performer profile → published event → external HTTPS ticket provider.
- An external link is a handoff only. Sway does not know whether inventory remains or whether a customer completes a purchase.
- Publishing / collaboration remains its own pillar (see `SWAY_COMPLETE_PRODUCT_GAP.md` and `SWAY_AUDIO_PUBLISHING_FOUNDATION.md`).
- Native ticket sales remains a separate, production-gated revenue lane beside merch and paid streams in the audio publishing foundation fee doctrine.

## Activation Rules

The performer-owned external-listing slice and the first native paid-GA implementation slice are activated. Native production sales are not.

The implementation must keep:

1. paid-GA v1 scope and explicit non-goals;
2. separate payment, order, ticket, ledger, webhook, and outbox records;
3. immutable seller and buyer terms/fee snapshots;
4. prominent mandatory-fee-inclusive price display before applicable government tax;
5. signed-webhook, concurrency, crash-recovery, refund, and transfer evidence;
6. a fail-closed production feature gate.

No marketing or readiness record may call native sales production-ready until a controlled charge, admission transfer, cancellation refund, no-show refund, and reconciliation packet all pass.

## Planning Doc

Active plan (tickets + public feed): `docs/SWAY_EVENT_TICKETS_AND_PUBLIC_FEED_PLAN.md`

Long-term owner locks already captured there (future scope, not active v1):

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
