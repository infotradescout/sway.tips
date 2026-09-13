# Integrated Sources and account recovery — 2026-09-13

This review candidate combines main `7db08c3946da01c8831a24b61fe54903d6c87c84`, Sources `167b0e77997d1a5f95f852fc26cfad2b85dc956f`, and account/payout recovery PR #241 (`ca1ff98a5b597ab526a0e6e4f7aa80708f9ea324`). It does not change main or the production service.

## Corrections

- Named source choices now pass their identity into the canonical import helper. A same-named CSV from Serato and Mixxx stays separate.
- `/api/talent/library/sources` counts tracks using a join on both performer and source, preserving zero-track sources. The previous Drizzle correlated subquery compiled its comparisons to unqualified tautologies and counted all library tracks for every source.
- The actual API regression uses persisted sessions and a disposable, migrated database to verify source isolation, performer isolation, empty sources, replacement, and anonymous denial.
- Browser proof obtains its performer identifier from the validated import receipt and checks active tracks against the real source-activity schema. Its 12-track reload assertion remains strict.
- The source acceptance suite is a direct hard contract gate. A stale contract checks the canonical source chooser mount instead of obsolete copy.

Playback remains in the external music source. File imports contain song metadata; they do not establish provider connections or transfer audio.

## Executed local verification

- Clean `npm ci`, `npm run lint`, and `npm run build` passed.
- Existing DJ importer tests, 26 parser cases, and 18 import-helper cases passed.
- `node --import tsx scripts/sway-library-source-count.behavior.test.ts` passed against the actual server and a disposable PGlite database using all 52 migrations. This is not standalone PostgreSQL proof.
- 120 selected contract gates passed. `contract-check.mjs` needed the absolute Node executable in this sandbox because a child intentionally clears PATH; the direct rerun passed without changing the guard.
- Five additional contract gates reached browser execution and stopped because the local Chromium executable is unavailable: payment closeout, FAQ/public information, payment modal viewport, gig-scoped room truth, and account claim onboarding.
- Public-profile behavior and withdrawal prerequisite/behavior tests passed separately. The full `test:contracts` command has **not** passed on the final candidate; profile/payout browser and the complete Sources acceptance gate also remain to run here.

## Earlier hosted proof: useful evidence, failed acceptance

Draft PR #242 initially published commit `b954c9f194f99dc41b9e62c8d5d898b24a9ed39c`, tree `b104e726ec81252f34dfd4844f1efcd8a97fde52`, before the source-count and hard-gate corrections above.

Existing static verification service `srv-daesln0u01pc73fso5kg` ran launcher `dd1e622902e3dda15acb07bb716568e2c2b849e3`. Its launcher rejects inherited production database/provider credentials and live-money flags, clones the exact candidate, and creates disposable loopback PostgreSQL. Reported PostgreSQL 18.4, port 25439; production mutations false; provider transactions false; tracked source unchanged.

The environment merge triggered deployment `dep-dajdqaek1f9s73d8e7s0` even with auto-deploy disabled. An immediate explicit trigger created `dep-dajdqah42hec73bi186g` and canceled the first. Future updates must inspect the environment-update result before triggering another deployment.

The second deployment finished `build_failed` at 2026-09-13 17:30:57 UTC. It passed installation, parsers, helpers, existing importers, Connections, lint, build, eight native-database browser import scenarios, profile/payout browser interactions, and 18 room/account-scope browser cases. Sources then exposed the count bug, and full contracts exposed the indirect npm hard-gate command. Neither failure is treated as a pass. The static proof URL still serves an older successful deployment.

## Remaining release gates

Publication was authorized on 2026-09-13. Published candidate `683bdbfbb297dcc40f49818f6c02b82f2109ad0d` has the exact reviewed local tree `7ade05f5dae32e5712847ee5e21c47bb1c34ca3f`. Environment merge triggered one isolated deployment, `dep-dajekebm8hqs7380eqg0`; no duplicate deploy was triggered.

That run passed the corrected 12-track Sources reload against native PostgreSQL, then exposed a proof navigation mistake: the test requested `/talent/library`, while the canonical Requests route is `/talent/music`. The proof now clicks the actual Requests navigation button and asserts the canonical route before searching. Source-count, reload, persistence, search, account-isolation, restart, and viewport assertions remain strict. This is a test-only follow-up; product routes are unchanged.

Monitoring also exposed an acceptance bug: PGlite shutdown reset the browser failure exit code, so the nested contract command continued after its failure report. The overall native proof still correctly failed. A local missing-Chromium reproduction confirmed the incorrect zero exit. The browser runner now applies failure status after cleanup, and a hard-gate regression invokes that actual runner with an empty browser directory to require a nonzero result after PGlite startup and shutdown. Native and embedded browser reports now have separate directories so one cannot overwrite the other's evidence.

Rerun the existing isolated service with the exact follow-up SHA. Require the entire source browser journey (reload, Requests search, second account, server restart/database counts, and responsive layouts) and full application contracts to pass. Reconfirm the source tree and disposable-database/provider protections. Production remains unchanged pending normal review and release gates; no live-money or provider transaction is part of this verification.
