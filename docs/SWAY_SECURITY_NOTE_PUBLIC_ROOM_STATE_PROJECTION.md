# Security Note: Public Room State Projection

Date: 2026-07-20
Status: Resolved in PR #109. Recorded as a standing security boundary, not folded into the migration incident record — this was a distinct defect with a distinct cause.

## What Was Exposed

`GET /api/state` and `GET /api/state/:gigId` returned the complete, unfiltered internal room and request objects to any caller who could reach the route — including anonymous callers with no session at all. Because a gig's public URL (and its QR code, by design) is meant to be freely shareable, this meant anyone with a room's link or QR code could read, for every request in the room:

- Real Stripe identifiers: `paymentId`, `paymentIntentId`, `paymentStatus`.
- Idempotency internals: `idempotencyKey`, `idempotencyFingerprint`, `idempotencyExpiresAt`, `clientRequestId`, `payloadHash`.
- `patronDeviceIdHash` (a per-device identifier).
- Moderation state: `shadowBanned`, `hidden`, `removed` — flags that are only meaningful, and only safe to disclose, to the performer running the room.
- `actorUserId` / `lastMutationActorUserId` on every request and boost.

There was no access-control check on this read path at all: the route did not distinguish the performer, an authenticated patron, or a fully anonymous caller.

## Root Cause

This was a missing-authorization defect, not a schema or deployment defect. The route handler serialized the internal in-memory/DB-backed room state object directly into the HTTP response. No projection layer existed between "what the server holds about a room" and "what an external caller receives." As new internal fields were added to requests over time (payment fields, idempotency fields, moderation fields), each one became publicly readable by default, silently, with no separate decision required.

## A Second, Related Defect: Cross-Patron Status Bleed

Separately, the patron-facing "your last request status" UI computed its answer as *the most recently created non-hidden/non-removed request anywhere in the room*, sorted globally and taking the first result. In any room with more than one active patron, this could show one patron a different patron's request status as if it were their own — a correctness bug with a privacy dimension (one patron learns another patron's activity), not just a UX bug.

## The Fix (PR #109)

1. **Sanitized projection.** `src/server/public-room-state.ts` (`projectPublicRoomState`, `projectPublicRequest`) builds an explicit allowlist response — only fields that are safe for any caller, and only requests in a publicly visible state (`approved`/`fulfilled`; never `hold`, `denied`, hidden, removed, or shadow-banned). The route now branches on `accessControl.requireGigMutationAccess(req, gigId)`: the performer/owner gets full internal state; every other caller gets the projection. `sanitizePatronMutationResponseBody` applies the same allowlist logic to idempotent-replay and pending-action-reconciliation response bodies, so those paths cannot leak the same fields through a different code path.
2. **Per-submission receipt for patron-scoped status.** `src/server/patron-status-receipt.ts` issues an unguessable receipt token (43-char URL-safe random string, `sha256`-hashed at rest, compared with `timingSafeEqual`) at submission time. The patron's client stores it in `localStorage`, scoped per gig, and polls `POST /api/patron/request-status` with it. A patron's displayed status is now resolved strictly by "does this receipt match this specific request," never by "what is the newest request in this room." One patron's action can no longer change what another patron sees as their own status.

## Permanent Security Boundary (Do Not Regress)

The following is a durable contract for this codebase, not a one-time fix description:

```text
Public room state is a projection, never the internal room object.
A patron can see only that patron's request status.
Performer-only operational state requires performer authorization.
Payment identifiers, idempotency keys, device hashes,
moderation flags, and other internal fields never enter
the public projection.
```

Any new field added to the internal request/session/room model is private by default. Making it visible to patrons or the public requires an explicit, reviewed addition to the allowlist in `projectPublicRoomState`/`projectPublicRequest`/`sanitizePatronMutationResponseBody` — never an unreviewed pass-through.

## Regression Coverage

- `scripts/sway-public-room-state.behavior.test.mjs` — pure allowlist/exclusion assertions, including a fixture (`shadowApprovedRequest`) specifically constructed so shadowBanned exclusion is proven independent of the status filter.
- `scripts/sway-public-room-state-projection.integration.test.mjs` — full end-to-end proof against a real server and disposable database, using two genuinely distinct patron identities (separate `fetch()` clients, no shared cookies/session) submitting different requests, asserting: neither patron's mutation response nor either public read exposes any of the forbidden internal fields; each patron's receipt resolves only their own request; performer's authenticated read retains full internal state including `idempotencyKey`; Patron B fulfilling their own request does not change what Patron A had already been shown for their own status; an invalid/foreign receipt returns 404.

## What To Check Before Adding Any New Room/Request Field

- Does this field need to be visible to patrons or the public? Default answer is no.
- If yes, is it added explicitly to the relevant projection function's allowlist, with a test asserting both its presence there and its continued absence from any other field on the object?
- If it's payment, idempotency, device, or moderation-related, the default answer is always no — surface it to the performer's authenticated view only.
