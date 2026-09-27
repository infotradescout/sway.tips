# Silent bridge reconnect acceptance

Continues PR249 from `147cf73951f6e65c4e3c24342c0409f012495bac`. The operator still controls the original player through the existing bridge; no new playback provider, room requirement, entitlement, account, or runtime adapter is introduced here.

The full `npm run validate` at that source caught a real gate integration error: the hard-contract normalizer does not accept a `node --test` command directly in its chain. A normal direct contract script now invokes Node's actual test runner and fails explicitly on a child error, timeout, signal, or nonzero status. The normalizer, assertions, and original seven execution tests remain intact.

An additional behavior case executes the actual bridge CLI as a separate process against two owned loopback HTTP fixtures. The simulated player receives a command and loses its response. Cloud completion delivery stays unavailable while player-state observations disconnect and reconnect. New claims remain blocked until the completion can be delivered. Restart preserves the same bridge identity and unknown command outcome; a repeated claim cannot dispatch that command or the later play command in its batch. Connected observations explicitly report a stopped synthetic deck.

This is silent protocol and process proof. It does not establish an installed VirtualDJ extension, license, physical device, track playback, audio, or a new Mixxx adapter. No real player process or user profile is accessed. Synthetic ledgers and receipts remain in the owned checkout's `.tmp/silent-bridge-reconnect-*` directories, including the unknown command identity.

Independent review required bounded child shutdown and lifecycle teardown. Cleanup now allows a bounded graceful shutdown, then signals only the owned child and verifies closure; both owned HTTP servers close on normal completion or failure. The outer hard runner has a finite timeout. No existing user process or port is selected for cleanup.

Focused verification executes eight behavior cases and the unchanged gate normalizer. The complete `npm run validate` must also pass at the final candidate; exact full-gate result, command count, conditional skips and source identity are recorded in the task's continuation receipt. Do not substitute PR250's separate full-gate result for this source. Actual player/device/audio acceptance and release authority remain separate boundaries.
