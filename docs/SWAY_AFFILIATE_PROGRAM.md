# Sway automatic affiliates

Owner instruction, September 8, 2026: every user is an affiliate automatically. Friends are automatically Sway Partners. Sway Partners and Sway Exclusive participants earn 20%; everyone else earns 10%. Both qualifying statuses together still earn 20%.

| Account qualification | Affiliate commission |
| --- | --- |
| Standard Sway user, including every account role | 10% |
| Sway Partner, including owner-confirmed friends | 20% |
| Sway Exclusive | 20% |
| Partner and Exclusive | 20% |

The base is the actual captured Sway platform fee on an eligible referred account's Live Room payment. This follows the active platform-fee calculators in MealScout and TradeScout. A $10 Sway fee produces $2 at 20% or $1 at 10%. Performer proceeds, customer gross spending, incoming processor recovery, and money from future product lanes are not substituted for that fee. This affiliate policy does not change Sway's customer fee policy or an accepted legacy fee contract.

## Enrollment and attribution

`affiliate_accounts` has one unique, stable, randomly generated code per user. Migration 0050 backfills existing users; an `AFTER INSERT` users trigger enrolls every future role and creation path. Authenticated account reads repair missing identities idempotently. No separate application, subscription, invitation, or affiliate approval is required.

An explicit `?ref=` share retains the first valid code in a host-only, HTTP-only, SameSite=Lax browser cookie for 30 days. The server removes the code from the destination URL with a private, noncacheable redirect. Ordinary universal-account signup and first-time profile claims bind the code in the account transaction. Account claim-code signup, performer claim acceptance, and first-time invite acceptance are covered. Performer acquisition uses the universal-account flow; the legacy performer-signup API remains terminal. A handoff of an account that already has credentials, verification, or accepted terms does not establish a new referral. Once bound, the unique referred account relationship is immutable; a later link cannot replace it. Self-referrals are rejected. Browser retention is not a promise to identify people across browsers or devices. Existing accounts are not reassigned when they click a share link.

The account page supplies an invite link and, when the account owns a public profile, an attributed profile link. A profile's owner is not silently substituted for an explicit sharer. Clean profile URLs carry no affiliate attribution by themselves.

## Partner recognition

`sway_program_memberships` recognizes either a user or a canonical performer. This permits friends who never enable Pro Mode, and artist recognition that follows the existing authorized account-claim ownership transaction. A friend must also be a Partner at the database boundary. Trusted admins can update these flags at `POST /api/admin/sway-membership` with one target, all three boolean flags, and a reason; before/after state and operator identity are audited. Ordinary account clients cannot set their commission rate or grant membership.

Public artist badges use that specific performer's recognition and explicit account grants. A performer-scoped grant does not label another artist owned by the same account. The account's affiliate rate still considers all of its qualifying memberships.

The initial named friends are Bubba Khain, Callie Hines, Corey Mack, Drew Maze, and canonical DJ3X. The old inactive DJ3X preview identity and all other performers are excluded. Existing effective Brand Partner contracts also qualify for the 20% affiliate rate, while retaining their own exact accepted terms. New recognition does not sign those contracts, grant music exclusivity, transfer master ownership, activate Pro Mode, complete KYC, or enable payments.

## Earnings and refunds

The persisted payment transition is the single commission owner. A new, durably linked captured payment looks up the authenticated payer's fixed referral. For boosts, the payer is the boost's patron, not the original request's patron. A commission snapshots the actual platform fee, beneficiary, referred account, currency, payment mode, basis, policy version, and the server-derived rate at capture. Integer minor units round half up once per payment.

The unique payment/event-kind constraint prevents duplicate credit from capture retries or repeated webhooks. Commission events are immutable. Full refunds append one equal negative reversal, including after a performer payout; retries cannot reverse twice. Disputed and refund-pending payments are held in the account read model. A dispute that is later resolved retains its event history and follows the payment's reconciled state. A provider discrepancy or partial refund must be reconciled before any affiliate cash-out eligibility is introduced.

Test and live records are reported separately. Historical payments are not backfilled. Unauthenticated guest purchases without an attributed account do not generate account-referral commissions. No client route accepts a caller-supplied commission, balance, or percentage.

**Affiliate cash-out is not available in this slice.** The UI reports recorded commissions and holds; it does not label them available cash or report a transfer. No payout minimum, external destination, automatic payment, tax treatment, or provider activation is imported from a reference app. A future payout implementation must reconcile partial refunds/disputes, beneficiary identity, verified destinations, withdrawal idempotency, and provider-confirmed settlement against this ledger before execution is enabled.

## Reference audit

- MealScout, commit `6090296ef242cc6c0ce909860ebb6c1d1a2f8fb8`: `server/affiliateTagService.ts`, `server/affiliateCommissionService.ts`, signup/manual account creation, and payout handlers.
- TradeScout, commit `753b65c65b3221e2dae443f854d713a2b89c7c3a`: automatic/lazy affiliate identity in `server/storage.ts`, `server/services/referralAttribution.ts`, `client/src/utils/share.ts`, and `server/payment-service.ts`.

Both current calculators use platform fees. Neither supplies Sway's 20%/10% policy. Neither application's payout/bookkeeping implementation was copied wholesale: the audit found missing refund reversals and incomplete or non-atomic balance settlement.

## Rollback

Revert the application commit to remove the new account card/routes. Leave additive schema and financial events intact. Revoke a mistaken membership through the audited admin endpoint; do not rewrite historical rate snapshots. Profile publication has its own exact-after-state rollback in `docs/profile-facts-2026-09-08.md`. A payment-trigger regression requires a reviewed forward migration to disable only `payments_affiliate_commission` while retaining all commission evidence; it must not erase or manually relabel earnings.
