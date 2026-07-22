import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const read = (file) => readFileSync(join(root, file), 'utf8');
const requireTerm = (source, term, label) => {
  if (!source.includes(term)) failures.push(`${label} missing: ${term}`);
};

for (const file of [
  'src/components/AccountAccess.tsx',
  'src/components/PerformerRightsReviewQueue.tsx',
  'src/components/PerformerRoomHistory.tsx',
  'src/server/patron-status-receipt.ts'
]) {
  if (!existsSync(join(root, file))) failures.push(`Core product file missing: ${file}`);
}

const server = read('server.ts');
const account = read('src/components/AccountAccess.tsx');
const rightsReview = read('src/components/PerformerRightsReviewQueue.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
const patronView = read('src/components/PatronView.tsx');
const proMode = read('src/server/pro-mode.ts');
const history = read('src/components/PerformerRoomHistory.tsx');
const types = read('src/types.ts');

for (const term of [
  "app.post('/api/account/signup'",
  "app.get('/api/account/verify-email/consume'",
  "app.post('/api/account/login'",
  "app.get('/api/account/session'",
  "app.post('/api/account/logout'",
  "app.post('/api/account/pro-mode/activate'"
]) requireTerm(server, term, 'Universal account runtime');
for (const term of ['activateProModeWithPerformer', "onboardingStatus: 'gig_ready'", 'isActive: true']) {
  requireTerm(proMode, term, 'Same-account Pro Mode activation');
}
for (const term of ['Create your Sway account', 'Join or scan a room', 'Activate Pro Mode', 'Open performer console']) {
  requireTerm(account, term, 'Universal account UI');
}
for (const term of ["'/account/reviews'", "name: 'account-rights-review'", 'backHref="/account"']) {
  requireTerm(patronApp, term, 'Account-scoped rights review route');
}
requireTerm(account, 'Review release rights', 'Account-scoped rights review entry');
for (const term of ['backHref', 'backLabel']) requireTerm(rightsReview, term, 'Reusable rights review surface');

const rightsDocumentRoute = server.slice(
  server.indexOf("app.get('/api/talent/audio/rights/:declarationId/document'"),
  server.indexOf("app.post('/api/talent/audio/rights/:declarationId/review'")
);
for (const term of [
  'applyNoStoreHeaders(res)',
  'requireAuthenticatedAccountAccess(req)',
  'openRightsReviewDocument',
  "res.setHeader('Content-Type'",
  "res.setHeader('Content-Length'",
  "res.setHeader('Content-Disposition', `attachment; filename=",
  "res.setHeader('X-Content-Type-Options', 'nosniff')",
  "res.setHeader('X-Sway-Asset-Sha256'",
  'opened.stream.pipe(res)'
]) requireTerm(rightsDocumentRoute, term, 'Sealed rights evidence route');
for (const term of [
  '/api/talent/audio/rights/${item.id}/document',
  'Open sealed evidence',
  'target="_blank"',
  'rel="noreferrer"'
]) requireTerm(rightsReview, term, 'Sealed rights evidence action');

for (const term of ['patronStatusReceiptHash', 'projectPatronBoostStatus', 'boost: newBoost', 'receipt: patronStatusReceipt.receipt']) {
  requireTerm(server + types, term, 'Boost receipt status');
}
for (const term of ['sway.patronStatusReceipts', 'JSON.stringify(next)', 'patronActivity={patronActivity.map']) {
  requireTerm(patronApp, term, 'Patron activity ledger');
}
requireTerm(patronView, 'Your room activity', 'Patron activity UI');

for (const term of [
  'async function settleRoomCloseout',
  'paymentService.voidOrRefundMany',
  'paymentService.aggregateCapturedTotals',
  "eventType: 'session.auto_closeout'",
  "closeoutReason = 'maximum_room_duration'",
  "app.get('/api/talent/rooms/history'",
  "eventType: 'request.triage.approve_payment_failed'",
  "payment_status: 'capture_failed'"
]) requireTerm(server, term, 'Durable closeout and payment truth');
for (const term of ['Earnings and recaps', 'capturedEarnings', 'completedActions']) {
  requireTerm(history, term, 'Durable recap UI');
}

if (failures.length) {
  console.error('Sway core product completion contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway core product completion contract passed.');
