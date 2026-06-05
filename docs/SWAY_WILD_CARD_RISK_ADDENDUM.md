# Sway Wild Card Risk Addendum

## Decision

Sway must be built for live venue conditions, not clean demos.

This addendum locks three new Objector risks into the roadmap:

```text
native wrapper review risk
stale offline pending actions
venue Wi-Fi captive portal failure
```

## 1. Native Wrapper Review Risk

Capacitor is allowed only if the native app provides real device utility beyond a packaged web app.

Required before TestFlight/App Store work:

```text
native push notifications for performer queue/session alerts
native local notifications for stale gig and closeout reminders
native deep link handling for performer and gig links
native secure storage for performer auth/session tokens
native network status integration
native payment SDK path when native checkout is used
```

The native app must not be submitted as a simple webview wrapper. App Review notes must explain the native utility.

Payment copy must be truthful. Sway must not describe live event payments as an App Store fee workaround. Live payments must be tied to real-world performance services or voluntary support, not digital content unlocks.

Required test:

```text
scripts/sway-native-minimum-functionality.contract.test.mjs
```

## 2. Offline Pending Action TTL

Client pending actions must expire quickly so a retry cannot execute after the live context is stale.

Default pending action TTL:

```text
5 minutes
```

Expire earlier if:

```text
gig ended
request window closed
target request fulfilled
target request denied
target request voided_or_refunded
boosting disabled
server rejects stale action
```

Required user copy after expiry:

```text
Network dropped. Your request expired and you were not charged.
```

Server must validate:

```text
client_pending_actions.expires_at
idempotency key validity
gig state
request window state
target request state
```

Required test:

```text
scripts/sway-offline-pending-ttl.contract.test.mjs
```

## 3. Captive Portal Preflight

The patron entry must run a network preflight before checkout or payment UI mounts.

Required backend endpoint:

```text
GET /api/health/network-probe -> 204 No Content
```

The endpoint must not redirect, set cookies, or require auth.

The patron client must block checkout on:

```text
non-204 response
redirect
HTML response
timeout
fetch failure
network status unavailable
```

Required user copy:

```text
Network sign-in required. Connect to the venue Wi-Fi or switch to cellular before sending a request. You were not charged.
```

Required test:

```text
scripts/sway-captive-portal-preflight.contract.test.mjs
```

## New Anti-Patterns

```text
webview-only native submission
retrying stale live actions
creating payment attempts after local action expiry
mounting payment UI before network preflight
claiming App Store readiness without native utility
```
