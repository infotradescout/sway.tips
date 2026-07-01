import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
const failures = [];

const allowedHrefPatterns = [
  /^\/$/,
  /^\/talent\/login$/,
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

const audienceCtas = anchors.filter((anchor) => /^Audience:/i.test(anchor.text));

if (!audienceCtas.length) {
  failures.push('Expected at least one public Audience CTA in shells/public.html.');
}

const immediateRequestCopyPattern = /\b(start request|request now|send request|open request)\b/i;
const truthfulAudienceCopyPattern = /\b(explore sway|browse|discover|learn more|join a live room)\b/i;

for (const cta of audienceCtas) {
  if (cta.href === 'https://app.sway.tips/' && immediateRequestCopyPattern.test(cta.text)) {
    failures.push(
      `Audience CTA "${cta.text}" cannot promise immediate request creation while linking to bare https://app.sway.tips/.`
    );
  }

  if (!truthfulAudienceCopyPattern.test(cta.text) && !immediateRequestCopyPattern.test(cta.text)) {
    failures.push(`Audience CTA "${cta.text}" must use approved truthful audience copy.`);
  }
}

if (failures.length) {
  console.error('Public CTA integrity contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Public CTA integrity contract passed.');
