import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const mount = readFileSync(join(root, 'src/entries/mount.tsx'), 'utf8');
const prompt = readFileSync(join(root, 'src/shells/SwayInstallPrompt.tsx'), 'utf8');
const manifest = readFileSync(join(root, 'public/sway.webmanifest'), 'utf8');
const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
const patronHtml = readFileSync(join(root, 'shells/patron.html'), 'utf8');
const talentHtml = readFileSync(join(root, 'shells/talent.html'), 'utf8');

const failures = [];

for (const file of [
  'public/icon-192.png',
  'public/icon-512.png',
  'public/apple-touch-icon.png',
  'public/favicon.png',
  'public/assets/sway-s-only-no-text-icon-source.png',
  'public/offline.html'
]) {
  if (!existsSync(join(root, file))) failures.push(`Missing installable app asset: ${file}`);
}

for (const term of ['"display": "standalone"', '"start_url": "/home?source=installed-app"', '"purpose": "any maskable"']) {
  if (!manifest.includes(term)) failures.push(`Manifest missing term: ${term}`);
}

for (const term of ['CACHE_NAME', '/offline.html', 'serviceWorker.register', "navigator.serviceWorker.register('/sw.js')"]) {
  if (!sw.includes(term) && !mount.includes(term)) failures.push(`Installable app runtime missing term: ${term}`);
}

for (const term of ['beforeinstallprompt', 'Install Sway', 'Install app', 'Add to Home Screen']) {
  if (!prompt.includes(term)) failures.push(`Install prompt missing term: ${term}`);
}

for (const html of [publicHtml, patronHtml, talentHtml]) {
  for (const term of ['rel="manifest" href="/sway.webmanifest"', 'apple-touch-icon', 'rel="icon" type="image/png" href="/favicon.png"', 'theme-color']) {
    if (!html.includes(term)) failures.push(`Shell HTML missing install metadata: ${term}`);
  }
}

const iconGenerator = readFileSync(join(root, 'scripts/generate-app-icons.mjs'), 'utf8');
if (!iconGenerator.includes('public/assets/sway-s-only-no-text-icon-source.png')) {
  failures.push('Icon generator must derive app icons from the approved S-only no-text source asset.');
}

if (failures.length) {
  console.error('Installable app contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Installable app contract passed.');
