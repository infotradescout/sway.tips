# Booth command restart recovery

Objective: Continue the operator-to-original-player workflow by closing the existing VirtualDJ dispatch/restart gap.
Base: `implement/direct-music-control-20260916` at `a53353f6a203ca8867b724b358c42cffed09eab9` (PR #249).

The bridge now persists an unknown command outcome before sending anything to the player. If the process exits after dispatch, restart reports the unresolved outcome and never automatically dispatches that command again. A positive execute response still does not establish audible playback; separately observed player state remains the evidence for state.

Unreadable or inconsistent ledgers stop startup instead of starting a new identity. Pending completion records survive ledger pruning. While completion delivery remains unavailable the bridge stops claiming more commands and continues attempting state observations. An unknown result stops later commands in the current claimed batch; unexecuted claims retain the server's existing lease handling. This does not add a global operator recovery lock or change server command expiry.

Independent review identified and fixed inconsistent pending IDs and later commands executing after an unknown response. Focused verification: 13/13 behavior tests, including a real child process exiting at the dispatch boundary and reconstructing from its persisted ledger; bridge/token/cloud-action contracts and JavaScript syntax also passed. The additive execution runner is in the existing contract chain; no prior runner was removed.

Files: `scripts/sway-control-bridge.mjs`, `scripts/lib/control-bridge-execution.mjs`, `scripts/sway-control-bridge-execution.behavior.test.mjs`, `package.json`, this checkpoint. No schema, payment, role, provider activation, hosted runtime or installed booth changes. No real music played. The previous full gate proves the previous runtime, not these changed bridge bytes; full integration gates remain required before merge or deployment.

Next: prove the installed original player, device and reconnect lifecycle with authorized local music; qualify any additional player independently. Mixxx support is not implemented by this change. Direct Spotify acceptance, physical audio and the broader production/publishing work remain separate unfinished transitions. Preserve the ledger during recovery; do not delete it to retry an unresolved command. Rollback is the owned source commit only, retaining execution history.
