# Sway Plan: External Event Listings + Future Native Tickets

**Status:** External listings are active. Native paid-GA v1 implementation is active behind a fail-closed production sales gate.
**Date:** 2026-07-23
**External-listing slice activated:** 2026-07-26
**Native paid-GA v1 slice activated:** 2026-07-26
**Locked lane memo:** `docs/SWAY_FUTURE_LANE_EVENT_TICKET_SALES.md`
**Owner direction:**

- Event ticket sales is a Sway lane.
- External-mode events hand customers to an external HTTPS ticket provider; native-mode events use the isolated paid-GA v1 lane below.
- Performer is the only seller-side product actor. Location details do not create another account type or role.
- The merged external-listing product does **not** sell tickets. The authorized native paid-GA slice must remain disabled in production until its configuration and proof gates pass.
- Handle fraud and the real money/admission risks — without Ticketmaster-scale bloat.
- Simpler processes. No fluff tools. Power in the individual’s hands.
- Public feed needs work and is part of this plan.
- The long-term owner target includes credits, disclosed forfeiture, and face-value holder transfer. Those remain future scope; the active v1 is refund-only and must not expose those controls or claims.

---

## 0. Activated Slice: External Event Listings

The activated slice is deliberately narrow:

```text
Performer creates event
→ performer publishes event
→ event appears on the performer profile, /e/:eventId, and /discover
→ customer follows the performer-supplied HTTPS ticket URL
```

Required truth:

- Every event belongs to one performer.
- Only that performer’s authorized account can mutate it.
- Repeated creates with the same client request ID resolve idempotently.
- Performer profiles and the discovery feed show only published, public, future events owned by active, non-suspended performers.
- A direct `/e/:eventId` page may preserve a truthful previously published event record after it is unlisted, cancelled, or past; it must expose the real current status and disable stale handoffs.
- External ticket URLs must be safe HTTPS handoffs.
- External CTAs use the closed labels `Get tickets`, `RSVP`, or `View details`; performer copy cannot imply Sway inventory, checkout, or guaranteed admission.
- Cancelling changes the Sway listing only. The performer must separately handle external-provider cancellation, buyer communication, and refunds.
- A completed published event cannot be edited or rewritten as cancelled. If no end time is supplied, the event start closes the mutation window.
- An edit to an active published event cannot move its effective end (or start when no end is set) into the past.
- Anonymous event reads do not append unbounded audit rows. State mutations remain transactionally audited; future view/click analytics must be bounded and abuse-resistant.
- The event page and discovery feed must not claim Sway inventory, ticket availability, external purchase completion, admission, refund, or settlement.
- No location or venue field creates a venue actor, account, dashboard, or authority boundary.

Native checkout, orders, capacity, inventory, ticket issuance, QR admission, refunds, credits, forfeits, seller settlement, and the transfer market are not part of the external-listing slice. The first six plus refund-only settlement are now an isolated native implementation lane; credits, forfeits, and transfers remain future slices.

### Native paid-GA v1 scope

The active native implementation slice is:

- one authenticated customer;
- one ticket per order;
- USD paid general admission;
- prominent pretax ticket price including every mandatory Sway fee, with applicable government tax disclosed before payment;
- automatic platform charge through Stripe-hosted Checkout;
- performer share not transferred until an online, owner-authorized QR acceptance;
- durable outbox for charge, refund, and seller-transfer reconciliation;
- full refund for performer cancellation or an unused ticket after the disclosed grace window;
- immutable seller/buyer terms and fee snapshots;
- no venue actor.

Production sales stay disabled until fee, tax, Stripe, URL, QR-secret, legal, and evidence gates are complete. Product copy says funds are held by Sway and not yet transferred; it does not claim a bank, trust, protected, or regulated escrow account.

---

## 1. Long-Term Native-Ticket Product Lock (Not v1)

The future native lane would let a performer sell tickets to a real show, receive funds when admission is accepted or a lawful disclosed settlement applies, and let buyers prove entry or transfer a ticket. Everything in this section is target behavior, not current external-listing behavior.

```text
Creator lists a show (discloses no-show settle options)
→ Buyer pays (funds held in escrow — seller not paid yet)
→ Buyer gets admission proof (QR / code)
→ Optional: buyer lists ticket on Sway transfer market → new buyer pays → original buyer refunded → QR moves
→ Door QR accept  =  release that ticket’s escrow to seller
   OR seller settles unscanned ticket: refund | credit | you-agreed forfeit
→ Public feed shows live rooms + upcoming ticketed shows (truthful inventory only)
```

One-sentence lock:

> Customer paid, seller not paid yet — money stays escrowed until QR accept or a disclosed seller settle (refund / credit / you agreed); transfers swap the buyer in escrow, not a scalper exchange.

### Money law (owner lock)

| Moment | Money state |
| --- | --- |
| Purchase succeeds | Buyer charged; funds **escrowed**. Seller balance does **not** increase. |
| Official transfer sale | New buyer pays into escrow for that seat; **original buyer’s escrow refunds**; ticket + QR move to new buyer. Seller still unpaid. |
| QR accept (valid single-use scan) | That ticket’s escrow **releases** to seller (minus platform ticket fee). |
| Seller settle: **refund** | Escrow returns to current buyer. Seller never received it. |
| Seller settle: **credit** | Escrow converts to credit (toward that seller’s future events — lean default). Seller not paid cash. |
| Seller settle: **you agreed** | Escrow **releases to seller** without QR, only if that outcome was disclosed at purchase. |
| Event cancelled / seller no-show | Refund from escrow for remaining held tickets (seller cannot “you agreed” their own cancel). |
| Chargeback / dispute while held | Reverse from escrow; seller was never paid out. |
| Chargeback after release / forfeit | Evidence path (accept or disclosed forfeit + timestamps). |

**Copy must match reality:** never say “paid the performer” at purchase. Say held / escrowed until entry is accepted or the seller settles under the terms you agreed to.

**Processor constraint (plan truth):** card *authorization* holds expire too fast for advance ticket sales. Escrow here means **durable hold of captured funds off the seller payout** (platform/Connect hold + transfer or payout on QR accept / forfeit) — not a multi-week open card auth. Implementation must prove hold / transfer-swap / release / refund / credit states in the ticket ledger.

---

## 2. Who Can Sell

| Rule | Decision |
| --- | --- |
| Seller identity | Verified Sway performer account |
| Location | Optional event field (name / address / “TBA” / private details after purchase) |
| Collaborators | Later capability — v1 retains one performer seller of record |
| Unclaimed preview profiles | Cannot sell tickets until claimed + payout-ready |

Location is context, not permission. It never creates another product actor.

---

## 3. Future Native Ticketing Target

### Native ticket sales — future must-have loop

1. **Create event** — title, when, where (optional detail), capacity, price, cover image optional. Seller sets **no-show settle policy** shown at checkout: refund, credit, and/or you-agreed (forfeit) — at least one path; default recommended = refund.
2. **Publish** — public event page + share link; optional appearance on public feed when eligible.
3. **Buy** — quantity, email/receipt, checkout on a **separate ticket ledger**; funds enter **escrow**, not seller payout. Buyer sees settle + transfer rules in plain language.
4. **Transfer (optional)** — buyer hits **Sell ticket** → lists on official Sway transfer market → new buyer swaps escrow → original buyer refunded → QR reissued to new holder.
5. **Admit** — one scannable proof per ticket; single-use QR accept; seller sees sold / held / listed / checked-in counts.
6. **Release** — QR accept triggers escrow release for that ticket; platform ticket fee disclosed and taken per terms.
7. **Seller settle** — for unscanned held tickets (per ticket or bulk at close): **refund**, **credit**, or **you agreed** (only if disclosed).
8. **Close** — event ends; unsold primary inventory closes; listed transfers delist; remaining holds require seller settle or auto-apply the event’s default settle policy after grace.

### Public feed — must-have loop

Activated external-listing target: `/api/public/feed` returns active live rooms plus eligible performer-published upcoming events, and `/discover` renders that truthful inventory. This does not claim external ticket availability.

Target feed is a **truthful discovery strip**, not a social network:

| Card type | Source of truth | CTA |
| --- | --- | --- |
| Live now | Active gig / room registry | Enter room / tip-request |
| Upcoming events | Eligible performer-published events | Event page / external ticket handoff |
| Creator presence (optional later) | Claimed public profiles with live or upcoming activity | Profile |

Empty state tells the truth (“No live rooms or upcoming shows right now”) — never pads with fake acts.

---

## 4. Explicit Non-Goals (No Fluff)

Do **not** build in v1:

- Full Ticketmaster: bots arms race, dynamic pricing suites, seat maps for arenas, season packages, fan clubs, “insights dashboards,” promo-code empires, multi-tier CRM.
- Open scalping exchange (bids, markups above face, stub dumps, speculative bots).
- Location-operator OS / box-office staffing suites.
- Social feed, likes, comments, follows-as-ranking, algorithmic “For You.”
- Fake featured inventory or paid placement before real inventory exists.
- Merch bundles, paid streams, or DistroKid tools bolted onto tickets.

**In scope (lean):** official **face-value transfer market** — one button to list, one buy to swap escrow holders. Not a secondary Ticketmaster.

Compete by being **faster and clearer for the individual**, not feature-count parity.

---

## 5. Fraud, Trust, Escrow, And Money Risks (Still Required)

Lean ≠ naïve. These are in-scope even for a simple product:

| Risk | Lean control |
| --- | --- |
| Fake seller / unpaid payouts | Stripe Connect (or current payout readiness) required before ticket sales go live; suspended/onboarding-blocked sellers cannot publish |
| Seller paid before show | **Forbidden.** Escrow until QR accept. |
| Card fraud / friendly fraud | Processor Radar + 3DS where offered; durable orders + idempotency; escrow makes pre-entry disputes reverse without clawing seller payouts |
| Chargebacks while escrowed | Prefer reverse from hold; evidence still stored (order, email, event snapshot, not-yet-accepted state) |
| Chargebacks after QR accept | Evidence: accept timestamp, scanner actor, ticket id; rarer because fulfillment happened |
| Buyer misses the show | Seller settles from escrow: **refund**, **credit**, or **you agreed** (if disclosed). Customer already paid; seller only gets cash on accept or forfeit. |
| Seller cancels / never doors | Auto-**refund** remaining escrowed tickets; seller cannot keep via “you agreed” on their own cancel |
| Buyer can’t attend before show | **Sell ticket** on official transfer market (escrow swap) or request seller refund/credit while held |
| Seller “forgets” to scan friends | No QR accept = no automatic release. Seller may still settle that ticket (refund / credit / you agreed if allowed) — process stays explicit |
| Duplicate entry | Single-use admission token; scan marks accepted; re-scan shows already used |
| Transfer fraud / double sell | One active holder; listing freezes personal QR until sold or delisted; new QR on transfer; old QR dies |
| Screenshot sharing | Residual risk; optional name/email on ticket + door list — not DRM fantasy |
| Inventory oversell | Capacity reserved/committed at escrowed purchase success; fail closed on race |
| Speculative listing spam | Rate limits + payout-ready gate + report/takedown via existing moderation posture |
| Feed abuse | Only active rooms + published paid-ready events; no demo seeds on production feed |
| Fee stacking | Ticket fees disclosed on ticket terms only; never reuse live-room tip/request/boost payment rows as ticket proof |
| Stale holds | After grace window, apply event **default settle policy** to every remaining escrow ticket |

### Future escrow + seller settle (owner lock)

Truth: **customer has paid; ticket seller has not been paid yet** until QR accept or a disclosed **you agreed** forfeit.

| Seller action | Effect on escrow | When allowed |
| --- | --- | --- |
| **Refund** | Money back to current buyer | Anytime while escrowed; also as no-show settle |
| **Credit** | Held value becomes credit for that seller’s future events (lean default) | Anytime while escrowed; also as no-show settle |
| **You agreed** | Escrow releases to seller without QR | Only if that outcome was disclosed at purchase for no-show/forfeit; never for seller-cancelled events |

- **QR accept** remains the clean fulfillment release.
- Event create must pick a **default no-show settle** (refund recommended) and which settle options the seller may use.
- Checkout and receipt must show those options in plain language (“If you don’t check in, the seller may refund you, issue credit, or keep the funds if you agreed to final sale”).
- Seller can also refund or credit a specific ticket **before** the show (goodwill / dispute) without waiting for close.

### 5b. Official transfer market (best fit for this model)

**Recommended system: face-value escrow swap** — not an open scalping market.

Why this fits Sway:

- Escrow already holds the original payment; a transfer is a **buyer swap**, not a new seller payout.
- Face value (what was paid for that seat) keeps math honest and kills Ticketmaster-style markup theater.
- One button for the buyer who can’t go; one buy for someone who can.
- Door QR still gates paying the **event** seller.

```text
Buyer A: Sell ticket
→ Ticket listed on this event’s transfer list at face (amount A paid into escrow)
→ Buyer B pays face into escrow for that ticket id
→ A’s escrow refunds; B becomes holder; new QR issued; A’s QR void
→ Still escrowed to event seller until QR accept (or seller settle)
```

Rules:

- List / delist anytime before event start (or until doors policy cutoff).
- While listed: ticket cannot be used at the door until delisted or purchased by B.
- Sold-out primary inventory can still show **transfer available** counts on the event page / feed card.
- No bids, no price above face in v1. (Later optional: allow list **at or below** face only — still no markup.)
- Platform may take a small disclosed transfer fee from the swap; must not silently stack onto live-room fees.
- Private gift transfer (A → B without money) can be a later thin slice; v1 priority is the paid swap button.

This is the “or whatever system is best” answer: **official face-value transfer on Sway**, escrow-native, anti-scalp, one-button simple.

---

## 6. Ledger And Lane Boundaries

| Lane | Records |
| --- | --- |
| Live-room money | Tips / requests / boosts |
| Tickets | Orders, tickets, escrow holds, transfers/listings, QR accepts, releases, refunds, credits, forfeits, chargebacks |
| Publishing / royalties | Separate (already doctrine) |

Rules:

- Separate tables / payment purpose codes for tickets.
- Ticket payment states must include at least: `escrowed` → `listed_for_transfer` → `released` | `refunded` | `credited` | `forfeited_you_agreed` | `disputed` (names TBD; UI copy must match).
- QR accept releases escrow; seller settle can refund / credit / forfeit under disclosed rules; transfer swaps escrow holder without paying the event seller.
- Separate Partner Terms snapshot language before any public ticket claim (must describe escrow-until-accept, seller settle options, and face-value transfer).
- Public feed may **link** to rooms and events; it is not a money ledger.


---

## 7. Public Feed Plan (Included)

### Problems to fix

1. API is live-rooms-only — no upcoming events, no “who’s here” beyond room list.
2. No durable product UI for the feed on the public surface people actually land on.
3. Discovery doctrine historically blocked marketplace expansion before the live loop; tickets + feed must stay **truthful inventory**, not a fake marketplace reboot.
4. Empty / error / 503 states need honest copy when durable DB or rooms are unavailable.

### Target shape

```text
Public landing / discover
  → Live now (active rooms)
  → Coming up (ticketed events)
  → Scan / join by code (existing)
```

### Feed rules

- Sort: live rooms first (startedAt desc), then upcoming events (startAt asc).
- Cap list length (keep current ~12–30 discipline).
- Hide suspended / inactive sellers.
- Hide events that are draft, cancelled, or past. Sold-out primary may still show if transfers are available.
- No ranking ads in v1.
- Cards show: name, city/location line if present, time, avatar, clear CTA — no dashboard chrome.

### Feed ↔ tickets coupling

- Publishing an event can opt into feed visibility (default on for public events).
- Private / unlisted events stay off the feed (link-only).
- Live room cards remain independent of ticket sales (a show can be ticketed earlier and go live later).

---

## 8. Build Phases

The external-listing slice is activated. Native money phases remain gated until Gawain opens them with a separate ledger and evidence bar.

### Phase A — Doctrine + contracts (docs only → then contracts)

- Finalize fee language + Partner Terms ticket addendum: **escrow until QR accept**, seller settle (**refund / credit / you agreed**), face-value transfer swap.
- Schema sketch: `events`, `ticket_orders`, `tickets`, `ticket_escrow_ledger`, `ticket_transfers`, `ticket_credits`, accepts (names TBD).
- Payment contract: hold ≠ seller payout; release on accept or disclosed forfeit; refund/credit from escrow; transfer = buyer escrow swap; no long-lived card-auth fantasy for advance sales.
- Public feed contract: response shape for `rooms[]` + `events[]`, empty/error honesty.
- Explicit non-claims in readiness / revenue docs.

### Phase B — External listings + public feed (activated)

- Persist performer-owned external event listings.
- Expose eligible events on the performer profile, `/e/:eventId`, `/api/public/feed`, and `/discover`.
- Hand customers only to normalized HTTPS ticket URLs.
- Harden empty, loading, and 503 states.
- Evidence: contract tests + behavior tests + production smoke that the feed never invents performers, events, inventory, or sale state.

### Phase C1 — Native paid-GA core (activated; production gated)

- Configure, publish, and cancel one paid-GA offer with immutable refund-only terms.
- Authenticated one-ticket order → automatic platform capture → backend-confirmed ticket issuance.
- Seller door QR accept → durable per-ticket performer transfer operation.
- Cancel or close window → durable full-refund operation for each unused ticket.
- Buyer ticket wallet and rotating pass.
- Payout-ready gate for sellers.
- Signed webhook, dispute, idempotency, concurrency, and reconciliation evidence.

### Phase C2 — Alternate settlement (future)

- Seller credit with a redeemable seller-scoped liability ledger.
- Disclosed no-show forfeiture.
- Any partial/multi-ticket order behavior.

### Phase D — Native ticket holder transfers (future)

- Upcoming events on feed + event page share cards.
- Sold-out primary with **transfers available** on event/feed cards.
- Face-value transfer list + buy + QR reissue.
- Recap for seller after event (accepted / refunded / credited / forfeited / transferred).

### Phase E — Only if needed (still lean)

- Gift transfer (no money).
- List at or below face (still no markup).
- Simple promo code (one code, not a campaign suite).
- Collaborator payout split (only with clear ledger rules and no new product actor).

---

## 9. UX Principles

- One screen to create an event. One screen to buy. One screen to scan.
- Price and fees visible before pay; **escrow-until-entry**, settle options, and **Sell ticket** stated in plain language.
- Seller settle is three clear actions — refund, credit, you agreed — not a policy novel.
- Transfer is one button to list at face, one button to buy — no auction chrome.
- Individual voice: “Your show. Your link. Your door.” — not venue enterprise copy.
- Feed is a bulletin board of what’s real, not an engagement product.

---

## 10. Success Bar (Compete Without Ticketmaster)

We are winning when:

1. A solo performer can list a show and sell tickets the same day they’re payout-ready.
2. A buyer finishes purchase on mobile in under a minute and understands: paid now, performer paid on entry (or disclosed settle).
3. Door QR accept both admits the guest **and** releases that ticket’s escrow.
4. Seller can refund, credit, or (if disclosed) keep no-show funds — without clawing money that was never paid out.
5. Can’t-attend buyers list at face; new buyer swaps escrow; old QR dies.
6. Chargeback/refund/credit/forfeit state is explainable from Sway records; pre-accept disputes stay the cheap path.
7. Public feed shows only real live rooms and real upcoming shows — and still feels useful when the list is short.
8. No location-specific account, seat map, or “promoter toolkit” is required.


---

## 11. Open Owner Decisions (Before Build)

1. **Close / grace window** after event end before auto-applying the event’s default settle policy?
2. Free / RSVP events on the same event object, or tickets-only in v1?
3. Unlisted vs public feed default?
4. Should Phase B (feed UI) run ahead of ticket MVP while live-room money stays sacred?
5. Platform fee model for tickets (flat cents, %, or hybrid) — at release vs purchase — and any small transfer fee — must match Partner Terms before UI copy.
6. Credit scope: **that seller’s future events only** (recommended) vs platform-wide credit?
7. Allow list **below** face in v1, or face-only?

**Locked (no longer open):** escrow until QR accept; customer paid / seller not paid yet; seller settle = refund | credit | you agreed (disclosed); official face-value transfer market (escrow buyer swap, no markup scalping).


---

## Related Docs

- `docs/SWAY_FUTURE_LANE_EVENT_TICKET_SALES.md` — lane lock
- `docs/REPO_LANES.md` — future lane registry
- `docs/SWAY_REVENUE_MODEL.md` — future revenue
- `docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md` — non-stacking fee doctrine
- `docs/SWAY_DAY1_BUILD_CONTRACT.md` — no fake discovery inventory
- `docs/SWAY_LIVE_PILOT_READINESS_CHECKLIST.md` — marketplace expansion still owner-gated
- `docs/SWAY_PRODUCT_SPINE.md` — current completeness bar (tickets not required to claim live completeness)
