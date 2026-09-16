# Sources authenticated production acceptance

## Objective
Verify the actual signed-in Sources workflow and real provider/player readiness for deployed 80127f127bc1ec1b3ea7a32b89eea244f5953a1f.

## Base branch/commit
Production main: 80127f127bc1ec1b3ea7a32b89eea244f5953a1f. Prior evidence head: 3ea7fba9f5f37adf57885d75ee6efd5f894e4042.

## Current branch
Evidence-only branch: evidence/sources-release-248-20260916. No product code changes or release in this continuation.

## Verified completed work
The earlier fresh QA window returned 401, but the user's regular Chrome already had a legitimate Sway session. Native browser navigation and UI Automation refreshed Sources and reached the current interface without extracting cookies/passwords, resetting an account, or fabricating a session. Home identifies @edgewize. Sources shows 0 saved tracks and no active room selected for playback.
An invalid non-Spotify URL produced the expected input error. A correctly formatted placeholder Spotify playlist URL reached the actual production importer and returned: Spotify catalog credentials are not configured. The library remains at 0 tracks. This is an observed server-configuration failure, not missing Sway sign-in. No successful Spotify/provider call is claimed.
The actual native song-list chooser opened, then was canceled without selecting or uploading a file after tool safety blocked further chooser inspection. No upload or replacement pass is claimed.
The official Spotify developer dashboard required provider sign-in. The normal Spotify email step reported that contact@thetradescout.com is not linked to a Spotify account. No new provider account, paid subscription, or developer app was created.

## Changed but unverified work
Only this checkpoint, a sanitized acceptance record, and a real screenshot. Successful production file/playlist imports and replacements, real Spotify authorization, and physical-player feedback remain unverified.

## Evidence already run
See docs/qa-packets/sources-authenticated-20260916/acceptance.json and its screenshot. Final public health returned the expected commit, releaseActive=true, reachable DB and compatible migrations. Original 15 pre-release signed-in tests used simulated Spotify responses and are not substituted for these failed real-provider checks.

## Evidence invalidated / corrected
The earlier claim that Sway sign-in required user action was too broad: it applied only to the isolated fresh browser. The already-authenticated regular Chrome session was usable. That access obstacle is resolved. The new observed blocker is server Spotify configuration, plus the lack of an authenticated appropriate Spotify developer account.

## External side effects and retry safety
No saved tracks, existing customer data, live rooms, payment/provider settings, or production code were changed. One ordinary login-email request was made for an old dedicated QA alias, with no fresh email retrieved; a further request was blocked before execution and not retried. Main remains unchanged. Do not reuse or expose browser cookies. Final ordinary Chrome retains the existing Sway tab and the additional Spotify sign-in tab. Native UI controller was PowerShell process 118800, regular Chrome process 17556; recheck process identity before resuming.

## Next exact action
Use the correct authorized Spotify developer account and existing application, verify approved access mode and available credentials, then configure only the intended source connection under the required provider/release authorization. Finish successful import/replacement with isolated data and a verified cleanup path; do not populate a private user's empty library with unremovable QA tracks. Physical-player verification still requires an actual available supported player and must not be simulated.

## Actions that must NOT be repeated
Do not ask for another Sway sign-in, recreate the fresh QA browser, retry blocked signup/recovery/chooser commands through an alternate route, extract personal browser credentials, reset existing passwords, replay #248 deployment, or claim Spotify imports work because their code is deployed.
