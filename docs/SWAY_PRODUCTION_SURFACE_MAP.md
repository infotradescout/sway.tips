# Sway Production Surface Map

Date: 2026-06-14

## Decision

AUDIT HOLD - SURFACE MAP COMPLETE

This document is an audit artifact only. It makes no production readiness claim, no App Store readiness claim, and no feature-completion claim.

Product work remains frozen until the P0/P1 backlog below is accepted and sequenced.

## Current Production Truth

Intended current production commit:

```text
df1d44a9dd34ce871247e1262b061cc515b060e0
```

Prior verified commit:

```text
3c693004515839d29fd3ad0a431d72eff8a51451
```

Reconciliation:

```text
df1d44a... intentionally superseded 3c6930... through the deeper panel copy cleanup deploy.
```

Local audit-hold commit:

```text
ca3bc0928f03f0126558d4cf806cfad480bde83f
```

Push status at audit start:

```text
main...origin/main [ahead 1]
```

The local docs-only audit-hold commit is intentionally not pushed during freeze because pushing `main` would trigger another production marker change.

## Production Marker Results

All checked marker endpoints returned:

```text
commit: df1d44a9dd34ce871247e1262b061cc515b060e0
branch: main
buildTimestamp: 2026-06-14T20:08:00.509Z
nodeEnv: production
```

| Endpoint | Result | Commit |
| --- | ---: | --- |
| `https://sway.tips/api/build-marker` | `200 OK` | `df1d44a9dd34ce871247e1262b061cc515b060e0` |
| `https://www.sway.tips/api/build-marker` | `200 OK` after redirect handling | `df1d44a9dd34ce871247e1262b061cc515b060e0` |
| `https://app.sway.tips/api/build-marker` | `200 OK` | `df1d44a9dd34ce871247e1262b061cc515b060e0` |
| `https://sway-tips.onrender.com/api/build-marker` | `200 OK` | `df1d44a9dd34ce871247e1262b061cc515b060e0` |

Route responses also include:

```text
x-commit-sha: df1d44a9dd34ce871247e1262b061cc515b060e0
x-sway-build: df1d44a9dd34ce871247e1262b061cc515b060e0:2026-06-14T20:08:00.509Z
```

## Route Inventory

Server shell routing is defined in `server.ts`:

| Route or host | Shell | Notes |
| --- | --- | --- |
| `sway.tips/` | public | Static public landing shell. |
| `www.sway.tips/` | public via redirect to apex | `HEAD` returned `301` to `https://sway.tips/`; redirected `GET` returned public shell. |
| `app.sway.tips/` | patron | App subdomain root routes to patron shell. |
| `/home` | public on apex, patron on `app` | Host-dependent behavior. |
| `/g/:gigId` | patron | Audience request/tip/boost route. |
| `/p/:performerHandle` | patron | Performer handle route into patron experience. |
| `/talent/login` | talent | Login placeholder/shell message. |
| `/talent/gigs` | talent | Performer console. |
| `/admin` | admin | Operator/admin protected shell copy. |
| `/overlay/:gigId` | overlay | Room display. |
| `/dev/sandbox` | dev-sandbox | Disallowed in production by `isShellAllowed`. |
| unknown non-API route | patron by server default | React app may show not-found only inside some shell paths. |

API routes observed in `server.ts`:

| Area | Routes |
| --- | --- |
| Health/build | `GET /api/health/network-probe`, `GET /api/build-marker` |
| State | `GET /api/state`, `POST /api/pending-action/reconcile` |
| Session | `POST /api/session/start`, `feature`, `end`, `closeout`, `window/toggle`, `mode`, window preset activate/create/delete |
| Request | `POST /api/request/create`, `boost`, `triage`, `fulfill` |
| Payment | `POST /api/payment/webhook` |
| Safety | `POST /api/moderation/report`, `block`, `hide`, `remove`, `GET /api/moderation/placeholders` |
| Support/privacy | `GET /api/support/contact`, `POST /api/privacy/data-deletion-placeholder` |
| Music | `POST /api/music/search` |

## Live Route Behavior

| URL | Status | Type | Live observation |
| --- | ---: | --- | --- |
| `https://sway.tips/` | `200` | `text/html` | Public landing page. |
| `https://www.sway.tips/` | `301` to apex on `HEAD`; `200` after redirect on `GET` | `text/html` | Canonical behavior appears apex-oriented. |
| `https://app.sway.tips/` | `200` | `text/html` | Patron app shell with visible demo data. |
| `https://app.sway.tips/home` | `200` | `text/html` | Patron app shell with visible demo data. |
| `https://sway.tips/g/00000000-0000-4000-8000-000000000001` | `200` | `text/html` | Patron app shell with visible demo data. |
| `https://app.sway.tips/g/00000000-0000-4000-8000-000000000001` | `200` | `text/html` | Patron app shell with visible demo data. |
| `https://sway.tips/p/aria-neon` | `200` | `text/html` | Patron app shell. |
| `https://sway.tips/talent/login` | `200` | `text/html` | Talent login shell message. |
| `https://sway.tips/talent/gigs` | `200` | `text/html` | Performer console with visible demo data. |
| `https://sway.tips/admin` | `200` | `text/html` | Operator overview with visible demo data. |
| `https://sway.tips/overlay/00000000-0000-4000-8000-000000000001` | `200` | `text/html` | Overlay with visible demo data. |
| `https://sway.tips/metadata.json` | `200` | `text/html` | Serves app shell HTML, not JSON metadata. |
| `https://sway.tips/robots.txt` | `200` | `text/html` | Serves app shell HTML, not robots text. |
| `https://sway.tips/sitemap.xml` | `200` | `text/html` | Serves app shell HTML, not sitemap XML. |

## Screenshot Capture Summary

Headless screenshots were captured in memory for desktop `1365x768` and mobile `390x844`; no image files were written.

| Surface | Desktop screenshot hash | Mobile screenshot hash | Text finding |
| --- | --- | --- | --- |
| Public landing | `37570c80a9bb3fe6` | `5f31a699a26c4364` | Explains live requests and tipping. |
| App root | `b6a93d6238b97398` | `c77f1656e0a27bab` | Shows `DEMO DATA`, Aria Neon, Midnight City. |
| App `/home` | `98e42d6aa0cf6995` | `5dfe8a997957bdf4` | Shows same demo patron surface. |
| Patron gig | `98fa9276a807b90d` | `da62e6cce3422300` | Shows same demo patron surface. |
| Talent gigs | `111f6f56e82c508a` | `c04aec62899d3e32` | Shows `DEMO DATA`, Aria Neon, Midnight City. |
| Admin | `8b2fa9b4a1e69cdc` | `d41baa267eb44ca6` | Shows `DEMO DATA` and protected operator overview. |
| Overlay | `d4be3878f4051df2` | `1b08ba9e68687e7a` | Shows `DEMO DATA` and Midnight City. |

## Public Marketing Surface Inventory

Public landing source: `shells/public.html`.

Current strengths:

- Title and meta copy clearly say `Sway | Live Crowd Requests`.
- H1 and supporting copy explain crowd requests, tips, performer approval, queue movement, and overlay.
- The page has role-based cards for crowd, performers, and venues.
- Open Graph and Twitter image metadata are present.

Current concerns:

- Primary CTA links to the hardcoded demo gig id `00000000-0000-4000-8000-000000000001`.
- Footer copy says live tips and request moderation run on session state, but the linked app surfaces currently render demo data.
- The product still relies heavily on the single word `Sway`; metadata does add category context, which helps.
- Legal, privacy, support, terms, and data deletion policy links are not visible on the public landing.

## App Surface Inventory

| Surface | Main user | Primary action | Current state |
| --- | --- | --- | --- |
| Patron app | Audience/patron | Request, tip, boost, report/block/support/data deletion | Public production route currently shows demo data and read-only demo behavior. |
| Talent app | Performer/operator | Start session, manage requests, approve/deny, fulfill, hide/remove | Public production route currently shows demo data and disabled demo actions. |
| Admin app | Venue/operator/admin | Inspect safety queue, request lifecycle, identity checks | Shows protected/read-only overview, but also visible `DEMO DATA`. |
| Overlay | Room display | Show now playing and up next | Public production route currently shows demo data. |
| Talent login | Performer | Continue to gigs | Copy says auth is next production milestone; this is public-facing roadmap language. |

## Panel And Deeper Surface Inventory

Patron deeper panels:

- Performer branding hero with demo/live disclaimer.
- Room layer with Now Playing, Live Now, Manual/Open Call, Up Next.
- Safety Controls with Report, Block, Support / Contact, Data Deletion Request.
- Moderation/status timeline: `pending_review`, `approved`, `declined`, `hidden`, `blocked`, `played/completed`.
- Request Track, Tip Only, Boost and checkout confirmation surfaces.
- Empty/search surfaces and pending-action recovery messages.

Talent deeper panels:

- Session setup, active session controls, closeout timer.
- Request window and operating mode controls.
- Pending triage queue with Hide, Reject, Approve.
- Approved queue and Mark Playing.
- Visibility boost and Performance Meter panels.
- Victory/closed-session summary.

Admin deeper panels:

- Operations overview.
- Safety queue.
- Request lifecycle.
- Identity checks.
- Authority Boundary.

Overlay deeper panels:

- Now Playing.
- Up Next queue.
- Empty state: `Waiting for gig requests...`.

## Empty, Loading, And Error State Inventory

| State | Source | Current copy | Risk |
| --- | --- | --- | --- |
| Shared loading | `src/shells/shared.tsx` | `Synchronizing Sway live ledger...` | P2: "ledger" may imply durable financial state before user context. |
| Patron empty state | `src/shells/PatronApp.tsx` | `No live records yet` | P2: acceptable but abstract. |
| Talent empty state | `src/shells/TalentApp.tsx` | `No active session yet` | P3: clear. |
| Admin empty state | `src/shells/admin/AdminOpsRuntimeCompat.tsx` | `No operator records are available yet.` | P2: acceptable but internal/operator-focused. |
| Overlay empty state | `src/shells/OverlayApp.tsx` | `Waiting for gig requests...` | P3: clear. |
| Talent login shell | `src/shells/TalentApp.tsx` | `Account authentication is the next production milestone...` | P1: public roadmap/internal milestone language. |
| App not found | `src/App.tsx` | `Use /talent/login, /talent/gigs...` | P1: exposes route-spine/internal documentation language. |
| Demo mutation rejection | `src/shells/PatronApp.tsx`, `src/shells/TalentApp.tsx` | `Demo data is read-only. No backend mutation was sent.` | P1/P2: safe but visibly non-production if exposed. |

## Metadata, SEO, And Social Preview Inventory

| Item | Current state | Risk |
| --- | --- | --- |
| Public title | `Sway | Live Crowd Requests` | Good category disambiguation. |
| Public description | Present and specific. | Good. |
| Public OG/Twitter | Present with image, dimensions, alt text. | Good. |
| App shell titles | `Sway Patron`, `Sway Talent`, `Sway Admin`, `Sway Overlay` | P2: thin if indexed/shared directly. |
| `metadata.json` | Local file exists, but production URL serves HTML. | P1: nonfunctional public metadata URL. |
| `robots.txt` | Production URL serves HTML. | P1: indexing intent unclear. |
| `sitemap.xml` | Production URL serves HTML. | P2: missing sitemap if public pages expand. |
| Canonical | No canonical link found in public shell. | P2: add explicit apex canonical. |
| Favicons | No favicon links observed. | P3/P2 depending launch bar. |

## Header And Security Signal Inventory

Observed on apex, app, and Render origin:

```text
cache-control: no-store, must-revalidate, proxy-revalidate, no-cache
x-commit-sha: df1d44a9dd34ce871247e1262b061cc515b060e0
x-sway-build: df1d44a9dd34ce871247e1262b061cc515b060e0:2026-06-14T20:08:00.509Z
```

Not observed on checked HTML responses:

```text
strict-transport-security
content-security-policy
x-frame-options
x-content-type-options
referrer-policy
permissions-policy
```

Security/trust notes:

- Build marker and headers expose commit SHA by design. This is operationally useful but should be an explicit release-process decision.
- `www` returns a platform redirect without app build headers on the redirect response. This is acceptable if documented, but marker verification should follow the redirect.
- No CSP/HSTS/referrer/permissions headers were observed during this pass.

## Accessibility Risk Inventory

Read-only smoke findings:

- Public landing has 9 focusable elements on both desktop and mobile.
- Patron app has 22 focusable elements on both desktop and mobile.
- Talent app has 15 focusable elements on both desktop and mobile.
- Admin and overlay have 0 focusable elements in the captured state.

Risks:

- P1: No keyboard walkthrough was completed, so focus order, visible focus, and dialog/payment flow operability are unproven.
- P1: Icon-only overlay/open controls need accessible names verified; some use `title`, but screen reader quality is unproven.
- P2: Dense patron/talent panels may have crowded tap targets on mobile.
- P2: Contrast was not measured; the dark neon palette needs WCAG contrast verification.
- P2: Motion/animation exists in live UI; reduced-motion behavior is unverified.

## Trust And Copy Risk Inventory

| Severity | Finding | Evidence |
| --- | --- | --- |
| P0 | Production app routes expose demo data as the primary app experience. | App root, patron gig, talent gigs, admin, and overlay all show `DEMO DATA` in live production screenshots/text. |
| P0 | Public landing CTAs route users into the hardcoded demo gig. | `shells/public.html` links to `/g/00000000-0000-4000-8000-000000000001` and `/overlay/00000000-0000-4000-8000-000000000001`. |
| P1 | Auth/login copy exposes roadmap state. | `Account authentication is the next production milestone...`. |
| P1 | Not-found route exposes internal route spine. | `Use /talent/login, /talent/gigs...`. |
| P1 | Metadata/robots/sitemap URLs serve HTML app shells. | Live checks returned `text/html` for all three. |
| P1 | Security headers are sparse. | No HSTS/CSP/nosniff/referrer/permissions headers observed. |
| P2 | App shell titles are thin for SEO/share context. | `Sway Patron`, `Sway Talent`, etc. |
| P2 | "Ledger" loading copy may overstate financial durability to users. | Shared loading state. |
| P2 | Commit SHA exposure is not yet documented as a threat-model decision. | Build marker/header behavior. |
| P3 | Public landing copy is generally clear but should add legal/trust links before launch. | No privacy/terms/support links observed. |

## P0/P1/P2/P3 Backlog

P0:

- Decide whether live app routes should ever render demo data. If not, disable demo fixture publication and demo-mode runtime in production app routes.
- Replace public landing hardcoded demo CTAs with either real session creation/onboarding or a clearly labeled demo path that cannot be mistaken for production.
- Prove one non-demo production journey before any readiness claim: patron request -> performer triage -> approved/up next -> playing -> overlay update.

P1:

- Add real `robots.txt` and make `metadata.json` either intentionally unavailable or valid JSON.
- Add/verify `sitemap.xml` strategy if public indexable pages matter.
- Replace public roadmap/internal copy in talent login and not-found surfaces.
- Add baseline security headers: HSTS, CSP, `X-Content-Type-Options`, Referrer-Policy, Permissions-Policy, and frame policy.
- Run keyboard-only walkthrough for public, patron, talent, admin, and overlay states.

P2:

- Add canonical link to apex public landing.
- Improve app shell titles/descriptions for direct route sharing.
- Add privacy, terms, support, and data deletion links to public/trust surfaces.
- Decide whether build marker/header commit exposure remains public.
- Run contrast and tap-target checks on mobile patron/talent panels.

P3:

- Polish empty-state specificity once production/demo route strategy is settled.
- Tighten public footer copy after legal/trust links exist.
- Add analytics event map only after the main product action is stable.

## Recommended Next Three Implementation Slices

1. `prod/demo-route-boundary`
   - Goal: prevent production routes from looking like demo/test flows unless explicitly launched as a labeled demo.
   - Includes: demo-mode env audit, public CTA routing decision, fixture publication decision, contract update.

2. `public/trust-and-discovery-basics`
   - Goal: make public URLs and search/share surfaces intentional.
   - Includes: robots, metadata URL behavior, sitemap decision, canonical, privacy/terms/support links, app route titles.

3. `security/accessibility-smoke-hardening`
   - Goal: add baseline response headers and verify keyboard/focus/contrast risks on the main route set.
   - Includes: headers, keyboard walkthrough, focus states, contrast/tap-target fixes.

## Audit Validation Commands

Commands run:

```text
git status --short --branch
git log -3 --oneline --decorate
git fetch origin
git log --oneline --decorate -n 12 origin/main
git show --stat --oneline 3c693004515839d29fd3ad0a431d72eff8a51451..df1d44a9dd34ce871247e1262b061cc515b060e0
git branch --contains df1d44a9dd34ce871247e1262b061cc515b060e0 --all
rg route/copy/metadata/header searches across source files
Invoke-WebRequest marker, route, metadata, robots, sitemap, and header checks
Playwright headless screenshot/text/focusable-count capture without writing image files
npm run audit:contracts
git diff --check
```

## Non-Goals

This slice did not:

- change runtime code
- change routes
- change schema
- change money behavior
- change persistence behavior
- change role/access behavior
- change AI behavior
- change moderation behavior
- push `main`
- claim production or App Store readiness
