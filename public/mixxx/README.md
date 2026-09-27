# Sway + Mixxx: free transport mapping

This mapping connects Sway's existing one-way MIDI controls to Mixxx. Mixxx plays the audio; Sway does not upload, proxy or decode it. No Sway Booth/VirtualDJ Pro account, streaming subscription or Desktop Commander is needed for this mapping.

## Supported controls

Play, Pause, Stop and Cue, on decks 1–4. Load, Next and Previous are deliberately not mapped. Load your track in Mixxx itself. Play is explicit play-on, not a toggle; Pause is explicit play-off. Opening or reconnecting the mapping does not change a deck. A release message does not repeat the press.

This is one-way control. Sway saying a MIDI command was sent is not a confirmation from Mixxx. Inspect Mixxx for its current playback state, especially after an error. There is no automatic retry of an uncertain MIDI command.

## One-time setup

1. Install Mixxx from its official site: https://mixxx.org/download/ . Mixxx has no paid Pro edition. Use the currently supported download; the controlled Linux proof below specifically used stock 2.3.3 and does not certify every later version.
2. In Mixxx, open Preferences → Controllers → Open User Mapping Folder. Copy `Sway-Mixxx.midi.xml` and `Sway-Mixxx.js` into that folder together. Close and reopen Preferences → Controllers to refresh the list.
3. Provide a MIDI connection that is visible as an output to the browser running Sway and an input to Mixxx. Choose that input in Mixxx, select **Sway — Free Mixxx transport**, enable it and apply the settings. This package does not install an operating-system MIDI driver or virtual MIDI cable. Check the licensing and compatibility of any separately chosen MIDI routing software; no paid software is required by this mapping itself.
4. Load a local audio file in Mixxx. In Sway's performer playback controls, choose **MIDI · one-way**, choose the matching deck, press **Choose MIDI output**, grant the browser's MIDI permission, and select the connected output. Test with low volume on a non-live deck.
5. Press Play and verify that only the selected Mixxx deck plays. Press Pause and verify that it stops. After reconnecting, explicitly select the MIDI output again. Inspect the player before issuing a new action after an uncertain-delivery warning.

Mapping installation follows the Mixxx manual: https://manual.mixxx.org/2.5/en/chapters/controlling_mixxx . Browser/operating-system MIDI routing must be set up locally; cloud hosting alone cannot create a MIDI port on your computer.

## What was actually verified

The existing Sway React playback component and MIDI sender at `68b6e8dc6e61cc1e3b0ca530ef11d0f0b5b93d5f` controlled stock Mixxx 2.3.3 in an isolated Linux test. Play advanced deck 2 while deck 1 stayed paused. Independently captured Mixxx audio was non-silent during Play and exactly silent after Pause. Reconnect, a response lost after a real Play dispatch, and browser reload did not resend the old command. A new deliberate Pause and Stop still worked.

The MIDI connection was a clearly separated test cable, and the audio device was a JACK dummy device. The Mixxx executable, mapping runtime, decoder, playback engine and captured audio were real. A separate read-only observer collected player state; it is not a feedback feature in Sway. This does not establish physical Windows/Mac MIDI drivers, the browser's real permission prompt, a full signed-in live room, VirtualDJ, Spotify or the Windows Sway Booth CMD launcher.

The exact mapping has 12 passing unit tests covering all four decks and supported/unsupported actions; actual-player observations cover Play/Pause/Stop on deck 2. Cue and the other decks are not claimed as separate native-player executions.

Evidence: `docs/qa-packets/mixxx-free-player-20260920/observed-result.json`. Public mapping assets are available from a deployed candidate only after an authorized release. This change remains on the development branch; it does not itself release Sway production.
