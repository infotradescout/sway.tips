# Sway talent capability model

**Status:** Owner-approved architecture contract. This document defines how Sway may broaden its market without pretending that later capabilities are already live.

## Product position

Sway is for independent talent, creators, and gig professionals who earn from audiences, appearances, services, releases, partnerships, or events. Comedians are the first focused growth wedge. The permanent market also includes singers, songwriters, DJs, musicians, hosts, bartenders, event professionals, vendors, and other service professionals whose work can produce tips or legitimate deals.

Sway is not a generic freelance marketplace and is not free general-purpose cloud storage. Existing `performer`, `talent`, `/talent`, and related database and route names remain compatibility terms until a separately reviewed migration can change them safely.

## Identity is not authority

The account model must keep these persisted concepts separate:

1. **Primary identity** — the person's main public professional identity.
2. **Secondary identities** — additional truthful professional identities the person chooses to show.
3. **Earning modes** — ways the person says they work, such as live tips, bookings, partnerships, services, releases, or events.
4. **Desired capabilities** — features the person asks to use.
5. **Capability grants** — features the server has authorized after required eligibility, policy, verification, provider, or legal checks.
6. **Seller or venue authority** — durable proof that the account may act for the seller, organizer, venue, inventory, payout account, or catalog involved.

Labels never grant money, ticketing, publication, venue, catalog, payout, moderation, or administrative authority. Client routing and client-selected roles are not security boundaries. Every consequential action must be authorized by persisted server state.

## Publication and discovery

A shareable profile is not automatically index eligible. Publication must be an explicit owner action; no onboarding control may preselect `Public`. Public profile eligibility still requires owner intent, a claimed account with an owner, sufficient unique real information, an unrestricted active state, a valid canonical identity, and agreement between visible and structured content.

Discovery may widen only from real eligible records. Sway must not invent people, performances, events, releases, venues, testimonials, transactions, or engagement. Empty public inventory must remain truthful and must not be disguised with demo or preview records.

## Capability boundaries

| Capability | Identity may request it | Server grant required | Additional durable authority or evidence |
| --- | --- | --- | --- |
| Publish a profile | Yes | Yes | Owner intent and public-eligibility policy |
| Accept a non-money inquiry | Yes | Yes | Owned profile and abuse controls |
| Run a Live Room | Yes | Yes | Owned active gig and room authorization |
| Receive live money | Yes | Yes | Live-payment release gate, KYC/payout readiness, idempotency, audit records, backend confirmation |
| Publish an event | Yes | Yes | Organizer or venue authority and moderation eligibility |
| Sell native tickets | Yes | Yes | Inventory authority, payment gate, refund and reconciliation evidence |
| Publish audio | Yes | Yes | Rights declarations, moderation, durable media and publication records |
| Deliver to DSPs or process royalties | Yes | Yes | Provider, legal, accounting, rights, split, and payout evidence |

A request can be saved without implying approval. A grant can be denied, revoked, restricted, or expired without changing the person's chosen professional identity.

## Storage and release protection

The existing bounded-working-storage policy is permanent product truth: the default working pool is 5 GiB and the default working-object cap is 10,000. Only exact files named in immutable, independently validated release-package manifests graduate from working quota. Release count is not numerically capped. Drafts, mutable attachments, incomplete reviews, and status-only changes remain working storage.

This boundary prevents Sway from becoming free general storage while allowing any number of valid releases. No identity, earning mode, capability request, or public label may bypass it.

## Ordered delivery

- **Wave 0B:** lock this model, the copy-truth matrix, and direct fail-hard discovery contracts.
- **Wave 1:** add schema-first primary identity, secondary identities, earning modes, desired capabilities, server grants, and durable attribution.
- **Wave 2:** build onboarding, publication intent, and capability-request UX on persisted state.
- **Wave 3:** broaden truthful public pages and discovery only from eligible records, with measured organic acquisition.
- **Later waves:** add non-money rooms/events, comedian audio, non-money bookings and partnerships, then financial, ticketing, provider, legal, and App Store lanes only after their own gates pass.

No wave may use copy from a later wave as if the capability were already available.
