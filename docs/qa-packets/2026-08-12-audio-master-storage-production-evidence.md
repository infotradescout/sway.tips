# Audio Master Storage Production Evidence — 2026-08-12

## Decision

**HOLD — 9 of 10 production controls passed.** The exact-original R2 path is healthy and its customer authorization behavior is proven on the deployed build. The remaining control is operational: the Cloudflare account available to the operator has an active R2 subscription but contains no buckets, so it cannot prove ownership of the live bucket or inspect whether that bucket's public development URL and custom public domains are disabled.

This is not evidence that the live bucket is public. It is evidence that bucket ownership and privacy configuration remain independently unverified.

## Requested Outcome

Prove that Sway can store and recover a synthetic exact-original audio master in production, preserve the bytes across an application restart, deny unauthorized or exhausted access, and document the live provider-control boundary without exposing credentials, object keys, account identities, session cookies, share tokens, or customer audio.

## Run Identity

- Environment: `https://app.sway.tips`.
- Evidence date: 2026-08-12 America/Chicago (2026-08-13 UTC).
- Deployed merge: `b89d4033f8de55ba2c3a5a1dcf0bf566f1c3b48f` (PR #198).
- Build timestamp: `2026-08-13T03:56:26.873Z`.
- Release observation: release active; database reachable; migration report compatible with all 36 expected migrations applied.
- Runtime storage observation: enabled, provider `r2`, object-storage access verified.
- Verifier: repository owner with Codex-assisted production browser, HTTP, local gate, and Cloudflare dashboard inspection.

## Synthetic Fixture

- Format: generated one-second, 8 kHz, mono, 16-bit WAV.
- Byte count: `16,044`.
- SHA-256: `105eaba643f522ec731431fd0035959ebd2e46f2f9f6248a53b912b2841739b0`.
- Source: `npm run fixture:audio:production`; no creator-owned audio was used.

## Independent Evidence

| # | Production control | Result | Observed evidence |
| ---: | --- | --- | --- |
| 1 | Exact deployed commit | **PASS** | `/api/build-marker` and `/api/release-health` both reported merge `b89d4033f8de55ba2c3a5a1dcf0bf566f1c3b48f`. |
| 2 | Verified R2 runtime access | **PASS** | `/api/runtime-config-status` reported audio storage enabled, provider `r2`, and object storage verified. |
| 3 | Bucket public URL and custom domain disabled | **HOLD** | After operator sign-in and R2 subscription restoration, the available Cloudflare account's R2 overview showed zero buckets. The live bucket therefore could not be identified or inspected in that account. |
| 4 | Authenticated upload and immutable seal | **PASS** | The owner uploaded and sealed the generated fixture; the resulting immutable version reported `16,044` bytes and the expected SHA-256. |
| 5 | Exact authorized download | **PASS** | The authenticated owner download returned HTTP 200, `audio/wav`, `16,044` bytes, and the expected body SHA-256. |
| 6 | Exact download after application restart | **PASS** | After the new merge deployed, the retained immutable version returned the same byte count and SHA-256. |
| 7 | Account without authority denied | **PASS** | A separately verified account received HTTP 403 before pairing and again after pairing but before an explicit file grant. |
| 8 | Exhausted one-use share denied | **PASS** | A fresh one-use link returned the exact bytes once; immediate replay returned HTTP 403 with an exhausted-link response. |
| 9 | Separately controlled export and recovery | **PASS** | The master was exported outside the original project, independently hashed, then uploaded and sealed in a separate production recovery project with the same byte count and SHA-256. |
| 10 | Cleanup or retained-fixture record | **PASS** | The generated OS-temporary WAV copies plus the synthetic production accounts, fixture projects, and master objects are intentionally retained only until control #3 is resolved, then must be removed or scrubbed. The pairing token is consumed, the one-use link is exhausted, and active file grants and pairing connections are zero. No secret or identity is retained in this packet. |

## Access And Integrity Findings

- R2 object access remained server-mediated; no public object URL was used in any proof step.
- Pairing alone granted no access.
- The authorized download body, response checksum, and expected fixture checksum matched.
- Opening the R2 object now precedes the atomic one-use claim. A storage-open failure does not consume the link, an audit failure rolls back the claim and closes the stream, and concurrent attempts produce exactly one successful download and one audit record in the disposable PostgreSQL proof.

## What Remains Unproven

- Which Cloudflare account owns the bucket used by the live Render credentials.
- In that owning account, whether the live bucket's `r2.dev` public development URL is disabled.
- In that owning account, whether the live bucket has zero public custom domains.

The readiness row must remain `implemented_unverified` until those three observations are bound to the live bucket. If the current bucket owner cannot be established, create a private bucket in the controlled account, rotate Render to a bucket-scoped credential, migrate or deliberately retain the fixture, and rerun all ten controls.

## Rollback

- Application rollback: revert PR #198 while preserving PostgreSQL and R2 evidence.
- Automatic rollback trigger: object-storage readiness failure, byte/hash mismatch, unexpected unauthorized `2xx`, or evidence that the master bucket is public.
- Observability signal: `/api/release-health`, `/api/runtime-config-status`, authorization response status, exact byte/hash comparison, and Cloudflare bucket configuration.
- Safe response: fail audio routes closed, preserve the bucket and audit records, rotate only the bucket-scoped credential, and do not delete sealed objects during diagnosis.

## Explicit Non-Claims

- This packet does not prove that the signed-in Cloudflare account owns the production bucket.
- Verified application access to R2 does not prove the bucket's public-access settings.
- This packet does not authorize general availability, DSP delivery, royalties, collaborator payouts, live Stripe, or App Store submission.
- A passing local command, merge, deployment, or build marker is not independently sufficient.
