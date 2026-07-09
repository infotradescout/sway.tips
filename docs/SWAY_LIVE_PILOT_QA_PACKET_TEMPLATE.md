# Sway Live Pilot QA Packet Template

## Purpose

This packet records evidence from a real live-night pilot or manual QA run. It defines the proof required before Sway can claim live-pilot readiness around the core money loop:

Room settings -> Create room -> Show QR/link -> Request/Tip/Boost -> Queue action -> Patron status -> Earnings -> End room -> Recap.

This template does not claim that a pilot has passed. It does not automate payments, fake payment proof, mutate production, change runtime behavior, or create an App Store readiness claim.

## Run Identity

- Pilot date:
- Environment tested:
- Build marker / commit SHA:
- Operator name:
- Hold/go decision:

## Room Identity

- Room URL:
- Room/gig ID:
- Performer account:
- Device/browser notes:

## Required Evidence

Each item must include pass/fail, evidence link or screenshot/video reference, and operator notes.

### Performer Room-Settings Proof

- Evidence:
- Pass/fail:
- Notes:

### Performer Create-Room Proof

- Evidence:
- Pass/fail:
- Notes:

### QR/Link Proof

- Evidence:
- Pass/fail:
- Notes:

### Patron Room-Entry Proof

- Evidence:
- Pass/fail:
- Notes:

### Request Proof

- Evidence:
- Payment/provider mode:
- Pass/fail:
- Notes:

### Tip Proof

- Evidence:
- Payment/provider mode:
- Pass/fail:
- Notes:

### Boost Proof

- Evidence:
- Payment/provider mode:
- Pass/fail:
- Notes:

### Queue Action Proof

Capture approve, deny, complete, and Up Next behavior where applicable.

- Evidence:
- Pass/fail:
- Notes:

### Patron Status Proof

Capture patron-visible status using Pending, Approved, Playing, Up Next, Paused, and Ended where applicable.

- Pending evidence:
- Approved evidence:
- Playing evidence:
- Up Next evidence:
- Paused evidence:
- Ended evidence:
- Pass/fail:
- Notes:

### Earnings Or End-Room Proof

- Evidence:
- Pass/fail:
- Notes:

### Recap Proof

- Evidence:
- Pass/fail:
- Notes:

## Known Failures

- Failure:
- Impact:
- Owner:
- Required fix before go:

## Explicit Non-Claims

- This packet does not claim App Store readiness.
- This packet does not claim payment behavior changed.
- This packet does not claim real-provider payment proof unless Stripe, staging, or provider-backed validation evidence is attached.
- This packet does not change routes, schema, persistence, role/access behavior, AI behavior, moderation behavior, overlay runtime, or PR #44 status.
- PR #44 remains parked until the hold/go decision explicitly allows it.
