# Persisted Access Fallback Smoke

## Purpose

This runbook turns the persisted-access fallback smoke flow into a repeatable production check instead of tribal knowledge. Use it when durable DB-backed access is not yet available for authenticated talent/admin smoke and the signed fallback assertion path must be verified.

This is not the supported browser login path for `/talent`. Browser performer access must use the DB-backed performer session bootstrap flow instead.

## Required Render env vars

Set these on the Render service when fallback smoke is needed:

- `SWAY_FALLBACK_ACTOR_HEADER_SECRET`
- `SWAY_FALLBACK_TALENT_ACTOR_IDS`
- `SWAY_FALLBACK_ADMIN_ACTOR_IDS`
- `SWAY_FALLBACK_SUPPORT_ACTOR_IDS` optional

Do not store these secrets in repo files.

## Smoke-time local env vars

The smoke script reads its configuration from the local shell:

- `SWAY_PRODUCTION_BASE_URL`
- `SWAY_EXPECTED_BUILD_SHA`
- `SWAY_FALLBACK_ACTOR_HEADER_SECRET`
- `SWAY_FALLBACK_TALENT_ACTOR_ID`
- `SWAY_FALLBACK_ADMIN_ACTOR_ID`
- `SWAY_FALLBACK_SUPPORT_ACTOR_ID` optional
- `SWAY_FALLBACK_SESSION_ID` optional
- `SWAY_FALLBACK_TIMESTAMP` optional

`SWAY_PRODUCTION_BASE_URL` defaults to `https://app.sway.tips`.

## Naming

The route family is `talent`, but the fallback role value for that route family is `performer`.

That means:

- talent route family -> fallback role `performer`
- admin route family -> fallback role `admin`
- admin/support route family -> fallback role `admin` or `support`

## Header contract

Signed fallback requests must include:

- `x-sway-actor-id`
- `x-sway-session-id`
- `x-sway-fallback-role`
- `x-sway-fallback-timestamp`
- `x-sway-fallback-signature`

## Signature payload

The HMAC payload is:

`actorId|sessionId|role|timestamp`

## How to rotate the fallback secret

1. Generate a new strong random secret.
2. Update `SWAY_FALLBACK_ACTOR_HEADER_SECRET` in Render.
3. Redeploy or restart the Render service so the new env is loaded.
4. Rerun `npm run smoke:production:fallback` with the new local secret.
5. Remove the old secret from local shell history if it was exposed there.

## How to run

Example PowerShell session:

```powershell
$env:SWAY_PRODUCTION_BASE_URL = 'https://app.sway.tips'
$env:SWAY_EXPECTED_BUILD_SHA = 'REPLACE_WITH_DEPLOYED_SHA'
$env:SWAY_FALLBACK_ACTOR_HEADER_SECRET = 'REPLACE_WITH_SECRET'
$env:SWAY_FALLBACK_TALENT_ACTOR_ID = 'REPLACE_WITH_PERFORMER_UUID'
$env:SWAY_FALLBACK_ADMIN_ACTOR_ID = 'REPLACE_WITH_ADMIN_UUID'
npm run smoke:production:fallback
```

The smoke script checks:

- `GET /api/build-marker`
- `GET /api/talent/active-rooms` with valid signed `performer` fallback
- `GET /api/admin/active-rooms` with valid signed `admin` fallback
- `GET /talent/gigs` with valid signed `performer` fallback
- `GET /admin` with valid signed `admin` fallback
- anonymous talent/admin API requests still return `401`
- anonymous talent/admin HTML requests still return `401` with protected HTML
- invalid signature fails closed

## Pass criteria

- build marker matches `SWAY_EXPECTED_BUILD_SHA` if provided
- valid signed talent/admin fallback does not `503`
- anonymous routes still `401` or otherwise fail closed where documented
- invalid signature fails closed

## Fail criteria

- `503` means fallback config is missing or not loaded
- `401` on signed fallback means assertion/header mismatch or allowlist mismatch
- `403` on signed fallback means invalid signature, stale timestamp, role mismatch, or actor not allowlisted
- anonymous `200` is a blocker

## When to remove fallback config

Remove fallback env after durable persisted access store is configured and authenticated talent/admin smoke passes through the durable DB path.

## Rollback

Remove the Render fallback env vars and redeploy or restart the service.
