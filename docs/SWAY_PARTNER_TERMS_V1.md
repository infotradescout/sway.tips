# Sway Brand Partner Terms Snapshot

Version: `2026-07-18`

This snapshot records the Sway-controlled commercial terms preserved for performers who receive a durable Brand Partner entitlement.

## Grandfathered Sway terms

- Public profile hosting fee: `$0`.
- Performer subscription fee for capabilities available on the grant date: `$0`.
- Sway platform fee for a paid request, boost, or direct tip: no more than `$1` per paid interaction. The room's existing performer-or-patron fee allocation still applies.
- A free-request room continues to create no-charge requests and weight-1 upvotes without a Sway platform fee. Direct tips remain paid interactions.
- Future Sway premium add-ons may be offered, but they must remain optional for a Brand Partner and cannot be required to retain the capabilities covered by this snapshot.

## Outside the guarantee

Pass-through payment processor fees, taxes, refunds, disputes, and chargebacks are not Sway subscription or platform fees. Brand Partner status does not bypass identity verification, KYC, payout eligibility, safety, moderation, or legal requirements.

## Persistence rule

An administrator may create the Brand Partner grant, but cannot accept it for the performer. The authenticated performer owner must review the exact text, version, and SHA-256 hash and accept them from the performer surface.

The immutable receipt in `performer_partner_terms_acceptances` records the entitlement, performer account ID, terms version, terms hash, exact text and snapshot, and acceptance timestamp. Database triggers reject updates and deletes to grants, status events, and acceptance receipts.

Operational suspension or restoration appends a row to `performer_partner_entitlement_status_events`; it never deletes or rewrites the underlying grant or receipt. Public badges and fee-cap effectiveness require an owner acceptance receipt and a latest operational status of `active`.

`src/server/payment-service.ts` resolves the effective entitlement before it creates or confirms any Request, Tip, or Boost payment. Only the Sway-controlled `platformFee` is capped. That fee is always recorded for a paid interaction; the room setting controls whether it is added to the patron total or absorbed from performer proceeds. Payment processor fees, taxes, refunds, disputes, and chargebacks remain separate from that field and from the cap.
