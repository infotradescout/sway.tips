import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
const failures = [];

// Preserve the existing product and rights boundaries in the server source.
// The production route module is checked in an actual Express/Chromium test below.
for (const term of [
  "const aboutPageHtml = renderStaticDocument(",
  "app.get('/about'",
  "app.get('/faq'",
  "faqPath: '/faq'",
  'Sway: the whole performer business, connected',
  'Your public page',
  'Your live room',
  'Your Catalog and collaborators',
  'Your publishing and distribution',
  'Replacing an existing distributor',
  'Where the publishing product stands',
  'Still required for Self-Production external distribution (DistroKid-class outlet)',
  'current release workspace assembles singles, EPs, and albums from verified masters',
  'Live Rooms is the current operating product',
  'External distribution is one Self-Production outlet',
  'Sway.DIO',
  'Digital Independent Original',
  'Those gaps do not make Live Rooms unfinished',
  'Build and order the release tracks',
  'A single must keep one track; EP and album readiness requires at least two',
  'Track structure locks when rights review starts',
  'editable ordered multi-recording release drafts built from one verified master per track',
  'master control, composition control, artwork control, and distribution authorization',
  'Samples, third-party beats, cover songs, performer consent, and AI disclosure are conditional evidence',
  'contracted DSP delivery provider',
  'Money, ownership, and control'
]) {
  if (!server.includes(term)) failures.push(`Product information missing server term: ${term}`);
}
if (!publicHtml.includes('<a class="tagline" href="/about">sway to play</a>')) failures.push('Public landing sway to play tagline must route to /about.');
if (!publicHtml.includes('href="/about"')) failures.push('Public landing must include a visible /about link.');
const start = server.indexOf("const aboutPageHtml = renderStaticDocument(");
const end = start === -1 ? -1 : server.indexOf('\n);', start);
const template = start === -1 || end === -1 ? server : server.slice(start,end);
for (const staleClaim of ['each release draft connects one verified master to one recording','does not yet add or reorder recordings for an EP or album','Multi-recording EP and album assembly with track add and reorder controls']) {
  if (template.includes(staleClaim)) failures.push(`About source still presents implemented multi-track assembly as missing: ${staleClaim}`);
}
const productionSurface = readFileSync(join(root,'scripts/sway-dj-beta-about-preload.cjs'),'utf8');
for (const forbidden of ['instagram.com/','tiktok.com/','x.com/','twitter.com/','facebook.com/','youtube.com/','discord.gg/']) {
  if (template.includes(forbidden) || publicHtml.includes(forbidden) || productionSurface.includes(forbidden)) failures.push(`Public information must not invent an unapproved social link: ${forbidden}`);
}
if (!packageJson.includes('sway-faq-surface.contract.test.mjs')) failures.push('test:contracts must include FAQ surface contract.');
if (failures.length) {
  console.error('FAQ surface contract failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}
await import('./sway-public-information.browser.test.mjs');
await import('./sway-public-artwork.browser.test.mjs');
console.log('FAQ surface source and real browser contract passed.');
