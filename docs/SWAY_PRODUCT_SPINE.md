# Sway Product Spine

## One-Sentence Product Lock

Sway lets an audience join a live performer or DJ room, pay for song requests, send tips, and follow the queue in real time.

## Core Users

- Patrons scan a QR code, submit a request or tip, and boost live ladder items.
- Talent starts a gig, controls the request queue, accepts or denies items, marks fulfilled work, and reviews earnings.
- Admin remains internal-only if it exists at all and is not part of the marketed MVP.

## Production Principles

- A patron route must never expose talent controls.
- A talent route must never rely on patron-side sandbox switching.
- Public totals must only reflect real persisted gig activity.
- Payment language must describe the processor flow exactly as implemented.
- Moderation must remain active even when AI providers are unavailable.
- Every money event must have a lifecycle and ledger trail.

## Required Route Spine

- `/talent/login`
- `/talent/gigs`
- `/talent/gigs/:gigId`
- `/g/:gigId`
- `/p/:performerHandle`
- `/overlay/:gigId`
- `/admin` internal-only

## Current Product State

The first cleanup pass separates routes and removes public demo seed data. The app is not yet production-ready because database persistence, real payments, legal URLs, reporting/blocking, payout ledgers, and TestFlight validation still need to be completed. Public product truth should stay focused on one loop: join room, pay request or tip, performer manages queue.
