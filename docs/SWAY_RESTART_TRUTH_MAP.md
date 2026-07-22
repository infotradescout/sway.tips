# Sway Restart Truth Map

## Product Lock

Sway is a creator account product with two permanent surfaces:

1. **Live audience money** — join or run a live room for tips, requests, and queue control.
2. **Publishing & collaboration** — preserve masters, collaborate, share files, deliver releases, and (eventually) transfer catalogs with fail-closed continuity.

A live room is night mode, not an entry tax. One account covers audience and creator. Stripe verification unlocks getting paid, not using the site.

If a file, route, or doc does not help those surfaces — or honesty about what is unfinished — it is not core product scope.

See `docs/SWAY_COMPLETE_PRODUCT_GAP.md` and `docs/SWAY_PRODUCT_SPINE.md`.

## Current State Note (2026-07-21)

- Live-night loop remains implemented on `main`.
- Stripe test keys (publishable + secret + webhook) are present on Render; payment form config returns test mode. That is plumbing, not complete-product ship.
- Audio publishing / file-sharing / DistroKid-class catalog transfer foundation authored on `agent/audio-publishing-foundation` was **not** on `main`. Re-entry ports it as migration `0023_audio_publishing_foundation` + contracts. Runtime upload/share/cutover flags remain false until durable implementation exists.
- Unified account home (usable with zero live room) is required and not yet complete.
- Old “patron accounts held / live-loop-only” spine language is superseded by owner direction: do not ship incomplete product; publishing/collab are in-scope.

## Keep

- Live room: `PatronApp`, `TalentApp`, `TalentDashboard`, `PerformerShareKit` / `PerformerRoomShare`, payment + business store modules
- Auth: performer login/session (becoming unified account auth)
- Publishing foundation (re-entering): `docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md`, `src/server/audio-publishing-contract.ts`, `drizzle/0023_audio_publishing_foundation.sql`

## Quarantine

- `/admin` and operator extraction surfaces — internal only
- Side branches that claim product without `main` + production evidence

## Cut Or Rewrite First

- Any UI that implies DistroKid cutover, lossless collab, or file QR pairing is live before runtime exists
- Talent idle state that forces “create room” as the only useful action
- Docs that say publishing waits for “adoption proof”

## Restart Build Order

1. Correct product truth (this map + spine + gap ledger)
2. Land publishing foundation schema/contracts on `main` as `0023` (no fake runtime claims)
3. Account home usable with zero live room
4. First durable file upload + share path
5. Catalog transfer execution only after continuity evidence

## Immediate Cleanup Targets

- Finish re-entry PR for `0023` + contract wiring
- Remove “held” language that blocks unified account work
- Do not prioritize Stripe victory-laps over missing publishing/collab runtime
