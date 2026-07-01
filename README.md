# Sway Tips

Sway is a simple live-room app where audiences tip performers or DJs and pay for song requests from their phones.

This repo is moving from prototype behavior toward a production-ready web app and eventual App Store wrapper. The current implementation includes separated audience, performer, and overlay routes, with the persistent database, real payment processor flow, moderation controls, and App Store review package tracked in the roadmap docs.

## Routes

- `/talent/login`
- `/talent/gigs`
- `/talent/gigs/:gigId`
- `/g/:gigId`
- `/p/:performerHandle`
- `/overlay/:gigId`
- `/admin` internal-only

## Local Development

Prerequisite: Node.js

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in the values needed for your environment.
3. Run the app: `npm run dev`

Important:

- do not open repo HTML files directly with `file://`
- always run Sway through `npm run dev` or `npm start`
- if you want a production-style local check, use `npm run build` then `npm start`

Useful checks:

- `npm run lint`
- `npm run build`
- `npm run smoke:local:app`

## Performer Library Bridge

Performers can create a linked library source from the dashboard and run the local bridge:

- `npm run library:bridge -- --sync-key YOUR_SYNC_KEY`

That starts a localhost endpoint at `http://127.0.0.1:4314/ingest` so any DJ app, library manager, or companion script can push available-track snapshots into Sway. See `docs/SWAY_LIBRARY_CONNECTOR_BRIDGE.md` for payload details.

## Public Trust Routes

- `https://sway.tips/privacy`
- `https://sway.tips/terms`
- `https://sway.tips/support`
- `https://sway.tips/privacy/data-deletion`
- `https://sway.tips/legal/payments`
- `https://sway.tips/legal/payouts`

## Installable App Behavior

Sway is now intended to behave like an installable browser app, not just a website:

- installable from supported browsers via the app manifest
- home-screen install guidance for iPhone/iPad Safari
- lightweight service worker with offline fallback shell
- QR-first patron entry and repeat-use performer browser login

## Production Gaps

Do not submit this app for public App Store review until the launch gate is complete. Production business writes are blocked until a persistent store is configured, checkout is not wired to a real payment processor, and legal/support URLs must be published before review.

## Domain Routing Strategy

- `sway.tips` and `www.sway.tips`: public MVP landing shell at `/` and `/home`.
- `app.sway.tips`: application shell entry at `/` and `/home`.
- App route families remain:
	- `/g/*` patron shell
	- `/p/*` patron shell
	- `/talent/*` talent shell
	- `/overlay/*` overlay shell
	- `/admin/*` admin shell (internal-only and auth/role gated)

### Deploy Verification Checklist

Current live DNS status: pending cutover. Add `sway.tips`, `www.sway.tips`, and `app.sway.tips` to the Render service at `https://sway-tips.onrender.com`, then update GoDaddy DNS:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | `216.24.57.1` |
| CNAME | `www` | `sway-tips.onrender.com` |
| CNAME | `app` | `sway-tips.onrender.com` |

Remove conflicting `AAAA`, parked-domain, forwarding, or duplicate apex records before Render verification.

- `https://sway.tips/` serves public landing shell.
- `https://www.sway.tips/` serves public landing shell.
- `https://app.sway.tips/` serves app shell entry (patron shell).
- `https://app.sway.tips/g/test` resolves to patron shell.
- `https://app.sway.tips/talent/test` resolves to talent shell.
