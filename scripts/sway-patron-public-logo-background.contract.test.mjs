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

// Preserve the single approved static artwork, not delayed access to controls.
if (!publicHtml.includes(backgroundRoute)) failures.push('Public landing must render the background image.');
const publicImageRefs = publicHtml.match(/<img[^>]+src="\/assets\/sway-neon-background\.png"/g) ?? [];
if (publicImageRefs.length !== 1) failures.push(`Public landing must render exactly one background image, found ${publicImageRefs.length}.`);
if (!appBackdrop.includes(backgroundRoute)) failures.push('Patron backdrop must render the background image.');
if (!publicHtml.includes(`rel="preload" as="image" href="${backgroundRoute}"`) || !publicHtml.includes('fetchpriority="high"')) {
  failures.push('Public landing must preload the approved background for cold mobile first paint.');
}
for (const term of ['width="1080"', 'height="1620"', 'loading="eager"', 'decoding="async"', 'fetchpriority="high"']) {
  if (!publicHtml.includes(term)) failures.push(`Public landing S background image missing first-load stability hint: ${term}`);
}
for (const term of ['width={1080}', 'height={1620}', 'loading="eager"', 'decoding="async"', 'fetchPriority="high"']) {
  if (!appBackdrop.includes(term)) failures.push(`Patron backdrop S background image missing first-load stability hint: ${term}`);
}
for (const source of [
  { name: 'shells/public.html', text: publicHtml },
  { name: 'src/components/AppBackdrop.tsx', text: appBackdrop },
  { name: 'src/shells/PatronApp.tsx', text: patronApp }
]) {
  for (const forbidden of ['grid-bg','SwayMark',blockedTextBannerAsset,'sway-s-only-no-text-background.png','Run the room','Move the queue','Audience: join a live room','Performer sign in','sway-animated-stage','sway-approved-s-mark']) {
    if (source.text.includes(forbidden)) failures.push(`${source.name} must not include old animated/marketing/logo content: ${forbidden}`);
  }
  for (const forbidden of ['@keyframes','animation:','scale(','hover:scale']) {
    if (source.text.includes(forbidden)) failures.push(`${source.name} must not include zooming or animated background behavior: ${forbidden}`);
  }
}
if (!publicHtml.includes('align-items: center') || !publicHtml.includes('justify-content: center')) failures.push('Mobile public CTA stack must stay centered over the S background.');
for (const term of ['--sway-background-height: 100%','top: 0','height: var(--sway-background-height, 100%)','object-position: 50% 50%']) {
  if (!publicHtml.includes(term)) failures.push(`Public landing background S mark must stay centered in the viewport: ${term}`);
}
if (!appBackdrop.includes('top-0 h-full') || !appBackdrop.includes("objectPosition: '50% 50%'")) failures.push('Patron backdrop S mark must stay centered in the viewport.');
for (const term of ['align-items: flex-end','calc(290px +','calc(220px +','calc(160px +']) {
  if (publicHtml.includes(term)) failures.push(`Public landing must not restore bottom-pushed CTA placement: ${term}`);
}
for (const term of ['--sway-background-y','top-[4%]','top: var(--sway-background-y']) {
  if (publicHtml.includes(term) || appBackdrop.includes(term)) failures.push(`S background must stay centered, not offset with legacy framing: ${term}`);
}
if (!publicHtml.includes('height: var(--sway-background-height, 100%)') || !appBackdrop.includes('h-full')) failures.push('S background must use the full-height static frame that balances the mark above and below the buttons.');
if (!patronApp.includes('items-center justify-center') || patronApp.includes('+17rem') || patronApp.includes('+13rem')) failures.push('Patron recovery CTA stack must stay centered over the S background on mobile.');

// Image readiness may control decoration, never the availability of navigation.
for (const term of ['data-landing-background','landing-ui-ready','image.decode()','root.classList.add','html.landing-ui-ready .tagline','.tagline::before','text-shadow:','0 0 8px rgba(244, 114, 182, 0.72)']) {
  if (!publicHtml.includes(term)) failures.push(`Approved background/foreground styling missing: ${term}`);
}
if (publicHtml.indexOf('html.landing-ui-ready .tagline') > publicHtml.indexOf('html.landing-ui-ready .btn')) failures.push('Decorative tagline readiness must be defined before button readiness.');
if (publicHtml.indexOf('class="tagline"') < publicHtml.lastIndexOf('class="btn secondary"')) failures.push('Public landing tagline must render after the CTA buttons.');
for (const term of ['translateY(',"visualViewport.addEventListener('scroll'",'visualViewport.addEventListener("scroll"']) {
  if (publicHtml.includes(term) || patronApp.includes(term)) failures.push(`Landing UI/background must not move during reveal or mobile viewport scroll: ${term}`);
}
const visibleCopy = publicHtml.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
for (const term of ['SCAN','Create account','Login','sway to play']) {
  if (!visibleCopy.includes(term)) failures.push(`Public foreground stack missing: ${term}`);
}
if (!packageJson.includes('sway-patron-public-logo-background.contract.test.mjs')) failures.push('test:contracts must include the patron/public logo background contract.');
if (failures.length) {
  console.error('Patron/public logo background contract failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exit(1);
}
// Replaces the obsolete delayed-button requirement with stricter immediate
// access, keyboard focus, footer flow and performer-entry assertions.
await import('./sway-public-entry-contract.mjs');
console.log('Patron/public logo background and immediate access contract passed.');
