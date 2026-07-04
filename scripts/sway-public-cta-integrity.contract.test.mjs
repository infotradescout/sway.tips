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

const visibleCopy = publicHtml
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const requiredStack = ['SCAN', 'Create account', 'Login', 'sway to play'];
for (const term of requiredStack) {
  if (!visibleCopy.includes(term)) {
    failures.push(`Public landing foreground stack missing required copy: ${term}`);
  }
}

const stackPositions = requiredStack.map((term) => visibleCopy.indexOf(term));
if (stackPositions.some((index) => index < 0) || stackPositions.some((index, i) => i > 0 && index <= stackPositions[i - 1])) {
  failures.push('Public landing foreground stack must remain ordered as SCAN, Create account, Login, sway to play.');
}

for (const forbiddenCopy of [
  'Run the room',
  'Move the queue',
  'Audience: join a live room',
  'Performer sign in'
]) {
  if (visibleCopy.includes(forbiddenCopy)) {
    failures.push(`Public landing must not include old marketing/header copy: ${forbiddenCopy}`);
  }
}

const foregroundAnchors = anchors.filter((anchor) => requiredStack.includes(anchor.text));
if (foregroundAnchors.length !== requiredStack.length) {
  failures.push('Public landing must expose the complete foreground CTA stack as anchors.');
}

if (failures.length) {
  console.error('Public CTA integrity contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Public CTA integrity contract passed.');
