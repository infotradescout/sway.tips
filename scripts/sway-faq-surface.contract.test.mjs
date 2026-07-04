import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
const failures = [];

for (const term of [
  "const faqPageHtml = renderStaticDocument(",
  "app.get('/faq'",
  "faqPath: '/faq'",
  'Sway FAQ',
  'Official links',
  'Social links',
  'Approved social profile URLs are not configured in this repository yet'
]) {
  if (!server.includes(term)) failures.push(`FAQ surface missing server term: ${term}`);
}

if (!publicHtml.includes('<a class="tagline" href="/faq">sway to play</a>')) {
  failures.push('Public landing sway to play tagline must route to /faq.');
}

if (!publicHtml.includes('href="/faq"')) {
  failures.push('Public landing must include a visible /faq link.');
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
  if (server.includes(forbidden) || publicHtml.includes(forbidden)) {
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
