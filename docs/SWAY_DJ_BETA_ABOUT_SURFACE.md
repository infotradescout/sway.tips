# Sway DJ Beta About Surface

**Status:** Opening DJ beta release lane  
**Primary public routes:** `/about` and `/faq`  
**Product spine:** Start room → share QR or link → Request, Tip, or Boost → manage queue → show status → close room → review recap.

## Purpose

The previous About page asked invited DJs to read through Catalog, publishing, distribution, royalties, and other future product lanes before understanding the live room.

The opening beta page is intentionally narrower. It answers the questions a DJ needs before using Sway tonight:

1. What does Sway do during a set?
2. How does the crowd enter?
3. What can patrons send?
4. Does the DJ remain in control?
5. How does the DJ start?

## Public promises

The beta page states only that:

- Sway works alongside existing DJ setups.
- Patrons can use the web experience without downloading an app.
- Sway organizes Requests, Tips, Boosts, queue status, and room recap.
- A paid Request does not guarantee playback.
- Boosts apply only to already-approved Requests.
- Payment success waits for backend and payment-provider confirmation.
- Paid actions appear only when they are available for the performer.

It does not claim a direct integration with Serato, Rekordbox, VirtualDJ, Tidal, USB-drive decks, or any other DJ software or hardware.

## Runtime activation

The release uses the checked-in preload module:

`scripts/sway-dj-beta-about-preload.cjs`

Production activation is explicit through:

`NODE_OPTIONS=--require=./scripts/sway-dj-beta-about-preload.cjs`

The preload replaces only the existing `/about` and `/faq` GET handlers when they are registered. It does not change Request, Tip, Boost, payment, payout, queue, room, account, profile, Catalog, publishing, ticket, overlay, moderation, or database behavior.

The server writes this startup marker when the surface is active:

`[sway.about] DJ beta About and FAQ surface active.`

## Production proof

A release is complete only after all of the following are confirmed against the deployed commit:

- Render deploy reports live.
- The build marker matches the merged commit.
- `/about` returns HTTP 200 and contains `Run the crowd without stopping the set.`
- `/faq` returns HTTP 200 and contains the same focused beta explanation.
- The old Sway.DIO, Self-Production, DistroKid, distributor-replacement, and royalty-processing explanation is absent from both routes.
- The account signup, account login, room join, Privacy, Terms, Support, deletion, payment, payout, and ticket links remain present.
- The startup marker appears in Render logs.

## Rollback

Remove the production `NODE_OPTIONS` value or remove the preload flag from it, then deploy the same known-good application commit. The underlying server routes remain intact and no database rollback is required.

## Follow-up

After the opening beta stabilizes, move the focused copy into the canonical static-document source and retire the preload. Do not expand the About page into future product lanes unless they are live, verified, and useful to the person opening the page.
