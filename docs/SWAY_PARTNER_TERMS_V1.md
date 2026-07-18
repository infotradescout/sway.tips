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

Brand Partner status is granted by an administrator and stored in `performer_partner_entitlements` with `partner_kind = 'brand'`, this version, and a JSON snapshot. The grant is append-only from the product UI: routine account editing cannot remove it. Future billing or subscription code must read the entitlement before applying a new or increased Sway-controlled fee.
