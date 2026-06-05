# Sway App Store Roadmap

## Sprint 1: Product Spine And Cleanup

- Add product, roadmap, launch-gate, and revenue docs.
- Rename the package from `react-example` to `sway-tips`.
- Replace starter README content with real Sway product instructions.
- Separate production routes for talent, patron, performer, gig, and overlay surfaces.
- Remove fake public totals, demo performer marketplace entries, and demo request seed data.
- Add an explicit environment contract.
- Add smoke checks for build and route rendering.

Exit gate:

- `npm run lint` passes.
- `npm run build` passes.
- README explains the real product.
- No fake production positioning appears on initial public routes.

## Sprint 2: Production MVP Backend

- Add persistent database tables for users, performers, venues, gig sessions, requests, boosts, payments, payouts, moderation events, and audit events.
- Add performer account creation and login.
- Add create-gig and close-gig flows.
- Generate public QR URLs for real gig IDs.
- Create requests and tips against real gig sessions.
- Show performer dashboard queue for the active gig.
- Preserve requests and ledgers across reloads and server restarts.

Exit gate:

- One performer can create a gig.
- One patron can submit a request.
- The request appears on the performer dashboard.
- The request survives reload and restart.

## Sprint 3: App Store Submission

- Wrap the current React app with Capacitor unless native-only scope is commissioned.
- Create bundle ID, icon, launch screen, screenshots, and review notes.
- Publish Privacy Policy, Terms, Support URL, data deletion path, payment/refund terms, and payout terms.
- Provide a demo performer account, demo patron flow, sample review QR/gig link, and live backend services.
- Ship through TestFlight before public review.

Exit gate:

- 10 internal testers.
- 3 real performer test gigs.
- 50 or more patron scans.
- 20 or more successful test payments.
- 0 crash loops.
- 0 lost ledgers.
- 0 broken QR sessions.
