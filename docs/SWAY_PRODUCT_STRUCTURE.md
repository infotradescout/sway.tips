# Sway product structure (governing lock)

**Status:** Owner-locked product truth. Do not contradict in docs, readiness, AGENTS, or release language.

## Bottom line

Sway gives independent performers two connected systems:

1. **Live Rooms** — earning and engaging audiences during real performances
2. **Self-Production** — creating, owning, releasing, ticketing, distributing, and streaming original work

**Sway.DIO** — Digital Independent Original streaming, built for work owned by the people who created it. It lives **inside Self-Production** as the native streaming destination (the streaming side of Self-Production). It is not a third unrelated product.

**Sway.DIO economic model (decision D):** all three funding sources — listener subscriptions, advertising, and sponsorships — **staged**. Private beta / first earnable streams are **subscription-funded Sway Exclusives only** (clear funding source). Later, advertising-funded and sponsor-funded listening may be added without changing the zero streaming-cut rule. Forever: **100%** of streaming income attributable to qualifying Sway Exclusive artists goes to them; Sway takes **$0** streaming cut. For now only Sway Exclusives qualify to earn from streams. Sway Exclusive ≠ ownership: exclusive home / distributor / business partner for specific releases; artist keeps the master. Sway earns from Live Rooms (requests/tips/boosts), event/ticket fees, Self-Production services, file storage/collaboration, distribution services, and promotion/optional tools — not music streaming income. Competitive offer: Keep ownership. Release through Sway. Stream on Sway.DIO. Receive 100% of stream money. Sway makes money helping the career grow, not taking music income. Binding summary for this dual-lane lock lives in this document only (no hard dependency on a separate DIO economic-model file in this PR).

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

**Live Rooms test-mode production milestone: PASS.** The production-hosted money loop, webhook behavior, closeout, receipts, reconciliation, and authorized active-block lifecycle are recorded in `docs/qa-packets/2026-08-11-live-rooms-test-mode-pilot.md`. Live Stripe remains a separate owner-authorized release gate.

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

### Working-storage and release-count boundary

Sway is a release workspace, not a general-purpose cloud drive. The number of releases a creator may prepare or publish is **not numerically capped**. Storage abuse is controlled separately through a configurable per-performer working-storage pool (default: 5 GiB): active multipart reservations plus sealed files that are not named in an immutable, validated release-package manifest consume that pool.

Creating a draft, attaching a file to a draft, placing a release in rights review, or directly changing a release or delivery status does not exempt bytes from the working pool. A release-package file graduates only when Sway atomically records an immutable manifest after independent readiness validation. The manifest names each exact version ID, hash, byte size, and release role; later attachments do not inherit the exemption. A future provider-delivery path must create the same manifest from a coupled immutable submission event rather than trusting a mutable `submitted` status. Only one exact master per release recording, the exact artwork, and the latest independently verified rights document for each declaration scope may graduate; superseded, rejected, revoked, merely proposed documents and creator deals remain working storage. Existing package manifests remain preserved through takedown. Legally or operationally restricted files remain preserved, but restriction alone does not increase the account's available workspace. Graduation is accounting policy, not deletion or a claim that store delivery is live.

Manifest eligibility reopens and parses the sealed package: masters must be playable audio matching their declared container, artwork must decode and end at its image boundary, and bounded rights documents must be valid text/Markdown or non-embedded paged PDFs. Individual master, artwork, and rights-document size ceilings protect the release lane without imposing any numerical limit on releases.

Sway must count active upload reservations atomically, cap active plus sealed working-file records to prevent tiny-object/database abuse (default: 10,000), expire abandoned multipart sessions, reject unsupported or obviously disguised file content, and keep quota enforcement server-side. It must not enforce this boundary by limiting release count, silently deleting sealed originals, weakening rights review, or treating a client-side check as authority.

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

Governing summary for dual-lane language is this section. Simplified spine (authorized decision **D**):

| Rule | Required truth |
| --- | --- |
| Role | Sway.DIO = streaming side of Self-Production |
| Who can earn from streams (for now) | Only **Sway Exclusives** qualify to earn from streams |
| Funding sources (all three, staged) | Listener subscriptions → then advertising → then sponsorships |
| Private beta / first earnable streams | **Subscription-funded** Sway Exclusives only (clear funding source) |
| Later stages | Add advertising-funded and sponsor-funded listening **without** changing the zero streaming-cut rule |
| Sway streaming take | Forever **$0** — 100% of attributable streaming income to qualifying Sway Exclusive artists |
| Sway Exclusive ≠ ownership | Exclusive home / distributor / business partner for specific releases; artist keeps the master |
| Company profit | Live Rooms (requests/tips/boosts), event/ticket fees, Self-Production services, file storage/collaboration, distribution services, promotion/optional tools — **not** streaming income |
| Competitive offer | Keep ownership. Release through Sway. Stream on Sway.DIO. Receive 100% of stream money. Sway makes money helping the career grow, not taking music income. |

This economic lock does **not** authorize Sway.DIO launch, streaming/royalty runtime, live Stripe, merge, or deploy.

## Dual-lane readiness rule

- **Live Rooms readiness** may advance (including the test-mode production pilot) while Self-Production remains in progress.
- **Self-Production readiness** may advance capability-by-capability without redefining Live Rooms as incomplete.
- Machine config `config/sway-complete-product-readiness.json` remains a cohesive HOLD ledger across both lanes for whole-product launch claims; it must not be used to deny that Live Rooms is the current operating product.
- Iterative `main` deploys follow `RELEASE_CONTROL.md`. They do not authorize live Stripe and do not imply Self-Production or Sway.DIO is shipped.
- **GitHub Actions is NOT USED — NOT A GATE.** Actions billing and required check `validate` are irrelevant to merge/release. Holds on merge/deploy/live Stripe are authorization-only (see `RELEASE_CONTROL.md` corrected operating rule).

## Related docs

- Talent and capability model: `docs/SWAY_TALENT_CAPABILITY_MODEL.md`
- Public copy truth matrix: `docs/SWAY_PUBLIC_COPY_TRUTH_MATRIX.md`
- Live Rooms pilot: `docs/SWAY_LIVE_PILOT_READINESS_CHECKLIST.md`
- Test-mode milestone record: `docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md`
- Gap ledger (capability detail): `docs/SWAY_COMPLETE_PRODUCT_GAP.md`
- Release chain: `RELEASE_CONTROL.md`
- Agent rules: `AGENTS.md`

A fuller Sway.DIO economic-model document may exist later as a Self-Production artifact; this dual-lane PR does **not** ship or depend on `docs/SWAY_DIO_ECONOMIC_MODEL.md`.
