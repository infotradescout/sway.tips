import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
const packageConfig = JSON.parse(packageJson);
const failures = [];

for (const term of [
  "const aboutPageHtml = renderStaticDocument(",
  "const faqPageHtml = aboutPageHtml;",
  "app.get('/about'",
  "app.get('/faq'",
  "faqPath: '/faq'"
]) {
  if (!server.includes(term)) failures.push(`FAQ surface missing server term: ${term}`);
}

if (!publicHtml.includes('<a class="tagline" href="/about">sway to play</a>')) {
  failures.push('Public landing sway to play tagline must route to /about.');
}

if (!publicHtml.includes('href="/about"')) {
  failures.push('Public landing must include a visible /about link.');
}

// Scope the forbidden-link scan to the FAQ page template itself, not the
// whole server.ts file -- unrelated features (like control-bridge search
// deep links) may legitimately reference these hosts elsewhere.
const faqTemplateStart = server.indexOf("const aboutPageHtml = renderStaticDocument(");
const faqTemplateEnd = faqTemplateStart === -1 ? -1 : server.indexOf('\n);', faqTemplateStart);
const faqTemplate = faqTemplateStart === -1 || faqTemplateEnd === -1
  ? server
  : server.slice(faqTemplateStart, faqTemplateEnd);

for (const term of [
  'Run the crowd without stopping the set',
  'Sway gives DJs and live performers one room for Requests, Tips, and Boosts',
  'Start a room, share the QR code or link, and let people interact from their phones',
  'No app download is required for the web experience',
  'Sway works alongside your existing DJ setup',
  'Requests in one queue',
  'Tips in the same room',
  'Approved boosts',
  'Clear status',
  'Pending, Approved, Now Playing, Up Next, Paused, and Ended',
  'How patrons use Sway',
  'How to run Sway tonight',
  'Free requests',
  'Paid requests',
  'Minimum request amount',
  'My synced library first',
  'Open requests',
  'Review the room rules',
  'Create room',
  'Manual, Open Call, or Auto',
  'Pause Requests or Resume Requests',
  'Approve, Deny, and Mark played',
  'recorded captured payment volume',
  'You remain in control',
  'The opening DJ beta is focused on the live room',
  'Keep using Serato, Rekordbox, VirtualDJ, Tidal, USB drives, or your normal deck workflow',
  'A request is not a promise that a song will be played',
  'The DJ keeps artistic and operational control of the room',
  'If a paid option is available, set the Minimum request amount',
  'My synced library first or Open requests',
  "liveRoomPaymentRuntimeConfig.mode === 'test'",
  'or Test paid requests',
  'Test activity is not a real charge or payout',
  "liveRoomPaymentRuntimeConfig.mode === 'live'",
  'or Paid requests',
  'The performer must complete the required payment setup before using live paid actions'
]) {
  if (!faqTemplate.includes(term)) failures.push(`About template missing DJ-beta term: ${term}`);
}

for (const [href, label] of [
  ['/account/signup', 'Create your DJ account'],
  ['/account/login', 'Log in and start'],
  ['/home', 'Join a live room']
]) {
  if (!faqTemplate.includes(`<a href="${href}">${label}</a>`)) {
    failures.push(`About template missing CTA: ${label} -> ${href}`);
  }
}

const signupCtaIndex = faqTemplate.indexOf('<a href="/account/signup">Create your DJ account</a>');
const loginCtaIndex = faqTemplate.indexOf('<a href="/account/login">Log in and start</a>');
const joinCtaIndex = faqTemplate.indexOf('<a href="/home">Join a live room</a>');
if (!(signupCtaIndex !== -1 && signupCtaIndex < loginCtaIndex && loginCtaIndex < joinCtaIndex)) {
  failures.push('Create your DJ account must remain the visually first About-page action.');
}

if (!/liveRoomPaymentRuntimeConfig\.mode === 'test'[\s\S]*liveRoomPaymentRuntimeConfig\.mode === 'live'[\s\S]*: ''\}/.test(faqTemplate)) {
  failures.push('About payment notice must render for test/live modes and stay absent when payment mode is unavailable.');
}

for (const forbidden of [
  'Sway.DIO',
  'DistroKid',
  'Self-Production',
  'Replacing an existing distributor',
  'contracted DSP delivery provider',
  'royalty-statement',
  'catalog transfer',
  'multi-recording release',
  'provider-backed delivery',
  'durable Sway QR',
  'durable QR',
  'order approved items',
  'update status',
  'available earnings information'
]) {
  if (faqTemplate.includes(forbidden)) {
    failures.push(`About template still contains forbidden or unimplemented term: ${forbidden}`);
  }
}

for (const forbidden of [
  'instagram.com/',
  'tiktok.com/',
  'x.com/',
  'twitter.com/',
  'facebook.com/',
  'youtube.com/',
  'discord.gg/'
]) {
  if (faqTemplate.includes(forbidden) || publicHtml.includes(forbidden)) {
    failures.push(`FAQ/public surface must not invent unapproved social link: ${forbidden}`);
  }
}

const faqContractCommand = 'node scripts/sway-faq-surface.contract.test.mjs';
if (packageConfig.scripts?.['test:faq'] !== faqContractCommand) {
  failures.push('Package scripts must keep the dedicated FAQ test wired directly to the FAQ surface contract.');
}
if (!packageConfig.scripts?.['test:contracts']?.split(' && ').includes(faqContractCommand)) {
  failures.push('The full contract suite must keep the FAQ surface contract wired in.');
}

if (failures.length) {
  console.error('FAQ surface contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('FAQ surface contract passed.');
