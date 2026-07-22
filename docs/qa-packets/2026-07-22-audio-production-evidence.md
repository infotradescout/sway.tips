# Audio Production Evidence — 2026-07-22

## Requested Outcome

Prove the current production audio-master boundary without exposing a session cookie, share token, database URL, R2 credential, object key, account identity, or audio bytes.

## Independent Evidence

- Environment: `https://app.sway.tips`
- Deployed commit: `0fff1da9b89bedac18478067ced6c100f96774b8`
- Runtime observation: audio storage enabled; provider `r2`; object-storage readiness verified.
- Public-boundary request: unauthenticated `GET /api/talent/audio/projects/<fixture-project>/assets`.
- Observed result: HTTP `401` with `Cache-Control: no-store, must-revalidate, proxy-revalidate, no-cache`.
- Persisted production evidence already established by the fail-closed fixture journey: authenticated upload, immutable seal, one-use share, exact byte count and SHA-256 download, and sealed-version UI visibility.
- Repository verifier: `npm run audit:audio:production-evidence` checks the deployed marker/runtime, persisted proof records, owner read, unauthenticated HTTP denial, and read-only denial for a non-smoke account without a project grant. It emits no account identity or storage secret.

The cross-account verifier could not run from this workstation because production database credentials are intentionally unavailable here. Its failure was closed, not treated as evidence.

## What Remains Unproven

- Cross-account denial executed from an authorized production operations environment.
- Denial after share revocation or exhaustion using a retained one-time fixture token.
- Recovery from a separately controlled copy/export with the same byte count and SHA-256.
- Evidence cleanup or a recorded retention decision for the generated fixture.

## Decision

`HOLD`. Unauthenticated HTTP denial is verified. Durable master storage must remain below `production_verified` until the remaining controls are independently recorded.

## Rollback

- Code rollback: revert the evidence/audit commit; no production route or schema behavior changes in this packet.
- Automatic rollback trigger: any unexpected `2xx` public asset response, object-storage readiness failure, integrity mismatch, or authorization bypass.
- Observability signal that activates the trigger: build-marker/runtime drift, audit command failure, access-control error-rate change, or exact-byte/hash mismatch.
