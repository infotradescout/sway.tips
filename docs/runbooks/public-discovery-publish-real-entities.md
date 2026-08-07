# Publish real discovery entities (no seeds)

**Rule:** Sitemap and `/discover` list only eligible **real** performers, events, and releases. Never insert demo rows in production.

## Live eligibility (as implemented)

| Entity | Public URL | Included in `sitemap.xml` when |
| --- | --- | --- |
| Performer / preview | `/p/{handle}` | Active (or active preview), not suspended; bio **or** headline **or** avatar present; handle discovery-eligible |
| Event | `/e/{id}` | `status = published`, `visibility = public`, `starts_at` in the future, non-empty title |
| Release | `/r/{id}` | `status ∈ {ready, scheduled, published}`, `distribution_mode ≠ private`, non-empty title |

Static locs always include `/`, `/about`, `/discover`, `/faq`, legal pages. Canonical host: `https://app.sway.tips`.

## Operator: publish a real public event

1. Sign in as the owning performer (`/talent` / account with Pro Mode).
2. Create/edit the event with a real title, future start, and public visibility.
3. Set status to **published** (product event publish control — not a SQL insert).
4. Confirm `https://app.sway.tips/e/{eventId}` loads with truthful status.
5. Within ~15 minutes (sitemap cache max-age 900), confirm the `/e/{id}` loc appears in `https://app.sway.tips/sitemap.xml`.

## Operator: publish a real release

1. Complete Self-Production release workflow to a non-private distribution mode.
2. Move release to **ready**, **scheduled**, or **published** with a real title.
3. Confirm `https://app.sway.tips/r/{releaseId}` loads without store-delivery claims that are not true.
4. Confirm the `/r/{id}` loc appears in sitemap after cache window.

## Operator: make a performer discoverable

1. Activate performer identity; keep `is_active` true; not suspended.
2. Add a real bio and/or public profile headline and/or avatar.
3. Confirm `/p/{handle}` returns Person JSON-LD + visible H1 matching the profile.
4. Confirm sitemap lists `/p/{handle}`.

## Production truth snapshot (2026-08-07, post `c6b8188f`)

- Sitemap: static pages + real `/p/*` handles; **zero** `/e/*` and `/r/*` (DB has 0 `performer_events`, 0 `music_releases`).
- Sample `/p/dj3x`: HTTP 200, canonical, H1, Person JSON-LD present.
- Do **not** invent events/releases to “fill” discovery depth.
