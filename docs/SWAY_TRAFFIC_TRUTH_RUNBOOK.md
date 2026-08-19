# Sway Traffic Truth Runbook

## Purpose

Raw HTTP request totals are not audience totals. Render traffic includes static assets, redirects, health checks, search crawlers, social preview crawlers, security scanners, payment-provider callbacks, browser automation, and Sway's own QA work.

Traffic Trth v1 separates that infrastructure traffic from anonymous product journeys without changing Sway's public product, payment execution, room state, Request, Tip, Boost, payout, or Stripe behavior.

## Truth levels

Sway uses three different levels of evidence. They must not be presented as interchangeable.

1. **HTTP request:** Render received a request. This may be a person, crawler, scanner, health check, webhook, asset load, redirect, or QA process.
2. **Human candidate journey:** Sway received browser telemetry that was not identified as a known crawler, scanner, browser automation run, local development session, or explicitly marked QA session. This is useful audience evidence, but it is not proof that the visitor is a unique person.
3. **Confirmed product action:** Sway recorded direct server evidence such as valid room entry, Request completion, Boost completion, Tip completion, payment state, or another durable outcome. This is the strongest evidence.

The Discovery Observatory shows human-candidate journeys and any directly linked server outcomes. Render remains the source of truth for total request, bot, scanner, health-check, and infrastructure volume.

## Classifications

Every accepted browser telemetry event receives one server-authoritative classification in its existing `attribution_channel` field:

- `human_candidate`: no known automation, bot, scanner, local-development, or QA signal was found.
- `known_bot`: recognized search crawler, social preview crawler, monitoring crawler, or other identified bot.
- `scanner`: recognized scanner identity or a request for a secret, repository file, WordPress/PHP path, source file, backup, log, or traversal path.
- `qa_automation`: browser automation, command-line HTTP client, localhost session, explicit QA marker, or an operator-configured QA IP.
- `legacy_unclassified`: historical telemetry created before Traffic Truth v1.

The server may override a browser classification toward `known_bot`, `scanner`, or `qa_automation`. It never trusts a client request to promote itself to `human_candidate`.

## Observatory projection

The observatory projection is fail closed:

- A journey must contain at least one explicit `human_candidate` event to enter the human view.
- A journey containing any `known_bot`, `scanner`, or `qa_automation` event is excluded from the human view, even when another event looks human.
- Untagged historical journeys are excluded after the cutover.
- Direct server outcomes remain visible when they are attached to a qualifying human-candidate journey.
- Admin-recorded discovery observations remain visible because they are research evidence, not anonymous visitor traffic.

This means the observatory starts a clean post-deployment measurement period. Historical totals are still available in the audit table and Render logs, but they are not mixed into the new human-candidate view.

## QA marking

Use one of these methods for intentional QA traffic:

- Add `?sway_qa=1` to the page URL.
- Add `?sway_traffic=qa` to the page URL.
- Send `X-Sway-QA: 1` or `X-Sway-Traffic-Class: qa_automation` from controlled test tooling.
- Configure exact comma-separated addresses in `SWAY_TRAFFIC_TRUTH_QA_IPS` when stable operator IP exclusion is required.

The IP setting affects analytics classification only. It does not grant access, weaken authorization, or change any product action.

## Scanner hard 404

Known secret, repository, source-code, WordPress, PHP, backup, and traversal probes are rejected before the single-page application fallback. The response is a small text `404` with:

- `Cache-Control: no-store`
- `X-Content-Type-Options: nosniff`
- `X-Robots-Tag: noindex, nofollow`

Valid Sway routes, public assets, `robots.txt`, `llms.txt`, and `/.well-known/` remain outside this scanner rule.

## Privacy boundary

Traffic Truth v1 does not add raw IP addresses, raw user-agent strings, cookies, email addresses, phone numbers, payment details, or full URLs to Sway's audit records. The durable addition is only a short classification prefix on the existing attribution source.

Render request logs continue to contain the operational fields Render normally records. Their retention and access remain governed by Render and the existing Sway operator permissions.

## Tip evidence boundary

The current browser start event used by the legacy patron screen is generic for some direct-tip starts. Do not count that event alone as a Tip. A successful Tip is counted from the direct server-observed `tip_action_completed` outcome. This runbook intentionally prefers confirmed money evidence over a guessed browser label.

## Operator interpretation

When answering “Did real people use Sway?” report the following separately:

- total Render requests;
- known bot and scanner requests from Render logs;
- human-candidate journeys from the Discovery Observatory;
- valid room entries;
- Requests, Boosts, and confirmed Tips;
- payment starts and provider-confirmed outcomes.

Never present static-file loads, redirects, health checks, webhooks, crawler visits, scanner probes, or QA sessions as users.

## Rollback

The traffic-truth lane is isolated from money and room mutation behavior. If the projection produces an operational problem, revert the traffic-truth release commit. Existing audit rows remain intact because the projection is read-time filtering and the telemetry change only prefixes the existing source field.
