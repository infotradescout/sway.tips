# Sway Surface Split Architecture Plan

Status: Phase 0 planning and contract guard only.

This plan defines the surface boundaries Sway must move toward without changing production UI in this slice. Phase 0 does not delete routes, refactor components, configure Stripe, introduce live payment logic, or weaken existing guards. It is a build-order document for turning the current route/shell split into distinct product surfaces while preserving Sway's existing visual identity and behavior.

## Boundary Law

Sway must be split into physically isolated shell components:

- PublicWebShell
- PatronAppShell
- PerformerAppShell
- OperatorAppShell
- OverlayShell
- AdminOpsShell

These shell boundaries must be real files and entrypoints, not role-conditionals inside one primary wrapper. Patron App and Operator App must not share the same primary shell wrapper. A shared utility component such as SplitViewShell may continue to exist only as layout chrome; it must not become a god shell that owns Patron App and Operator App behavior, routing, mutations, or role branches.

Future implementation must reject any design where Patron App, Performer/DJ App, Operator App, Overlay, and Admin/Ops are implemented as branches inside one god-component. Compatibility code in the legacy App route spine may remain until replaced by isolated shell entrypoints, but it must not receive new product-surface behavior.

## Current Route And Shell Reality

Current server routing resolves host and path into shell families:

- Apex `sway.tips` and `www.sway.tips` at `/` or `/home` resolve to the public HTML layer.
- `app.sway.tips` at `/` or `/home` resolves to the patron shell.
- `/g/:gigId` and `/p/:performerHandle` resolve to the patron shell.
- `/talent/login` and `/talent/gigs/:gigId?` resolve to the talent shell.
- `/overlay/:gigId` resolves to the overlay shell.
- `/admin` resolves to the admin shell.

Current entrypoints and components:

- Public web: `shells/public.html`.
- Patron app: `src/entries/patron.tsx`, `src/shells/PatronApp.tsx`, `src/components/PatronView.tsx`.
- Performer/DJ app: `src/entries/talent.tsx`, `src/shells/TalentApp.tsx`, `src/components/TalentDashboard.tsx`, `src/components/VictoryScreen.tsx`.
- Operator app: currently partially represented by `src/shells/AdminApp.tsx` and `/admin` demo/operator copy.
- Overlay: `src/entries/overlay.tsx`, `src/shells/OverlayApp.tsx`.
- Shared state/types: `src/shells/shared.tsx`, `src/types.ts`, `src/demo-mode.tsx`.
- Legacy compatibility spine: `src/App.tsx`.

## Target Route Structure

Do not delete old routes in Phase 0. Target routes should be introduced with compatibility redirects or aliases only after shell isolation contracts are in place.

| Surface | Current routes | Target routes | Shell |
| --- | --- | --- | --- |
| Public Web Layer | `/` and `/home` on `sway.tips` / `www.sway.tips` | `/`, `/room/:roomId` entry CTA as public/patron handoff | PublicWebShell |
| Patron App | `/g/:gigId`, `/p/:performerHandle`, app-host `/home` | `/app`, `/patron`, `/room/:roomId` handoff where appropriate | PatronAppShell |
| Performer/DJ App | `/talent/login`, `/talent/gigs/:gigId?` | `/performer`, `/dj`, keep `/talent/*` compatibility | PerformerAppShell |
| Operator App | currently `/admin` demo/operator surface | `/operator`, venue/staff room control | OperatorAppShell |
| Overlay | `/overlay/:gigId` | `/overlay/:roomId` while preserving `/overlay/:gigId` | OverlayShell |
| Admin/Ops | currently mixed into `/admin` | `/admin`, `/ops` for internal config, diagnostics, provider/payment fail-closed state, logs | AdminOpsShell |

## Surface Map

### Public Web Layer

- Route(s): current `/` and `/home` on public hosts; target `/` plus `/room/:roomId` entry handoff.
- Current component(s): `shells/public.html`.
- Intended audience: new visitors and public requesters.
- Primary action: enter a Live Room or start a request flow.
- Secondary actions: open performer console, venue/operator sign-in, overlay display link.
- Role/access assumptions: public read-only entry; authenticated app behavior must not live here.
- Shared state dependencies: none for static landing; future room handoff may read public room metadata only.
- Current clutter/confusion: landing uses separate inline CSS tokens from app shell classes.
- Must-not-remove capabilities: social metadata, first-viewport request CTA, performer/venue entry links, request flow explanation.
- Terminology requirements: Demo, Live Room, Patron App, Operator App, Request, Tip, Boost, Pending, Approved, Playing, Up Next, Paused, Ended.
- Style/color preservation requirements: preserve dark room feel, glow/contrast, rhythm, current button treatment, and live-room energy.

### Patron App

- Route(s): current `/g/:gigId`, `/p/:performerHandle`, app-host `/home`; target `/app`, `/patron`, and room handoff routes.
- Current component(s): `src/shells/PatronApp.tsx`, `src/components/PatronView.tsx`, legacy `src/App.tsx` branches.
- Intended audience: returning patrons/requesters.
- Primary action: create a Request, Tip, or Boost for a Live Room.
- Secondary actions: track Pending, Approved, Playing, Up Next, Paused, and Ended state; report/block/support/data deletion placeholders.
- Role/access assumptions: public patron access is allowed for QR routes; patron actions must remain gated by route gig id, idempotency, and fail-closed money behavior.
- Shared state dependencies: `BackendState`, `GigSession`, `RequestItem`, demo fixture state, `/api/state`, request/boost/moderation endpoints.
- Current clutter/confusion: request, tip, queue, discover, moderation, and confirmation overlays all sit in one large view.
- Must-not-remove capabilities: Request, Tip, Boost, degraded-network state, idempotency reconciliation, report/block/support/data deletion placeholders, no payment success before backend confirmation.
- Terminology requirements: use Patron App, Demo, Live Room, Request, Tip, Boost, Pending, Approved, Playing, Up Next, Paused, Ended.
- Style/color preservation requirements: keep slate/fuchsia/cyan live-room treatment, glow accents, compact controls, dark panels, and current button hierarchy.

### Performer/DJ App

- Route(s): current `/talent/login`, `/talent/gigs/:gigId?`; target `/performer` and `/dj` with `/talent/*` compatibility.
- Current component(s): `src/shells/TalentApp.tsx`, `src/components/TalentDashboard.tsx`, `src/components/VictoryScreen.tsx`.
- Intended audience: DJs and performers.
- Primary action: approve/manage requests and control Playing/Up Next.
- Secondary actions: start/end/closeout room, pause submissions, open call/manual mode, mark Playing, hide/remove unsafe requests.
- Role/access assumptions: protected performer routes must preserve persisted role/access guards and must not rely on client routing as a security boundary.
- Shared state dependencies: `BackendState`, `GigSession`, `RequestItem`, `/api/session/*`, `/api/request/triage`, `/api/request/fulfill`, moderation endpoints.
- Current clutter/confusion: performer setup, request triage, room controls, visibility boost activity, and closeout live in one dashboard.
- Must-not-remove capabilities: pause/end submission blocks, request window controls, manual Boost approval gates, closeout gate, moderation placeholders.
- Terminology requirements: Performer/DJ App, Request, Tip, Boost, Pending, Approved, Playing, Up Next, Paused, Ended.
- Style/color preservation requirements: keep dense operator-console feel, high-contrast cards, fuchsia/cyan/amber status colors, and glow emphasis for live state.

### Operator App

- Route(s): current operator-like demo exists under `/admin`; target `/operator`.
- Current component(s): `src/shells/AdminApp.tsx` demo surface only.
- Intended audience: operator, venue, and staff roles.
- Primary action: room control and request lifecycle oversight.
- Secondary actions: moderation queue, state repair, identity review, support actions.
- Role/access assumptions: must use persisted admin/support/operator authorization; no client-only authority checks.
- Shared state dependencies: room state, request lifecycle state, moderation records, audit events, role/access state.
- Current clutter/confusion: `/admin` currently mixes operator-facing demo copy with internal admin authority language.
- Must-not-remove capabilities: durable audit requirement, operator mutation routes disabled until auth/audit/ledgers are implemented, moderation/report/block/hide/remove placeholders.
- Terminology requirements: Operator App, Request lifecycle, Demo data, Live Room, Pending, Approved, Playing, Up Next, Paused, Ended.
- Style/color preservation requirements: use the same dark/glow visual language as the core app while reading as a work console, not a public landing page.

### Overlay

- Route(s): current `/overlay/:gigId`; target `/overlay/:roomId` while preserving compatibility.
- Current component(s): `src/shells/OverlayApp.tsx`, legacy `src/App.tsx` overlay branch.
- Intended audience: displays, screens, and streams.
- Primary action: display Now Playing and Up Next.
- Secondary actions: show Boost/Tip activity and room state.
- Role/access assumptions: display-only; public overlay access may remain explicit or token-gated by rule, but overlay must not mutate state.
- Shared state dependencies: `BackendState`, approved/fulfilled requests, demo fixture state, `/api/state`.
- Current clutter/confusion: route names still use gig id while target language should be room oriented.
- Must-not-remove capabilities: transparent display, Now Playing, Up Next, Demo data banner, no control buttons.
- Terminology requirements: SWAY LIVE ROOM, Now Playing, Up Next, Demo data, Request, Tip, Boost.
- Style/color preservation requirements: keep transparent display, fuchsia/cyan glow, high contrast, compact readable cards for screens.

### Admin/Ops

Parity extraction closeout reference: see `docs/SWAY_ADMIN_OPS_PARITY_EXTRACTION_CLOSEOUT.md`.

- Route(s): current `/admin`; target `/admin` and `/ops`.
- Current component(s): currently not physically distinct from `src/shells/AdminApp.tsx`.
- Intended audience: internal administrators and operations.
- Primary action: configuration, diagnostics, provider/payment fail-closed state, logs.
- Secondary actions: audit review, deployment/build-marker checks, support diagnostics.
- Role/access assumptions: protected admin/support access backed by persisted schema; never route-only security.
- Shared state dependencies: audit logs, payment provider status, build marker, diagnostics, role/access state.
- Current clutter/confusion: internal admin and venue/operator control need separate shells.
- Must-not-remove capabilities: provider-disabled/fail-closed payment state visibility, audit logging requirement, persistent ledger requirement.
- Terminology requirements: Admin/Ops, provider/payment fail-closed state, logs, Request lifecycle where applicable.
- Style/color preservation requirements: quiet internal console using the same tokens, typography, cards, and live-room contrast.

## Styling And Token Rules

PublicWebShell must consume the same CSS variables/tokens as the core app. Phase 1 should consolidate the public HTML inline variables with the app stylesheet, preserving or mapping the Sway token set:

- `--night` for the deep room background currently expressed as slate/near-black values.
- `--rose` for fuchsia/rose action energy.
- `--mint` for live/pulse success energy.
- Existing app classes and effects such as `bg-slate-950`, `text-slate-100`, `text-fuchsia-400`, `text-cyan-400`, `glow-fuchsia`, `glow-cyan`, `bg-glass`, `glass-panel`, `auction-gradient`, `grid-bg`, `font-display`, `font-sans`, and `font-mono`.

Shared styling must preserve:

- color tokens
- typography
- button styles
- cards/panels
- live-room glow/energy
- dark-first assumptions
- high-contrast status treatment

Landing alignment rules:

- The landing must visually match Sway app colors/style.
- The landing must not look like a generic SaaS page.
- Generic SaaS UI libraries/templates are forbidden.
- The first viewport must drive to Enter Live Room, Start a Request, or Open App.
- The landing must preserve Sway visual identity, color system, glow/contrast, typography rhythm, button treatment, and live-room energy.

## Execution Discipline

Phase 0 must not:

- delete existing routes
- alter functional production UI components
- configure Stripe
- introduce live payment logic
- remove pause/end submission blocks
- remove manual Boost approval gates
- weaken access/role guards
- use client routing as a security boundary
- change product scope
- ship demo data in production paths

payment behavior must remain fail-closed when provider/env is missing. This plan does not authorize payment implementation. Overlay remains display-only. Public web remains separate from authenticated or returning-user app surfaces.

## Phase Order

1. Document and contract the six-surface model.
2. Add shell files and entrypoint names without changing behavior.
3. Move current shell-specific code into the physical shells.
4. Introduce route aliases only after contracts prove old routes remain intact.
5. Split Operator App from Admin/Ops after persisted access and audit requirements are available.
6. Retire legacy compatibility branches only after parity tests prove no capabilities were removed.
