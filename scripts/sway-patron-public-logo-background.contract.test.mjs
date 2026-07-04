import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const failures = [];

const publicHtml = read('shells/public.html');
const appBackdrop = read('src/components/AppBackdrop.tsx');
const css = read('src/index.css');
const packageJson = read('package.json');

const approvedBackground = 'public/assets/sway-s-only-no-text-background.png';
const approvedIconSource = 'public/assets/sway-s-only-no-text-icon-source.png';
const approvedRoute = '/assets/sway-s-only-no-text-background.png';
const blockedTextBannerAsset = '419c8589-e2ef-4199-8221-4794e7420df4.png';

function readPngDimensions(path) {
  const buffer = readFileSync(join(root, path));
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    size: buffer.length
  };
}

for (const asset of [approvedBackground, approvedIconSource]) {
  if (!existsSync(join(root, asset))) {
    failures.push(`Approved S-only no-text asset missing: ${asset}`);
    continue;
  }

  const dimensions = readPngDimensions(asset);
  if (!dimensions) {
    failures.push(`Approved asset is not a readable PNG: ${asset}`);
    continue;
  }

  if (dimensions.width !== 1024 || dimensions.height !== 1536) {
    failures.push(`Approved S-only no-text asset must remain 1024x1536, got ${dimensions.width}x${dimensions.height}: ${asset}`);
  }

  if (statSync(join(root, asset)).size !== 1646154) {
    failures.push(`Approved S-only no-text asset size changed unexpectedly: ${asset}`);
  }
}

if (!publicHtml.includes(approvedRoute)) {
  failures.push('Public landing must reference the approved S-only no-text background asset.');
}

if (!appBackdrop.includes(approvedRoute)) {
  failures.push('Patron no-session backdrop must reference the approved S-only no-text background asset.');
}

for (const source of [
  { name: 'shells/public.html', text: publicHtml },
  { name: 'src/components/AppBackdrop.tsx', text: appBackdrop }
]) {
  for (const forbidden of [
    'grid-bg',
    'eq-bar',
    '<svg',
    'SwayMark',
    blockedTextBannerAsset,
    'Run the room',
    'Move the queue',
    'Audience: join a live room',
    'Performer sign in'
  ]) {
    if (source.text.includes(forbidden)) {
      failures.push(`${source.name} must not include old grid/equalizer/marketing/logo content: ${forbidden}`);
    }
  }
}

if (!publicHtml.includes('object-fit: contain') || !css.includes('object-fit: contain')) {
  failures.push('Landing background art must use contain scaling to avoid ugly desktop crop.');
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

for (const animationTerm of [
  'landing-wave-ribbon',
  'landing-neon-breathe',
  'landing-light-sweep',
  'landing-particles'
]) {
  if (!publicHtml.includes(animationTerm)) {
    failures.push(`Public landing missing animated background layer: ${animationTerm}`);
  }
  if (!appBackdrop.includes(animationTerm)) {
    failures.push(`Patron no-session backdrop missing animated background layer: ${animationTerm}`);
  }
}

for (const cssTerm of [
  '@keyframes landing-bg-pan',
  '@keyframes landing-art-breathe',
  '@keyframes landing-wave-drift',
  '@keyframes landing-light-sweep',
  '@keyframes landing-particle-drift',
  '@media (max-width: 640px)',
  '@media (max-width: 640px) and (max-height: 760px)',
  '@media (max-height: 480px) and (orientation: landscape)'
]) {
  if (!css.includes(cssTerm) && !publicHtml.includes(cssTerm)) {
    failures.push(`Landing background animation/mobile CSS missing: ${cssTerm}`);
  }
}

for (const animationTerm of [
  'landing-bg-pan 16s',
  'landing-art-breathe 6.4s',
  'landing-wave-drift 5.6s',
  'landing-light-sweep 6.8s',
  'landing-particle-drift 10s'
]) {
  if (!css.includes(animationTerm) || !publicHtml.includes(animationTerm)) {
    failures.push(`Landing background motion must remain visibly animated: ${animationTerm}`);
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
