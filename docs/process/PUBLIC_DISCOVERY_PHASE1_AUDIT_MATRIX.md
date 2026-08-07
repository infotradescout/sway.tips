# Public Discovery Contract v1 — Phase 1 forensic audit matrix

**Date (UTC):** 2026-08-07  
**Branch:** `codex/public-discovery-contract-v1`  
**Authority:** Read-only forensic pass + contract docs on feature branch. **No merge. No deploy.**  
**Reference fixture:** JW Stone discovery behavior (not visual design).  
**Contract:** `docs/PUBLIC_DISCOVERY_CONTRACT_V1.md`

## Method notes

- Verified crawler traffic must be separated from requests that merely claim a crawler UA (not proven in this pass).  
- Live probes for Sway used unauthenticated HTTP GETs from an operator environment.  
- Systems without a mounted workspace in this session are marked **unknown** pending repo/domain access.  
- Do not treat MealScout as TradeScout. Judge Sway Live Rooms and Self-Production separately.

---

## Ecosystem matrix (summary)

| Product / lane | Repo path (local when known) | Official public domain (stated/observed) | robots / sitemap | First-response facts | Permanent entity URLs | Structured ≡ visible | Attribution | Live = repo | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| JW Stone | TradeScout profiles / marketplace (reference) | JW Stone public site (ChatGPT `utm_source=chatgpt.com` referral proven historically) | Unknown this pass | Proven useful enough for real call | Inventory + profile depth (reference) | Unknown this pass | ChatGPT UTM proven; offline “How did you find us?” still needed through sale | Unknown | **partial** — control fixture; deepen attribution to sale |
| TradeScout profiles | `TradeScout\TradeScoutPro` (sibling) | Unknown this pass | Unknown | Core server-readable machinery exists (stated) | Intent pages incomplete (stated) | Unknown | Start a Request path required | Unknown | **partial** — enforce completeness, not rebuild renderer |
| TradeScout main | `TradeScout\TradeScoutPro` | Unknown; OpenAI already crawling some landings (stated) | Unknown | Unknown | Connect landings to eligible businesses | Unknown | Measure Start a Request | Unknown | **partial** |
| HomeID | Unknown sibling | Must stay private by default | Should block private | N/A private | Owner-approved share only | N/A | N/A | Unknown | **intentionally private** |
| HomeScout | Unknown | Unknown | Unknown | Unknown | Owner-approved listings needed | Unknown | Direct contact | Unknown | **unknown** / strong opportunity |
| TradeComp | Unknown | Unknown | Unknown | Unknown | Trade+location benchmarks needed | Unknown | Unknown | Unknown | **unknown** / Q&A opportunity |
| ScoutFitters | Unknown | Unknown | Unknown | Unknown | Permanent product URLs needed | Unknown | Purchase/request | Unknown | **unknown** |
| AutoID / MarineID / RVID / EquipID | Unknown | Mixed | Block private IDs | Education + owner-approved only | Never default-expose identifiers | Unknown | Owner-approved connection | Unknown | **intentionally private** (default) |
| MealScout | `TradeScout\MealScout` (+ many gate worktrees) | Custom domain + Render (stated conflict risk) | Strong foundation (stated); live sitemap visited (stated) | SSR public pages exist (stated) | Menus/schedules/events should be permanent | Unknown | Unknown | Deep-page indexing weaker than architecture (stated) | **partial** — audit domain agreement + claim quality next |
| **Sway Live Rooms** | `TradeScout\sway\sway.tips` | `sway.tips` / `www` / `app.sway.tips` | **Live PASS** `text/plain` + `application/xml` (2026-08-07) | **Partial** — title+meta; missing H1 + JSON-LD on sample `/p/dj3x`; root shell present | `/p/{handle}` yes; `/e/`, `/r/` claimed in `llms.txt`; sitemap currently **no** events/releases | **Fail sample** — server source expects JSON-LD; live sample lacked it | Acquisition events in client/source contract; full ChatGPT→outcome chain not proven | Deployed `c4e95655` serves robots/sitemap; surface map docs stale (still say HTML shells) | **partial** |
| **Sway Self-Production** | same repo, separate lane | Same domains | Same robots | Public release pages when eligible | `/r/{id}` when ready/published | Must not fake store delivery | Separate from Live Rooms | Unfinished SP must not mark Live Rooms unfinished | **partial** / incomplete depth |
| Sway.DIO public discovery | Planned only | N/A until real | N/A | N/A | Forbidden until product ready | N/A | N/A | Decision D locked; no live catalog | **intentionally private** / not ready |
| Skill Gaming World | `TradeScout\skill-gaming-world` | Preview | noindex (stated) | N/A | Keep blocked | N/A | N/A | Unknown live probe this pass | **intentionally private** |
| 30Aplus | Unknown | Unknown | Unknown | Unknown | Audit before indexing changes | Unknown | Unknown | Unknown | **unknown** |
| AutoBott / NewsFilter | `TradeScout\NewsFilter` (+ AutoBott unknown) | Internal | Keep blocked | N/A | Public info only if approved purpose | N/A | N/A | Unknown | **intentionally private** |

---

## Sway deep dive (verified this pass)

### Domains and canonical policy

| Check | Result |
| --- | --- |
| Apex `https://sway.tips/robots.txt` | 200 `text/plain` — Allow `/`; Disallow `/admin` `/talent` `/account` `/api/`; Sitemap → `https://app.sway.tips/sitemap.xml` |
| `https://www.sway.tips/robots.txt` | Same |
| Apex + www `sitemap.xml` | 200 `application/xml` |
| Canonical host in sitemap + HTML | **`https://app.sway.tips`** (not apex) |
| Canonical-domain agreement | **Partial / risk** — apex and www serve crawler files but point canonical/sitemap locs at `app.` |

### Live sitemap contents (2026-08-07)

14 URLs only:

- Static: `/`, `/about`, `/discover`, `/faq`, `/legal/*`, `/privacy`, `/terms`  
- Performers: `/p/bubbakhain`, `/p/calliehines`, `/p/coreymack`, `/p/dj3x`, `/p/drewmaze`  
- **Zero** `/e/*` event URLs  
- **Zero** `/r/*` release URLs  

Primary Sway gap is **eligible real entity depth**, not another crawler file.

### Sample performer page `https://app.sway.tips/p/dj3x`

| Contract item | Observed |
| --- | --- |
| HTTP | 200 `text/html` |
| Unique title | Yes — `@dj3x on Sway` |
| Meta description | Yes — short bio/summary |
| Canonical link | Yes — `https://app.sway.tips/p/dj3x` |
| Real H1 | **Missing** |
| JSON-LD | **Missing** in first response |
| `#root` app shell | **Present** |
| Useful pre-JS facts | Partial (title + description meta); fails “real heading + structured facts” bar |

### Repository machinery (main @ `c4e95655`)

| Asset | Present |
| --- | --- |
| `GET /robots.txt` | Yes (`server.ts`) |
| `GET /llms.txt` | Yes |
| `GET /sitemap.xml` | Yes — eligibility filters for bios/headlines/avatars; published public future events; ready/scheduled/published releases |
| Organic discovery contract | `scripts/sway-organic-discovery.contract.test.mjs` (source-text; expects JSON-LD Person/Event/MusicAlbum in server) |
| Acquisition telemetry names | `performer_profile_claim_started`, `guest_to_performer_started`, `public_*_shared` |
| Stale docs | `docs/SWAY_PRODUCTION_SURFACE_MAP.md` still claims robots/sitemap return HTML — **contradicted by live 2026-08-07 probes** |

### Search vs training crawler policy

| Policy | Current |
| --- | --- |
| Search discovery | `User-agent: *` Allow `/` with private Disallows |
| Training / LLM | `llms.txt` published (separate from robots) |
| Separation | Partial — dedicated `llms.txt` exists; no distinct GPTBot/Google-Extended rules observed in robots |

### Attribution (Sway)

| Item | Status |
| --- | --- |
| Share / claim telemetry events | Implemented in source contract |
| Full funnel: ChatGPT landing → entity view → Live Room/event action → outcome | **Not proven** this pass |
| Optional “How did you find us?” for offline | **Missing** |
| Preserve UTM through auth / return visit | **Unknown** |

### Lane separation

| Lane | Discovery posture |
| --- | --- |
| Live Rooms | Current operating product — public performer + room entry actions when appropriate |
| Self-Production | Public release pages only when eligible; no fake DSP/store claims |
| Sway.DIO | Not a live discovery surface |

---

## Proven / likely / supporting / unknown (ecosystem)

### Proven

- JW Stone ChatGPT referral → return (~8h46m) → call is a real acquisition pattern (owner-stated; use as control).  
- Sway production robots.txt and sitemap.xml now return correct content types (live probe).  
- Sway sitemap is small; performer URLs exist; events/releases absent from live sitemap snapshot.  
- Sample Sway performer page fails full first-response contract (no H1, no JSON-LD, shell present).

### Likely contributors (Sway depth)

- Eligibility filters + sparse real published events/releases.  
- Canonical host pinned to `app.sway.tips` while humans also use apex/www.  
- SSR path emits meta/title but not full contract-grade heading/JSON-LD for all profiles.

### Supporting factors

- Existing organic discovery contract and `llms.txt`.  
- MealScout stated foundation (robots, multi-sitemaps, SSR, thin-import blocking) — needs domain/index audit, not rebuild.  
- TradeScout profile renderer foundation already exists — completeness enforcement is the work.

### Unknowns

- Live audits for TradeScout, MealScout, HomeScout, TradeComp, ScoutFitters, ID products, Skill Gaming World, 30Aplus in this pass.  
- Verified-bot vs spoofed crawler separation.  
- Whether Sway JSON-LD is conditional and simply not emitted for `/p/dj3x`.

---

## Required next phases (feature branches only)

1. **Phase 2** — Contract doc added: `docs/PUBLIC_DISCOVERY_CONTRACT_V1.md` (this branch).  
2. **Phase 3–6** — **Sway implemented on this branch (HOLD — not merged/deployed):** first-response H1 + JSON-LD passthrough fix + discovery body facts; sitemap eligibility tightened (non-private releases, titled events, lastmod); attribution (`discovery_*` + UTM first-touch + optional How did you find us?); contract tests fail on app-shell robots/sitemap and missing first-response identity facts.  
3. **Phase 7** — Fixed query matrix doc: `docs/process/PUBLIC_DISCOVERY_QUERY_MATRIX_V1.md` (results intentionally `_not run — HOLD_` until authorized deploy).  
4. Sibling repos (MealScout, TradeScoutPro, skill-gaming-world, …) need dedicated clean feature branches and live domain probes — not started beyond path discovery.

## Rollback procedure (if a bad discovery change were ever deployed)

1. Restore prior `robots.txt` / sitemap generation.  
2. Remove ineligible sitemap URLs.  
3. Re-noindex accidental publics.  
4. Record in release evidence checklist.  
5. Do **not** compensate by exposing private data.

## Stop condition

Feature branch + proof packet only. **Do not merge. Do not deploy.** Production indexing policy unchanged by this documentation pass.
