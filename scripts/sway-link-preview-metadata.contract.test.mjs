import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
const patronHtml = readFileSync(join(root, 'shells/patron.html'), 'utf8');
const packageJson = readFileSync(join(root, 'package.json'), 'utf8');
const failures = [];

for (const term of [
  'type ShareMetadata',
  'DEFAULT_SHARE_IMAGE_PATH = \'/social-preview.png?v=1\'',
  'function injectShareMetadata',
  'function resolveShareMetadata',
  'function findPublicShareProfile',
  'function renderPerformerShareCard',
  "app.get('/api/public/performer/:handle/share-card.png'",
  "image: `/api/public/performer/${encodeURIComponent(profile.handle)}/share-card.png?v=1`",
  "url: `/p/${profile.handle}`",
  "import sharp from \"sharp\"",
  'renderShareMetaTags',
  'sway-share-meta',
  "pathParts[0] === 'p'",
  "pathParts[0] === 'g'",
  'normalizedHandle.toLowerCase()',
  'og:title',
  'og:description',
  'og:image',
  'twitter:card',
  'twitter:image',
  'vite.transformIndexHtml(req.originalUrl, template)',
  'injectShareMetadata(transformedHtml, await resolveShareMetadata(req))',
  'injectShareMetadata(template, await resolveShareMetadata(req))'
]) {
  if (!server.includes(term)) {
    failures.push(`Server link-preview metadata missing required term: ${term}`);
  }
}

for (const term of [
  'https://app.sway.tips/social-&#112;review.png?v=1',
  'og:image:width" content="1672"',
  'og:image:height" content="941"',
  'twitter:image" content="https://app.sway.tips/social-&#112;review.png?v=1"'
]) {
  if (!publicHtml.includes(term)) {
    failures.push(`Public landing metadata missing required term: ${term}`);
  }
}

for (const forbidden of [
  'https://sway.tips/assets/sway-neon-background.png?v=1',
  'og:image:width" content="1080"',
  'og:image:height" content="1620"'
]) {
  if (publicHtml.includes(forbidden)) {
    failures.push(`Public landing metadata must not use stale tall preview term: ${forbidden}`);
  }
}

for (const term of ['og:title', 'twitter:card', 'sway-share-meta']) {
  if (patronHtml.includes(term)) {
    failures.push(`Patron shell should receive route-specific share metadata from the server, not static ${term}.`);
  }
}

if (!packageJson.includes('node scripts/sway-link-preview-metadata.contract.test.mjs')) {
  failures.push('package.json must register the link-preview metadata contract in test:contracts.');
}
if (!packageJson.includes('"sharp"')) {
  failures.push('package.json must include the server-side PNG renderer used by performer share cards.');
}

if (failures.length) {
  console.error('Link preview metadata contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Link preview metadata contract passed.');
