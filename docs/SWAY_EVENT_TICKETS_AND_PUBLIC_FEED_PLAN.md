# Sway Plan: Event Tickets + Public Feed

**Status:** Planning only — not active build.  
**Date:** 2026-07-23  
**Locked lane memo:** `docs/SWAY_FUTURE_LANE_EVENT_TICKET_SALES.md`  
**Owner direction:**

- Event ticket sales is a Sway lane.
- You do **not** need to be a venue to sell tickets.
- Handle fraud and the real money/admission risks — without Ticketmaster-scale bloat.
- Simpler processes. No fluff tools. Power in the individual’s hands.
- Public feed needs work and is part of this plan.
- **Ticket money is escrowed until QR accept (check-in).** The customer has already paid; the ticket seller has **not** been paid yet.
- After the show (or when settling a held ticket), the **seller** chooses: **refund**, **credit**, or **“sorry — you agreed”** (forfeit to seller under disclosed terms).
- Buyers who can’t go can hit **Sell ticket** — it lists on Sway’s official transfer market; a new buyer swaps into the escrow seat and the original buyer gets their money back (lean face-value transfer — see §5b).

---

## 1. Product Lock

Sway helps an **individual creator** sell tickets to a real show, get paid **when the door accepts the ticket or when they lawfully settle a no-show under disclosed terms**, and let buyers prove entry or transfer a seat — then helps the public **find what’s live or coming up** without a fake marketplace.

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
| Seller identity | Any verified Sway creator account (performer / host), not venue-gated |
| Venue | Optional field (name / address / “TBA” / private location details after purchase) |
| Co-hosts | Later slice — v1 is one seller of record |
| Unclaimed preview profiles | Cannot sell tickets until claimed + payout-ready |

Venue is context, not permission.

---

## 3. What We Build (Lean Core)

### Ticket sales — must-have loop

1. **Create event** — title, when, where (optional detail), capacity, price, cover image optional. Seller sets **no-show settle policy** shown at checkout: refund, credit, and/or you-agreed (forfeit) — at least one path; default recommended = refund.
2. **Publish** — public event page + share link; optional appearance on public feed when eligible.
3. **Buy** — quantity, email/receipt, checkout on a **separate ticket ledger**; funds enter **escrow**, not seller payout. Buyer sees settle + transfer rules in plain language.
4. **Transfer (optional)** — buyer hits **Sell ticket** → lists on official Sway transfer market → new buyer swaps escrow → original buyer refunded → QR reissued to new holder.
5. **Admit** — one scannable proof per ticket; single-use QR accept; seller sees sold / held / listed / checked-in counts.
6. **Release** — QR accept triggers escrow release for that ticket; platform ticket fee disclosed and taken per terms.
7. **Seller settle** — for unscanned held tickets (per ticket or bulk at close): **refund**, **credit**, or **you agreed** (only if disclosed).
8. **Close** — event ends; unsold primary inventory closes; listed transfers delist; remaining holds require seller settle or auto-apply the event’s default settle policy after grace.

### Public feed — must-have loop

Today: `/api/public/feed` returns **active live rooms only**, and there is **no first-class public feed UI** wired as a product surface.

Target feed is a **truthful discovery strip**, not a social network:

| Card type | Source of truth | CTA |
| --- | --- | --- |
| Live now | Active gig / room registry | Enter room / tip-request |
| Upcoming tickets | Published ticketed events with remaining inventory | Buy tickets / event page |
| Creator presence (optional later) | Claimed public profiles with live or upcoming activity | Profile |

Empty state tells the truth (“No live rooms or upcoming shows right now”) — never pads with fake acts.

---

## 4. Explicit Non-Goals (No Fluff)

Do **not** build in v1:

- Full Ticketmaster: bots arms race, dynamic pricing suites, seat maps for arenas, season packages, fan clubs, “insights dashboards,” promo-code empires, multi-tier CRM.
- Open scalping exchange (bids, markups above face, stub dumps, speculative bots).
- Venue operator OS / box-office staffing suites.
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

### Escrow + seller settle (owner lock)

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
- Cards show: name, city/venue line if present, time, avatar, clear CTA — no dashboard chrome.

### Feed ↔ tickets coupling

- Publishing an event can opt into feed visibility (default on for public events).
- Private / unlisted events stay off the feed (link-only).
- Live room cards remain independent of ticket sales (a show can be ticketed earlier and go live later).

---

## 8. Build Phases (When Activated)

Do not start code until Gawain opens the lane. Suggested order:

### Phase A — Doctrine + contracts (docs only → then contracts)

- Finalize fee language + Partner Terms ticket addendum: **escrow until QR accept**, seller settle (**refund / credit / you agreed**), face-value transfer swap.
- Schema sketch: `events`, `ticket_orders`, `tickets`, `ticket_escrow_ledger`, `ticket_transfers`, `ticket_credits`, accepts (names TBD).
- Payment contract: hold ≠ seller payout; release on accept or disclosed forfeit; refund/credit from escrow; transfer = buyer escrow swap; no long-lived card-auth fantasy for advance sales.
- Public feed contract: response shape for `rooms[]` + `events[]`, empty/error honesty.
- Explicit non-claims in readiness / revenue docs.

### Phase B — Public feed repair (can ship before full ticketing)

- Wire a real public discover/feed UI to `/api/public/feed`.
- Harden empty, loading, and 503 states.
- Keep rooms-only until events exist; design the card list so event cards drop in without a rewrite.
- Evidence: contract tests + production smoke that feed never invents performers.

### Phase C — Ticket MVP (individual seller + escrow + settle)

- Create / edit / publish / cancel event with disclosed settle policy.
- Checkout → escrowed ticket issuance + receipt email (copy: held until entry; seller settle options).
- Seller door QR accept → per-ticket release.
- Seller settle UI: refund / credit / you agreed (gated by disclosure).
- Close window job: apply default settle policy to remaining holds.
- Buyer “my ticket” page: held / listed / accepted + **Sell ticket** button.
- Payout-ready gate for sellers.
- Chargeback/dispute path while escrowed proven in contracts.

### Phase D — Feed + tickets + transfers together

- Upcoming events on feed + event page share cards.
- Sold-out primary with **transfers available** on event/feed cards.
- Face-value transfer list + buy + QR reissue.
- Recap for seller after event (accepted / refunded / credited / forfeited / transferred).

### Phase E — Only if needed (still lean)

- Gift transfer (no money).
- List at or below face (still no markup).
- Simple promo code (one code, not a campaign suite).
- Co-host payout split (only with clear ledger rules).

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
8. No one needs a venue account, seat map, or “promoter toolkit” to participate.


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
