import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const failures = [];

const publicHtml = read('shells/public.html');
const appBackdrop = read('src/components/AppBackdrop.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
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
  { name: 'src/components/AppBackdrop.tsx', text: appBackdrop },
  { name: 'src/shells/PatronApp.tsx', text: patronApp }
]) {
  for (const forbidden of [
    'grid-bg',
    'SwayMark',
    blockedTextBannerAsset,
    'sway-s-only-no-text-background.png',
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

  for (const forbiddenZoom of ['@keyframes', 'animation:', 'scale(', 'hover:scale']) {
    if (source.text.includes(forbiddenZoom)) {
      failures.push(`${source.name} must not include zooming or animated background behavior: ${forbiddenZoom}`);
    }
  }
}

if (!publicHtml.includes('align-items: center') || !publicHtml.includes('justify-content: center')) {
  failures.push('Mobile public CTA stack must stay centered over the S background.');
}

for (const term of ['--sway-background-height: 100%', 'top: 0', 'height: var(--sway-background-height, 100%)', 'object-position: 50% 50%']) {
  if (!publicHtml.includes(term)) {
    failures.push(`Public landing background S mark must stay centered in the viewport: ${term}`);
  }
}

if (!appBackdrop.includes('top-0 h-full') || !appBackdrop.includes("objectPosition: '50% 50%'")) {
  failures.push('Patron backdrop S mark must stay centered in the viewport.');
}

for (const forbiddenPlacement of ['align-items: flex-end', 'calc(290px +', 'calc(220px +', 'calc(160px +']) {
  if (publicHtml.includes(forbiddenPlacement)) {
    failures.push(`Public landing must not restore bottom-pushed CTA placement: ${forbiddenPlacement}`);
  }
}

for (const forbiddenBackgroundOffset of ['--sway-background-y', 'top-[4%]', 'top: var(--sway-background-y']) {
  if (publicHtml.includes(forbiddenBackgroundOffset) || appBackdrop.includes(forbiddenBackgroundOffset)) {
    failures.push(`S background must stay centered, not offset with legacy framing: ${forbiddenBackgroundOffset}`);
  }
}

if (!publicHtml.includes('height: var(--sway-background-height, 100%)') || !appBackdrop.includes('h-full')) {
  failures.push('S background must use the full-height static frame that balances the mark above and below the buttons.');
}

if (!patronApp.includes('items-center justify-center') || patronApp.includes('+17rem') || patronApp.includes('+13rem')) {
  failures.push('Patron recovery CTA stack must stay centered over the S background on mobile.');
}

for (const term of [
  'data-landing-background',
  'landing-ui-ready',
  'image.decode()',
  'root.classList.add',
  'opacity: 0',
  'html.landing-ui-ready .tagline',
  '.tagline::before',
  'text-shadow:',
  '0 0 8px rgba(244, 114, 182, 0.72)',
  'transition: opacity 1.25s cubic-bezier(0.22, 1, 0.36, 1)',
  'opacity 1.15s cubic-bezier(0.4, 0, 0.2, 1) 0.52s'
]) {
  if (!publicHtml.includes(term)) {
    failures.push(`Public landing must reveal UI after the background image is ready: ${term}`);
  }
}

if (publicHtml.indexOf('html.landing-ui-ready .tagline') > publicHtml.indexOf('html.landing-ui-ready .btn')) {
  failures.push('Public landing tagline reveal must be defined before the delayed button reveal.');
}

if (publicHtml.indexOf('class="tagline"') > publicHtml.indexOf('class="btn primary"')) {
  failures.push('Public landing tagline must render before the primary CTA so it visibly leads the stack.');
}

for (const forbiddenMotion of ['translateY(', "visualViewport.addEventListener('scroll'", 'visualViewport.addEventListener("scroll"']) {
  if (publicHtml.includes(forbiddenMotion) || patronApp.includes(forbiddenMotion)) {
    failures.push(`Landing UI/background must not move during reveal or mobile viewport scroll: ${forbiddenMotion}`);
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
