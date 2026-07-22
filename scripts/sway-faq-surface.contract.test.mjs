import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
const failures = [];

for (const term of [
  "const aboutPageHtml = renderStaticDocument(",
  "const faqPageHtml = aboutPageHtml;",
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
  'Still required for the complete DistroKid replacement',
  'each release draft connects one verified master to one recording',
  'does not yet add or reorder recordings for an EP or album',
  'master control, composition control, artwork control, and distribution authorization',
  'Samples, third-party beats, cover songs, performer consent, and AI disclosure are conditional evidence',
  'Multi-recording EP and album assembly',
  'contracted DSP delivery provider',
  'Money, ownership, and control'
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

if (!packageJson.includes('sway-faq-surface.contract.test.mjs')) {
  failures.push('test:contracts must include FAQ surface contract.');
}

if (failures.length) {
  console.error('FAQ surface contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('FAQ surface contract passed.');
