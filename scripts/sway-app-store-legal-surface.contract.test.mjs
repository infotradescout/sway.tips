import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const publicHtml = readFileSync(join(root, 'shells/public.html'), 'utf8');
const patronShell = readFileSync(join(root, 'src/shells/PatronApp.tsx'), 'utf8');
const legacyApp = readFileSync(join(root, 'src/App.tsx'), 'utf8');
const reviewPacket = readFileSync(join(root, 'docs/SWAY_APPSTORE_REVIEW_PACKET.md'), 'utf8');

const failures = [];

for (const term of [
  "app.get('/support'",
  "app.get('/faq'",
  "app.get('/privacy'",
  "app.get('/terms'",
  "app.get('/legal/payments'",
  "app.get('/legal/payouts'",
  "app.get('/privacy/data-deletion'",
  "app.post('/api/privacy/data-deletion'",
  "app.post('/api/privacy/data-deletion-placeholder'",
  "supportPath: '/support'",
  "faqPath: '/faq'",
  "dataDeletionInfoPath: '/privacy/data-deletion'"
]) {
  if (!server.includes(term)) failures.push(`Server missing legal/support surface: ${term}`);
}

const privacyTemplateStart = server.indexOf("const privacyPageHtml = renderStaticDocument(");
const privacyTemplateEnd = privacyTemplateStart === -1 ? -1 : server.indexOf('\n);', privacyTemplateStart);
const privacyTemplate = privacyTemplateStart === -1 || privacyTemplateEnd === -1
  ? ''
  : server.slice(privacyTemplateStart, privacyTemplateEnd);

for (const term of [
  'original master and supporting-file bytes',
  'collaborator connections, selected-file access grants',
  'rights documents, declarations, review decisions',
  'public performer profile or an eligible public release page',
  'Uploading a file does not make a private Catalog file public',
  'Provider-backed music delivery, royalty processing, collaborator payouts, pre-saves, and catalog cutover are not live'
]) {
  if (!privacyTemplate.includes(term)) failures.push(`Privacy policy missing creator-data truth: ${term}`);
}

const termsTemplateStart = server.indexOf("const termsPageHtml = renderStaticDocument(");
const termsTemplateEnd = termsTemplateStart === -1 ? -1 : server.indexOf('\n);', termsTemplateStart);
const termsTemplate = termsTemplateStart === -1 || termsTemplateEnd === -1
  ? ''
  : server.slice(termsTemplateStart, termsTemplateEnd);

for (const term of [
  'a draft with one verified master and one recording',
  'there is no add-or-reorder workflow for an EP or album',
  'master control, composition control, artwork control, and distribution authorization',
  'Sample clearance, third-party beat licenses, cover licenses, performer consent, and AI disclosure are conditional evidence',
  'revocation blocks future access but cannot retrieve copies already downloaded',
  'Provider-backed delivery, store callbacks and corrections, royalties, splits, payouts, destination pre-saves, takedowns, and catalog cutover are not live',
  'has not thereby been submitted, accepted, distributed, streamed, monetized, or migrated'
]) {
  if (!termsTemplate.includes(term)) failures.push(`Terms missing creator-product boundary: ${term}`);
}

for (const href of ['/privacy', '/terms', '/faq', '/support', '/privacy/data-deletion']) {
  if (!publicHtml.includes(`href="${href}"`)) {
    failures.push(`Public landing missing trust link: ${href}`);
  }
}

for (const term of [
  "/api/support/contact",
  "/api/privacy/data-deletion",
  "window.open(data.supportPath",
  "window.open(data.dataDeletionInfoPath"
]) {
  if (!patronShell.includes(term) && !legacyApp.includes(term)) {
    failures.push(`Patron support/deletion wiring missing term: ${term}`);
  }
}

for (const term of [
  'Privacy Policy URL',
  'Support URL',
  'review notes',
  '/privacy',
  '/terms',
  '/support',
  '/privacy/data-deletion',
  'not yet App Store-ready'
]) {
  if (!reviewPacket.includes(term)) failures.push(`Review packet missing term: ${term}`);
}

if (failures.length) {
  console.error('App Store legal surface contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('App Store legal surface contract passed.');
