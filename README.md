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

## Local Development

Prerequisite: Node.js

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in the values needed for your environment.
3. Run the app: `npm run dev`

Useful checks:

- `npm run lint`
- `npm run build`

## Production Gaps

Do not submit this app for public App Store review until the launch gate is complete. The backend still uses temporary in-memory state, checkout is not wired to a real payment processor, and legal/support URLs must be published before review.
