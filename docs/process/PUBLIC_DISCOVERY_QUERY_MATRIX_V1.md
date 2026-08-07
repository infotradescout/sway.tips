# Public Discovery Contract v1 — Fixed query matrix (Sway)

**Status:** Phase 7 measurement scaffold (feature branch only).  
**Branch:** `codex/public-discovery-contract-v1`  
**Authority:** Do not merge. Do not deploy. Do not fabricate clicks, impressions, or ranking claims.  
**Canonical host:** `https://app.sway.tips` (HTML canonical, robots Sitemap, and sitemap `<loc>` must agree).

## Methodology

This section records methodology for Sway discovery measurement.

1. Use only **eligible real** public addresses already proven in sitemap or first-response HTML.  
2. Run each query in a clean browser/profile when possible; record date (UTC), tool, and observed result.  
3. Separate crawler visits from human visits; never treat UA strings alone as verified bots.  
4. Record presence/absence only — do not invent CTR, position, or ChatGPT citation counts.  
5. Live Rooms and Self-Production are separate lanes; do not score DIO catalog pages (not live).  
6. If a page fails first-response identity facts (title, H1, summary, entity, primary action), mark the query row **blocked** until fixed.

## Query families (Sway)

Covered families: exact name, category + location, specific event / release, problem phrasing.

| # | Family | Example query pattern | Expected eligible surface | Pass criteria (after authorized deploy) | Result (fill later) |
| --- | --- | --- | --- | --- | --- |
| Q1 | exact name | `"{performer display name}" Sway` or `@{handle} Sway` | `/p/{handle}` | Canonical `app.sway.tips` URL; first response has title + H1 + JSON-LD Person | _not run — HOLD_ |
| Q2 | category + location | `"{specialty} {city}" live requests` / `DJ {city} Sway` | Eligible `/p/{handle}` with city + specialty facts | Page shows location + categories in first response | _not run — HOLD_ |
| Q3 | specific event | `"{event title}" {city/date}` | `/e/{event-id}` when published public future event exists | Event in sitemap; first response Event JSON-LD + Attend action | _not run — HOLD_ |
| Q4 | specific release | `"{release title}" {artist} Sway` | `/r/{release-id}` when non-private ready/scheduled/published | Release in sitemap; MusicAlbum JSON-LD; no fake store claim | _not run — HOLD_ |
| Q5 | problem phrasing | `crowd song requests tip DJ live` / `send song request during show` | `/`, `/discover`, or live-eligible performer | Landing explains Live Rooms; no demo/fake performers as live inventory | _not run — HOLD_ |

## Seed addresses for post-deploy verification (real handles observed 2026-08-07)

Use only if still eligible after deploy:

- `https://app.sway.tips/p/dj3x`
- `https://app.sway.tips/p/bubbakhain`
- `https://app.sway.tips/p/calliehines`
- `https://app.sway.tips/p/coreymack`
- `https://app.sway.tips/p/drewmaze`
- `https://app.sway.tips/robots.txt`
- `https://app.sway.tips/sitemap.xml`
- `https://app.sway.tips/llms.txt`

Events/releases: add rows only when sitemap contains real `/e/*` or `/r/*` locs. Do not invent.

## Attribution checks (same visits)

| Check | Expected |
| --- | --- |
| UTM first touch | `?utm_source=chatgpt.com` (or similar) preserved in `sway.discovery.firstTouch` across navigation |
| Discovery events | `discovery_landing`, `discovery_entity_view`, `discovery_primary_action` accepted by `/api/analytics/shell` |
| Offline prompt | “How did you find us?” optional; does not overwrite stronger first-touch |

## Stop condition

Fill results only after an **authorized** production deploy of this branch. Until then every Result cell stays `_not run — HOLD_`.
