# Sway Restart Truth Map

## Product Lock

Sway is a simple app for one live loop:

1. Audience joins a live performer or DJ room.
2. Audience pays to send a song request or tip.
3. Performer or DJ manages the queue.

If a file, route, or doc does not help that loop, it is not core product scope.

## Keep

These areas align with the actual product and should form the restart base:

- Public audience and performer entry:
  - `shells/public.html`
  - `src/components/TalentLoginCard.tsx`
  - `src/components/TalentSignupCard.tsx`
- Audience room flow:
  - `src/shells/PatronApp.tsx`
  - `src/components/PatronView.tsx`
  - `/g/:gigId`
  - `/p/:performerHandle`
- Performer room flow:
  - `src/shells/TalentApp.tsx`
  - `src/components/TalentDashboard.tsx`
  - `src/components/PerformerShareKit.tsx`
  - `/talent/login`
  - `/talent/signup`
  - `/talent/gigs`
- Durable auth and performer identity:
  - `src/server/performer-login.ts`
  - `src/server/performer-password-auth.ts`
  - `src/server/performer-session-store.ts`
  - `src/server/performer-login-mailer.ts`
- Durable business and payment foundations:
  - `src/db/schema.ts`
  - `src/server/business-store.ts`
  - `src/server/idempotency-store.ts`
  - `src/server/payment-service.ts`
  - `src/server/payment-lifecycle.ts`
  - `src/server/payment-provider.ts`
  - `src/server/payment-webhook.ts`
- Core server routes in `server.ts`:
  - performer signup/login/session routes
  - audience state routes
  - request/tip/boost routes
  - performer queue/session routes

## Quarantine

These areas may stay in the repo for now, but they should be treated as internal or legacy rather than product-defining:

- `/admin` route family
- `src/shells/AdminApp.tsx`
- `src/shells/AdminOpsRuntime.tsx`
- `src/shells/AdminOpsShell.tsx`
- `src/shells/admin/**`
- `src/shells/OperatorAppShell.tsx`
- `src/shells/OperatorRuntime.tsx`
- `src/shells/operator/**`
- admin/operator fallback and access-control copy that is not part of the public story
- admin/operator extraction docs and parity plans

Rule: quarantine code must not shape public copy, onboarding, or the marketed product story.

## Cut Or Rewrite First

These are the first places that should stop telling the wrong story:

- Public landing copy that mentions venues or operator tools
- Top-level docs that describe venues as a core user
- README/product spine language that broadens beyond audience + performer/DJ
- Any support-style auth wording that sounds like the primary sign-in method instead of account login

## Internal-Only, Not Marketed

These may exist technically, but they are not part of the MVP story:

- `/admin`
- support-only recovery affordances
- moderation internals
- compliance and App Store packaging work

## Restart Build Order

1. Truthful public entry: audience + performer/DJ only
2. Performer account creation and login
3. Performer starts a live room and shares the room link/QR
4. Audience joins that specific room
5. Audience pays to send a request or tip
6. Performer sees and manages the queue
7. Payments, closeout, and ledger truth

## Immediate Cleanup Targets

- Remove venue/operator language from public entry points
- Keep admin/internal routes protected and unmarketed
- Continue reducing legacy docs that redefine the product
- Do not start new venue, operator, or marketplace work unless explicitly requested
