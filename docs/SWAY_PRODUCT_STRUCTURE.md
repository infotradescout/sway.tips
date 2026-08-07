# Sway product structure (governing lock)

**Status:** Owner-locked product truth. Do not contradict in docs, readiness, AGENTS, or release language.

## Bottom line

Sway gives independent performers two connected systems:

1. **Live Rooms** — earning and engaging audiences during real performances
2. **Self-Production** — creating, owning, releasing, ticketing, distributing, and streaming original work

**Sway.DIO** — Digital Independent Original streaming, built for work owned by the people who created it. It lives **inside Self-Production** as the native streaming destination. It is not a third unrelated product.

**Sway.DIO economic model:** zero-take, listener-directed streaming. Each paying listener creates a monthly creator pool that follows verified listening; Sway keeps **$0** from the streaming pool and earns from Live Rooms, events, tickets, Self-Production, files, and optional services. Artists keep masters; collaborators are paid at the source. Canonical lock: `docs/SWAY_DIO_ECONOMIC_MODEL.md`.

## Hierarchy

```text
Sway
├── Live Rooms                          (current operating product)
└── Self-Production                     (active build in progress)
    ├── Files and projects
    ├── Collaboration
    ├── Releases
    ├── Events and tickets
    ├── External distribution           (one outlet — not Sway’s identity)
    ├── Sway.DIO streaming              (planned native layer)
    └── Earnings and ownership records
```

## Status language (required)

| Lane | Correct status |
| --- | --- |
| Live Rooms | Current operating product |
| Self-Production | Active build in progress |
| Sway.DIO | Planned native streaming layer within Self-Production |
| External distribution | One Self-Production capability, not Sway’s identity |
| Live payment activation | Separate release gate for Live Rooms |

Unfinished Self-Production does **not** make Live Rooms unfinished. Audits, roadmaps, and release gates must judge the two lanes **independently**.

## Live Rooms (current product)

During a real performance:

- Performer-controlled live room
- QR audience entry
- Song/performance requests
- Tips and boosts
- Live request queue
- Performer controls
- Public display and overlay
- Audience payment recovery
- End-of-room closeout
- Performer earnings and recap
- Moderation and room access controls

**Payment boundary:** Stripe test-only today; live money is a separate release gate. That boundary must not be confused with Live Rooms being a “future idea.” Live Rooms is the current product; live money is a later Live Rooms gate.

**Next Live Rooms product milestone (HOLD before live Stripe):** one performer + one audience account, production-hosted room, Stripe **test-mode** request/tip/boost/refund, duplicate + delayed webhooks, closeout, earnings view, audience receipt/history, DB reconciliation, exact deployed-commit evidence. See `docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md`.

## Self-Production (creator ownership system)

Broader than distribution. Path from original file to independent creator business:

- Original master-file storage
- Projects and working files
- Private collaboration
- Version history and approvals
- Credits, ownership, rights, and splits
- Singles, EPs, albums, and other releases
- Artwork and release pages
- Creator profiles and catalogs
- Events
- Native ticket sales
- Direct audience relationships
- Promotion and release discovery
- External distribution to streaming services
- Native Sway streaming through Sway.DIO
- Earnings, statements, payouts, long-term catalog control

External distribution (including any DistroKid-class DSP cutover work) is **one outlet** inside Self-Production — not the definition of Sway, and not the definition of Self-Production.

Later independent lanes (not Live Rooms unfinished-proof): DSP delivery, ticket sales, royalty processing, collaborator payouts.

## Sway.DIO naming honesty

| Field | Value |
| --- | --- |
| Product name | Sway.DIO |
| Meaning | Digital Independent Original |
| Web address | `dio.sway.tips` |
| Alternate | `sway.tips/dio` |

`.dio` is **not** a public TLD. Do not claim `sway.dio` works as a normal website. This is not formal trademark clearance — do not claim cleared.

## Sway.DIO economic model (summary)

Governing detail: `docs/SWAY_DIO_ECONOMIC_MODEL.md`.

| Rule | Required truth |
| --- | --- |
| Pool model | Per-listener monthly creator pool — not one platform-wide streamshare pool |
| Allocation | Verified listening share (time-based rules), not raw play count or fixed pennies |
| Sway streaming take | **$0** after taxes, refunds/chargebacks, disclosed payment-rail costs, and required composition royalties |
| Masters | Creator retains master copyright |
| Splits | Paid directly to approved master owners and named contributors |
| Outside DSPs | Pass through 100% of actual master royalties received; never claim PRO/other-org payments as Sway-paid |
| Sway Exclusive | Exclusive distributor/administrator for selected recordings + defined term; not ownership of the artist |
| Company profit | Live Rooms, events, tickets, Self-Production, files, optional services — not the streaming pool |

This economic lock does **not** authorize Sway.DIO launch or royalty runtime.

## Dual-lane readiness rule

- **Live Rooms readiness** may advance (including the test-mode production pilot) while Self-Production remains in progress.
- **Self-Production readiness** may advance capability-by-capability without redefining Live Rooms as incomplete.
- Machine config `config/sway-complete-product-readiness.json` remains a cohesive HOLD ledger across both lanes for whole-product launch claims; it must not be used to deny that Live Rooms is the current operating product.
- Iterative `main` deploys follow `RELEASE_CONTROL.md`. They do not authorize live Stripe and do not imply Self-Production or Sway.DIO is shipped.

## Related docs

- Live Rooms pilot: `docs/SWAY_LIVE_PILOT_READINESS_CHECKLIST.md`
- Test-mode milestone HOLD: `docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md`
- Sway.DIO economic model: `docs/SWAY_DIO_ECONOMIC_MODEL.md`
- Gap ledger (capability detail): `docs/SWAY_COMPLETE_PRODUCT_GAP.md`
- Release chain: `RELEASE_CONTROL.md`
- Agent rules: `AGENTS.md`
