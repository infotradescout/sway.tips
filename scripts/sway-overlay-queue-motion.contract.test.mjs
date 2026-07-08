import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const overlayApp = readFileSync(join(root, 'src/shells/OverlayApp.tsx'), 'utf8');
const patronView = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

// Overlay Up Next queue must use the same Framer Motion layout-animation
// pattern already proven in PatronView's Live Queue, so rows reflow/bounce
// when ranking changes instead of snapping to a new position.
if (!patronView.includes('layoutId={`patron-queue-${req.id}`}')) {
  failures.push('PatronView reference pattern (layoutId={`patron-queue-${req.id}`}) is missing -- nothing to compare the overlay against.');
}

for (const term of [
  'layoutId={`overlay-queue-${req.id}`}',
  'upNextQueue.slice(0, transparent ? 5 : 4).map((req, idx) => (',
  '<motion.div'
]) {
  if (!overlayApp.includes(term)) {
    failures.push(`OverlayApp Up Next queue missing motion-layout term: ${term}`);
  }
}

// Album art per queue row, with a safe non-broken-image fallback -- mirrors
// the icon-fallback style OverlayApp already uses for the now-playing card.
for (const term of [
  'req.albumArt ? (',
  'alt=""',
  "onError={(e) => { e.currentTarget.style.display = 'none'; }}",
  'from-fuchsia-600/30 to-blue-600/30'
]) {
  if (!overlayApp.includes(term)) {
    failures.push(`OverlayApp Up Next queue missing album art term: ${term}`);
  }
}

// This lane explicitly excludes synced/karaoke lyrics and any playback-clock
// anchoring -- confirm none of that scope crept in.
for (const forbidden of [
  'syncedLyrics',
  'now starting',
  'nowStartingAt',
  'lyricsAnchor',
  'playbackClock'
]) {
  if (overlayApp.includes(forbidden)) {
    failures.push(`OverlayApp must not introduce synced-lyrics/clock-anchor scope in this lane: found ${forbidden}`);
  }
}

// Existing static lyrics behavior must remain unchanged.
for (const term of [
  "fetch(`/api/lyrics?${params}`)",
  "setLyricsText(data.instrumental ? 'Instrumental — no lyrics.' : data.plainLyrics)",
  "setLyricsStatus('found')"
]) {
  if (!overlayApp.includes(term)) {
    failures.push(`OverlayApp must preserve existing static lyrics behavior: missing ${term}`);
  }
}

// Overlay must remain read-only / OBS-projector-friendly -- no new mutation
// calls introduced by this purely visual change.
for (const forbidden of ['postJson(', "method: 'POST'", 'method: "POST"', "method: 'DELETE'", 'method: "DELETE"', "method: 'PATCH'", 'method: "PATCH"']) {
  if (overlayApp.includes(forbidden)) {
    failures.push(`OverlayApp must remain read-only for projector/audience display: found ${forbidden}`);
  }
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
if (!testContracts.includes('node scripts/sway-overlay-queue-motion.contract.test.mjs')) {
  failures.push('test:contracts must include the overlay queue motion contract.');
}

if (failures.length) {
  console.error('Overlay queue motion contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Overlay queue motion contract passed.');
