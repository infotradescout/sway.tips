# Sway Restart Truth Map

## Product Lock

Sway has exactly two customer-facing sides: customer and performer.

- Customer: join, request, tip, boost, pay, and see status.
- Performer: activate Pro Mode, start/share a room, manage requests, get paid, end, and recap.

## Authoritative Continuation Order

1. Read `docs/VIBE_ENGINEERING_DOCTRINE.md`.
2. Read `docs/SWAY_PRODUCT_SPINE.md`.
3. Verify `main`, the production build marker, and current CI rather than trusting a prior handoff.
4. Inspect the real customer and performer journeys.
5. Implement the smallest change that improves or protects the live loop.

## Scope Drift Guard

Do not restart music distribution, release delivery, royalty, master-storage, file-collaboration, catalog-transfer, venue, or third-side work from historical migrations, modules, documents, branches, or pull requests.

Historical audio tables remain only to avoid destructive production data changes. Their routes are retired and their infrastructure is not a Sway startup requirement.

## Completion Standard

Only current independent production evidence can move the two-sided readiness decision from `HOLD` to `GO`.
