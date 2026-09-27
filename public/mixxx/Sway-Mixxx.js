/* Sway transport mapping. Audio and observed state remain in Mixxx. */
var SwayMixxx = {};

// Opening, reconnecting or closing a MIDI connection must not act on a deck.
SwayMixxx.init = function () {};
SwayMixxx.shutdown = function () {};

SwayMixxx.transport = function (channel, control, value, status, group) {
    // Sway sends a Note On followed by a Note Off. Only the press is an action.
    if ((status & 0xF0) !== 0x90 || value !== 127 ||
            channel < 0 || channel > 3 ||
            group !== '[Channel' + (channel + 1) + ']') return;
    if (control === 37) {
        if (engine.getValue(group, 'track_samples') > 0) engine.setValue(group, 'play', 1);
    } else if (control === 38) {
        engine.setValue(group, 'play', 0);
    } else if (control === 39) {
        engine.setValue(group, 'play', 0);
        engine.setValue(group, 'playposition', 0);
    } else if (control === 40) {
        engine.setValue(group, 'cue_gotoandstop', 1);
        engine.setValue(group, 'cue_gotoandstop', 0);
    }
};
