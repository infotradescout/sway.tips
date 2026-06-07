# Sway Tips

Sway lets live performers, DJs, bartenders, and event acts accept paid tips, requests, and audience boosts through a QR-powered live ladder.

This repo is moving from prototype behavior toward a production-ready web app and eventual App Store wrapper. The current implementation includes separated patron, talent, and overlay routes, with the persistent database, real payment processor flow, moderation controls, and App Store review package tracked in the roadmap docs.

## Routes

- `/talent/login`
- `/talent/gigs`
- `/talent/gigs/:gigId`
- `/g/:gigId`
- `/p/:performerHandle`
- `/overlay/:gigId`
- `/admin`

## Local Development

Prerequisite: Node.js

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in the values needed for your environment.
3. Run the app: `npm run dev`

Useful checks:

- `npm run lint`
- `npm run build`

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
	- `/admin/*` admin shell (still auth/role gated)

### Deploy Verification Checklist

- `https://sway.tips/` serves public landing shell.
- `https://www.sway.tips/` serves public landing shell.
- `https://app.sway.tips/` serves app shell entry (patron shell).
- `https://app.sway.tips/g/test` resolves to patron shell.
- `https://app.sway.tips/talent/test` resolves to talent shell.
