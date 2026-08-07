# Live Rooms test-mode production pilot milestone — HOLD

**Status:** HOLD until proven with real production-hosted evidence.  
**Lane:** Live Rooms (current operating product). Self-Production progress is judged separately — see `docs/SWAY_PRODUCT_STRUCTURE.md`.

## Binding rule

Hardening the release chain (CI, health, migration compatibility, smoke, branch rules) does **not** authorize live Stripe.

Live Stripe may be considered only after this **Live Rooms** milestone is proven end-to-end in **Stripe test mode** on production-hosted Sway.

Unfinished Self-Production (DSP, tickets, royalties, collaborator payouts, Sway.DIO) does **not** make this Live Rooms milestone incomplete or redefine Live Rooms as a future idea.

## Required proof (all must pass)

1. One performer account
2. One separate audience account
3. A real production-hosted room
4. Stripe test-mode request, tip, boost, and refund flows
5. Duplicate and delayed webhook tests
6. Room closeout
7. Performer earnings view
8. Audience receipt and history
9. Database reconciliation
10. Exact deployed-commit evidence (`/api/build-marker` and `/api/release-health` commit match the intended SHA; `releaseActive: true`)

## Explicit non-goals (later Self-Production / independent lanes)

- DSP delivery / external distribution cutover
- Ticket sales
- Royalty processing
- Collaborator payouts
- Sway.DIO streaming launch (economic law summarized in `docs/SWAY_PRODUCT_STRUCTURE.md`; runtime not authorized by this Live Rooms gate)
- Live Stripe / live money

## Evidence homes

- Product structure lock: `docs/SWAY_PRODUCT_STRUCTURE.md`
- Sway.DIO economic summary: `docs/SWAY_PRODUCT_STRUCTURE.md`
- Operational pilot checklist: `docs/SWAY_LIVE_PILOT_READINESS_CHECKLIST.md`
- QA packet: `docs/SWAY_LIVE_PILOT_QA_PACKET_TEMPLATE.md`
- Release evidence: `docs/process/RELEASE_EVIDENCE_CHECKLIST.md`
- Release doctrine: `RELEASE_CONTROL.md`
