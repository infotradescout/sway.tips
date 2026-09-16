# Sources real-account and device acceptance — continuation

## Objective
Verify the deployed Sources workflow with legitimate production sign-in and an actual player, without modifying customer libraries or active performances.

## Base branch/commit
Production main: 80127f127bc1ec1b3ea7a32b89eea244f5953a1f. Release evidence: 9162de537019e061f4fdbdada024d3c9fb64769c on evidence/sources-release-248-20260916.

## Verified completed work
The production release remains active at the expected SHA. The connected Gmail account is user-controlled and contains earlier Sway QA verification emails; those historical messages are not current login sessions. Only TSCommandCenter is connected. Checked conventional VirtualDJ/Spotify/Serato install paths, installed-app records for VirtualDJ/rekordbox/Serato/Spotify/Mixxx/Traktor/djay, and running player processes; no matching player was found. This is scoped device inspection, not a search of every disk or other computers.
A dedicated visible Playwright browser was opened normally to production Sources. The page reached /account/login. A Sources API read using that browser context returned 401, so authenticated acceptance has not started. No personal-browser cookie database was accessed, no session was fabricated, and no password was reset.

## Changed but unverified work
No runtime edits. Authenticated production imports/replacement, real Spotify permissions, and physical playback remain NOT VERIFIED. A proposed automated signup command was blocked by tool safety before execution; no account was created. Do not retry that blocked command or bypass the safety check.

## Tests/evidence already run
Reused the deployed-release checkpoint without repeating full gates. Fresh dedicated-browser preflight observed expected live SHA, releaseActive=true, /account/login, and private Sources HTTP 401. VirtualDJ's official Network Control documentation states VirtualDJ 2023 or later plus a Pro license and the Network Control extension are required; no such working player was observed here.

## External side effects and retry safety
Only a dedicated local browser/profile and this evidence document were created. No production account/library/room/provider/payment mutation or playback command was made. The browser remains open on TSCommandCenter; REPL process 108100 owns qaContext and qaPage. Profile directory: C:\Users\flavo\AppData\Local\Temp\sway-user-authorized-qa-1h5pIH. Do not publish or read its cookie storage; use the ordinary browser context after user sign-in.

## Next exact action
User signs in to the dedicated QA window. Recheck /api/talent/library/sources and performer ownership through that same normal browser session; inspect active rooms and avoid all customer/live-performance mutations. Perform isolated import/cancel/replacement/reload cleanup checks only on an authorized test account. Physical acceptance additionally requires an actual connected playback computer running a supported player; do not install paid software, bypass licensing, execute a room file against a live performance, or substitute a fake provider/player for acceptance.

## Actions that must NOT be repeated
Do not merge/deploy #248 again, rerun unchanged full gates, reset existing QA passwords to force access, extract personal browser credentials, bypass tool safety, or label this pending stage a pass. The Sources release is live; real-account/device acceptance is still pending.
