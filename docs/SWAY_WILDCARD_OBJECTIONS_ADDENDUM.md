# Sway Wildcard Objections Addendum

This addendum records physical-world and App Store wildcards raised by the Objector after the AI Council protocol was locked.

## Decision

Accepted.

The architecture must account for real venue conditions and App Store review risk, not only clean browser demos.

## Wildcard 1 — Capacitor Minimum Functionality Trap

### Risk

A native wrapper that only packages the web app can be treated as a weak App Store submission.

Sway cannot rely on a Capacitor shell alone as proof of App Store-grade utility.

### Rule

If Sway ships through Capacitor, the native app must provide real native-device utility beyond loading the React bundle.

Required native utility candidates:

```text
native push notifications for performer alerts
native payment integration where required by payment architecture
native deep links for gig QR/session recovery
native share sheet for performer QR link
native secure storage for performer session tokens
native camera/QR support if used inside performer tools
```

### App Store Review Package Requirement

The review notes must explain the native utility:

```text
why the app is not just the website
which native capabilities are used
how reviewer can test push/deep-link/payment paths
which demo account and sample QR/gig link to use
```

### Contract Test Required

```text
scripts/sway-native-utility.contract.test.mjs
```

The test must prove that the iOS/App Store package references at least one approved native utility path before App Store submission is marked ready.

## Wildcard 2 — Offline Queue Versus Live Vibe Paradox

### Risk

Offline retries can become stale.

A patron may press boost or request in a bad-signal venue, regain connection much later, and accidentally submit a request after the moment has passed or the gig has ended.

### Rule

Client pending actions must have a strict TTL.

Default pending action TTL:

```text
5 minutes for request/tip/boost intent submission before server acceptance
```

A pending action must be canceled locally when:

```text
TTL expires before server acceptance
gig state is confirmed closed or ending
request window closes before server acceptance
target request is fulfilled, denied, voided, or refunded before acceptance
payment step has not started and network cannot reach server
```

### User Copy

Required user-facing copy when TTL expires before payment is initiated:

```text
Network dropped. Your request expired and you were not charged.
```

Forbidden behavior:

```text
charging stale queued actions after TTL
showing success before server confirmation
retrying payment creation after gig closeout without fresh user confirmation
silently preserving pending actions across venue/session changes
```

### Contract Test Required

```text
scripts/sway-pending-action-ttl.contract.test.mjs
```

The test must prove:

```text
client pending actions have expires_at
expired actions are not retried
expired actions show no-charge copy
stale boosts require fresh user confirmation
payment creation requires non-expired intent
```

## Wildcard 3 — Venue Wi-Fi Captive Portal Black Hole

### Risk

Venue Wi-Fi captive portals can intercept initial network requests and cause partial app loads, hanging payment setup, broken WebSocket state, or Stripe/payment initialization failure.

### Rule

The patron entry point must perform network readiness detection before mounting payment UI.

Required behavior:

```text
run connectivity/captive-portal probe before payment UI mounts
block checkout when network probe fails or is intercepted
show clear venue Wi-Fi sign-in guidance
allow retry after user signs into Wi-Fi
never create payment intent while network readiness is unknown
```

Suggested probe pattern:

```text
GET /health/network-probe expecting 204 No Content from Sway backend
or use a dedicated Sway-controlled probe endpoint with strict response validation
```

Do not rely only on generic `navigator.onLine`.

### Required UI Copy

```text
Please finish signing into the venue Wi-Fi before requesting. Your card will not be charged until the connection is confirmed.
```

### Contract Test Required

```text
scripts/sway-captive-portal-guard.contract.test.mjs
```

The test must prove:

```text
patron entry performs readiness probe before checkout mount
payment UI is blocked when probe fails
payment intent is not created while captive portal state is unknown
retry path exists after Wi-Fi login
```

## Sprint Placement

These wildcards update the build order:

### Slice 0B — Contract Gates

Add tests:

```text
sway-native-utility.contract.test.mjs
sway-pending-action-ttl.contract.test.mjs
sway-captive-portal-guard.contract.test.mjs
```

### Slice 2 — Route Decoupling

Patron entry must include captive portal/network readiness state before checkout UI.

### Slice 4 — Degraded Network And Idempotent Actions

Pending action queue must include:

```text
expires_at
stale_reason
requires_fresh_confirmation
last_network_probe_status
```

### Slice 7 — App Store/TestFlight Package

Native wrapper may not be marked App Store-ready unless native utility is implemented and documented.

## Non-Negotiables Added

```text
No stale queued charges.
No checkout mount before network readiness check.
No App Store submission as a web-only wrapper.
No payment intent creation while captive portal state is unknown.
No retry beyond pending action TTL without fresh user confirmation.
```
