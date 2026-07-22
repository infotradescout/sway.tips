# Sway Complete Product Gap

## Decision

Complete-product decision: **HOLD**.

This is not a claim that the live loop is broken. It means the repository does not yet contain one current, independent production evidence packet proving the entire customer-to-performer journey on the deployed build.

## Confirmed Repository State

- Customer and performer shells exist.
- Universal accounts and Pro Mode state exist.
- Performer signup, login, profile, room setup, QR/link sharing, queue controls, earnings, and recap paths exist.
- Customer room join, request, tip, boost, checkout, status, and recovery paths exist.
- Payment lifecycle, idempotency, audit, moderation, and closeout contracts exist.
- Historical audio-distribution schema exists but is retired from product scope and must remain dormant.

These are repository facts, not production outcome proof.

## Evidence Still Required

| Capability | Required production outcome |
|---|---|
| One-account journey | One user can join as a customer and activate/use Pro Mode without a second identity silo. |
| Room start and join | A verified performer starts a room and a separate customer joins from its QR/link. |
| Request/tip/boost | The customer completes each allowed action and receives truthful status. |
| Money lifecycle | Backend-confirmed authorization/capture/void/refund outcomes match the UI and audit trail. |
| Queue control | Performer approve/deny/complete actions update the correct room and customer receipt. |
| Safety and recovery | Role denial, moderation, duplicate retry, transient network failure, and expired action behavior are observed. |
| Closeout | Ending the room produces correct final earnings and recap without manual-only recovery. |

## Correct Next Work

1. Run a current production journey with one performer account and one separate customer.
2. Record exact build marker, routes, payment mode, observed outcomes, and audit evidence without secrets.
3. Fix the first failed or confusing step in that journey.
4. Re-run the affected path and the full contract gate.
5. Change readiness to `GO` only after every capability is independently production verified.

## Non-Claims

- A deploy is not proof of a working room.
- A contract test is not proof of a production payment.
- A build marker is not proof of a customer outcome.
- Dormant historical schema is not a product requirement.
