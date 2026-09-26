# Multi-program connection continuation — September 21, 2026

Objective: Users keep their existing programs; broaden actual connection implementations while preventing automatic playback, retargeting or replay after uncertainty. The owner rejected a Mixxx-only outcome. This is incremental multi-program delivery, not dozens of completed integrations.

Base branch/commit: `implement/direct-music-control-20260916` at `b6bb833fecdf6ae901aedcaea5475ff6e285f61a`, PR249. Current source is the commit containing this checkpoint. Main and shared-host GrindZone are not edited.

## Implemented candidate

Shared native capability registry, explicit multi-connection hub, fixed-target revision/command binding, durable local owner journal, exact-origin authenticated loopback host, browser client and Sources-mounted local-player panel. Real protocol adapters for VLC HTTP and mpv JSON IPC join the existing VirtualDJ adapter. The existing Spotify component is copied without edits to `PerformerSpotifyConnection.tsx` and mounted beside the new panel by the former account-only entry. Existing cloud provider validation, room queue, Mixxx mapping, VirtualDJ code, schema, dependencies and payment controls remain intact.

The host uses the existing `executeClaimedOnce` implementation rather than replacing its conservative ledger. No arbitrary OS command, track URL, provider fallback or auto-resend is exposed. Unknown commands remain held across aliases and reconnect until deliberate review. Secrets stay outside URLs, browser storage and receipts. Playback state is read independently from acknowledgement.

## Executed evidence so far

Local Linux Node v22.16.0: `node --test scripts/sway-native-player-adapters.test.mjs scripts/sway-native-player-host.test.mjs` completed 34 tests, 34 pass, zero fail/skip/cancel. Scope: real local HTTP and Unix sockets, controlled provider replies, explicit source-target binding, deadlines, redirects, corruption/storage failures, actual journal file lock contention and two native CLI process lifetimes. The browser client was tested under Node against the real host. It was not an installed browser permission test or a real original-player test.

Both new JSX entry files passed TypeScript syntax transpilation. This is not a project typecheck/build. New browser test is prepared, not yet executed at this checkpoint. It is registered under the existing Sources acceptance entry without deleting any older checks.

Tests invalidated: new wrapper/native UI, localhost permission flow and new native transports need their own browser/original-player acceptance. Old Mixxx, registry, merge and VirtualDJ receipts retain their own source/scope; none is relabeled a new run.

## Remaining acceptance

Run the new exact-candidate browser flow and actual VLC/mpv binaries. Preserve every earlier artifact before reusing the existing isolated runner. Do not disable CORS/mixed-content/local-network security. Complete normal customer onboarding/installer, platform ACL and signed-in production-origin acceptance before calling this customer-ready. Native developer preview is same-computer only; it does not finish cloud accounts or Serato/rekordbox/Traktor/djay integrations.

External side effects: draft-branch code publication only. No main merge, production deploy, new service, provider grant, payment, production database, or Desktop Commander operation. The shared-host GrindZone pin and runtime files are untouched.

Next exact action: test the two new adapters and shared browser panel against real VLC/mpv in the existing isolated runner; retain exact source identity and honest limitation records. Then continue actual program coverage and normal user setup, not another isolated kit.

Must NOT repeat: completed merge reconstruction/publication, old registry/Mixxx/unchanged full hosted gates, new proof-service provisioning, access/billing ceremony, fake multi-provider type widening, or a logo catalog represented as integrations. Rollback is a revert of this additive candidate; no production migration or payment rollback is involved.
