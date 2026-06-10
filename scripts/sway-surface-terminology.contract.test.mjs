import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// App Unification terminology guard.
//
// Proves the four core surfaces (Public Entry, Patron App, Performer/Operator
// App, Overlay) do not render fragmented or payment-first vocabulary. The shared
// product vocabulary is: Request, Tip, Boost, Pending, Approved, Playing,
// Up Next, Paused, Ended.
//
// Fragmented / payment-first terms are banned from visible copy. Idempotency-
// locked code identifiers (checkoutPayload, initiateCheckout) and the
// intentional demo-mode read-only disclaimers (which only render when demo mode
// is ON, never in the live product) are explicitly excluded so this guard tracks
// real user-facing copy rather than internal code or the demo harness.

const root = process.cwd();

// Banned in visible copy on every surface.
const BANNED_EVERYWHERE = [
  /invoice/i,
  /desk board/i,
  /standing index/i,
  /captured total/i,
  /total captured/i,
  /product direction/i,
  /payment sprint/i,
  /coming soon/i,
  /\bplanned\b/i,
  /\bsoon\b/i,
];

// Standalone visible "checkout" / "check out" / "check-out". The word-boundary
// anchors mean code identifiers like checkoutPayload or initiateCheckout do NOT
// match (the adjacent word characters break the \b at "out\b").
const CHECKOUT = /\bcheck[\s-]?out\b/i;

// "preview" as a visible word. Banned on the Public Entry surface, which has no
// demo gating and is always rendered.
const PREVIEW = /\bpreview\b/i;

// Intentional demo-mode read-only disclaimers. These only render when demo mode
// is enabled and are an intentional safety harness, not live product copy.
const DEMO_DISCLAIMER_ALLOWLIST = [
  'Demo data only. No payment or moderation action will be sent.',
  'Demo only: sending disabled',
];

function stripCommentsAndDisclaimers(src) {
  // Remove block comments.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove whole-line comments without touching "https://" inside string copy.
  out = out
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  // Remove intentional demo-mode disclaimer phrases.
  for (const phrase of DEMO_DISCLAIMER_ALLOWLIST) {
    out = out.split(phrase).join('');
  }
  return out;
}

const failures = [];

function scan(label, text, patterns) {
  for (const re of patterns) {
    const match = text.match(re);
    if (match) {
      failures.push(`${label}: banned terminology "${match[0]}" in visible copy`);
    }
  }
}

// Public Entry: always rendered, no demo gating -> ban the full vocabulary set.
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
scan('shells/public.html', publicHtml, [...BANNED_EVERYWHERE, CHECKOUT, PREVIEW]);

// React surfaces: ban fragmented / payment-first terms and visible checkout.
const reactSurfaces = [
  'src/components/PatronView.tsx',
  'src/components/TalentDashboard.tsx',
  'src/components/VictoryScreen.tsx',
  'src/shells/OverlayApp.tsx',
  'src/App.tsx',
];

for (const rel of reactSurfaces) {
  const scrubbed = stripCommentsAndDisclaimers(readFileSync(join(root, rel), 'utf8'));
  scan(rel, scrubbed, [...BANNED_EVERYWHERE, CHECKOUT]);
}

if (failures.length) {
  console.error('Surface terminology contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Surface terminology contract passed.');
