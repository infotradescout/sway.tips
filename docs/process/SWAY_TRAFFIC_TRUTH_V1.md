# Sway Traffic Truth v1

## Product outcome

Sway operators need to know whether outside people are finding and using Sway without treating automated requests, internal QA, uptime checks, or security probes as audience growth.

## Evidence lanes

Traffic Truth keeps different evidence classes separate:

- `human_candidate`: an ordinary browser document navigation signal. This is not proof that a person engaged.
- `known_bot`: a recognized search crawler or link-preview fetcher.
- `scanner`: a request for a known secret, WordPress, exploit, or server-probe path. These requests receive a hard `404`.
- `internal_qa`: an explicitly marked Sway test visit.
- `platform_probe`: a recognized hosting or uptime check.
- `unknown_automation`: traffic that does not provide enough evidence to count as an ordinary browser candidate.

A real Sway interaction is still proved by the existing durable room-entry, Request, Tip, Boost, payment, and outcome records. A navigation is never relabeled as an interaction.

## Internal QA marking

Use either of these bounded mechanisms:

- Open a Sway public URL once with `?sway_traffic=qa`. The browser stores a non-sensitive QA marker and uses the reserved `00000000-` journey namespace.
- Send `x-sway-traffic-qa` with the configured `SWAY_TRAFFIC_TRUTH_QA_TOKEN` for controlled HTTP tests.

Open a public URL with `?sway_traffic=live` to clear the browser QA marker.

The Discovery Observatory excludes only the reserved internal-QA journey namespace. It continues to show real browser journeys, deliberate actions, and authoritative outcomes.

## Privacy boundary

Traffic Truth does not write raw IP addresses, full user-agent strings, cookies, URLs, search text, contact details, session tokens, payment data, or request notes to its structured records.

For ordinary browser candidates and internal QA only, it may produce a 24-character HMAC pseudonym from the network address and user agent. The pseudonym requires `SWAY_TRAFFIC_TRUTH_SALT` and rotates every UTC day. A missing or short salt produces `null`; raw values are never used as a fallback.

## Render configuration

- `SWAY_TRAFFIC_TRUTH_SALT`: at least 32 private characters. Required for daily visitor pseudonyms.
- `SWAY_TRAFFIC_TRUTH_QA_TOKEN`: optional private token for authenticated QA requests.
- `SWAY_TRAFFIC_TRUTH_QA_IPS`: optional comma- or space-separated exact test addresses. Do not use broad ranges.

Structured application logs begin with `[sway.traffic.truth]` and contain only the classified, minimized fields defined above.

## Completion proof

A release is not complete until:

1. TypeScript, build, and repository contract gates pass on the exact commit.
2. Known crawler requests remain reachable.
3. known scanner paths return hard `404` responses.
4. a marked QA navigation appears as `internal_qa` in Render logs.
5. an ordinary browser navigation appears only as `human_candidate`, not confirmed engagement.
6. the deployed build marker matches the merged commit.
