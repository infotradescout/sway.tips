import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
const browserEnvironment = readFileSync(join(root, 'src/browserEnvironment.ts'), 'utf8');
const generateAppIcons = readFileSync(join(root, 'scripts/generate-app-icons.mjs'), 'utf8');
const mount = readFileSync(join(root, 'src/entries/mount.tsx'), 'utf8');
const prompt = readFileSync(join(root, 'src/shells/SwayInstallPrompt.tsx'), 'utf8');
const manifest = readFileSync(join(root, 'public/sway.webmanifest'), 'utf8');
const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
const patronHtml = readFileSync(join(root, 'shells/patron.html'), 'utf8');
const talentHtml = readFileSync(join(root, 'shells/talent.html'), 'utf8');
const overlayHtml = readFileSync(join(root, 'shells/overlay.html'), 'utf8');
const adminHtml = readFileSync(join(root, 'shells/admin.html'), 'utf8');
const devSandboxHtml = readFileSync(join(root, 'shells/dev-sandbox.html'), 'utf8');

const failures = [];

function readPngDimensions(file) {
  const buffer = readFileSync(join(root, file));
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

const iconFiles = [
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
  ['public/favicon.png', 64],
  ['public/apple-touch-icon.png', 180]
];

for (const file of ['public/assets/sway-site-icon-source.png', 'public/offline.html', ...iconFiles.map(([file]) => file)]) {
  if (!existsSync(join(root, file))) failures.push(`Missing installable app asset: ${file}`);
}

for (const [file, expectedSize] of iconFiles) {
  const dimensions = readPngDimensions(file);
  if (!dimensions || dimensions.width !== expectedSize || dimensions.height !== expectedSize) {
    failures.push(`${file} must be a ${expectedSize}x${expectedSize} PNG.`);
  }
}

for (const term of ['"display": "standalone"', '"start_url": "/home?source=installed-app"', '"purpose": "any maskable"']) {
  if (!manifest.includes(term)) failures.push(`Manifest missing term: ${term}`);
}

for (const term of ['CACHE_NAME', '/offline.html', '/favicon.png', 'serviceWorker.register', "navigator.serviceWorker.register('/sw.js')"]) {
  if (!sw.includes(term) && !mount.includes(term)) failures.push(`Installable app runtime missing term: ${term}`);
}

for (const term of ['public/assets/sway-site-icon-source.png', 'object-fit:cover', 'public/favicon.png']) {
  if (!generateAppIcons.includes(term)) failures.push(`Icon generator missing source-image term: ${term}`);
}

for (const forbidden of ['S_PATH', 'markSvg(', '<svg viewBox="-20 -20 120 166"']) {
  if (generateAppIcons.includes(forbidden)) failures.push(`Icon generator must not redraw the old generated logo: ${forbidden}`);
}

for (const term of ['beforeinstallprompt', 'Install Sway', 'Install app', 'Add to Home Screen']) {
  if (!prompt.includes(term)) failures.push(`Install prompt missing term: ${term}`);
}

for (const term of [
  'public-install-prompt',
  'beforeinstallprompt',
  'Install Sway',
  'Download Sway',
  'Install app',
  'Add to Home Screen',
  'sway.installPromptDismissed.v2',
  'isMetaInAppBrowser'
]) {
  if (!publicHtml.includes(term)) failures.push(`Public landing install prompt missing term: ${term}`);
}

for (const term of [
  'Download Sway',
  'sway.installPromptDismissed.v2',
  'suppressedRoute',
  'Download',
  'Smartphone',
  'X'
]) {
  if (!prompt.includes(term)) failures.push(`Install prompt missing premium tray term: ${term}`);
}

for (const term of ['isMetaInAppBrowser', 'FBAN', 'FBAV', 'FB_IAB', 'MessengerForiOS']) {
  if (!browserEnvironment.includes(term)) failures.push(`Browser environment missing Meta in-app detection term: ${term}`);
}

for (const term of ['installViewportEnvironment', '--sway-viewport-height', 'is-meta-in-app-browser', 'is-compact-viewport', 'is-compact-landscape']) {
  if (!browserEnvironment.includes(term)) failures.push(`Browser environment missing viewport handling term: ${term}`);
}

for (const forbidden of ["visualViewport?.addEventListener('scroll'", 'visualViewport?.addEventListener("scroll"', "visualViewport.addEventListener('scroll'", 'visualViewport.addEventListener("scroll"']) {
  if (browserEnvironment.includes(forbidden) || publicHtml.includes(forbidden)) {
    failures.push(`Viewport handling must not reframe the landing background on scroll: ${forbidden}`);
  }
}

if (!mount.includes('installViewportEnvironment();')) {
  failures.push('Shell mount must install viewport environment before rendering app shells.');
}

if (!prompt.includes('metaInAppBrowser') || !prompt.includes('isMetaInAppBrowser') || !prompt.includes('standalone || dismissed || metaInAppBrowser')) {
  failures.push('Install prompt must be suppressed inside Facebook/Messenger in-app browsers.');
}

for (const html of [publicHtml, patronHtml, talentHtml]) {
  for (const term of ['rel="manifest" href="/sway.webmanifest"', 'apple-touch-icon', 'theme-color']) {
    if (!html.includes(term)) failures.push(`Shell HTML missing install metadata: ${term}`);
  }
}

for (const html of [indexHtml, publicHtml, patronHtml, talentHtml, overlayHtml, adminHtml, devSandboxHtml]) {
  for (const term of [
    'rel="icon" type="image/png" sizes="64x64" href="/favicon.png"',
    'rel="icon" type="image/png" sizes="192x192" href="/icon-192.png"'
  ]) {
    if (!html.includes(term)) failures.push(`HTML entrypoint missing favicon metadata: ${term}`);
  }
}

if (failures.length) {
  console.error('Installable app contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Installable app contract passed.');
