import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
const failures = [];

const allowedHrefPatterns = [
  /^\/$/,
  /^\/home$/,
  /^\/talent\/login$/,
  /^\/talent\/signup$/,
  /^\/talent\/gigs$/,
  /^\/admin$/,
  /^\/overlay\/live$/,
  /^\/privacy$/,
  /^\/terms$/,
  /^\/support$/,
  /^\/faq$/,
  /^\/privacy\/data-deletion$/,
  /^https:\/\/app\.sway\.tips\/$/
];

const forbiddenHrefPatterns = [
  /^$/,
  /^#$/,
  /^\/404$/,
  /^javascript:/i,
  /placeholder/i
];

const anchorPattern = /<a\b([^>]*)href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi;
const anchors = [];
let match;

while ((match = anchorPattern.exec(publicHtml)) !== null) {
  const href = match[2].trim();
  const text = match[4]
    .replace(/<[^>]+>/g, ' ')
    .replace(/&rarr;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  anchors.push({ href, text });
}

if (!anchors.length) {
  failures.push('Public CTA integrity contract could not find any anchors in shells/public.html.');
}

for (const anchor of anchors) {
  if (forbiddenHrefPatterns.some((pattern) => pattern.test(anchor.href))) {
    failures.push(`Public CTA "${anchor.text}" uses a forbidden href: ${anchor.href || '(empty)'}`);
  }

  if (!allowedHrefPatterns.some((pattern) => pattern.test(anchor.href))) {
    failures.push(`Public CTA "${anchor.text}" points outside the approved allowlist: ${anchor.href}`);
  }
}

for (const requiredCta of [
  { text: 'SCAN', href: '/home' },
  { text: 'Create account', href: '/talent/signup' },
  { text: 'Login', href: '/talent/login' },
  { text: 'sway to play', href: '/faq' }
]) {
  if (!anchors.some((anchor) => anchor.text === requiredCta.text && anchor.href === requiredCta.href)) {
    failures.push(`Public landing missing required CTA: ${requiredCta.text} -> ${requiredCta.href}`);
  }
}

for (const forbiddenCopy of ['Audience: join a live room', 'Run the room.', 'Move the queue.', 'Performer sign in']) {
  if (publicHtml.includes(forbiddenCopy)) {
    failures.push(`Public landing must not restore removed marketing copy: ${forbiddenCopy}`);
  }
}

if (failures.length) {
  console.error('Public CTA integrity contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Public CTA integrity contract passed.');
