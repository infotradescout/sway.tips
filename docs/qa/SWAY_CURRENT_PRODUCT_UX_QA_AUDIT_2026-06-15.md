# Sway Current Product UX QA Audit - 2026-06-15

## Baseline

Baseline commit SHA: `d5435e0c7fbb52f43f2c6ee515fcfa52226d3ae7`

Branch at start: `main`

Production marker checked:

- `https://sway.tips/api/build-marker` returned commit `d5435e0c7fbb52f43f2c6ee515fcfa52226d3ae7`
- `https://app.sway.tips/api/build-marker` returned commit `d5435e0c7fbb52f43f2c6ee515fcfa52226d3ae7`

This audit is evidence only. No app runtime, copy, styling, schema, route, config, package, deployment, or test file changes were made.

## Commands Run

Initial repo state:

```bash
git status --short --branch
git log --oneline -5
git rev-parse HEAD
```

Source and route inspection:

```bash
rg -n "checkout|invoice|desk board|captured total|preview|Request|Tip|Boost|Pending|Approved|Playing|Up Next|Paused|Ended|disabled|coming soon|TODO|FIXME|placeholder|moderation|internal|admin|ops|operator|performer|overlay|patron" src server.ts public docs -S
rg --files src
rg -n "app\\.get|app\\.post|serve|/admin|/talent|/overlay|/api|build-marker|patron|performer|operator" server.ts src -S
rg -n "checkout|invoice|desk board|captured total|preview" src server.ts public -S
rg -n "placeholder|Phase 1 scaffold|fail-closed|Demo only|Demo data only|previewMode|data-deletion-placeholder|patron_shell_placeholder|patron_ui_placeholder|read-only status|compat|next production milestone" src server.ts -S
```

Local production-mode render checks:

```bash
npm run build
NODE_ENV=production PORT=4310 node dist/server.cjs
```

Then passive Playwright reads were run against:

- `http://127.0.0.1:4310/`
- `http://127.0.0.1:4310/g/00000000-0000-4000-8000-000000000001`
- `http://127.0.0.1:4310/talent/gigs`
- `http://127.0.0.1:4310/overlay/00000000-0000-4000-8000-000000000001`
- `http://127.0.0.1:4310/admin`

Live passive render checks:

- `https://sway.tips/`
- `https://app.sway.tips/`
- `https://app.sway.tips/g/00000000-0000-4000-8000-000000000001`
- `https://app.sway.tips/talent/gigs`
- `https://app.sway.tips/overlay/00000000-0000-4000-8000-000000000001`
- `https://app.sway.tips/admin`

## Surfaces Inspected

| Surface | Route or source | Verification level |
| --- | --- | --- |
| Public landing | `https://sway.tips/`, `shells/public.html` | Live and local passive render verified |
| Patron app | `https://app.sway.tips/`, `/g/00000000-0000-4000-8000-000000000001`, `src/shells/PatronApp.tsx`, `src/components/PatronView.tsx` | Live and local empty-state render verified; active gig flow not verified |
| Performer/operator app | `https://app.sway.tips/talent/gigs`, `src/shells/TalentApp.tsx`, `src/components/TalentDashboard.tsx` | Unauthenticated guard verified; authenticated console source inspected; authenticated render not verified |
| Overlay | `https://app.sway.tips/overlay/00000000-0000-4000-8000-000000000001`, `src/shells/OverlayApp.tsx` | Live and local empty-state render verified |
| Admin/ops | `https://app.sway.tips/admin`, `src/shells/admin/AdminOpsRuntimeCompat.tsx` | Unauthenticated guard verified; authenticated ops render not verified |

## Findings

| ID | Severity | Surface | Finding | Evidence | Recommended fix lane |
| --- | --- | --- | --- | --- | --- |
| UX-001 | High | Public landing to patron app | The primary audience CTA sends users to `https://app.sway.tips/`, which renders an empty patron shell with no active performer, request action, or recovery instruction. A new audience user can land in a dead-end state. | `shells/public.html:285` and `shells/public.html:297` link to `https://app.sway.tips/`. Live Playwright read of `https://app.sway.tips/` returned `No live records yet`, `No active performer`, `Requests 0`, `Performers 0`, and `Empty-state inspector remains visible.` | `ux/public-audience-entry-routing` |
| UX-002 | High | Public landing to protected routes | Public `Performer sign in`, `Venue sign in`, `Performer: open console`, and `Venue: operator tools` links lead unauthenticated users to raw JSON 401 responses instead of a polished sign-in, waitlist, or protected-route explanation. | Live Playwright reads of `https://app.sway.tips/talent/gigs` and `https://app.sway.tips/admin` returned status `401` with body `{"error":"Sway actor resolution required."}`. Public links are defined at `shells/public.html:305` and `shells/public.html:313`; top nav also exposes sign-in links in rendered landing text. | `ux/protected-route-auth-shells` |
| UX-003 | Medium | Patron app empty state | Patron empty state uses internal/debug-sounding labels: `Selected gig inspector`, `Empty-state inspector remains visible`, and `DJ surface`. This is production-visible on `app.sway.tips` and does not tell a patron what to do next. | Live `https://app.sway.tips/g/00000000-0000-4000-8000-000000000001` rendered `SELECTED GIG INSPECTOR`, `DJ surface`, and `Empty-state inspector remains visible.` Source: `src/shells/PatronApp.tsx:153`, `src/shells/PatronApp.tsx:182`, `src/shells/PatronApp.tsx:197`. | `copy/patron-empty-state-public-language` |
| UX-004 | Medium | Patron app request/tip/boost clarity | The live empty patron shell says `Request, Tip, and Boost live`, but the primary pane is replaced by an empty state and exposes no request, tip, boost, scan-again, or performer-selection action. The claim and visible affordances do not match in the no-session state. | Live patron route body included `Request, Tip, and Boost live` and `No live records yet`; no buttons were present in the passive Playwright button list. Source: `src/shells/PatronApp.tsx:136`, `src/shells/PatronApp.tsx:154` through `src/shells/PatronApp.tsx:160`. | `ux/patron-no-session-recovery` |
| UX-005 | Medium | Admin/ops | Admin/ops source still contains compatibility/demo-frame copy such as `Operations overview`, `Read-only status is shown here until operator access is available`, and `Operator features remain unavailable until authentication, audit logs, and persistent ledgers are implemented.` This may be acceptable as fail-closed behavior, but it should be intentionally productized before authenticated ops users see it. | Source references: `src/shells/admin/AdminOpsRuntimeCompat.tsx:5` through `src/shells/admin/AdminOpsRuntimeCompat.tsx:9`, and `src/shells/admin/AdminOpsRuntimeCompat.tsx:58` through `src/shells/admin/AdminOpsRuntimeCompat.tsx:64`. Authenticated admin render was not verified. | `copy/admin-ops-authenticated-empty-state` |
| UX-006 | Medium | Performer/operator app | Performer source mixes `Performer Console` with `Operator App` as the eyebrow. That may confuse performer vs operator ownership on the talent surface. | `src/shells/TalentApp.tsx:157` sets title `Performer Console`; `src/shells/TalentApp.tsx:158` sets eyebrow `Operator App`. Authenticated performer render was not verified. | `copy/performer-operator-terminology-alignment` |
| UX-007 | Medium | Patron deeper flow copy | The patron component still uses `checkoutPayload` and `initiateCheckout` internally and renders confirmation modal copy such as `Confirm Request`, `Confirm Boost`, and `Send Request`. The forbidden term `checkout` did not appear in the verified empty live render, but the deeper request flow still carries checkout-language implementation and should be reviewed when active-gig QA is possible. | Source references: `src/components/PatronView.tsx:162`, `src/components/PatronView.tsx:480`, `src/components/PatronView.tsx:1736` through `src/components/PatronView.tsx:1841`. Active request flow was not verified. | `qa/active-gig-request-tip-boost-copy` |
| UX-008 | Low | Overlay | Overlay empty state is clear but very thin: `Waiting for gig requests...` with no room, performer, paused, or ended context. This is safe, but not very informative for a production display when no queue exists. | Live overlay route rendered `SWAY LIVE ROOM`, `LIVE GIG FEED`, and `Waiting for gig requests...`. Source: `src/shells/OverlayApp.tsx:59` through `src/shells/OverlayApp.tsx:62`. | `copy/overlay-empty-state-context` |
| UX-009 | Low | Public landing | Landing footer claims `Live tips and request moderation run on session state.` This is directionally true for implemented session state, but the public page has no evidence path to an active session from the default audience CTA. It amplifies UX-001. | Live public landing rendered the footer sentence. Source: `shells/public.html:337` through `shells/public.html:340`. | Include in `ux/public-audience-entry-routing` |
| UX-010 | Low | Mobile terminology and style | Some source-visible labels still use non-public or implementation-ish words such as `previewMode`, `placeholder`, `Phase 1 scaffold`, and `fail-closed`. Not all are production-rendered in the verified no-session path, but they are risk markers for deeper panels and authenticated surfaces. | Search evidence includes `src/shells/PatronAppShell.tsx:9`, `src/shells/PerformerAppShell.tsx:9`, `src/shells/OperatorAppShell.tsx:9`, `src/shells\AdminOpsShell.tsx:9`, `server.ts:1666`, and `src/shells/PatronApp.tsx:113`. | `copy/deeper-panel-cleanup` |

## Evidence Notes

- Live public landing at `https://sway.tips/` returned status `200` and rendered the flow language `Request -> Tip -> Boost -> Pending -> Approved -> Up Next -> Playing`.
- Live `https://app.sway.tips/` returned status `200` but rendered an empty patron shell with no actionable buttons.
- Live patron gig route `/g/00000000-0000-4000-8000-000000000001` returned status `200` and the same empty patron shell.
- Live performer route `/talent/gigs` returned status `401` with `{"error":"Sway actor resolution required."}`.
- Live admin route `/admin` returned status `401` with `{"error":"Sway actor resolution required."}`.
- Live overlay route returned status `200` and rendered `Waiting for gig requests...`.
- Live marker endpoints verified that these observations were against commit `d5435e0c7fbb52f43f2c6ee515fcfa52226d3ae7`.
- Local production-mode checks on port `4310` matched the live route behavior for the inspected public, patron, overlay, performer unauthenticated, and admin unauthenticated surfaces.

## Not Verified

- Authenticated performer console behavior was not verified because the local and live QA contexts did not include a persisted performer actor.
- Authenticated admin/ops behavior was not verified because the local and live QA contexts did not include a persisted admin/support actor.
- Active gig request creation was not verified because no live production gig ID with an active session was provided.
- Request payment confirmation, Stripe card confirmation, authorization, capture, and refund behavior were not verified.
- Boost submission flow was not verified because no approved request existed in the verified sessions.
- Moderation report/block/hide/remove flows were not exercised.
- Mobile visual overlap was not screenshot-verified beyond passive mobile viewport text/button/link extraction.
- Cross-browser checks beyond Chromium were not performed.
- Production deployment timing beyond the marker endpoints was not independently verified.

## Recommended Fix Lanes

| Priority | Lane | Scope |
| --- | --- | --- |
| 1 | `ux/public-audience-entry-routing` | Make public audience CTAs route to a usable scan/gig path, a clear no-active-gig explainer, or a performer discovery state. |
| 2 | `ux/protected-route-auth-shells` | Replace raw JSON 401 for user-facing `/talent/gigs` and `/admin` browser routes with polished sign-in or protected-state shells while preserving API guard semantics. |
| 3 | `copy/patron-empty-state-public-language` | Rewrite patron no-session inspector copy into public language with clear next actions. |
| 4 | `ux/patron-no-session-recovery` | Add or expose no-session recovery actions without changing request/payment behavior. |
| 5 | `copy/performer-operator-terminology-alignment` | Clarify performer vs operator labels in the talent surface. |
| 6 | `copy/admin-ops-authenticated-empty-state` | Productize authenticated admin/ops empty and locked states. |
| 7 | `qa/active-gig-request-tip-boost-copy` | Run a seeded active-gig QA pass for request, tip, boost, pending, approved, and playing copy. |
| 8 | `copy/overlay-empty-state-context` | Improve overlay empty-state context for room displays. |
| 9 | `copy/deeper-panel-cleanup` | Continue scanning deeper panels for placeholder, preview, demo, scaffold, and internal language. |

## Confirmation

No runtime code was changed.

No production behavior was changed.

This audit produced only this markdown evidence file.
