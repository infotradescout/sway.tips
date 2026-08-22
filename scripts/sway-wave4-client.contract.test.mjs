import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const patronView = read('src/components/PatronView.tsx');
const app = read('src/App.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
const harness = read('scripts/browser-fixtures/sway-generalized-live-room-harness.tsx');
const browserProof = read('scripts/sway-generalized-live-room.browser.test.ts');

try {
  for (const term of [
    "LEGACY_PENDING_ACTION_STORAGE_KEY = 'sway.pendingAction'",
    'migrateLegacyPendingActionForRoom(',
    'parsed?.gigId !== gigId',
    'storage.setItem(roomKey, legacyAction)',
    'storage.getItem(LEGACY_PENDING_ACTION_STORAGE_KEY) === legacyAction',
    'data-sway-report-menu-item',
    'onReportMenuItem(',
    "'Host menu item safety report'",
    "requestMenuLabel: 'Comedy request menu'",
    "requestMenuLabel: 'Service request menu'",
    "requestMenuLabel: 'Professional request menu'",
    'const PENDING_ACTION_STORAGE_VERSION = 2 as const',
    'schemaVersion: PENDING_ACTION_STORAGE_VERSION',
    "endpoint: '/api/request/create'",
    "endpoint: '/api/request/boost'",
    'senderName: payload.senderName',
    'message: payload.message',
    'sourceProvider: payload.sourceProvider',
    'spotifyUri: payload.spotifyUri',
    'spotifyUrl: payload.spotifyUrl',
    'patronName: payload.boostPatronName',
    'payment_intent_id: paymentIntentId',
    'const serializedPendingAction = JSON.stringify(action)',
    "result?.recovery !== 'resubmit_original_action'",
    'const response = await resubmitPersistedPendingAction(persistedAction)',
    'return createRequestRef.current(action.submission)',
    'return boostRequestRef.current(',
    'LEGACY_PENDING_ACTION_INCOMPLETE_COPY',
    'LEGACY_PENDING_ACTION_TERMINAL_COPY',
    'Nothing was shown as complete.'
  ]) {
    assert.equal(patronView.includes(term), true, `Patron client is missing Wave 4 behavior: ${term}`);
  }

  const persistenceStart = patronView.indexOf('const createPersistedPendingAction =');
  const resubmitStart = patronView.indexOf('const resubmitPersistedPendingAction =');
  const persistenceBody = persistenceStart >= 0 && resubmitStart > persistenceStart
    ? patronView.slice(persistenceStart, resubmitStart)
    : '';
  assert.notEqual(persistenceBody, '', 'Pending-action persistence builder must be inspectable.');
  assert.equal(
    persistenceBody.includes('clientSecret'),
    false,
    'Crash-recovery storage must not persist the Stripe client secret.'
  );
  assert.equal(
    patronView.includes('const serializedPendingAction = JSON.stringify(payload)'),
    false,
    'The display checkout object must not be serialized as the durable recovery contract.'
  );

  const recoveryResubmit = patronView.indexOf('const response = await resubmitPersistedPendingAction(persistedAction)');
  const recoveryCompletion = patronView.indexOf('completeCheckoutSuccess(persistedAction.type, persistedAction.clientRequestId)', recoveryResubmit);
  assert.equal(recoveryResubmit >= 0 && recoveryCompletion > recoveryResubmit, true,
    'Recovery may complete only after the original canonical endpoint returns its replay.');
  assert.equal(
    patronView.includes("completeCheckoutSuccess(parsed.type === 'boost' ? 'boost' : 'request', parsed.clientRequestId)"),
    false,
    'Status-only reconciliation must never directly finalize the patron action.'
  );

  for (const [name, source] of [['legacy app shell', app], ['patron app shell', patronApp]]) {
    assert.equal(source.includes('expected_gig_id: expectedGigId'), true,
      `${name} must bind status lookup to the route room.`);
    assert.equal(source.includes('responseBody'), false,
      `${name} must not expect a receipt, state, or body from status-only reconciliation.`);
  }

  assert.match(
    patronApp,
    /postJson\('\/api\/moderation\/report',\s*\{\s*\n\s*gig_id: gigId,\s*\n\s*menu_item_id: menuItemId,\s*\n\s*reason,\s*\n\s*details\s*\n\s*\}\)/,
    'Patron shell must send the exact room-menu report API fields.'
  );
  assert.equal(
    patronApp.includes('onReportMenuItem={handleReportMenuItem}'),
    true,
    'Patron shell must wire the room-menu report callback into PatronView.'
  );

  for (const term of [
    'setReportProof({ gig_id: gigId, menu_item_id: menuItemId, reason, details })',
    "moderation_action: 'room_menu_report_submitted'"
  ]) {
    assert.equal(harness.includes(term), true, `Browser harness is missing report proof: ${term}`);
  }

  for (const term of [
    'width: 320',
    'width: 390',
    'width: 430',
    "legacyMode: 'foreign'",
    "legacyMode: 'room-and-foreign'",
    "legacyMode: 'matching'",
    'A legacy action belonging to another room must remain untouched.',
    'Matching legacy action must migrate into the current room key.',
    'Fixture menu title must exercise realistic long content.',
    'room must not expose music-only performer, DJ, or track language.'
  ]) {
    assert.equal(browserProof.includes(term), true, `Browser proof is missing client boundary coverage: ${term}`);
  }

  console.log('Sway Wave 4 client contract passed.');
} catch (error) {
  console.error('Sway Wave 4 client contract failed:', error);
  process.exit(1);
}
