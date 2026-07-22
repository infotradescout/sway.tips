# Vibe Engineering Doctrine

We do not measure agent productivity by code produced.

We measure it by verified outcomes delivered without increasing uncontrolled risk.

## Ownership

Humans own intent, constraints, risk tolerance, architecture boundaries, product scope, and final authority.

Agents own exploration, implementation, repetition, testing assistance, analysis, documentation, and continuous challenge.

Systems own policy enforcement, validation gates, audit trails, observability, deployment controls, and rollback triggers.

## Evidence Law

No generated output is trusted because it is plausible.

No task is complete because an agent says it is complete.

No deployment is successful merely because it deployed.

The work advances only when independent evidence supports the requested outcome. The objective is maximum verified throughput per unit of human attention.

## Sway Product Law

Sway is one simple two-sided live product:

- Customer side: join a performer room, request, tip, boost, pay, and see status.
- Performer side: start and share a room, set request rules, manage the queue, receive money, end the room, and review the recap.

One person may use both sides of the same account. Pro Mode activates performer capabilities; it does not create a separate product or identity silo.

The complete live loop is:

`Start room -> Share QR/link -> Join -> Request/Tip/Boost -> Pay/confirm -> Approve/Deny/Complete -> Status -> Earnings -> End room -> Recap`

Profiles, authentication, moderation, payment operations, overlays, and internal administration are supporting systems for that loop. They are not separate customer-facing product pillars.

## Scope Lock

Do not add music distribution, release delivery, royalty accounting, master storage, file collaboration, catalog transfer, social networking, venue management, or any other adjacent product without a new explicit owner decision.

Historical audio-distribution schema may remain dormant to avoid destructive production rollback. It must not be exposed through navigation, customer/performer routes, startup dependencies, readiness requirements, or roadmap instructions.

No future task may treat an old migration, dormant module, closed pull request, or archived evidence packet as product authorization.

## Readiness Law

Sway is ready only when the customer and performer journeys are independently verified together in production. Schema, code, contracts, a merged pull request, a build marker, or a deployment is not sufficient evidence by itself.

`npm run readiness:assert` must fail closed until every required live-room capability has current production evidence.
