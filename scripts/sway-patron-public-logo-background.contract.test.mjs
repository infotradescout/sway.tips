import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const failures = [];

const publicHtml = read('shells/public.html');
const appBackdrop = read('src/components/AppBackdrop.tsx');
const packageJson = read('package.json');

const backgroundAsset = 'public/assets/sway-neon-background.png';
const backgroundRoute = '/assets/sway-neon-background.png';
const blockedTextBannerAsset = '419c8589-e2ef-4199-8221-4794e7420df4.png';

if (!existsSync(join(root, backgroundAsset))) {
  failures.push(`Background asset missing: ${backgroundAsset}`);
} else if (statSync(join(root, backgroundAsset)).size === 0) {
  failures.push(`Background asset is empty: ${backgroundAsset}`);
}

// The landing background is a single static image on both surfaces - no
// animated CSS/SVG scene, no 3D-rendered layers. Just the approved artwork.
if (!publicHtml.includes(backgroundRoute)) {
  failures.push('Public landing must render the background image.');
}

if (!appBackdrop.includes(backgroundRoute)) {
  failures.push('Patron backdrop must render the background image.');
}

const publicImageRefs = publicHtml.match(/<img[^>]+src="\/assets\/sway-neon-background\.png"/g) ?? [];
if (publicImageRefs.length !== 1) {
  failures.push(`Public landing must render exactly one background image, found ${publicImageRefs.length}.`);
}

for (const source of [
  { name: 'shells/public.html', text: publicHtml },
  { name: 'src/components/AppBackdrop.tsx', text: appBackdrop }
]) {
  for (const forbidden of [
    'grid-bg',
    'SwayMark',
    blockedTextBannerAsset,
    'Run the room',
    'Move the queue',
    'Audience: join a live room',
    'Performer sign in',
    'sway-animated-stage',
    'sway-approved-s-mark'
  ]) {
    if (source.text.includes(forbidden)) {
      failures.push(`${source.name} must not include old animated/marketing/logo content: ${forbidden}`);
    }
  }
}

const visibleCopy = publicHtml
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

for (const term of ['SCAN', 'Create account', 'Login', 'sway to play']) {
  if (!visibleCopy.includes(term)) {
    failures.push(`Public foreground stack missing: ${term}`);
  }
}

if (!packageJson.includes('sway-patron-public-logo-background.contract.test.mjs')) {
  failures.push('test:contracts must include the patron/public logo background contract.');
}

if (failures.length) {
  console.error('Patron/public logo background contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Patron/public logo background contract passed.');
